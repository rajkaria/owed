import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { GET as lookupRoute, POST as refundRoute } from "@/app/api/v1/refunds/route";
import { GET as getRefundRoute } from "@/app/api/v1/refunds/[id]/route";
import { POST as createInvoiceRoute } from "@/app/api/v1/invoices/route";
import { GET as getInvoiceRoute } from "@/app/api/v1/invoices/[id]/route";
import { CreateRefundResponse, InvoiceTermsResponse, RefundResponse, RefundsLookupResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { confirmPendingRefunds, refundedText, refundIdFor, refundPrefix, refundSummaries } from "@/lib/refunds";
import { getRequest } from "@/lib/requests";
import { isoSeconds } from "@/lib/verify-signature";
import { check, shapes } from "../../contract/shapes.mjs";

// F8 refunds on real Postgres (every migration through 0021 on PGlite, answering lib/db.ts's Neon-over-HTTP calls) and
// the refund routes as Vercel runs them. Signatures are real ed25519 from throwaway keys (fixed seeds, they hold
// nothing), made the way PayBox's request_wallet_sign makes them. The chain double knows only the transfers a test
// constructs, in the jsonParsed shape mainnet returns (test/pairing.test.ts builds them the same way).

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
const KEY = keyFrom("owed test signer: refunds-db.test.ts");
const ME = bs58.encode(KEY.publicKey);
const MALLORY_KEY = keyFrom("owed test signer: refunds-db.test.ts, someone else");
const MALLORY = bs58.encode(MALLORY_KEY.publicKey);
const PAYER = bs58.encode(keyFrom("owed test signer: refunds-db.test.ts, the payer").publicKey);
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");
const key32 = (label: string) => bs58.encode(createHash("sha256").update(label).digest());
let counter = 0;
const freshSig = () => bs58.encode(Buffer.concat([createHash("sha256").update(`r sig a ${counter}`).digest(), createHash("sha256").update(`r sig b ${counter++}`).digest()]));

// ---- the chain double ----
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const bySig = new Map<string, unknown>();
const byRef = new Map<string, Array<{ signature: string; err: null; slot: number; blockTime: number }>>();
let rpcDown = false;

/** A confirmed USDC transferChecked `from` -> `to` carrying `reference`, as the plugin's refund proposal builds it. */
function usdcTransfer({ from, to, amount, reference, at = Date.now() - 30_000 }: { from: string; to: string; amount: bigint; reference: string; at?: number }) {
  const sig = freshSig();
  const fromAta = key32(`ata ${from}`);
  const toAta = key32(`ata ${to}`);
  const keys = [from, fromAta, toAta, USDC, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", reference];
  const slot = 310_000_000 + counter;
  bySig.set(sig, {
    slot, blockTime: Math.floor(at / 1000),
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), innerInstructions: [],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: from, uiTokenAmount: { amount: String(amount + 9_000_000n) } },
        { accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: "1000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: from, uiTokenAmount: { amount: "9000000" } },
        { accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: String(amount + 1_000_000n) } },
      ],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i <= 2 })),
        instructions: [
          { program: "spl-memo", parsed: "owed-refund:x" },
          { program: "spl-token", parsed: { type: "transferChecked", info: { source: fromAta, mint: USDC, destination: toAta, multisigAuthority: from, signers: [reference], tokenAmount: { amount: String(amount), decimals: 6 } } } },
        ],
      },
    },
  });
  byRef.set(reference, [...(byRef.get(reference) ?? []), { signature: sig, err: null, slot, blockTime: Math.floor(at / 1000) }]);
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
  delete process.env.HELIUS_API_KEY;
  delete process.env.X402_FACILITATOR_URL;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});
beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from refunds; delete from invoice_term_requests; delete from invoice_terms; delete from request_matches;
    delete from x402_receipts; delete from invoices; delete from requests; delete from signature_nonces; delete from rate_events;`);
  rpcDown = false;
  bySig.clear();
  byRef.clear();
});

// ---- helpers ----
const BASE = "https://www.getowed.xyz";
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

/** A request already paid by PAYER (as the settle path writes it). */
async function paidRequest({ amount = 1_000_000n, paid = amount, token = "USDC", rail = "solana_pay", status = "paid" }: { amount?: bigint; paid?: bigint; token?: "USDC" | "SOL"; rail?: string; status?: string } = {}) {
  const reference = key32(`refunds-db reference ${counter++}`);
  const id = requestIdFor({ recipient: ME, token, amountAtomic: amount, reference });
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, status, paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, for_text)
     values ($1, $2, $3, $4, $5, $6, $7, 'plugin', $8, $9, $10, $11, now() - interval '1 hour', $12, 'dinner')`,
    [id, ME, token, token === "USDC" ? USDC : null, token === "USDC" ? 6 : 9, amount.toString(), reference, status, freshSig(), PAYER, paid.toString(), rail],
  );
  return id;
}
const message = (amount: string, id: string, { token = "USDC", payer = PAYER, recipient = ME, at = Date.now() } = {}) =>
  `${refundPrefix(amount, token as "USDC", id, payer, recipient)} at ${isoSeconds(at)}`;
const body = (id: string, amount: string, opts: { key?: typeof KEY; msg?: string; recipient?: string; token?: string } = {}) => {
  const msg = opts.msg ?? message(amount, id, { token: opts.token });
  return { request: id, recipient: opts.recipient ?? ME, amount, signed_message: msg, signature: signHex(msg, opts.key) };
};
async function refund(b: unknown) {
  const res = await refundRoute(new Request(`${BASE}/api/v1/refunds`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  return { status: res.status, json: (await res.json()) as Json };
}
async function lookup(ids: string[]) {
  const res = await lookupRoute(new Request(`${BASE}/api/v1/refunds?requests=${ids.join(",")}`));
  return { status: res.status, json: (await res.json()) as Json };
}
async function readRefund(id: string) {
  const res = await getRefundRoute(new Request(`${BASE}/api/v1/refunds/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getRefundRoute>[1]);
  return { status: res.status, json: (await res.json()) as Json };
}
const shapeErrors = (shape: string, value: unknown) => {
  const r = check((shapes as unknown as Record<string, Parameters<typeof check>[0]>)[shape], value);
  return [...r.errors];
};

// ---------------------------------------------------------------- creating refunds

it("a partial refund: pending, a fresh reference linked to the request, and what is left to refund", async () => {
  const id = await paidRequest();
  const b = body(id, "0.4");
  assert.deepEqual(shapeErrors("createRefundReq", b), []);
  const { status, json } = await refund(b);
  assert.equal(status, 201, JSON.stringify(json));
  const r = CreateRefundResponse.parse(json);
  assert.deepEqual(shapeErrors("createRefundRes", json), []);
  assert.equal(r.status, "pending");
  assert.equal(r.request_id, id);
  assert.equal(r.recipient, ME);
  assert.equal(r.payer, PAYER);
  assert.equal(r.amount, "0.4");
  assert.equal(r.memo, `owed-refund:${r.id}`);
  assert.equal(r.request_link, `${BASE}/r/${id}`);
  assert.equal(r.confirmed, null);
  assert.deepEqual([r.paid, r.refunded, r.pending, r.refundable], ["1", "0", "0.4", "0.6"]);
  assert.equal(refundIdFor({ requestId: id, payer: PAYER, token: "USDC", amountAtomic: 400_000n, reference: r.reference }), r.id);
  // The reference is new: no request uses it, and the stored row keeps the signed message as proof.
  assert.equal((await pg.query(`select 1 from requests where reference = $1`, [r.reference])).rows.length, 0);
  assert.equal(r.signed_message, b.signed_message);
});

it("refunds never add up to more than was paid: over the rest is refused before the signature is spent", async () => {
  const id = await paidRequest();
  assert.equal((await refund(body(id, "0.4"))).status, 201);
  const over = body(id, "0.7");
  const tooMuch = await refund(over);
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.error!.message, /0\.4 USDC is waiting to land, so at most 0\.6 USDC can be refunded now/);
  // The refusal came before the signature was spent: only the first refund's message is used.
  assert.equal((await pg.query(`select 1 from signature_nonces where purpose = 'refund'`)).rows.length, 1);
  const rest = await refund(body(id, "0.6"));
  assert.equal(rest.status, 201, JSON.stringify(rest.json));
  assert.deepEqual([rest.json.refunded, rest.json.pending, rest.json.refundable], ["0", "1", "0"]);
  const more = await refund(body(id, "0.000001"));
  assert.equal(more.status, 400);
  assert.match(more.json.error!.message, /at most 0 USDC/);
  const first = await refund(body(await paidRequest(), "1.000001"));
  assert.match(first.json.error!.message, /a refund can't be more than was paid \(1 USDC\)/);
});

it("a full refund in one go, and an overpaid request refunds the difference", async () => {
  const id = await paidRequest();
  const full = await refund(body(id, "1"));
  assert.equal(full.status, 201);
  assert.equal(full.json.refundable, "0");
  const over = await paidRequest({ amount: 1_000_000n, paid: 1_500_000n });
  const diff = await refund(body(over, "0.5"));
  assert.equal(diff.status, 201, JSON.stringify(diff.json));
  assert.deepEqual([diff.json.paid, diff.json.refundable], ["1.5", "1"]);
});

it("refused: another wallet's request, a signature from someone else, wrong wording, a replay, unpaid, card and matched payments", async () => {
  const id = await paidRequest();
  const notMine = await refund(body(id, "0.1", { recipient: MALLORY, key: MALLORY_KEY, msg: message("0.1", id, { recipient: MALLORY }) }));
  assert.match(notMine.json.error!.message, /only the wallet this request pays can refund it/);
  const forged = await refund(body(id, "0.1", { key: MALLORY_KEY }));
  assert.match(forged.json.error!.message, /signature doesn't match/);
  const wrongPayer = await refund(body(id, "0.1", { msg: message("0.1", id, { payer: MALLORY }) }));
  assert.match(wrongPayer.json.error!.message, /must read "Owed refund 0\.1 USDC of/);
  const notCanonical = await refund(body(id, "0.10", { msg: message("0.10", id) }));
  assert.match(notCanonical.json.error!.message, /must read "Owed refund 0\.1 USDC/);
  const ok = body(id, "0.1");
  assert.equal((await refund(ok)).status, 201);
  const replay = await refund(ok);
  assert.match(replay.json.error!.message, /already used/);
  const stale = await refund(body(id, "0.1", { msg: message("0.1", id, { at: Date.now() - 6 * 60_000 }) }));
  assert.match(stale.json.error!.message, /more than 5 minutes old/);

  const unpaid = await paidRequest({ status: "open" });
  await pg.query(`update requests set paid_signature = null, paid_payer = null, paid_amount_atomic = null, paid_at = null, paid_rail = null where id = $1`, [unpaid]);
  assert.match((await refund(body(unpaid, "0.1"))).json.error!.message, /isn't paid \(it is open\)/);
  const card = await paidRequest({ rail: "moonpay_card" });
  assert.match((await refund(body(card, "0.1"))).json.error!.message, /MoonPay/);
  const matched = await paidRequest({ rail: "matched" });
  assert.match((await refund(body(matched, "0.1"))).json.error!.message, /matched by you/);
  const missing = await refund(body("Ab3dEf6hJk9m", "0.1"));
  assert.equal(missing.status, 404);
  const zero = await refund(body(id, "0"));
  assert.equal(zero.status, 400);
});

it("a SOL refund names SOL and lamports precision", async () => {
  const id = await paidRequest({ token: "SOL", amount: 50_000_000n });
  const r = await refund(body(id, "0.025", { token: "SOL" }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.token, "SOL");
  assert.equal(r.json.refundable, "0.025");
});

// ---------------------------------------------------------------- confirming on chain

it("confirmed only when the chain shows the refunding wallet's transfer carrying the reference", async () => {
  const id = await paidRequest();
  const created = CreateRefundResponse.parse((await refund(body(id, "0.4"))).json);
  // Nothing on chain yet: still pending.
  let got = RefundResponse.parse((await readRefund(created.id)).json);
  assert.equal(got.status, "pending");
  // Someone else's transfer with the (public) reference doesn't count.
  usdcTransfer({ from: MALLORY, to: PAYER, amount: 400_000n, reference: created.reference });
  await new Promise((r) => setTimeout(r, 3100)); // findPayments runs per call; no throttle here, but keep reads apart
  got = RefundResponse.parse((await readRefund(created.id)).json);
  assert.equal(got.status, "pending");
  // The recipient's own transfer of the refund lands: confirmed, with the transaction.
  byRef.clear();
  const sig = usdcTransfer({ from: ME, to: PAYER, amount: 400_000n, reference: created.reference });
  const res = await readRefund(created.id);
  assert.equal(res.status, 200);
  got = RefundResponse.parse(res.json);
  assert.equal(got.status, "confirmed");
  assert.equal(got.confirmed?.signature, sig);
  assert.equal(got.confirmed?.amount, "0.4");
  assert.deepEqual(shapeErrors("refundRes", res.json), []);
  // The lookup says refunded 0.4 of 1; the summary text reads "refunded 0.4 USDC".
  const { status, json } = await lookup([id, "Ab3dEf6hJk9m"]);
  assert.equal(status, 200);
  const l = RefundsLookupResponse.parse(json);
  assert.deepEqual(shapeErrors("refundsLookupRes", json), []);
  assert.deepEqual(l.not_found, ["Ab3dEf6hJk9m"]);
  assert.deepEqual([l.requests[0]!.paid, l.requests[0]!.refunded, l.requests[0]!.pending, l.requests[0]!.refundable], ["1", "0.4", "0", "0.6"]);
  const row = (await getRequest(id))!;
  const { summaries } = await refundSummaries([row], null);
  assert.equal(refundedText(summaries[0]!), "refunded 0.4 USDC");
  // The request itself stays paid: a refund is money going back, not an unpaid request.
  assert.equal(row.status, "paid");
});

it("one transfer confirms one refund; the cron re-reads pending refunds; a pending one lapses after 30 minutes", async () => {
  const id = await paidRequest();
  const a = CreateRefundResponse.parse((await refund(body(id, "0.3"))).json);
  const b = CreateRefundResponse.parse((await refund(body(id, "0.3", { msg: message("0.3", id, { at: Date.now() - 1000 }) }))).json);
  usdcTransfer({ from: ME, to: PAYER, amount: 300_000n, reference: a.reference });
  const out = await confirmPendingRefunds({ deadline: Date.now() + 2000 });
  assert.deepEqual(out.confirmed, [a.id]);
  assert.equal(out.checked, 2);
  // b never landed: after 30 minutes it stops holding back its 0.3, so 0.7 can be refunded again.
  await pg.query(`update refunds set created_at = now() - interval '31 minutes' where id = $1`, [b.id]);
  const lapsed = RefundResponse.parse((await readRefund(b.id)).json);
  assert.equal(lapsed.status, "lapsed");
  const again = await refund(body(id, "0.7"));
  assert.equal(again.status, 201, JSON.stringify(again.json));
  // Full in the end: 0.3 + 0.7 confirmed reads "in full".
  usdcTransfer({ from: ME, to: PAYER, amount: 700_000n, reference: (again.json as { reference: string }).reference });
  await confirmPendingRefunds({ deadline: Date.now() + 2000 });
  const { summaries } = await refundSummaries([(await getRequest(id))!], null);
  assert.equal(refundedText(summaries[0]!), "refunded 1 USDC in full");
});

it("a pending refund stays pending while Solana can't be read; reads still answer", async () => {
  const id = await paidRequest();
  const a = CreateRefundResponse.parse((await refund(body(id, "0.2"))).json);
  rpcDown = true;
  const got = await readRefund(a.id);
  assert.equal(got.status, 200);
  assert.equal(RefundResponse.parse(got.json).status, "pending");
  const l = RefundsLookupResponse.parse((await lookup([id])).json);
  assert.equal(l.chain_checked, false);
});

// ---------------------------------------------------------------- the invoice shows it

it("an invoice page's data shows refunds: refunded <amount> and each refund", async () => {
  const res = await createInvoiceRoute(new Request(`${BASE}/api/v1/invoices`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: ME, business_name: "Northwind", client_name: "Acme", items: [{ description: "Logo", unit_price: "2" }], due_date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), source: "plugin" }),
  }));
  const inv = (await res.json()) as { id: string };
  await pg.query(`update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = 2000000, paid_at = now(), paid_rail = 'solana_pay' where id = $1`, [inv.id, freshSig(), PAYER]);
  const r = CreateRefundResponse.parse((await refund(body(inv.id, "0.5"))).json);
  usdcTransfer({ from: ME, to: PAYER, amount: 500_000n, reference: r.reference });
  const got = await getInvoiceRoute(new Request(`${BASE}/api/v1/invoices/${inv.id}`), { params: Promise.resolve({ id: inv.id }) } as Parameters<typeof getInvoiceRoute>[1]);
  const view = InvoiceTermsResponse.parse(await got.json());
  assert.equal(view.status, "paid");
  assert.equal(view.refunded, "0.5");
  assert.equal(view.refunds?.[0]?.status, "confirmed");
  assert.equal(view.terms, undefined);
});

it("one transfer that names two refunds' references confirms only one of them", async () => {
  const id = await paidRequest();
  const a = CreateRefundResponse.parse((await refund(body(id, "0.3"))).json);
  const b = CreateRefundResponse.parse((await refund(body(id, "0.3", { msg: message("0.3", id, { at: Date.now() - 1000 }) }))).json);
  const sig = usdcTransfer({ from: ME, to: PAYER, amount: 300_000n, reference: a.reference });
  // The same transaction also carries b's reference (someone listed both on one transfer).
  byRef.set(b.reference, [...(byRef.get(a.reference) ?? [])]);
  const tx = bySig.get(sig) as { transaction: { message: { accountKeys: Array<{ pubkey: string }>; instructions: Array<{ parsed: { info?: { signers?: string[] } } }> } } };
  tx.transaction.message.accountKeys.push({ pubkey: b.reference });
  tx.transaction.message.instructions[1]!.parsed.info!.signers!.push(b.reference);
  const out = await confirmPendingRefunds({ deadline: Date.now() + 2000 });
  assert.equal(out.confirmed.length, 1);
  const rows = (await pg.query<{ status: string }>(`select status from refunds where request_id = $1 order by status`, [id])).rows;
  assert.deepEqual(rows.map((r) => r.status), ["confirmed", "pending"]);
});

import { requestTermsNotes } from "@/lib/invoice-terms-notes";

it("the /r page note: refunded <amount> once a refund is confirmed (in full when all of it went back)", async () => {
  const id = await paidRequest();
  assert.deepEqual(await requestTermsNotes(id), []);
  const r = CreateRefundResponse.parse((await refund(body(id, "1"))).json);
  assert.deepEqual(await requestTermsNotes(id), []); // pending: nothing yet
  usdcTransfer({ from: ME, to: PAYER, amount: 1_000_000n, reference: r.reference });
  await confirmPendingRefunds({ deadline: Date.now() + 2000 });
  assert.deepEqual(await requestTermsNotes(id), ["Refunded 1 USDC in full to the payer, confirmed on Solana."]);
});
