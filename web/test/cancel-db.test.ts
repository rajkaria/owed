import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST as cancelRoute } from "@/app/api/v1/requests/[id]/cancel/route";
import { GET as getRoute } from "@/app/api/v1/requests/[id]/route";
import { POST as createRoute } from "@/app/api/v1/requests/route";
import { POST as statusRoute } from "@/app/api/v1/status/route";
import { POST as groupsRoute } from "@/app/api/v1/groups/route";
import { POST as invoicesRoute } from "@/app/api/v1/invoices/route";
import { GET as x402Route } from "@/app/x/[id]/route";
import { cancelPrefix } from "@/lib/cancel";
import { CancelResponse, CreateRequestResponse, GetRequestResponse, GroupResponse, InvoiceResponse, StatusResponse } from "@/lib/contract";
import { DbError, sql } from "@/lib/db";
import { requestIdFor } from "@/lib/ids";
import { getLedger } from "@/lib/ledger";
import { parseJsonExact } from "@/lib/solana";
import { isoSeconds } from "@/lib/verify-signature";
import { verifyMessageSignature } from "@/lib/verify-signature";
import { store } from "@/lib/x402/store";
import { stateFromRequest } from "@/lib/view/request-view";
import { check, shapes } from "../../contract/shapes.mjs";

// W3-C cancel + expiry on real Postgres: every migration (0001 → 0009, with 0005's single-use table and 0007's
// columns) on PGlite answering lib/db.ts's Neon-over-HTTP calls; the cancel, request, status, group, invoice
// and x402 routes as Vercel runs them. Chain reads replay W1-B's recorded mainnet responses. Signatures come from
// a throwaway ed25519 key (fixed seed, holds nothing), signed exactly the way PayBox's request_wallet_sign does
// (the message's UTF-8 bytes, hex out). Skips until the devDependency @electric-sql/pglite is installed.

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
const MIGRATIONS = new URL("db/migrations/", WEB);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

// ---- signers (throwaway keys, fixed seeds) ----
const keyFrom = (seed: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(seed).digest()));
const KEY = keyFrom("owed test signer: cancel-db.test.ts");
const ME = bs58.encode(KEY.publicKey);
const MALLORY_KEY = keyFrom("owed test signer: cancel-db.test.ts, someone else");
const MALLORY = bs58.encode(MALLORY_KEY.publicKey);
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");
const cancelMessage = (id: string, recipient = ME, at = Date.now()) => `${cancelPrefix(id, recipient)} at ${isoSeconds(at)}`;

// ---- recorded mainnet RPC (W1-B, publicnode, 2026-10-17) ----
// sol-reference-payment: a real 0.003027 SOL payment carrying reference SOL_REF. For the cases where the payee
// must be a key this test can sign for, the same recording is replayed with the payee's key swapped for ME:
// labelled "constructed"; every number, the signature and the reference stay as recorded.
interface RecordedCall { method: string; params: unknown[]; result: unknown }
const recordingText = readFileSync(new URL("fixtures/chain/sol-reference-payment.json", import.meta.url), "utf8");
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_AMOUNT = 3_027_000n; // lamports the recorded payment credited the payee
// Each test asks a slightly different amount (still covered by the payment), so each gets its own id: the server
// checks one id against the chain at most every 3 s, and these tests run faster than that.
const CONSTRUCTED_PAID_TO_ME = (parseJsonExact(recordingText.replaceAll(SOL_PAYEE, ME)) as { calls: RecordedCall[] }).calls;
const PAID_SIGS = [
  "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
  "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK",
];
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** References no transaction has used: mainnet answers getSignaturesForAddress with []. */
const unusedRefs = new Set<string>();
/** When true, SOL_REF answers with the constructed payment to ME; otherwise it is unused too. */
let solRefPaid = false;
let rpcDown = false;

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const RPC_HOSTS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

function answerRpc(m: { id: number; method: string; params: unknown[] }) {
  if (solRefPaid) {
    const hit = CONSTRUCTED_PAID_TO_ME.find((c) => c.method === m.method && String(c.params[0]) === String(m.params[0]));
    if (hit) return { jsonrpc: "2.0", id: m.id, result: hit.result };
  }
  const subject = String(m.params[0]);
  if (m.method === "getSignaturesForAddress" && (unusedRefs.has(subject) || subject === SOL_REF)) return { jsonrpc: "2.0", id: m.id, result: [] };
  return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `unrecorded call ${m.method} ${subject}` } };
}
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));

before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (RPC_HOSTS.some((h) => url.startsWith(h))) {
      if (rpcDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init!.body));
      return new Response(toJson(Array.isArray(body) ? body.map(answerRpc) : answerRpc(body)), { headers: { "content-type": "application/json" } });
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
  delete process.env.X402_FACILITATOR_URL;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await pg.exec("delete from x402_receipts; delete from invoices; delete from requests; delete from groups; delete from signature_nonces; delete from rate_events;");
  unusedRefs.clear();
  solRefPaid = false;
  rpcDown = false;
});

let refCounter = 0;
function freshReference(): string {
  const ref = bs58.encode(createHash("sha256").update(`cancel-db.test reference ${refCounter++}`).digest());
  unusedRefs.add(ref);
  return ref;
}

interface RowSpec {
  recipient?: string;
  token?: "USDC" | "SOL";
  amountAtomic?: bigint;
  reference?: string;
  status?: "open" | "paid" | "underpaid" | "cancelled";
  paidSig?: string;
  /** Days ago the request was made, and days after that it expires (null: never). */
  createdDaysAgo?: number;
  expiresAfterDays?: number | null;
  cancel?: { message: string; signature: string };
}
async function insert(spec: RowSpec = {}): Promise<string> {
  const recipient = spec.recipient ?? ME;
  const token = spec.token ?? "USDC";
  const amountAtomic = spec.amountAtomic ?? 10_000n;
  const reference = spec.reference ?? freshReference();
  const id = requestIdFor({ recipient, token, amountAtomic, reference });
  const paid = spec.status === "paid" || spec.status === "underpaid";
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, status,
       paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, created_at, expires_at,
       cancelled_at, cancel_message, cancel_signature)
     values ($1, $2, $3, $4, $5, $6, $7, 'plugin', $8, $9, $10, $11, $12, $13,
       now() - make_interval(days => $14::int),
       case when $15::int is null then null else now() - make_interval(days => $14::int) + make_interval(days => $15::int) end,
       case when $16::text is null then null else now() end, $16, $17)`,
    [id, recipient, token, token === "USDC" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : null, token === "USDC" ? 6 : 9,
      amountAtomic.toString(), reference, spec.status ?? "open",
      paid ? spec.paidSig : null, paid ? PAYER : null, paid ? (spec.status === "underpaid" ? amountAtomic / 2n : amountAtomic).toString() : null,
      paid ? new Date().toISOString() : null, paid ? "solana_pay" : null,
      spec.createdDaysAgo ?? 0, spec.expiresAfterDays ?? null, spec.cancel?.message ?? null, spec.cancel?.signature ?? null],
  );
  return id;
}

const BASE = "https://www.getowed.xyz";
async function cancel(id: string, body: Record<string, unknown>) {
  const res = await cancelRoute(new Request(`${BASE}/api/v1/requests/${id}/cancel`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) } as Parameters<typeof cancelRoute>[1]);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}
const signedBody = (id: string, msg = cancelMessage(id)) => ({ recipient: ME, signed_message: msg, signature: signHex(msg) });
async function read(id: string) {
  const res = await getRoute(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getRoute>[1]);
  return { status: res.status, body: GetRequestResponse.parse(await res.json()) };
}
async function statusOf(ids: string[]) {
  const res = await statusRoute(new Request(`${BASE}/api/v1/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }));
  return StatusResponse.parse(await res.json()).results;
}
const stored = async (id: string) =>
  (await pg.query<Record<string, string | null>>("select status, cancelled_at::text as cancelled_at, cancel_message, cancel_signature, paid_signature from requests where id = $1", [id])).rows[0];
// Invoice and cancel shapes are added to contract/shapes.mjs with Object.assign, so TypeScript can't see them on `shapes`.
type ShapeName = "createRequestRes" | "getRequestRes" | "statusRes" | "groupRes" | "invoiceRes" | "cancelReq" | "cancelRes";
const contractShapes = shapes as unknown as Record<ShapeName, Parameters<typeof check>[0]>;
const contractErrors = (shape: ShapeName, value: unknown) => {
  const r = check(contractShapes[shape], value);
  return [...r.errors, ...r.warnings];
};

// ------------------------------------------------------------------------------------------- 0007 itself

it("0007 adds the columns; expiry must be 1 to 90 days after creation; a cancellation always carries its proof", async () => {
  const cols = await pg.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_name = 'requests' and column_name in ('expires_at', 'cancelled_at', 'cancel_message', 'cancel_signature') order by column_name`);
  assert.deepEqual(cols.rows.map((c) => `${c.column_name} ${c.data_type}`), [
    "cancel_message text", "cancel_signature text", "cancelled_at timestamp with time zone", "expires_at timestamp with time zone",
  ]);
  const id = await insert();
  for (const [expr, ok] of [["created_at + interval '1 day'", true], ["created_at + interval '90 days'", true],
    ["created_at + interval '23 hours'", false], ["created_at + interval '91 days'", false], ["created_at - interval '1 day'", false]] as const) {
    const attempt = sql(`update requests set expires_at = ${expr} where id = $1`, [id]);
    if (ok) await attempt;
    else await assert.rejects(attempt, (e: unknown) => e instanceof DbError && e.constraint === "requests_expires_check", expr);
  }
  await assert.rejects(sql("update requests set cancelled_at = now() where id = $1", [id]),
    (e: unknown) => e instanceof DbError && e.constraint === "requests_cancel_check");
  await assert.rejects(sql("update requests set cancelled_at = now(), cancel_message = 'x', cancel_signature = $2 where id = $1", [id, "a".repeat(201)]),
    (e: unknown) => e instanceof DbError && e.constraint === "requests_cancel_check");
});

// ------------------------------------------------------------------------------------------- expiry

it("POST /requests with expires_in_days: the server sets expires_at = created_at + N days; bad values are 400", async () => {
  const res = await createRoute(new Request(`${BASE}/api/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", amount: "0.01", source: "plugin", expires_in_days: 1 }),
  }));
  assert.equal(res.status, 201);
  const created = CreateRequestResponse.parse(await res.json());
  assert.ok(created.expires_at);
  assert.equal(Date.parse(created.expires_at!) - Date.parse(created.created_at), 86_400_000);
  assert.deepEqual(contractErrors("createRequestRes", created), []);
  unusedRefs.add(created.reference);
  const got = await read(created.id);
  assert.equal(got.body.status, "open");
  assert.equal(got.body.expires_at, created.expires_at);
  assert.equal(got.body.cancelled, null);

  for (const bad of [0, 91, 1.5, "7", -3]) {
    const r = await createRoute(new Request(`${BASE}/api/v1/requests`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", amount: "0.01", expires_in_days: bad }),
    }));
    assert.equal(r.status, 400, String(bad));
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /^expires_in_days: /);
  }
});

it("past expires_at a request reads as expired everywhere: GET, /status, the page state, the ledger; still payable rows are unchanged", async () => {
  const expired = await insert({ createdDaysAgo: 2, expiresAfterDays: 1 });
  const live = await insert({ createdDaysAgo: 2, expiresAfterDays: 3 });
  const never = await insert({ createdDaysAgo: 2 });
  const got = await read(expired);
  assert.equal(got.body.status, "expired");
  assert.deepEqual(contractErrors("getRequestRes", got.body), []);
  assert.equal((await stored(expired)).status, "open", "the stored status stays open; expiry is computed on read");
  assert.equal((await read(live)).body.status, "open");
  assert.equal((await read(never)).body.expires_at, null);

  const results = await statusOf([expired, live]);
  assert.deepEqual(results.map((r) => [r.id, r.status]), [[expired, "expired"], [live, "open"]]);
  assert.equal(results[0].expires_at, got.body.expires_at);
  assert.deepEqual(contractErrors("statusRes", { results }), []);

  assert.deepEqual(stateFromRequest({ ...got.body, cancelled: null, from_domain: null, from_domain_verified_at: null, x402_url: null, paid: null, expires_at: got.body.expires_at ?? null } as Parameters<typeof stateFromRequest>[0]),
    { status: "expired", at: got.body.expires_at });

  const ledger = await getLedger(ME, { base: BASE });
  assert.deepEqual(ledger.open.map((e) => e.id).sort(), [live, never].sort(), "an expired request is no longer owed");
});

it("a payment that landed anyway (before or after expiry) still shows as paid: money that arrived wins over expired", async () => {
  const id = await insert({ token: "SOL", amountAtomic: SOL_AMOUNT, reference: SOL_REF, createdDaysAgo: 2, expiresAfterDays: 1 });
  solRefPaid = true;
  const got = await read(id);
  assert.equal(got.body.status, "paid");
  assert.equal(got.body.paid?.signature, SOL_SIG);
  assert.equal((await stored(id)).status, "paid");
});

it("x402: an expired request gets no challenge (409), and the settlement lock refuses it", async () => {
  const id = await insert({ createdDaysAgo: 2, expiresAfterDays: 1 });
  const res = await x402Route(new Request(`${BASE}/x/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof x402Route>[1]);
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("payment-required"), null);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /expired and no longer takes payments/);
  const lock = await store.begin({ requestId: id, version: 2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountAtomic: 10_000n, payer: PAYER, feePayer: PAYER });
  assert.deepEqual(lock, { ok: false, holder: null });
  assert.equal((await pg.query("select count(*)::int as n from x402_receipts")).rows[0].n, 0);
});

it("POST /groups and /invoices take expires_in_days; an invoice may not expire before it is due", async () => {
  const groupRes = await groupsRoute(new Request(`${BASE}/api/v1/groups`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", total: "1", title: "Pizza", people: [{ name: "A" }, { name: "B" }], expires_in_days: 7 }),
  }));
  assert.equal(groupRes.status, 201);
  const group = GroupResponse.parse(await groupRes.json());
  assert.equal(Date.parse(group.expires_at!) - Date.parse(group.created_at), 7 * 86_400_000);
  assert.deepEqual(contractErrors("groupRes", group), []);
  const shares = await pg.query<{ n: number }>("select count(*)::int as n from requests where group_id = $1 and expires_at = created_at + interval '7 days'", [group.id]);
  assert.equal(shares.rows[0].n, 2);

  const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const invoice = (expires_in_days: number, dueDate: string) => invoicesRoute(new Request(`${BASE}/api/v1/invoices`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", business_name: "Kestrel", client_name: "Lumen", due_date: dueDate,
      items: [{ description: "Logo", unit_price: "1" }], expires_in_days }),
  }));
  const early = await invoice(3, due(10));
  assert.equal(early.status, 400);
  assert.match(((await early.json()) as { error: { message: string } }).error.message, /^expires_in_days 3 ends before the due date .*; use at least 10, or leave it out$/);
  const ok = await invoice(10, due(10));
  assert.equal(ok.status, 201);
  const inv = InvoiceResponse.parse(await ok.json());
  assert.equal(Date.parse(inv.expires_at!) - Date.parse(inv.created_at), 10 * 86_400_000);
  assert.equal(inv.cancelled_at, undefined);
  assert.deepEqual(contractErrors("invoiceRes", inv), []);
});

// ------------------------------------------------------------------------------------------- cancel

it("good signature → cancelled with its proof; GET, /status and the page agree; anyone can re-check the proof", async () => {
  const id = await insert({ expiresAfterDays: 5 });
  const body = signedBody(id);
  const res = await cancel(id, body);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const out = CancelResponse.parse(res.json);
  assert.equal(out.status, "cancelled");
  assert.equal(out.already_cancelled, false);
  assert.equal(out.cancelled?.signed_message, body.signed_message);
  assert.equal(out.cancelled?.signature, body.signature);
  assert.ok(verifyMessageSignature(out.cancelled!.signed_message, out.cancelled!.signature, out.recipient), "the stored proof verifies for the recipient");
  assert.deepEqual(contractErrors("cancelRes", res.json), []);
  assert.deepEqual(contractErrors("cancelReq", body), []);

  const row = await stored(id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancel_message, body.signed_message);
  const got = await read(id);
  assert.equal(got.body.status, "cancelled");
  assert.equal(got.body.cancelled?.at, out.cancelled?.at);
  const [st] = await statusOf([id]);
  assert.deepEqual([st.status, st.cancelled_at], ["cancelled", out.cancelled?.at]);
  assert.deepEqual(stateFromRequest(got.body as Parameters<typeof stateFromRequest>[0]), { status: "cancelled", at: out.cancelled?.at });
});

it("replay: the same signed message is refused, even after the cancel went through", async () => {
  const id = await insert();
  const body = signedBody(id);
  assert.equal((await cancel(id, body)).status, 200);
  const again = await cancel(id, body);
  assert.equal(again.status, 400);
  assert.deepEqual(again.json, { error: { code: "invalid_input", message: "this signature was already used; sign a fresh message to try again" } });
});

it("cancelling twice is idempotent: a fresh signature returns already_cancelled and keeps the first proof", async () => {
  const id = await insert();
  const first = CancelResponse.parse((await cancel(id, signedBody(id, cancelMessage(id, ME, Date.now() - 2000)))).json);
  const second = await cancel(id, signedBody(id));
  assert.equal(second.status, 200);
  const out = CancelResponse.parse(second.json);
  assert.equal(out.already_cancelled, true);
  assert.deepEqual(out.cancelled, first.cancelled);
});

it("wrong signer: another wallet's signature over the recipient's message, or another wallet claiming the request, is refused", async () => {
  const id = await insert();
  const msg = cancelMessage(id);
  const forged = await cancel(id, { recipient: ME, signed_message: msg, signature: signHex(msg, MALLORY_KEY) });
  assert.equal(forged.status, 400);
  assert.match(forged.json.error!.message, /^the signature doesn't match this message for wallet /);
  const own = cancelMessage(id, MALLORY);
  const claimed = await cancel(id, { recipient: MALLORY, signed_message: own, signature: signHex(own, MALLORY_KEY) });
  assert.equal(claimed.status, 400);
  assert.equal(claimed.json.error!.message, "only the wallet this request pays can cancel it, and that is not this recipient");
  // A message for a different request doesn't cancel this one.
  const other = await insert();
  const wrongId = await cancel(id, signedBody(id, cancelMessage(other)));
  assert.equal(wrongId.status, 400);
  assert.match(wrongId.json.error!.message, /^signed_message must read "Owed cancel /);
  assert.equal((await stored(id)).status, "open");
});

it("stale or future-dated messages are refused; nothing changes", async () => {
  const id = await insert();
  const stale = await cancel(id, signedBody(id, cancelMessage(id, ME, Date.now() - 6 * 60_000)));
  assert.equal(stale.status, 400);
  assert.equal(stale.json.error!.message, "this signed message is more than 5 minutes old; sign a fresh one");
  const future = await cancel(id, signedBody(id, cancelMessage(id, ME, Date.now() + 3 * 60_000)));
  assert.equal(future.status, 400);
  assert.equal(future.json.error!.message, "this signed message is dated in the future; sign a fresh one with the current time");
  assert.equal((await stored(id)).status, "open");
});

it("a paid request can't be cancelled: stored paid, partly paid, or paid on chain since the last check", async () => {
  const paid = await insert({ status: "paid", paidSig: PAID_SIGS[0] });
  const r1 = await cancel(paid, signedBody(paid));
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error!.message, "this request is already paid, so it can't be cancelled");
  const part = await insert({ status: "underpaid", paidSig: PAID_SIGS[1] });
  const r2 = await cancel(part, signedBody(part));
  assert.equal(r2.json.error!.message, "this request already received a partial payment, so it can't be cancelled");

  // Stored as open, but the chain shows the payment (the recorded SOL payment, payee constructed as ME).
  const onChain = await insert({ token: "SOL", amountAtomic: SOL_AMOUNT - 1n, reference: SOL_REF });
  solRefPaid = true;
  const r3 = await cancel(onChain, signedBody(onChain));
  assert.equal(r3.status, 400);
  assert.equal(r3.json.error!.message, "this request is already paid, so it can't be cancelled");
  assert.deepEqual([(await stored(onChain)).status, (await stored(onChain)).paid_signature], ["paid", SOL_SIG]);
});

it("when the chain can't be read, nothing is cancelled (503)", async () => {
  const id = await insert();
  rpcDown = true;
  const res = await cancel(id, signedBody(id));
  assert.equal(res.status, 503);
  assert.equal(res.json.error!.code, "upstream_unavailable");
  assert.equal((await stored(id)).status, "open");
});

it("an expired request can be cancelled; unknown and malformed ids are 404 and 400", async () => {
  const id = await insert({ createdDaysAgo: 2, expiresAfterDays: 1 });
  const res = await cancel(id, signedBody(id));
  assert.equal(res.status, 200);
  assert.equal(CancelResponse.parse(res.json).status, "cancelled");
  const missing = requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 1n, reference: freshReference() });
  assert.equal((await cancel(missing, signedBody(missing))).status, 404);
  assert.equal((await cancel("not-an-id", signedBody("not-an-id"))).status, 400);
  const extra = await cancel(id, { ...signedBody(id), note: "x" });
  assert.equal(extra.status, 400, "the body is strict");
});

it("an x402 settlement in flight blocks the cancel; a stale lock doesn't; after the cancel /x serves no challenge and won't lock", async () => {
  const id = await insert();
  await pg.query("insert into x402_receipts (request_id, state, x402_version, network, amount_atomic) values ($1, 'settling', 2, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 10000)", [id]);
  const blocked = await cancel(id, signedBody(id, cancelMessage(id, ME, Date.now() - 1000)));
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error!.message, /^an x402 payment for this request is being settled right now/);
  assert.equal((await stored(id)).status, "open");

  await pg.query("update x402_receipts set created_at = now() - interval '10 minutes' where request_id = $1", [id]);
  const ok = await cancel(id, signedBody(id));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const x = await x402Route(new Request(`${BASE}/x/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof x402Route>[1]);
  assert.equal(x.status, 409);
  assert.equal(x.headers.get("payment-required"), null);
  assert.equal(((await x.json()) as { error: { message: string } }).error.message, "This request was cancelled by the requester.");
  await pg.query("update x402_receipts set state = 'abandoned' where request_id = $1", [id]);
  const lock = await store.begin({ requestId: id, version: 2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountAtomic: 10_000n, payer: PAYER, feePayer: PAYER });
  assert.deepEqual(lock, { ok: false, holder: null });
});

it("a payment that lands after a cancel is still recorded: the request reads paid, the cancel proof stays", async () => {
  const msg = cancelMessage("placeholder");
  const id = await insert({ token: "SOL", amountAtomic: SOL_AMOUNT - 2n, reference: SOL_REF, status: "cancelled", cancel: { message: msg, signature: signHex(msg) } });
  solRefPaid = true;
  const got = await read(id);
  assert.equal(got.body.status, "paid");
  assert.equal(got.body.paid?.signature, SOL_SIG);
  assert.ok(got.body.cancelled?.at);
});

it("the per-wallet hourly cap applies to cancel signatures (purpose 'cancel', separate from the ledger's)", async () => {
  const id = await insert();
  await pg.query(
    `insert into signature_nonces (message_sha256, purpose, signer, signed_at)
     select encode(sha256(('n' || g)::bytea), 'hex'), 'cancel', $1, now() from generate_series(1, 30) g`, [ME]);
  const res = await cancel(id, signedBody(id));
  assert.equal(res.status, 429);
  assert.equal((await stored(id)).status, "open");
});
