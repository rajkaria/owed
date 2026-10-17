import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST as matchRoute } from "@/app/api/v1/requests/[id]/match/route";
import { POST as restRoute } from "@/app/api/v1/requests/[id]/rest/route";
import { GET as getRoute } from "@/app/api/v1/requests/[id]/route";
import { POST as statusRoute } from "@/app/api/v1/status/route";
import { POST as attributedRoute } from "@/app/api/v1/attributed/route";
import { loadProof } from "@/app/proof/data";
import { AttributedResponse, GetRequestResponse, LedgerResponse, MatchResponse, RestResponse, StatusResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { getLedger } from "@/lib/ledger";
import { matchPrefix } from "@/lib/match";
import { parseJsonExact } from "@/lib/solana";
import { isoSeconds } from "@/lib/verify-signature";
import { MATCHED_LABEL, stateFromRequest } from "@/lib/view/request-view";
import { check, shapes } from "../../contract/shapes.mjs";

// 0012 matched payments on real Postgres: every migration (0001 → 0012) on PGlite answering lib/db.ts's Neon-over-HTTP
// calls; the match, rest, request, status and attributed routes as Vercel runs them. Chain reads replay the recorded
// mainnet history of the team wallet's USDC account (fixtures/mainnet/team-usdc-unreferenced.json): four 0.01/1 USDC
// transfers from GSWh…8dcD that carry no Solana Pay reference (FACTS, Mainnet transactions), and Phantom's referenced
// payment mBef… for request qNaosx73zzt3. The recipient must be a key this test can sign for, so the recording is
// replayed with the team wallet's address swapped for ME: "constructed", every amount, signature, payer and block time
// stays as recorded. Signatures come from a throwaway ed25519 key (fixed seed, holds nothing), made the way PayBox's
// request_wallet_sign makes them (the message's UTF-8 bytes, hex out).

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
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

// ---- signers (throwaway keys, fixed seeds) ----
const keyFrom = (seed: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(seed).digest()));
const KEY = keyFrom("owed test signer: match-db.test.ts");
const ME = bs58.encode(KEY.publicKey);
const MALLORY_KEY = keyFrom("owed test signer: match-db.test.ts, someone else");
const MALLORY = bs58.encode(MALLORY_KEY.publicKey);
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");

// ---- the recorded team-wallet history, constructed to pay ME ----
interface RecordedCall { method: string; params: unknown[]; result: unknown }
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const recordingText = readFileSync(new URL("fixtures/mainnet/team-usdc-unreferenced.json", import.meta.url), "utf8");
const CALLS = (parseJsonExact(recordingText.replaceAll(TEAM, ME)) as { calls: RecordedCall[] }).calls;
const GSWH = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD"; // Raj's Phantom, the sender of every incoming transfer here
const TX = {
  /** 0.01 USDC, 17:14:15Z, no reference, no memo */
  a: "5w8NvDDoTWKEWjVABR78bwTXbbiutvvgXqe9WAegotZq2s4awqXf5oHKLg8zpnUZ9aE2pCxA3s9e4zASndGS5cTp",
  /** 0.01 USDC, 17:22:33Z, no reference, no memo */
  b: "3V3GyHymd4d1wT8RDmoSLcXLo5BvRyCNrqaoT6tMxyMX81TEc41rqhAvbCpcXbLYMGaPB641obfxu4kV6tgUSyXW",
  /** 1 USDC, 15:32:04Z, no reference, no memo */
  one: "5LPHMNke5nYHpnBiR65JUF9Bhp5WQqSbWaB38dwDBtZdevKU6y4abqdM53oajiVnCyrCEV42hc8Bani28XnqSuHA",
  /** 0.01 USDC, 18:37:27Z, Phantom through Owed's transaction request: reference 31hp… of qNaosx73zzt3, memo owed:qNaosx73zzt3 */
  referenced: "mBefU4x5vN7nfLZhPkJbsEsmXuTaWYZrkGrBiHBEUXJE7BySYXqNYDYJ7ePmRETCBWoBYGNsWDeJosVHGmuf3i9",
  /** the team wallet paying someone else over x402 (outgoing: credits nothing) */
  outgoing: "2ycZFaKx86Jhm91qXUgcMY6NkoDdH7qk6GE6zanDuKQBXy4AhrcPE1E11Qxwf8z2WgGuhtXfGdFmTEyvhZk21DVA",
};
const QNAOS_REF = "31hpKQLhjpJjmKdpW2chHTW67szXVMFdytsDqoBvpdHq";
const BEFORE_A = "2026-10-17T17:00:00Z"; // a request made before TX.a landed

let rpcDown = false;
const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const RPC_HOSTS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

function answerRpc(m: { id: number; method: string; params: unknown[] }) {
  const subject = String(m.params[0]);
  if (m.method === "getTransaction") {
    const hit = CALLS.find((c) => c.method === "getTransaction" && c.params[0] === subject);
    return { jsonrpc: "2.0", id: m.id, result: hit ? hit.result : null };
  }
  // Every request reference here is unused on mainnet: no referenced payment to find.
  if (m.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: m.id, result: [] };
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
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await pg.exec("delete from request_matches; delete from x402_receipts; delete from invoices; delete from requests; delete from groups; delete from signature_nonces; delete from rate_events;");
  rpcDown = false;
  delete process.env.OWED_TEAM_WALLETS;
});

let refCounter = 0;
const freshReference = () => bs58.encode(createHash("sha256").update(`match-db.test reference ${refCounter++}`).digest());

interface RowSpec {
  recipient?: string;
  amountAtomic?: bigint;
  reference?: string;
  createdAt?: string;
  status?: "open" | "underpaid" | "paid" | "cancelled";
  paid?: { signature: string; payer: string; amountAtomic: bigint; at: string };
}
async function insert(spec: RowSpec = {}): Promise<string> {
  const recipient = spec.recipient ?? ME;
  const amountAtomic = spec.amountAtomic ?? 10_000n;
  const reference = spec.reference ?? freshReference();
  const id = requestIdFor({ recipient, token: "USDC", amountAtomic, reference });
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, status, payer_name, for_text, requester_name,
       paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, created_at)
     values ($1, $2, 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, $3, $4, 'plugin', $5, 'Priya', 'dinner', 'Raj',
       $6, $7, $8, $9::timestamptz, $10, $11::timestamptz)`,
    [id, recipient, amountAtomic.toString(), reference, spec.status ?? "open",
      spec.paid?.signature ?? null, spec.paid?.payer ?? null, spec.paid?.amountAtomic.toString() ?? null, spec.paid?.at ?? null,
      spec.paid ? "solana_pay" : null, spec.createdAt ?? BEFORE_A],
  );
  return id;
}

const BASE = "https://www.getowed.xyz";
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
async function post(route: (req: Request, ctx: never) => Promise<Response>, path: string, body: unknown, id?: string) {
  const req = new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await route(req, { params: Promise.resolve({ id }) } as never);
  return { status: res.status, json: (await res.json()) as Json };
}
const message = (tx: string, id: string, recipient = ME, at = Date.now()) => `${matchPrefix(tx, id, recipient)} at ${isoSeconds(at)}`;
const matchBody = (tx: string, id: string, msg = message(tx, id), key = KEY, recipient = ME) =>
  ({ recipient, transaction: tx, signed_message: msg, signature: signHex(msg, key) });
const match = (id: string, body: unknown) => post(matchRoute as never, `/api/v1/requests/${id}/match`, body, id);
const askRest = (id: string, body: unknown = { source: "plugin" }) => post(restRoute as never, `/api/v1/requests/${id}/rest`, body, id);
async function read(id: string) {
  const res = await getRoute(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getRoute>[1]);
  return GetRequestResponse.parse(await res.json());
}
async function statusOf(ids: string[]) {
  const res = await statusRoute(new Request(`${BASE}/api/v1/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }));
  return StatusResponse.parse(await res.json()).results;
}
type ShapeName = "matchRes" | "restRes" | "getRequestRes" | "statusRes" | "ledgerRes" | "attributedRes" | "matchReq";
const contractErrors = (shape: ShapeName, value: unknown) => {
  const r = check((shapes as unknown as Record<ShapeName, Parameters<typeof check>[0]>)[shape], value);
  return [...r.errors, ...r.warnings];
};

// ------------------------------------------------------------------------------------------- 0012 itself

it("0012 adds request_matches, the matched rail and rest_of (one follow-up per request, never itself)", async () => {
  const cols = await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'request_matches' order by ordinal_position`);
  assert.deepEqual(cols.rows.map((c) => c.column_name), ["request_id", "signature", "covers", "payer", "amount_atomic", "paid_at", "slot",
    "confirmed_by", "confirm_message", "confirm_signature", "confirmed_at"]);
  const parent = await insert();
  await assert.rejects(pg.query(`update requests set rest_of = id where id = $1`, [parent]), /requests_rest_of_check/);
  await assert.doesNotReject(pg.query(`update requests set paid_rail = 'matched' where id = $1`, [parent]));
  await assert.rejects(pg.query(`update requests set paid_rail = 'wire' where id = $1`, [parent]), /requests_paid_rail_check/);
  const a = await insert();
  const b = await insert();
  await pg.query(`update requests set rest_of = $2 where id = $1`, [a, parent]);
  await assert.rejects(pg.query(`update requests set rest_of = $2 where id = $1`, [b, parent]), /requests_rest_of_key/);
});

// ------------------------------------------------------------------------------------------- confirm a match

it("a payment without the reference, matched by the recipient: paid, rail matched, signed proof kept, labelled everywhere", async () => {
  const id = await insert();
  const body = matchBody(TX.a, id);
  assert.deepEqual(contractErrors("matchReq", body), []);
  const { status, json } = await match(id, body);
  assert.equal(status, 200, JSON.stringify(json));
  const res = MatchResponse.parse(json);
  assert.equal(res.status, "paid");
  assert.equal(res.already_matched, false);
  assert.deepEqual(res.paid, { signature: TX.a, payer: GSWH, amount: "0.01", at: "2026-10-17T17:14:15Z", rail: "matched" });
  assert.equal(res.matched?.covers, "full");
  assert.equal(res.matched?.signature, TX.a);
  assert.equal(res.matched?.payer, GSWH);
  assert.equal(res.matched?.confirmed_by, ME);
  assert.equal(res.matched?.signed_message, body.signed_message);
  assert.equal(res.matched?.message_signature, body.signature);
  // The shared lint verifies the stored signature for real and the full-match invariants.
  assert.deepEqual(contractErrors("matchRes", json), []);

  const got = await read(id);
  assert.equal(got.paid?.rail, "matched");
  assert.deepEqual(contractErrors("getRequestRes", got), []);
  const [st] = await statusOf([id]);
  assert.equal(st.rail, "matched");
  assert.deepEqual(st.matched, { signature: TX.a, covers: "full", amount: "0.01", confirmed_at: res.matched!.confirmed_at });
  assert.deepEqual(contractErrors("statusRes", { results: [st] }), []);
  // The pay page shows it as matched, not with the referenced badge.
  const state = stateFromRequest(got as never);
  assert.equal(state.status === "paid" && state.rail, "matched");
  assert.equal(state.status === "paid" && state.matched?.covers, "full");
  assert.equal(MATCHED_LABEL, "Matched by the recipient (no reference on the payment)");

  const stored = (await pg.query<Record<string, string>>(`select covers, confirmed_by, confirm_message, amount_atomic::text as a, slot::text as slot from request_matches where request_id = $1`, [id])).rows[0];
  assert.deepEqual(stored, { covers: "full", confirmed_by: ME, confirm_message: body.signed_message, a: "10000", slot: stored.slot });
  assert.ok(BigInt(stored.slot) > 458_000_000n);
});

it("replay is refused; a fresh message for the same transaction changes nothing (already_matched)", async () => {
  const id = await insert();
  const body = matchBody(TX.a, id);
  assert.equal((await match(id, body)).status, 200);
  const replay = await match(id, body);
  assert.equal(replay.status, 400);
  assert.match(replay.json.error!.message, /already used/);
  const again = await match(id, matchBody(TX.a, id, message(TX.a, id, ME, Date.now() + 1000)));
  assert.equal(again.status, 200);
  assert.equal(MatchResponse.parse(again.json).already_matched, true);
});

it("refuses: another wallet's signature, a stale or reworded message, the wrong recipient", async () => {
  const id = await insert();
  const mallory = await match(id, matchBody(TX.a, id, message(TX.a, id), MALLORY_KEY));
  assert.match(mallory.json.error!.message, /doesn't match this message for wallet/);
  const stale = await match(id, matchBody(TX.a, id, message(TX.a, id, ME, Date.now() - 6 * 60_000)));
  assert.match(stale.json.error!.message, /more than 5 minutes old/);
  const otherTx = await match(id, { ...matchBody(TX.b, id), transaction: TX.a }); // signed for TX.b, sent for TX.a
  assert.match(otherTx.json.error!.message, /must read "Owed match/);
  const wrongRecipient = await match(id, matchBody(TX.a, id, message(TX.a, id, MALLORY), MALLORY_KEY, MALLORY));
  assert.match(wrongRecipient.json.error!.message, /only the wallet this request pays/);
  assert.equal((await read(id)).status, "open");
});

it("refuses a transaction that credits a different amount, landed before the request, failed, or never paid this wallet", async () => {
  const twoCents = await insert({ amountAtomic: 20_000n });
  const wrong = await match(twoCents, matchBody(TX.a, twoCents));
  assert.equal(wrong.json.error!.message, "that transaction credits 0.01 USDC, not 0.02 USDC (this request's amount); only an exact match can be confirmed");

  const late = await insert({ createdAt: "2026-10-17T18:00:00Z" });
  assert.match((await match(late, matchBody(TX.a, late))).json.error!.message, /landed at 2026-10-17T17:14:15Z, before this request was made/);

  const out = await insert();
  assert.match((await match(out, matchBody(TX.outgoing, out))).json.error!.message, /sends no USDC to/);

  const unknown = await insert();
  const missing = "4".repeat(87) + "1";
  assert.match((await match(unknown, matchBody(missing, unknown))).json.error!.message, /isn't on Solana mainnet/);
  for (const id of [twoCents, late, out, unknown]) assert.equal((await read(id)).status, "open");
});

it("a transaction that names a request's reference, or already settles one, is never re-attributed", async () => {
  // mBef… carries qNaosx73zzt3's reference: by Owed's rules it pays that request.
  await insert({ reference: QNAOS_REF, createdAt: "2026-10-17T18:30:00Z" });
  const id = await insert();
  assert.match((await match(id, matchBody(TX.referenced, id))).json.error!.message, /carries the reference of another Owed request/);

  await insert({ status: "paid", paid: { signature: TX.b, payer: GSWH, amountAtomic: 10_000n, at: "2026-10-17T17:22:33Z" } });
  assert.match((await match(id, matchBody(TX.b, id))).json.error!.message, /already settles Owed request/);

  // One transaction, one request: matched to A, it can't be matched to B.
  const a = await insert();
  const b = await insert();
  assert.equal((await match(a, matchBody(TX.a, a))).status, 200);
  assert.match((await match(b, matchBody(TX.a, b))).json.error!.message, /already settles Owed request|already matched to another/);
  assert.equal((await read(b)).status, "open");
});

it("an underpaid request takes the exact remainder: paid in total, the referenced payment keeps its rail, the rest is labelled", async () => {
  const id = await insert({ amountAtomic: 1_010_000n, status: "underpaid", createdAt: "2026-10-17T15:00:00Z",
    paid: { signature: TX.one, payer: GSWH, amountAtomic: 1_000_000n, at: "2026-10-17T15:32:04Z" } });
  // The whole amount (1.01) doesn't match: only the remainder does.
  const whole = await match(id, matchBody(TX.one, id));
  assert.match(whole.json.error!.message, /already settles Owed request|credits 1 USDC, not 0.01 USDC/);
  const { status, json } = await match(id, matchBody(TX.b, id));
  assert.equal(status, 200, JSON.stringify(json));
  const res = MatchResponse.parse(json);
  assert.equal(res.status, "paid");
  assert.deepEqual(res.paid, { signature: TX.one, payer: GSWH, amount: "1.01", at: "2026-10-17T15:32:04Z", rail: "solana_pay" });
  assert.equal(res.matched?.covers, "rest");
  assert.equal(res.matched?.amount, "0.01");
  assert.deepEqual(contractErrors("matchRes", json), []);
  const [st] = await statusOf([id]);
  assert.equal(st.status, "paid");
  assert.equal(st.amount_paid, "1.01");
  assert.equal(st.matched?.covers, "rest");
});

it("Solana unreachable: nothing is written and the agent is told to try again", async () => {
  const id = await insert();
  rpcDown = true;
  const { status, json } = await match(id, matchBody(TX.a, id));
  assert.equal(status, 503);
  assert.match(json.error!.message, /couldn't be read/);
  rpcDown = false;
  assert.equal((await read(id)).status, "open");
  assert.equal((await pg.query(`select 1 from request_matches`)).rows.length, 0);
});

// ------------------------------------------------------------------------------------------- ask_for_rest

it("ask_for_rest: one linked request for exactly the remainder; asking again returns it; the ledger counts the rest once", async () => {
  const parent = await insert({ amountAtomic: 500_000n, status: "underpaid",
    paid: { signature: TX.b, payer: GSWH, amountAtomic: 250_000n, at: "2026-10-17T17:22:33Z" } });
  const first = await askRest(parent);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const rest = RestResponse.parse(first.json);
  assert.equal(rest.amount, "0.25");
  assert.equal(rest.rest_of, parent);
  assert.equal(rest.recipient, ME);
  assert.equal(rest.already_asked, false);
  assert.deepEqual(contractErrors("restRes", first.json), []);
  const again = await askRest(parent);
  assert.equal(again.status, 200);
  assert.equal(RestResponse.parse(again.json).id, rest.id);
  assert.equal(RestResponse.parse(again.json).already_asked, true);

  const p = await read(parent);
  assert.deepEqual(p.rest_request, { id: rest.id, status: "open", link: `${BASE}/r/${rest.id}` });
  const child = await read(rest.id);
  assert.equal(child.rest_of, parent);
  assert.equal(child.payer_name, "Priya");
  assert.deepEqual(contractErrors("getRequestRes", child), []);
  const [ps] = await statusOf([parent]);
  assert.equal(ps.rest_request, rest.id);

  const ledger = await getLedger(ME, { base: BASE });
  LedgerResponse.parse(ledger);
  assert.deepEqual(ledger.open.map((e) => [e.id, e.amount_due, e.rest_of ?? null]), [[rest.id, "0.25", parent]]);
  assert.deepEqual(ledger.totals, [{ token: "USDC", outstanding: "0.25", received_30d: "0.25", open_count: 1, paid_count: 0 }]);
  assert.deepEqual(contractErrors("ledgerRes", ledger), []);
});

it("ask_for_rest refuses an open, paid or unknown request", async () => {
  const open = await insert();
  assert.match((await askRest(open)).json.error!.message, /only an underpaid request has a rest to ask for, and this one is open/);
  const paid = await insert({ status: "paid", paid: { signature: TX.a, payer: GSWH, amountAtomic: 10_000n, at: "2026-10-17T17:14:15Z" } });
  assert.match((await askRest(paid)).json.error!.message, /already paid in full/);
  assert.equal((await askRest("1111111111ab")).status, 404);
});

// ------------------------------------------------------------------------------------------- attributed + proof

it("/attributed names what is already counted and which keys are Owed references", async () => {
  const qn = await insert({ reference: QNAOS_REF, status: "paid", paid: { signature: TX.referenced, payer: GSWH, amountAtomic: 10_000n, at: "2026-10-17T18:37:27Z" } });
  const m = await insert();
  assert.equal((await match(m, matchBody(TX.a, m))).status, 200);
  const { status, json } = await post(attributedRoute as never, "/api/v1/attributed", { signatures: [TX.referenced, TX.a, TX.b], keys: [QNAOS_REF, GSWH] });
  assert.equal(status, 200);
  const res = AttributedResponse.parse(json);
  assert.deepEqual(new Set(res.attributed.map((a) => `${a.signature}:${a.request_id}:${a.how}`)), new Set([`${TX.referenced}:${qn}:reference`, `${TX.a}:${m}:matched`]));
  assert.deepEqual(res.references, [{ key: QNAOS_REF, request_id: qn }]);
  assert.deepEqual(contractErrors("attributedRes", json), []);
  assert.equal((await post(attributedRoute as never, "/api/v1/attributed", { signatures: ["not a signature"] })).status, 400);
});

it("/proof lists a team payment matched by the recipient with its own chip, never as Solana Pay", async () => {
  process.env.OWED_TEAM_WALLETS = GSWH;
  const id = await insert();
  assert.equal((await match(id, matchBody(TX.a, id))).status, 200);
  const proof = await loadProof();
  assert.deepEqual(proof.rails, { solana_pay: 0, x402: 0, matched: 1 });
  assert.deepEqual([proof.payments[0]!.id, proof.payments[0]!.rail, proof.payments[0]!.amount], [id, "matched", "0.01"]);
});
