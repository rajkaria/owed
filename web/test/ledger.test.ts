import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST } from "@/app/api/v1/ledger/route";
import { LedgerResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { createGroup } from "@/lib/groups";
import { createInvoice } from "@/lib/invoices";
import { getLedger, LEDGER_MAX_ROWS } from "@/lib/ledger";
import { parseJsonExact } from "@/lib/solana";
import { isoSeconds, ledgerPrefix, spendOnce, checkSignedMessage, SIGNATURES_PER_HOUR } from "@/lib/verify-signature";

// POST /api/v1/ledger, lib/ledger.ts and lib/verify-signature.ts's single-use table on real Postgres:
// PGlite (Postgres compiled to WASM) answers lib/db.ts's Neon-over-HTTP calls, after every migration in
// db/migrations/ is applied in order. Chain reads replay W1-B's recorded mainnet responses. Skips until
// the devDependency @electric-sql/pglite is installed (W2-B asked LEAD for 0.5.8, pinned).

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
const WEB = new URL("../", import.meta.url);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

// ---- recorded mainnet RPC (W1-B, publicnode, 2026-10-17) ----
interface RecordedCall { method: string; params: unknown[]; result: unknown }
const recording = (name: string) =>
  (parseJsonExact(readFileSync(new URL(`fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RecordedCall[] }).calls;
const SOL_PAY = recording("sol-reference-payment");
const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
// Real mainnet signatures, used as paid_signature on rows (one transaction settles at most one row).
const PAID_SIGS = [
  "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
  "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK",
  "3ZdwwA4rYiiXodsuZ7374PEahd9iXeiq1VSvVXz17acEcpv1XhV45hu2gPZCXgun4gbm3Sh7vS72NS59rzTsmD2a",
];
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** References no transaction has used: mainnet answers getSignaturesForAddress with []. */
const unusedRefs = new Set<string>();
let rpcDown = false;
let rpcCalls = 0;

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const RPC_HOSTS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

function answerRpc(m: { id: number; method: string; params: unknown[] }) {
  const hit = SOL_PAY.find((c) => c.method === m.method && String(c.params[0]) === String(m.params[0]));
  if (hit) return { jsonrpc: "2.0", id: m.id, result: hit.result };
  if (m.method === "getSignaturesForAddress" && unusedRefs.has(String(m.params[0]))) return { jsonrpc: "2.0", id: m.id, result: [] };
  return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `unrecorded call ${m.method} ${String(m.params[0])}` } };
}
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));

before(async () => {
  if (!mod) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (RPC_HOSTS.some((h) => url.startsWith(h))) {
      rpcCalls++;
      if (rpcDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init!.body));
      return new Response(toJson(Array.isArray(body) ? body.map(answerRpc) : answerRpc(body)), { headers: { "content-type": "application/json" } });
    }
    if (!url.startsWith(NEON)) return realFetch(input, init);
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
  delete process.env.HELIUS_API_KEY;
  process.env.OWED_BASE_URL = "https://www.getowed.xyz";
  const dir = new URL("db/migrations/", WEB);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await pg.exec("delete from invoices; delete from requests; delete from groups; delete from signature_nonces;");
  unusedRefs.clear();
  rpcDown = false;
  rpcCalls = 0;
});

// A throwaway signer (fixed seed); it holds nothing. PayBox signs the same way and returns hex.
const KEY = nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update("owed test signer: ledger.test.ts").digest()));
const ME = bs58.encode(KEY.publicKey);
const OTHER = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const signHex = (text: string) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), KEY.secretKey)).toString("hex");
const ledgerMessage = (at = Date.now()) => `${ledgerPrefix(ME)} at ${isoSeconds(at)}`;

let refCounter = 0;
function freshReference(): string {
  const ref = bs58.encode(createHash("sha256").update(`ledger.test reference ${refCounter++}`).digest());
  unusedRefs.add(ref);
  return ref;
}

interface RowSpec {
  recipient?: string;
  token?: "USDC" | "SOL";
  amountAtomic: bigint;
  reference?: string;
  status?: "open" | "paid" | "underpaid" | "cancelled";
  paidAtomic?: bigint;
  paidSig?: string;
  paidAt?: string;
  createdAt?: string;
  payerName?: string | null;
  forText?: string | null;
}
async function insert(spec: RowSpec): Promise<string> {
  const recipient = spec.recipient ?? ME;
  const token = spec.token ?? "USDC";
  const reference = spec.reference ?? freshReference();
  const id = requestIdFor({ recipient, token, amountAtomic: spec.amountAtomic, reference });
  const paid = spec.status === "paid" || spec.status === "underpaid";
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, payer_name, for_text, source, status,
       paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'plugin', $10, $11, $12, $13, $14, $15, coalesce($16::timestamptz, now()))`,
    [id, recipient, token, token === "USDC" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : null, token === "USDC" ? 6 : 9,
      spec.amountAtomic.toString(), reference, spec.payerName ?? null, spec.forText ?? null, spec.status ?? "open",
      paid ? spec.paidSig : null, paid ? PAYER : null, paid ? (spec.paidAtomic ?? spec.amountAtomic).toString() : null,
      paid ? (spec.paidAt ?? new Date().toISOString()) : null, paid ? "solana_pay" : null, spec.createdAt ?? null],
  );
  return id;
}

async function post(body: unknown) {
  const res = await POST(new Request("https://www.getowed.xyz/api/v1/ledger", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as { error: { code: string; message: string } } };
}
const signedBody = (msg = ledgerMessage()) => ({ recipient: ME, signed_message: msg, signature: signHex(msg) });

it("one fresh signature returns the ledger; the same signature again is refused", async () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const open = await insert({ amountAtomic: 1_000_000n, payerName: "Priya", forText: "coffee", createdAt: daysAgo(2) });
  const part = await insert({ amountAtomic: 3_000_000n, status: "underpaid", paidAtomic: 1_000_000n, paidSig: PAID_SIGS[0], createdAt: daysAgo(1) });
  const paid = await insert({ amountAtomic: 500_000n, status: "paid", paidSig: PAID_SIGS[1], paidAt: daysAgo(3), payerName: "Sam" });
  await insert({ amountAtomic: 700_000n, status: "paid", paidSig: PAID_SIGS[2], paidAt: daysAgo(31) }); // older than 30 days
  await insert({ amountAtomic: 900_000n, status: "cancelled" });
  await insert({ amountAtomic: 2_000_000n, recipient: OTHER }); // someone else's
  const sol = await insert({ amountAtomic: 250_000_000n, token: "SOL" });

  const body = signedBody();
  const first = await post(body);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const ledger = LedgerResponse.parse(first.json);
  assert.equal(ledger.recipient, ME);
  assert.equal(ledger.chain_checked, true);
  assert.equal(ledger.truncated, false);
  assert.deepEqual(ledger.open.map((e) => e.id), [sol, part, open]);
  assert.deepEqual(ledger.paid_recently.map((e) => e.id), [paid]);
  const o = ledger.open.find((e) => e.id === open)!;
  assert.deepEqual({ status: o.status, amount: o.amount, amount_due: o.amount_due, payer_name: o.payer_name, for: o.for, link: o.link, from_domain: o.from_domain },
    { status: "open", amount: "1", amount_due: "1", payer_name: "Priya", for: "coffee", link: `https://www.getowed.xyz/r/${open}`, from_domain: null });
  const u = ledger.open.find((e) => e.id === part)!;
  assert.deepEqual({ status: u.status, amount_due: u.amount_due, amount_paid: u.amount_paid, signature: u.signature }, { status: "underpaid", amount_due: "2", amount_paid: "1", signature: PAID_SIGS[0] });
  assert.equal(ledger.paid_recently[0].payer, PAYER);
  assert.deepEqual(ledger.totals, [
    { token: "USDC", outstanding: "3", received_30d: "1.5", open_count: 2, paid_count: 1 },
    { token: "SOL", outstanding: "0.25", received_30d: "0", open_count: 1, paid_count: 0 },
  ]);

  const replay = await post(body);
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error.code, "invalid_input");
  assert.match(replay.json.error.message, /already used/);
});

it("a stale, future, mis-worded or wrong-wallet signature is refused before any read", async () => {
  await insert({ amountAtomic: 1_000_000n });
  const stale = await post(signedBody(ledgerMessage(Date.now() - 5 * 60_000 - 2000)));
  assert.equal(stale.status, 400);
  assert.match(stale.json.error.message, /more than 5 minutes old/);
  const future = await post(signedBody(ledgerMessage(Date.now() + 120_000)));
  assert.match(future.json.error.message, /dated in the future/);
  const msg = `${ledgerPrefix(OTHER)} at ${isoSeconds(Date.now())}`;
  const someoneElse = await post({ recipient: OTHER, signed_message: msg, signature: signHex(msg) });
  assert.match(someoneElse.json.error.message, /doesn't match this message for wallet FN6G4C/);
  const worded = await post({ ...signedBody(), signed_message: `Owed ledger for ${ME}` });
  assert.match(worded.json.error.message, /must read "Owed ledger access for/);
  const extra = await post({ ...signedBody(), scope: "all" });
  assert.equal(extra.status, 400);
  const notJson = await POST(new Request("https://www.getowed.xyz/api/v1/ledger", { method: "POST", body: "{" }));
  assert.equal(notJson.status, 400);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from signature_nonces")).rows[0].n, 0);
  assert.equal(rpcCalls, 0);
});

it("single use is keyed on the message, so a re-encoded or malleated signature can't replay it", async () => {
  const msg = ledgerMessage();
  const sig = nacl.sign.detached(new TextEncoder().encode(msg), KEY.secretKey);
  assert.equal((await post({ recipient: ME, signed_message: msg, signature: Buffer.from(sig).toString("hex") })).status, 200);
  const asBase58 = await post({ recipient: ME, signed_message: msg, signature: bs58.encode(sig) });
  assert.equal(asBase58.status, 400);
  assert.match(asBase58.json.error.message, /already used/);
});

it("a wallet gets 30 fresh signatures an hour; old rows are purged as it goes", async () => {
  const now = Date.now();
  for (let i = 0; i < SIGNATURES_PER_HOUR; i++) {
    const msg = ledgerMessage(now - i * 1000);
    await spendOnce("ledger", checkSignedMessage({ message: msg, signature: signHex(msg), signer: ME, prefix: ledgerPrefix(ME), now }));
  }
  const over = await post(signedBody(ledgerMessage(now - 40_000)));
  assert.equal(over.status, 429);
  assert.equal(over.json.error.code, "rate_limited");
  // Another purpose has its own budget.
  const msg = ledgerMessage(now - 41_000);
  await spendOnce("cancel", checkSignedMessage({ message: msg, signature: signHex(msg), signer: ME, prefix: ledgerPrefix(ME), now }));
  await pg.exec("update signature_nonces set used_at = now() - interval '3 hours' where purpose = 'ledger'");
  assert.equal((await post(signedBody(ledgerMessage(now - 42_000)))).status, 200);
  const left = await pg.query<{ purpose: string; n: number }>("select purpose, count(*)::int as n from signature_nonces group by purpose order by purpose");
  assert.deepEqual(left.rows, [{ purpose: "cancel", n: 1 }, { purpose: "ledger", n: 1 }]);
});

it("an open request paid on chain since the last check is listed as paid, written once", async () => {
  const id = await insert({ recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_000n, reference: SOL_REF });
  const ledger = await getLedger(SOL_PAYEE, { base: "https://www.getowed.xyz" });
  assert.equal(ledger.chain_checked, true);
  assert.deepEqual(ledger.open, []);
  assert.equal(ledger.paid_recently.length, 1);
  assert.deepEqual(
    { id: ledger.paid_recently[0].id, status: ledger.paid_recently[0].status, payer: ledger.paid_recently[0].payer, signature: ledger.paid_recently[0].signature, amount_paid: ledger.paid_recently[0].amount_paid },
    { id, status: "paid", payer: SOL_PAYER, signature: SOL_SIG, amount_paid: "0.003027" },
  );
  assert.deepEqual(ledger.totals, [{ token: "SOL", outstanding: "0", received_30d: "0.003027", open_count: 0, paid_count: 1 }]);
  const stored = await pg.query<{ status: string; paid_signature: string }>("select status, paid_signature from requests where id = $1", [id]);
  assert.deepEqual(stored.rows[0], { status: "paid", paid_signature: SOL_SIG });
});

it("when the chain can't be read, the stored state is listed and chain_checked is false", async () => {
  await insert({ amountAtomic: 1_000_000n });
  rpcDown = true;
  const ledger = await getLedger(ME, { base: "https://www.getowed.xyz", chainBudgetMs: 600 });
  assert.equal(ledger.chain_checked, false);
  assert.equal(ledger.open.length, 1);
  assert.deepEqual(ledger.totals, [{ token: "USDC", outstanding: "1", received_30d: "0", open_count: 1, paid_count: 0 }]);
});

it("past 100 rows the list is cut, and the totals still count every row", async () => {
  for (let i = 0; i < LEDGER_MAX_ROWS + 5; i++) await insert({ amountAtomic: 10_000n, createdAt: new Date(Date.now() - i * 60_000).toISOString() });
  const ledger = await getLedger(ME, { base: "https://www.getowed.xyz" });
  assert.equal(ledger.truncated, true);
  assert.equal(ledger.open.length, LEDGER_MAX_ROWS);
  assert.deepEqual(ledger.totals, [{ token: "USDC", outstanding: "1.05", received_30d: "0", open_count: 105, paid_count: 0 }]);
});

it("split shares and invoices are listed as such, on the configured base, with their verified domain", async () => {
  const BASE = "https://www.getowed.xyz";
  const plain = await insert({ amountAtomic: 4_500_000n, payerName: "Sam", forText: "taxi", createdAt: new Date(Date.now() - 60_000).toISOString() });
  const { group, shares } = await createGroup({
    recipient: ME, token: "USDC", title: "Pizza night", requesterName: "Raj", flags: [], source: "plugin", fromDomain: "getowed.xyz",
    shares: [{ name: "Alex", amountAtomic: 1_500_000n, flags: [] }, { name: "Jo", amountAtomic: 1_500_000n, flags: [] }],
  });
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const { request: invoice } = await createInvoice({
    recipient: ME, token: "USDC", businessName: "Kestrel Studio", clientName: "Lumen Analytics", invoiceNumber: "2026-114", notes: null,
    dueDate: due, items: [{ description: "Logo refresh", quantity: "2", unit_price: "12.5" }], source: "plugin",
  });
  for (const r of [...shares, invoice]) unusedRefs.add(r.reference);

  const res = await post(signedBody());
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const ledger = LedgerResponse.parse(res.json);
  assert.equal(ledger.chain_checked, true);
  const byId = new Map(ledger.open.map((e) => [e.id, e]));
  const pick = (id: string) => {
    const e = byId.get(id)!;
    return { kind: e.kind, link: e.link, payer_name: e.payer_name, for: e.for, group_id: e.group_id, group_title: e.group_title,
      group_link: e.group_link, invoice_number: e.invoice_number, due_date: e.due_date, from_domain: e.from_domain };
  };
  assert.deepEqual(pick(shares[0].id), {
    kind: "split_share", link: `${BASE}/r/${shares[0].id}`, payer_name: "Alex", for: "Pizza night", group_id: group.id,
    group_title: "Pizza night", group_link: `${BASE}/g/${group.id}`, invoice_number: null, due_date: null, from_domain: "getowed.xyz",
  });
  assert.equal(pick(shares[1].id).payer_name, "Jo");
  assert.deepEqual(pick(invoice.id), {
    kind: "invoice", link: `${BASE}/i/${invoice.id}`, payer_name: "Lumen Analytics", for: "Invoice 2026-114", group_id: null,
    group_title: null, group_link: null, invoice_number: "2026-114", due_date: due, from_domain: null,
  });
  assert.deepEqual(pick(plain), {
    kind: "single", link: `${BASE}/r/${plain}`, payer_name: "Sam", for: "taxi", group_id: null,
    group_title: null, group_link: null, invoice_number: null, due_date: null, from_domain: null,
  });
  assert.deepEqual(ledger.totals, [{ token: "USDC", outstanding: "32.5", received_30d: "0", open_count: 4, paid_count: 0 }]);
});
