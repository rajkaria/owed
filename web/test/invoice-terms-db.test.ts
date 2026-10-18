import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST as createInvoiceRoute } from "@/app/api/v1/invoices/route";
import { GET as getInvoiceRoute } from "@/app/api/v1/invoices/[id]/route";
import { GET as getRequestRoute } from "@/app/api/v1/requests/[id]/route";
import { GET as cronGET } from "@/app/api/cron/schedules/route";
import { GetRequestResponse, InvoiceTermsResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { getLedger } from "@/lib/ledger";
import { createInvoiceWithTerms, runDueInvoiceTerms, withInvoiceTerms } from "@/lib/invoice-terms";
import { addDays, isoDay } from "@/lib/invoice-terms-core";
import { usdcAtomicFor } from "@/lib/fiat";
import { check, shapes } from "../../contract/shapes.mjs";

// F8 invoice terms on real Postgres: every migration (0001 → 0021) on PGlite answering lib/db.ts's Neon-over-HTTP calls,
// the invoice routes and the daily cron as Vercel runs them. Chain reads come from a double that knows only the payments a
// test constructs (in the jsonParsed shape mainnet returns, as test/pairing.test.ts builds them); every other reference
// has no transactions. Payments are mostly written straight into the row (status, paid_*), the way every settle path
// writes them, so the 0021 trigger runs exactly as it does after a real payment; one test pays through the chain read.

interface PgResult { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }
interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], options?: Record<string, unknown>): Promise<{ rows: T[] } & Partial<PgResult>>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
}
const PGLITE = "@electric-sql/pglite";
const mod = (await import(PGLITE).catch(() => null)) as { PGlite: new () => Pg } | null;
const it = mod ? test : test.skip;
const pg = mod ? new mod.PGlite() : (null as unknown as Pg);
const MIGRATIONS = new URL("../db/migrations/", import.meta.url);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1005, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

const keyFrom = (seed: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(seed).digest()));
const ME = bs58.encode(keyFrom("owed test signer: invoice-terms-db.test.ts").publicKey);
const PAYER = bs58.encode(keyFrom("owed test signer: invoice-terms-db.test.ts, the client").publicKey);
const key32 = (label: string) => bs58.encode(createHash("sha256").update(label).digest());
let sigCounter = 0;
const freshSig = () => bs58.encode(Buffer.concat([createHash("sha256").update(`sig a ${sigCounter}`).digest(), createHash("sha256").update(`sig b ${sigCounter++}`).digest()]));

// ---- the chain double ----
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const bySig = new Map<string, unknown>();
const byRef = new Map<string, Array<{ signature: string; err: null; slot: number; blockTime: number }>>();
let rpcDown = false;

/** A confirmed USDC transfer `from` -> `to` carrying `reference` on its transferChecked (as pay_link builds it). */
function usdcTransfer({ from, to, amount, reference, at }: { from: string; to: string; amount: bigint; reference: string; at: number }) {
  const sig = freshSig();
  const fromAta = key32(`ata ${from}`);
  const toAta = key32(`ata ${to}`);
  const keys = [from, fromAta, toAta, USDC, TOKEN_PROGRAM, reference];
  const tx = {
    slot: 300_000_000 + sigCounter, blockTime: Math.floor(at / 1000),
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), innerInstructions: [],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: from, uiTokenAmount: { amount: String(amount + 5_000_000n) } },
        { accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: from, uiTokenAmount: { amount: "5000000" } },
        { accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: String(amount) } },
      ],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i <= 2 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: fromAta, mint: USDC, destination: toAta, multisigAuthority: from, signers: [reference], tokenAmount: { amount: String(amount), decimals: 6 } } } }],
      },
    },
  };
  bySig.set(sig, tx);
  byRef.set(reference, [...(byRef.get(reference) ?? []), { signature: sig, err: null, slot: tx.slot, blockTime: tx.blockTime }]);
  return sig;
}

function answerRpc(m: { id: number; method: string; params: unknown[] }) {
  const subject = String(m.params[0]);
  if (m.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: m.id, result: [...(byRef.get(subject) ?? [])].reverse() };
  if (m.method === "getTransaction") return { jsonrpc: "2.0", id: m.id, result: bySig.get(subject) ?? null };
  return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `unrecorded call ${m.method}` } };
}

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const RPC_HOSTS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const CRON_SECRET = "f8-invoice-terms-cron-secret-0123456789";

before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (RPC_HOSTS.some((h) => url.startsWith(h))) {
      if (rpcDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answerRpc) : answerRpc(body)), { headers: { "content-type": "application/json" } });
    }
    if (!url.startsWith(NEON)) throw new TypeError(`no network in this test: ${url}`);
    const body = JSON.parse(String(init!.body));
    try {
      if (body.queries) {
        const results = await pg.transaction(async (tx) => {
          const out = [];
          for (const q of body.queries) out.push(await run(q, tx));
          return out;
        });
        return Response.json({ results });
      }
      return Response.json(await run(body));
    } catch (e) {
      const err = e as { message: string; code?: string; constraint?: string };
      return Response.json({ message: err.message, code: err.code, constraint: err.constraint }, { status: 400 });
    }
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = "https://www.getowed.xyz";
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.HELIUS_API_KEY;
  delete process.env.X402_FACILITATOR_URL;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from refunds; delete from invoice_term_requests; delete from invoice_terms;
    delete from request_matches; delete from x402_receipts; delete from invoices; delete from requests; delete from signature_nonces; delete from rate_events;`);
  rpcDown = false;
  bySig.clear();
  byRef.clear();
});

// ---- helpers ----
const BASE = "https://www.getowed.xyz";
const DAY = 86_400_000;
const TODAY = isoDay(Date.now());
const at = (date: string, time = "12:00:00") => Date.parse(`${date}T${time}Z`);
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

const invoiceBody = (extra: Record<string, unknown> = {}) => ({
  recipient: ME, token: "USDC", business_name: "Northwind", client_name: "Acme Corp", invoice_number: "INV-7",
  items: [{ description: "Website build", quantity: "1", unit_price: "300.000001" }],
  due_date: addDays(TODAY, 10), source: "plugin", ...extra,
});
async function createInvoice(body: Record<string, unknown>) {
  const res = await createInvoiceRoute(new Request(`${BASE}/api/v1/invoices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Json };
}
async function readInvoice(id: string) {
  const res = await getInvoiceRoute(new Request(`${BASE}/api/v1/invoices/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getInvoiceRoute>[1]);
  assert.equal(res.status, 200);
  return InvoiceTermsResponse.parse(await res.json());
}
async function readRequest(id: string) {
  const res = await getRequestRoute(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getRequestRoute>[1]);
  return GetRequestResponse.parse(await res.json());
}
async function markPaid(id: string, { amount, on, payer = PAYER }: { amount?: bigint; on: number; payer?: string }) {
  const [{ amount_atomic }] = (await pg.query<{ amount_atomic: string }>(`select amount_atomic::text from requests where id = $1`, [id])).rows;
  await pg.query(
    `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = $4, paid_at = to_timestamp($5::double precision / 1000), paid_rail = 'solana_pay' where id = $1`,
    [id, freshSig(), payer, (amount ?? BigInt(amount_atomic)).toString(), on],
  );
}
const termRows = async (invoiceId: string) =>
  (await pg.query<{ role: string; seq: number; state: string; request_id: string | null; skip_reason: string | null; amount_atomic: string; due_date: string; opens_on: string }>(
    `select role, seq, state, request_id, skip_reason, amount_atomic::text, to_char(due_date, 'YYYY-MM-DD') as due_date, to_char(opens_on, 'YYYY-MM-DD') as opens_on
       from invoice_term_requests where invoice_id = $1 order by role, seq`, [invoiceId])).rows;
const count = async (what: string) => Number((await pg.query<{ n: string }>(`select count(*)::text as n from ${what}`)).rows[0]!.n);
const termsShapeErrors = (value: unknown) => {
  const r = check((shapes as unknown as Record<string, Parameters<typeof check>[0]>).invoiceTermsRes, value);
  return [...r.errors];
};

// ---------------------------------------------------------------- 0021 itself

it("0021: refunds, invoice_terms, invoice_term_requests, superseded_by, the loosened cancel check and the pair trigger", async () => {
  const tables = (await pg.query<{ table_name: string }>(`select table_name from information_schema.tables where table_name in ('refunds', 'invoice_terms', 'invoice_term_requests') order by 1`)).rows;
  assert.deepEqual(tables.map((t) => t.table_name), ["invoice_term_requests", "invoice_terms", "refunds"]);
  const trig = (await pg.query<{ tgname: string }>(`select tgname from pg_trigger where tgname = 'requests_term_pair_paid'`)).rows;
  assert.equal(trig.length, 1);
  const ref = key32("0021 ref");
  const id = requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 1_000_000n, reference: ref });
  await pg.query(`insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source) values ($1, $2, 'USDC', $3, 6, 1000000, $4, 'plugin')`, [id, ME, USDC, ref]);
  // superseded_by only together with cancelled_at and no signed message; a signed cancel is unchanged.
  await assert.rejects(pg.query(`update requests set status = 'cancelled', cancelled_at = now(), superseded_by = $1 where id = $1`, [id]), /requests_superseded_check/);
  const ref2 = key32("0021 ref 2");
  const other = requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 2_000_000n, reference: ref2 });
  await pg.query(`insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source) values ($1, $2, 'USDC', $3, 6, 2000000, $4, 'plugin')`, [other, ME, USDC, ref2]);
  await assert.rejects(pg.query(`update requests set superseded_by = $2 where id = $1`, [id, other]), /requests_cancel_check/);
  await assert.rejects(pg.query(`update requests set status = 'cancelled', cancelled_at = now() where id = $1`, [id]), /requests_cancel_check/);
  await assert.rejects(pg.query(`update requests set status = 'cancelled', cancelled_at = now(), superseded_by = $2, cancel_message = 'm', cancel_signature = 's' where id = $1`, [id, other]), /requests_cancel_check/);
  await pg.query(`update requests set status = 'cancelled', cancelled_at = now(), superseded_by = $2 where id = $1`, [id, other]);
  await pg.query(`update requests set status = 'cancelled', cancelled_at = now(), cancel_message = 'Owed cancel', cancel_signature = 'sig' where id = $1`, [other]);
});

// ---------------------------------------------------------------- installments

it("3 monthly installments: the invoice's own request is installment 1; the rest open 7 days before their due dates; paid only when all are", async () => {
  const first = addDays(TODAY, 10);
  const { status, json } = await createInvoice(invoiceBody({ due_date: first, installments: { count: 3, interval: "monthly" }, late_fee: { amount: "5" } }));
  assert.equal(status, 201, JSON.stringify(json));
  const inv = InvoiceTermsResponse.parse(json);
  assert.deepEqual(termsShapeErrors(json), []);
  const id = inv.id;
  assert.equal(inv.total, "300.000001");
  assert.equal(inv.status, "open");
  const plan = inv.terms!.installments!.plan;
  assert.deepEqual(plan.map((p) => [p.seq, p.amount, p.status]), [[1, "100.000001", "open"], [2, "100", "scheduled"], [3, "100", "scheduled"]]);
  const due2 = plan[1]!.due_date;
  const due3 = plan[2]!.due_date;
  assert.equal(plan[0]!.due_date, first);
  assert.equal(plan[0]!.id, id);
  assert.equal(plan[1]!.opens_on, addDays(due2, -7));
  assert.equal(inv.terms!.installments!.interval_label, "monthly");
  assert.deepEqual(inv.terms!.pay_now, { id, link: `${BASE}/i/${id}`, amount: "100.000001", due_date: first, role: "installment", seq: 1 });
  assert.deepEqual(inv.terms!.chase, { days: [3, 7, 14] });
  assert.equal(inv.terms!.late_fee!.amount, "5");
  // The id commits to installment 1's amount, and the request says which installment it is.
  const own = await readRequest(id);
  assert.equal(own.amount, "100.000001");
  assert.equal(requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 100_000_001n, reference: own.reference }), id);
  assert.match(own.for ?? "", /^Invoice INV-7 · 1 of 3$/);
  assert.match(inv.solana_pay_url, /amount=100\.000001/);

  // Today nothing more opens.
  assert.equal((await runDueInvoiceTerms({ now: Date.now() })).opened.length, 0);
  // Installment 1 is paid on its due date: partly paid, and the next one is what's owed once it opens.
  await markPaid(id, { on: at(first, "09:00:00") });
  let parent = await readInvoice(id);
  assert.equal(parent.status, "underpaid");
  assert.equal(parent.terms!.paid_so_far, "100.000001");
  assert.equal(parent.terms!.remaining, "200");
  assert.equal(parent.terms!.pay_now, null); // installment 2 hasn't opened yet
  assert.equal(parent.paid?.amount, "100.000001");
  assert.deepEqual(termsShapeErrors(parent), []);

  // On installment 2's open day exactly one request opens, however often (and however concurrently) the cron runs;
  // the late fee waits: installment 1 was paid on time and the others aren't due yet.
  const opensOn2 = Date.parse(`${plan[1]!.opens_on}T00:07:00Z`);
  const [r1, r2] = await Promise.all([runDueInvoiceTerms({ now: opensOn2 }), runDueInvoiceTerms({ now: opensOn2 })]);
  assert.deepEqual([...r1.opened, ...r2.opened].map((o) => [o.role, o.seq]), [["installment", 2]]);
  assert.deepEqual([...r1.waiting, ...r2.waiting].map((w) => [w.role, w.reason]), [["late_fee", "installments are still coming due"]]);
  const again = await runDueInvoiceTerms({ now: opensOn2 });
  assert.equal(again.opened.length, 0);
  const second = (await termRows(id)).find((t) => t.role === "installment" && t.seq === 2)!;
  assert.equal(second.state, "opened");
  const child = await readInvoice(second.request_id!);
  assert.deepEqual(termsShapeErrors(child), []);
  assert.equal(child.total, "100");
  assert.equal(child.due_date, due2);
  assert.equal(child.invoice_number, "INV-7 2/3");
  assert.equal(child.status, "open");
  assert.deepEqual(child.term_of, { invoice_id: id, link: `${BASE}/i/${id}`, role: "installment", seq: 2, count: 3, label: "Installment 2 of 3" });
  assert.deepEqual(child.items, [{ description: "Installment 2 of 3", quantity: "1", unit_price: "100", amount: "100" }]);
  const childReq = await readRequest(second.request_id!);
  assert.equal(childReq.kind, "invoice");
  assert.equal(requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 100_000_000n, reference: childReq.reference }), childReq.id);

  // Paid only when all three are: still partly paid after two.
  const later = await readInvoice(id);
  assert.equal(later.terms!.pay_now?.id, second.request_id);
  await markPaid(second.request_id!, { on: at(due2, "09:00:00") });
  assert.equal((await readInvoice(id)).status, "underpaid");

  // Installment 3 opens on its own day (the late fee still waits: both paid on time, the last not due yet).
  const r3 = await runDueInvoiceTerms({ now: Date.parse(`${plan[2]!.opens_on}T00:07:00Z`) });
  assert.deepEqual(r3.opened.map((o) => [o.role, o.seq]), [["installment", 3]]);
  const third = (await termRows(id)).find((t) => t.role === "installment" && t.seq === 3)!;
  assert.equal(third.state, "opened");
  assert.equal((await readInvoice(third.request_id!)).due_date, due3);
  await markPaid(third.request_id!, { on: at(due3, "09:00:00") });
  parent = await readInvoice(id);
  assert.equal(parent.status, "paid");
  assert.equal(parent.terms!.paid_so_far, "300.000001");
  assert.equal(parent.terms!.remaining, "0");
  assert.equal(parent.terms!.pay_now, null);
  assert.ok(parent.terms!.installments!.plan.every((p) => p.status === "paid" && p.paid?.on_time));
  assert.deepEqual(termsShapeErrors(parent), []);

  // Paid on time throughout: after the last due date the late fee is skipped, never opened.
  const after = await runDueInvoiceTerms({ now: Date.parse(`${addDays(due3, 1)}T00:07:00Z`) });
  assert.deepEqual(after.skipped.map((s) => [s.role, s.reason]), [["late_fee", "every installment was paid on time"]]);
  assert.equal((await termRows(id)).find((t) => t.role === "late_fee")!.state, "skipped");
});

it("installments every 14 days; the first missed one opens the late fee once (percent of the total, printed at issue)", async () => {
  const first = addDays(TODAY, 3);
  const { json } = await createInvoice(invoiceBody({ due_date: first, installments: { count: 2, interval: 14 }, late_fee: { percent: "1.5" } }));
  const inv = InvoiceTermsResponse.parse(json);
  assert.equal(inv.terms!.installments!.plan[1]!.due_date, addDays(first, 14));
  assert.equal(inv.terms!.late_fee!.amount, "4.500000".replace(/0+$/, ""));
  assert.equal(inv.terms!.late_fee!.percent, "1.5");
  assert.equal(inv.terms!.late_fee!.applies_after, first);
  // The day after installment 1's due date, still unpaid: the fee opens, once.
  const dayAfter = Date.parse(`${addDays(first, 1)}T00:07:00Z`);
  const out = await runDueInvoiceTerms({ now: dayAfter });
  const fee = out.opened.find((o) => o.role === "late_fee");
  assert.ok(fee, JSON.stringify(out));
  const feeInvoice = await readInvoice(fee.request_id);
  assert.equal(feeInvoice.total, "4.5");
  assert.equal(feeInvoice.term_of?.label, "Late fee");
  assert.equal(feeInvoice.invoice_number, "INV-7 late fee");
  assert.match(feeInvoice.items[0]!.description, /^Late fee: invoice INV-7 was not paid by /);
  assert.equal((await runDueInvoiceTerms({ now: dayAfter + DAY })).opened.filter((o) => o.role === "late_fee").length, 0);
  assert.equal(await count(`requests where for_text like '%late fee%'`), 1);
});

it("a cancelled invoice stops its plan: later installments are skipped, not opened", async () => {
  const { json } = await createInvoice(invoiceBody({ installments: { count: 2 } }));
  const inv = InvoiceTermsResponse.parse(json);
  await pg.query(`update requests set status = 'cancelled', cancelled_at = now(), cancel_message = $2, cancel_signature = 'sig' where id = $1`, [inv.id, `Owed cancel ${inv.id} for ${ME} at 2026-10-18T00:00:00Z`]);
  const out = await runDueInvoiceTerms({ now: Date.parse(`${inv.terms!.installments!.plan[1]!.opens_on}T00:07:00Z`) });
  assert.deepEqual(out.skipped.map((s) => [s.role, s.seq, s.reason]), [["installment", 2, "the invoice was cancelled"]]);
  assert.equal((await readInvoice(inv.id)).status, "cancelled");
});

it("installments refuse what can't work: with an early discount, in a local currency, with expires_in_days, a mismatched first_due", async () => {
  const refused = async (extra: Record<string, unknown>, re: RegExp) => {
    const { status, json } = await createInvoice(invoiceBody(extra));
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error!.message, re);
  };
  await refused({ installments: { count: 2 }, early_discount: { percent: "5", until: addDays(TODAY, 2) } }, /not both/);
  await refused({ installments: { count: 2 }, expires_in_days: 30 }, /expires_in_days/);
  await refused({ installments: { count: 2, first_due: addDays(TODAY, 3) } }, /first installment's due date/);
  await refused({ installments: { count: 13 } }, /2 to 12/);
  await refused({ installments: { count: 3, interval: 3 } }, /at least 7 days/);
  await refused({ late_fee: { amount: "1", percent: "2" } }, /exactly one/);
  await refused({ chase: { days: [7, 3] } }, /each later/);
  assert.equal(await count("invoices"), 0);
  assert.equal(await count("rate_events"), 0); // refused before a rate-limit slot is spent
});

// ---------------------------------------------------------------- early-pay discount

it("early price paid through the chain before the date: the full price never opens; the invoice is paid at the early price", async () => {
  const until = addDays(TODAY, 5);
  const { status, json } = await createInvoice(invoiceBody({ items: [{ description: "Logo", unit_price: "100" }], early_discount: { percent: "10", until } }));
  assert.equal(status, 201, JSON.stringify(json));
  const inv = InvoiceTermsResponse.parse(json);
  assert.deepEqual(termsShapeErrors(json), []);
  const d = inv.terms!.early_discount!;
  assert.deepEqual([d.early_price, d.full_price, d.discount, d.percent, d.until, d.early.status, d.full.status, d.full.opens_on],
    ["90", "100", "10", "10", until, "open", "scheduled", addDays(until, 1)]);
  assert.equal(inv.total, "100");
  assert.match(inv.solana_pay_url, /amount=90&/);
  assert.equal(inv.expires_at, undefined);

  // The client pays 90 USDC with the request's reference; the next status read settles it, and the trigger skips the full price.
  usdcTransfer({ from: PAYER, to: ME, amount: 90_000_000n, reference: inv.reference, at: Date.now() - 60_000 });
  const settled = await readRequest(inv.id);
  assert.equal(settled.status, "paid");
  assert.equal(settled.amount, "90");
  assert.equal(settled.paid?.payer, PAYER);
  // The early price's own request stops taking payments at the start of the day after `until`.
  assert.equal(settled.expires_at, `${addDays(until, 1)}T00:00:00Z`);
  const rows = await termRows(inv.id);
  assert.deepEqual(rows.find((t) => t.role === "full_price"), { ...rows.find((t) => t.role === "full_price")!, state: "skipped", skip_reason: "the early price was paid" });
  const out = await runDueInvoiceTerms({ now: Date.parse(`${addDays(until, 1)}T00:07:00Z`) });
  assert.equal(out.opened.length, 0);
  const after = await readInvoice(inv.id);
  assert.equal(after.status, "paid");
  assert.equal(after.terms!.early_discount!.paid_with, "early");
  assert.equal(after.terms!.early_discount!.full.status, "skipped");
  assert.equal(after.paid?.amount, "90");
  assert.deepEqual(termsShapeErrors(after), []);
});

it("no early payment: the full price opens the day after; paying it cancels the early price (and a late early payment cancels the full price)", async () => {
  const until = addDays(TODAY, 2);
  const due = addDays(TODAY, 20);
  const mk = async () => InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ due_date: due, items: [{ description: "Logo", unit_price: "100" }], early_discount: { amount: "15", until } }))).json);
  const a = await mk();
  const b = await mk();
  const dayAfter = Date.parse(`${addDays(until, 1)}T00:07:00Z`);
  const out = await runDueInvoiceTerms({ now: dayAfter });
  assert.equal(out.opened.filter((o) => o.role === "full_price").length, 2);
  const fullOf = async (id: string) => (await termRows(id)).find((t) => t.role === "full_price")!.request_id!;
  const fullA = await readInvoice(await fullOf(a.id));
  assert.equal(fullA.total, "100");
  assert.equal(fullA.due_date, due);
  assert.equal(fullA.invoice_number, "INV-7");
  assert.deepEqual(fullA.items, [{ description: "Logo", quantity: "1", unit_price: "100", amount: "100" }]);
  assert.equal(fullA.term_of?.label, "Full price");

  // A pays the full price: the trigger cancels the early price (it names the payment that superseded it).
  await markPaid(fullA.id, { on: Date.now() });
  const earlyA = await readRequest(a.id);
  assert.equal(earlyA.status, "cancelled");
  assert.equal(earlyA.cancelled, null); // no signed message: Owed's server cancelled it
  assert.deepEqual(check(shapes.getRequestRes, earlyA).errors, []);
  const viewA = await readInvoice(a.id);
  assert.equal(viewA.status, "paid");
  assert.equal(viewA.terms!.early_discount!.paid_with, "full");
  assert.equal(viewA.terms!.early_discount!.early.status, "cancelled");
  assert.equal(viewA.terms!.early_discount!.early.superseded_by, fullA.id);
  assert.equal(viewA.cancelled_at, undefined);
  assert.deepEqual(termsShapeErrors(viewA), []);

  // B: a late payment of the early price (a solana: link someone kept) cancels the full price before anyone pays it.
  const fullB = await fullOf(b.id);
  await markPaid(b.id, { on: Date.now() });
  const fullBReq = await readRequest(fullB);
  assert.equal(fullBReq.status, "cancelled");
  const viewB = await readInvoice(b.id);
  assert.equal(viewB.status, "paid");
  assert.equal(viewB.terms!.early_discount!.paid_with, "early");
  assert.equal(viewB.terms!.early_discount!.full.superseded_by, b.id);
  const fullBView = await readInvoice(fullB);
  assert.equal(fullBView.status, "cancelled");
});

it("the full price waits while Solana can't be read, and opens on the next run", async () => {
  const until = addDays(TODAY, 1);
  const inv = InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ items: [{ description: "Logo", unit_price: "100" }], early_discount: { percent: "5", until } }))).json);
  rpcDown = true;
  const day = Date.parse(`${addDays(until, 1)}T00:07:00Z`);
  const out = await runDueInvoiceTerms({ now: day });
  assert.equal(out.opened.length, 0);
  assert.deepEqual(out.waiting.map((w) => w.role), ["full_price"]);
  assert.equal((await termRows(inv.id)).find((t) => t.role === "full_price")!.state, "scheduled");
  rpcDown = false;
  await new Promise((r) => setTimeout(r, 3100)); // the settle throttle (3 s per request per instance)
  assert.equal((await runDueInvoiceTerms({ now: day })).opened.length, 1);
});

it("a local-currency early price: each price is its own quote at the rate locked at issue", async () => {
  const rate = { rate: "84.123456", rate_source: "Coinbase USD table (test)", quoted_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  const until = addDays(TODAY, 3);
  const { created } = await createInvoiceWithTerms({
    recipient: ME, token: "USDC", businessName: "Northwind", clientName: "Acme", invoiceNumber: "IN-1", notes: null, dueDate: addDays(TODAY, 9),
    items: [{ description: "Translation", quantity: "1", unit_price: "10000" }], source: "plugin", currency: "INR", rate,
  }, { early_discount: { amount: "1000", until } });
  const own = created.request;
  assert.equal(own.fiat?.amount, "9000");
  assert.equal(own.amountAtomic, usdcAtomicFor("9000", "INR", rate.rate));
  assert.equal(created.invoice.totalAtomic, usdcAtomicFor("10000", "INR", rate.rate));
  const view = await readInvoice(own.id);
  assert.equal(view.fiat?.amount, "10000");
  assert.equal(view.terms!.early_discount!.early.fiat_amount, "9000");
  assert.deepEqual(termsShapeErrors(view), []);
  await runDueInvoiceTerms({ now: Date.parse(`${addDays(until, 1)}T00:07:00Z`) });
  const full = await readInvoice((await termRows(own.id)).find((t) => t.role === "full_price")!.request_id!);
  assert.deepEqual([full.fiat?.amount, full.fiat?.rate, full.total], ["10000", rate.rate, view.total]);
});

// ---------------------------------------------------------------- late fee

it("late fee on a plain invoice: opens once the day after the due date if unpaid or paid late; never if paid on time or cancelled", async () => {
  const due = addDays(TODAY, 4);
  const mk = async () => InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ due_date: due, items: [{ description: "Audit", unit_price: "50" }], late_fee: { amount: "2.5" } }))).json);
  const unpaid = await mk();
  const onTime = await mk();
  const late = await mk();
  const cancelled = await mk();
  assert.equal(unpaid.status, "open");
  assert.equal(unpaid.terms!.late_fee!.request.status, "scheduled");
  assert.equal(unpaid.terms!.installments, null);
  assert.match(unpaid.solana_pay_url, /amount=50&/); // the invoice itself is unchanged
  await markPaid(onTime.id, { on: at(due, "23:00:00") });
  await markPaid(late.id, { on: at(addDays(due, 1), "00:01:00") });
  await pg.query(`update requests set status = 'cancelled', cancelled_at = now(), cancel_message = 'Owed cancel x', cancel_signature = 'sig' where id = $1`, [cancelled.id]);

  // The cron on the due date itself opens nothing.
  assert.equal((await runDueInvoiceTerms({ now: Date.parse(`${due}T00:07:00Z`) })).opened.length, 0);
  const res = await cronGET(new Request(`${BASE}/api/cron/schedules`, { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  assert.equal(res.status, 200);
  const out = await runDueInvoiceTerms({ now: Date.parse(`${addDays(due, 1)}T00:07:00Z`) });
  assert.deepEqual(out.opened.map((o) => o.invoice_id).sort(), [late.id, unpaid.id].sort());
  assert.deepEqual(out.skipped.map((s) => [s.invoice_id, s.reason]).sort(), [[cancelled.id, "the invoice was cancelled"], [onTime.id, "the invoice was paid on time"]].sort());
  const fee = await readInvoice(out.opened.find((o) => o.invoice_id === unpaid.id)!.request_id);
  assert.equal(fee.total, "2.5");
  assert.equal(fee.due_date, addDays(due, 1));
  const twice = await runDueInvoiceTerms({ now: Date.parse(`${addDays(due, 2)}T00:07:00Z`) });
  assert.equal(twice.opened.length + twice.skipped.length, 0);
  const view = await readInvoice(unpaid.id);
  assert.equal(view.terms!.late_fee!.request.status, "open");
  assert.equal(view.status, "open"); // the fee is its own request; the invoice is still just unpaid
});

it("the cron route reports invoice terms beside schedules and stays 200 when nothing fails", async () => {
  const res = await cronGET(new Request(`${BASE}/api/cron/schedules`, { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { invoice_terms: { date: string; opened: unknown[]; refunds: unknown } };
  assert.equal(body.invoice_terms.date, TODAY);
  assert.deepEqual(body.invoice_terms.opened, []);
});

// ---------------------------------------------------------------- chase schedule (who_owes_me's ledger)

it("chase: polite, firm and formal reminders on days 3, 7 and 14 after the due date; custom days; off", async () => {
  const due = addDays(TODAY, 1);
  const plain = InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ due_date: due, invoice_number: "A" }))).json);
  const quiet = InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ due_date: due, invoice_number: "B", chase: false }))).json);
  InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ due_date: due, invoice_number: "C", chase: { days: [1, 2] } }))).json);
  assert.equal(plain.terms, undefined); // the default chase needs no terms row
  assert.deepEqual(quiet.terms!.chase, null);
  const ledger = await getLedger(ME, { base: BASE, chainBudgetMs: 500 });
  const tone = async (days: number) => {
    const tagged = await withInvoiceTerms(ledger, { now: Date.parse(`${addDays(due, days)}T09:00:00Z`) });
    return Object.fromEntries(tagged.open.map((e) => [e.invoice_number, e.reminder?.tone ?? null]));
  };
  assert.deepEqual(await tone(0), { A: null, B: null, C: null });
  assert.deepEqual(await tone(1), { A: null, B: null, C: "polite" });
  assert.deepEqual(await tone(3), { A: "polite", B: null, C: "firm" });
  assert.deepEqual(await tone(7), { A: "firm", B: null, C: "firm" });
  assert.deepEqual(await tone(14), { A: "formal", B: null, C: "firm" });
  const tagged = await withInvoiceTerms(ledger, { now: Date.parse(`${addDays(due, 8)}T09:00:00Z`) });
  const byNumber = Object.fromEntries(tagged.open.map((e) => [e.invoice_number, e]));
  assert.deepEqual(byNumber.A!.reminder, { tone: "firm", days_overdue: 8 });
  assert.equal("chase" in byNumber.A!, false);
  assert.equal(byNumber.B!.chase, null);
  assert.deepEqual(byNumber.C!.chase, { days: [1, 2] });
});

// ---------------------------------------------------------------- what the coordinator wires in (ledger route, /r page)
import { withSchedules } from "@/lib/schedules";
import { LedgerResponse } from "@/lib/contract";
import { requestTermsNotes } from "@/lib/invoice-terms-notes";

it("the ledger route's composition: withInvoiceTerms(withSchedules(getLedger)) keeps the contract and adds reminder and chase", async () => {
  const due = addDays(TODAY, -8);
  await pg.query(`insert into requests (id, kind, invoice_id, recipient, token, mint, decimals, amount_atomic, reference, source, created_at)
    values ('Ab3dEf6hJk9m', 'invoice', 'Ab3dEf6hJk9m', $1, 'USDC', $2, 6, 1000000, $3, 'plugin', now() - interval '20 days')`, [ME, USDC, key32("ledger composition ref")]);
  await pg.query(`insert into invoices (id, recipient, token, total_atomic, business_name, client_name, due_date, items, source, created_at)
    values ('Ab3dEf6hJk9m', $1, 'USDC', 1000000, 'Northwind', 'Acme', $2::date, '[{"description":"x","quantity":"1","unit_price_atomic":"1000000","amount_atomic":"1000000"}]', 'plugin', now() - interval '20 days')`, [ME, due]);
  const ledger = await withInvoiceTerms(await withSchedules(await getLedger(ME, { base: BASE, chainBudgetMs: 500 }), { base: BASE }));
  assert.ok(LedgerResponse.safeParse(ledger).success);
  const e = ledger.open.find((x) => x.id === "Ab3dEf6hJk9m")!;
  assert.deepEqual(e.reminder, { tone: "firm", days_overdue: 8 });
  assert.equal("chase" in e, false); // the default days: nothing extra to say
});

it("the /r page notes: a plan's request names its invoice; a superseded price says why it was cancelled", async () => {
  const until = addDays(TODAY, 2);
  const inv = InvoiceTermsResponse.parse((await createInvoice(invoiceBody({ items: [{ description: "Logo", unit_price: "100" }], early_discount: { percent: "10", until } }))).json);
  await runDueInvoiceTerms({ now: Date.parse(`${addDays(until, 1)}T00:07:00Z`) });
  const full = (await termRows(inv.id)).find((t) => t.role === "full_price")!.request_id!;
  assert.deepEqual(await requestTermsNotes(full), [`The full price of invoice ${inv.id}.`]);
  await markPaid(full, { on: Date.now() });
  assert.deepEqual(await requestTermsNotes(inv.id), [`Cancelled by Owed: the other price of this invoice was paid (request ${full}).`]);
  assert.deepEqual(await requestTermsNotes("Zz9zZz9zZz9z"), []);
});
