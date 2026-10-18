import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { GET as statementRoute } from "@/app/api/v1/statements/route";
import { GET as csvRoute } from "@/app/api/v1/statements/csv/route";
import { StatementResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { buildStatement, checkStatementLink, parseClient, statementLinks } from "@/lib/statements";
import { isoSeconds, ledgerPrefix } from "@/lib/verify-signature";
import { check, shapes } from "../../contract/shapes.mjs";

// F8 monthly statements on real Postgres (every migration through 0021 on PGlite answering lib/db.ts's Neon calls):
// invoices to one wallet for one client, their payments, cancellations and refunds, folded into the month's lines and
// the balance before and after. Signatures are real ed25519 from a throwaway key (fixed seed, holds nothing).

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
const KEY = keyFrom("owed test signer: statements-db.test.ts");
const ME = bs58.encode(KEY.publicKey);
const CLIENT_WALLET = bs58.encode(keyFrom("owed test signer: statements-db.test.ts, the client").publicKey);
const signHex = (text: string) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), KEY.secretKey)).toString("hex");
const key32 = (label: string) => bs58.encode(createHash("sha256").update(label).digest());
let counter = 0;
const freshSig = () => bs58.encode(Buffer.concat([createHash("sha256").update(`s sig a ${counter}`).digest(), createHash("sha256").update(`s sig b ${counter++}`).digest()]));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const RPC_HOSTS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (RPC_HOSTS.some((h) => url.startsWith(h))) {
      const body = JSON.parse(String(init!.body));
      const answer = (m: { id: number; method: string }) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "getSignaturesForAddress" ? [] : null });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { headers: { "content-type": "application/json" } });
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
  process.env.CSV_LINK_SECRET = "statements-db test secret, 32 characters at least";
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});
beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from refunds; delete from invoice_term_requests; delete from invoice_terms; delete from request_matches;
    delete from invoices; delete from requests; delete from signature_nonces; delete from rate_events;`);
});

const BASE = "https://www.getowed.xyz";

/** An invoice row and its request, made at `created` (ISO), for `client`, optionally paid at `paidAt`. */
async function invoice({ client = "Acme Corp", amount, created, due, number, paidAt, payerWallet, cancelledAt }: {
  client?: string; amount: bigint; created: string; due: string; number: string; paidAt?: string; payerWallet?: string; cancelledAt?: string;
}) {
  const reference = key32(`statements reference ${counter++}`);
  const id = requestIdFor({ recipient: ME, token: "USDC", amountAtomic: amount, reference });
  await pg.query(
    `insert into requests (id, kind, invoice_id, recipient, token, mint, decimals, amount_atomic, reference, source, created_at, payer_name, for_text,
       status, paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, payer_wallet, cancelled_at, cancel_message, cancel_signature)
     values ($1, 'invoice', $1, $2, 'USDC', $3, 6, $4, $5, 'plugin', $6::timestamptz, $7, $8,
       $9, $10, $11, $12, $13::timestamptz, $14, $15, $16::timestamptz, $17, $18)`,
    [id, ME, USDC, amount.toString(), reference, created, client, `Invoice ${number}`,
      paidAt ? "paid" : cancelledAt ? "cancelled" : "open", paidAt ? freshSig() : null, paidAt ? CLIENT_WALLET : null, paidAt ? amount.toString() : null,
      paidAt ?? null, paidAt ? "solana_pay" : null, payerWallet ?? null, cancelledAt ?? null, cancelledAt ? `Owed cancel ${id} for ${ME} at ${cancelledAt}` : null, cancelledAt ? "sig" : null],
  );
  await pg.query(
    `insert into invoices (id, recipient, token, total_atomic, business_name, client_name, invoice_number, due_date, items, source, created_at)
     values ($1, $2, 'USDC', $3, 'Northwind', $4, $5, $6::date, $7::jsonb, 'plugin', $8::timestamptz)`,
    [id, ME, amount.toString(), client, number, due, JSON.stringify([{ description: "Work", quantity: "1", unit_price_atomic: amount.toString(), amount_atomic: amount.toString() }]), created],
  );
  return id;
}
async function refundConfirmed(requestId: string, amount: bigint, at: string) {
  const reference = key32(`statements refund ${counter++}`);
  await pg.query(
    `insert into refunds (id, request_id, recipient, payer, token, amount_atomic, reference, signed_message, signature, status,
       confirmed_signature, confirmed_amount_atomic, confirmed_at, confirmed_slot, created_at)
     values ($1, $2, $3, $4, 'USDC', $5, $6, 'Owed refund', 'sig', 'confirmed', $7, $5, $8::timestamptz, 1, $8::timestamptz)`,
    [key32(`refund id ${counter}`).slice(-12), requestId, ME, CLIENT_WALLET, amount.toString(), reference, freshSig(), at],
  );
}
const signed = (at = Date.now()) => {
  const message = `${ledgerPrefix(ME)} at ${isoSeconds(at)}`;
  return { message, signature: signHex(message) };
};
async function getStatement(params: Record<string, string>) {
  const res = await statementRoute(new Request(`${BASE}/api/v1/statements?${new URLSearchParams(params)}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { message: string } } };
}

async function seed() {
  const a = await invoice({ amount: 100_000_000n, created: "2026-10-20T10:00:00Z", due: "2026-11-01", number: "INV-1", paidAt: "2026-11-03T09:00:00Z" });
  const b = await invoice({ amount: 50_000_000n, created: "2026-11-02T10:00:00Z", due: "2026-11-30", number: "INV-2" });
  const c = await invoice({ amount: 20_000_000n, created: "2026-11-04T10:00:00Z", due: "2026-11-30", number: "INV-3", cancelledAt: "2026-11-05T10:00:00Z" });
  await invoice({ client: "Someone Else", amount: 7_000_000n, created: "2026-11-02T10:00:00Z", due: "2026-11-30", number: "X-1" });
  const d = await invoice({ amount: 30_000_000n, created: "2026-12-01T10:00:00Z", due: "2026-12-20", number: "INV-4" });
  await refundConfirmed(a, 10_000_000n, "2026-11-06T12:00:00Z");
  return { a, b, c, d };
}

it("a client's November: opening balance, invoiced, paid, cancelled, refunded, closing; other clients and other months left out", async () => {
  const { a, b, c, d } = await seed();
  const { message, signature } = signed();
  const { status, json } = await getStatement({ recipient: ME, client: "acme corp", month: "2026-11", signed_message: message, signature });
  assert.equal(status, 200, JSON.stringify(json));
  const s = StatementResponse.parse(json);
  assert.deepEqual(check((shapes as unknown as Record<string, Parameters<typeof check>[0]>).statementRes, json).errors, []);
  assert.equal(s.client, "acme corp");
  assert.deepEqual([s.from, s.to], ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"]);
  assert.deepEqual(s.lines.map((l) => [l.kind, l.invoice_number, l.amount]), [
    ["invoiced", "INV-2", "50"], ["paid", "INV-1", "100"], ["invoiced", "INV-3", "20"], ["cancelled", "INV-3", "20"], ["refunded", "INV-1", "10"],
  ]);
  assert.deepEqual(s.totals, [{ token: "USDC", opening: "100", invoiced: "70", cancelled: "20", paid: "100", refunded: "10", closing: "60" }]);
  assert.deepEqual(s.invoices.map((i) => i.id).sort(), [a, b, c].sort());
  assert.ok(!s.invoices.some((i) => i.id === d));
  assert.match(s.caution, /^Anyone can create a request that pays your wallet/);
  assert.ok(s.csv && s.page);
  assert.match(s.page!.url, /^https:\/\/www\.getowed\.xyz\/i\/statement\?/);

  // The CSV link: the same lines and totals, private headers, 10 minutes, nothing else.
  const csv = await csvRoute(new Request(s.csv!.url));
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("cache-control"), "no-store, private");
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // a BOM, so spreadsheets read UTF-8
  const text = new TextDecoder().decode(bytes);
  const rows = text.trim().split("\r\n");
  assert.match(rows[0]!, /Anyone can create a request/);
  assert.equal(rows[2], `"at","kind","request_id","invoice_id","invoice_number (unverified)","description","token","amount","balance_effect","solscan_url","link"`);
  assert.equal(rows.length, 3 + 5 + 2);
  assert.match(rows[rows.length - 1]!, /^"USDC","100","70","20","100","10","60"$/);
  const tampered = new URL(s.csv!.url);
  tampered.searchParams.set("client", "someone else");
  assert.equal((await csvRoute(new Request(tampered))).status, 403);
  const link = statementLinks(ME, "acme corp", "2026-11", BASE, Date.now() - 11 * 60_000);
  assert.equal(checkStatementLink(new URL(link.csv!.url).searchParams).ok, false);
});

it("a client by wallet: invoices addressed to it or paid from it", async () => {
  const addressed = await invoice({ client: "Whoever", amount: 5_000_000n, created: "2026-11-10T00:00:00Z", due: "2026-11-20", number: "W-1", payerWallet: CLIENT_WALLET });
  const paidFrom = await invoice({ client: "Other name", amount: 6_000_000n, created: "2026-11-11T00:00:00Z", due: "2026-11-20", number: "W-2", paidAt: "2026-11-12T00:00:00Z" });
  await invoice({ client: "Stranger", amount: 1_000_000n, created: "2026-11-11T00:00:00Z", due: "2026-11-20", number: "W-3" });
  const s = await buildStatement(ME, parseClient(CLIENT_WALLET), "2026-11", { base: BASE, chainBudgetMs: null });
  assert.deepEqual(s.invoices.map((i) => i.id).sort(), [addressed, paidFrom].sort());
  assert.deepEqual(s.totals[0], { token: "USDC", opening: "0", invoiced: "11", cancelled: "0", paid: "6", refunded: "0", closing: "5" });
});

it("needs the recipient's fresh ledger signature, once; a bad month or client is a 400", async () => {
  await seed();
  const { message, signature } = signed();
  const ok = await getStatement({ recipient: ME, client: "Acme Corp", month: "2026-11", signed_message: message, signature });
  assert.equal(ok.status, 200);
  const replay = await getStatement({ recipient: ME, client: "Acme Corp", month: "2026-11", signed_message: message, signature });
  assert.match(replay.json.error!.message, /already used/);
  const wrong = await getStatement({ recipient: ME, client: "Acme Corp", month: "2026-11", signed_message: `Owed cancel x at ${isoSeconds(Date.now())}`, signature });
  assert.equal(wrong.status, 400);
  const fresh = signed(Date.now() - 1000);
  assert.match((await getStatement({ recipient: ME, client: "Acme Corp", month: "2026-13", signed_message: fresh.message, signature: fresh.signature })).json.error!.message, /YYYY-MM/);
  assert.match((await getStatement({ recipient: ME, client: "", month: "2026-11", signed_message: fresh.message, signature: fresh.signature })).json.error!.message, /client is required/);
});

it("a negative balance is a credit: a cancelled invoice that was paid anyway", async () => {
  await invoice({ amount: 9_000_000n, created: "2026-11-01T00:00:00Z", due: "2026-11-09", number: "Z-1", cancelledAt: "2026-11-02T00:00:00Z" });
  await pg.query(`update requests set status = 'paid', paid_signature = $1, paid_payer = $2, paid_amount_atomic = 9000000, paid_at = '2026-11-03T00:00:00Z', paid_rail = 'solana_pay'`, [freshSig(), CLIENT_WALLET]);
  const s = await buildStatement(ME, parseClient("Acme Corp"), "2026-11", { base: BASE, chainBudgetMs: null });
  assert.equal(s.totals[0]!.closing, "-9");
  assert.deepEqual(check((shapes as unknown as Record<string, Parameters<typeof check>[0]>).statementRes, { ...s, csv: null, page: null }).errors, []);
});
