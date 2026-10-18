import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { POST as createPotRoute } from "@/app/api/v1/pots/route";
import { GET as getPotRoute } from "@/app/api/v1/pots/[id]/route";
import { POST as contributeRoute } from "@/app/api/v1/pots/[id]/contributions/route";
import { POST as payRoute, GET as payLabelRoute } from "@/app/api/v1/pay/[id]/route";
import { GET as getRequestRoute } from "@/app/api/v1/requests/[id]/route";
import { GET as x402Route } from "@/app/x/[id]/route";
import { GET as potX402Route } from "@/app/x/pot/[potId]/[amount]/route";
import { GET as statsRoute } from "@/app/api/v1/stats/route";
import { LedgerPotsResponse, PotContributionResponse, PotResponse, StatsPotsResponse } from "@/lib/contract";
import { sql } from "@/lib/db";
import { potIdFor, requestIdFor } from "@/lib/ids";
import { getLedger } from "@/lib/ledger";
import { CONTRIBUTION_LIMITS, getPot, mintContribution, potTransactionRequestUrl, withPots } from "@/lib/pots";
import { getPublicRequest } from "@/lib/public-api";
import { getRequest } from "@/lib/requests";
import { handlePotX402, type PotX402Deps, type X402Deps } from "@/lib/x402/handler";
import { store } from "@/lib/x402/store";
import { parseJsonExact } from "@/lib/solana";
import type { Facilitator, Supported } from "@/lib/x402/facilitator";

// F7 chip-in pots on real Postgres: migration 0019, the three pot routes, the pot's transaction request
// (/api/v1/pay/<pot id>), its x402 presets (/x/pot/<id>/<amount>), the ledger and stats. PGlite answers lib/db.ts's
// Neon-over-HTTP calls; Solana answers from the transactions a test puts on `chain` (an unknown reference has no
// signatures). Any other network call fails. Skips until @electric-sql/pglite is installed.

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

// ---------------------------------------------------------------- wallets and chain

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest();
const key = (label: string) => bs58.encode(sha(label));
/** A deterministic ed25519 wallet address (on the curve, so it can sign and pay). */
function wallet(label: string): string {
  const k = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sha(`owed pots-db test: ${label}`)]), format: "der", type: "pkcs8" });
  return bs58.encode(createPublicKey(k).export({ format: "der", type: "spki" }).subarray(12));
}
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const TEAM_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // off curve: a token account
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ANA = wallet("ana");
const BEN = wallet("ben");
const CAL = wallet("cal");
const BLOCKHASH = key("pots-db test blockhash");
let sigSeq = 0;
/** A fresh 64-byte base58 signature per call. */
const signature = () => bs58.encode(Buffer.concat([sha(`sig a ${++sigSeq}`), sha(`sig b ${sigSeq}`)]));

const chain: Array<{ refs: string[]; tx: Record<string, unknown> }> = [];
const rpcCalls: string[] = [];

/** One USDC transferChecked from `payer` to `recipient` carrying `refs` as extra signer-less keys (jsonParsed shape). */
function paymentTx(sig: string, payer: string, recipient: string, amount: bigint, refs: string[]) {
  const payerAta = key(`ata of ${payer}`);
  const recipientAta = key(`ata of ${recipient}`);
  const keys = [payer, payerAta, recipientAta, USDC, TOKEN_PROGRAM, ...refs];
  return {
    slot: 400_000_000 + sigSeq, blockTime: Math.floor(Date.now() / 1000), version: "legacy",
    meta: {
      err: null, preBalances: keys.map(() => 1_000_000), postBalances: keys.map(() => 1_000_000),
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: payer, uiTokenAmount: { amount: String(amount * 2n) } },
        { accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: payer, uiTokenAmount: { amount: String(amount) } },
        { accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: String(amount) } },
      ],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [
          { program: "spl-token", parsed: { type: "transferChecked", info: { source: payerAta, mint: USDC, destination: recipientAta, authority: payer, signers: refs, tokenAmount: { amount: String(amount), decimals: 6 } } } },
          { program: "spl-memo", parsed: "owed:contribution" },
        ],
      },
    },
  };
}
/** Puts a payment on chain and returns what it credited the recipient (the on-chain amount, from the balance delta). */
function pay(payer: string, amount: bigint, refs: string[], recipient = TEAM): { sig: string; credited: bigint } {
  const sig = signature();
  const tx = paymentTx(sig, payer, recipient, amount, refs);
  chain.push({ refs, tx });
  const post = BigInt(tx.meta.postTokenBalances[1].uiTokenAmount.amount);
  const pre = BigInt(tx.meta.preTokenBalances[1].uiTokenAmount.amount);
  return { sig, credited: post - pre };
}

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
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
    }
    if (/^https:\/\/(solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com)\/?$/.test(url)) {
      const body = JSON.parse(String(init!.body));
      const answer = (m: { id: number; method: string; params: unknown[] }) => {
        rpcCalls.push(m.method);
        if (m.method === "getSignaturesForAddress") {
          const list = chain.filter((t) => t.refs.includes(m.params[0] as string));
          return { jsonrpc: "2.0", id: m.id, result: list.map((t) => ({ signature: (t.tx.transaction as { signatures: string[] }).signatures[0], err: null })) };
        }
        if (m.method === "getTransaction") {
          const t = chain.find((c) => (c.tx.transaction as { signatures: string[] }).signatures[0] === m.params[0]);
          return { jsonrpc: "2.0", id: m.id, result: t?.tx ?? null };
        }
        if (m.method === "getLatestBlockhash") return { jsonrpc: "2.0", id: m.id, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } } };
        throw new TypeError(`no ${m.method} in this test`);
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

// ---------------------------------------------------------------- routes

const BASE = "https://owed-preview.example";
let ipSeq = 0;
const ip = () => `203.0.113.${(++ipSeq % 250) + 1}`;
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const postJson = (path: string, body: unknown, at = ip()) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": at }, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

async function newPot(body: Record<string, unknown> = {}) {
  // These tests make dozens of pots for one wallet; the per-recipient limit has its own test below.
  await sql("delete from rate_events where key = $1", [`pot-create:recipient:${String(body.recipient ?? TEAM)}`]);
  const res = await createPotRoute(postJson("/api/v1/pots", { recipient: TEAM, title: "Team dinner", source: "plugin", ...body }));
  assert.equal(res.status, 201, await res.clone().text());
  return PotResponse.parse(await res.json());
}
async function board(id: string) {
  const res = await getPotRoute(new Request(`${BASE}/api/v1/pots/${id}`), ctx({ id }));
  assert.equal(res.status, 200, await res.clone().text());
  return PotResponse.parse(await res.json());
}
const contributeRaw = (id: string, body: Record<string, unknown> = {}, at?: string) =>
  contributeRoute(postJson(`/api/v1/pots/${id}/contributions`, { source: "web", ...body }, at), ctx({ id }));
async function contribute(id: string, body: Record<string, unknown> = {}) {
  const res = await contributeRaw(id, body);
  assert.equal(res.status, 201, await res.clone().text());
  return PotContributionResponse.parse(await res.json());
}
const scan = (potId: string, account: string, query = "") =>
  payRoute(postJson(`/api/v1/pay/${potId}${query}`, { account }), ctx({ id: potId }));
/** Ends a pot as if its deadline had passed (created two days ago, ended a second ago). */
const endPot = (id: string) => sql(`update pots set created_at = now() - interval '2 days', deadline = now() - interval '1 second' where id = $1`, [id]);
/** Expires a contribution as if minted an hour ago with an end a second ago. */
const expire = (id: string) => sql(`update requests set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' where id = $1`, [id]);

// ---------------------------------------------------------------- migration

it("0019: pots table, the id/nonce/amount/deadline checks, requests.pot_id and the loosened expiry check", async () => {
  const [t] = await sql("select to_regclass('pots')::text as t");
  assert.equal(t.t, "pots");
  const insert = (over: Record<string, string>) => {
    const v = { id: "'11111111111111'", recipient: `'${TEAM}'`, token: "'USDC'", nonce: `'${key("nonce check")}'`, title: "'t'", deadline: "now() + interval '1 day'", presets: "'{}'", any_amount: "true", suggested: "null", ...over };
    return pg.query(`insert into pots (id, recipient, token, nonce, title, deadline, presets_atomic, any_amount, suggested_atomic, source)
      values (${v.id}, ${v.recipient}, ${v.token}, ${v.nonce}, ${v.title}, ${v.deadline}, ${v.presets}, ${v.any_amount}, ${v.suggested}, 'web')`);
  };
  await assert.rejects(insert({ id: "'1111111111111'" }), /pots_id_check/); // 13 characters
  await assert.rejects(insert({ deadline: "now() - interval '1 minute'" }), /pots_deadline_check/);
  await assert.rejects(insert({ deadline: "now() + interval '91 days'" }), /pots_deadline_check/);
  await assert.rejects(insert({ presets: "'{1,2,3,4,5}'" }), /pots_presets_check/);
  await assert.rejects(insert({ presets: "'{1000}'", token: "'SOL'" }), /pots_presets_check/);
  await assert.rejects(insert({ presets: "'{0}'" }), /pots_presets_check/);
  await assert.rejects(insert({ any_amount: "false" }), /pots_amount_rule_check/);
  await assert.rejects(insert({ title: "''" }), /pots_title_check/);
  // A request that isn't a contribution keeps the 0007 rule: at least a day.
  await assert.rejects(
    pg.query(`insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, expires_at)
      values ('1111111111ab', $1, 'USDC', $2, 6, 1, $3, 'web', now() + interval '1 hour')`, [TEAM, USDC, key("ref expiry")]),
    /requests_expires_check/,
  );
});

// ---------------------------------------------------------------- create

it("POST /api/v1/pots: defaults (USDC, any amount, 30 days), an id that commits to recipient + token via the nonce", async () => {
  const pot = await newPot({ title: "Lisbon gift https://evil.example/claim", note: "for Ana", requester_name: "Raj", requester_handle: "@RajKaria", target: "100", suggested: "10" });
  assert.equal(pot.id.length, 14);
  assert.equal(potIdFor({ recipient: TEAM, token: "USDC", nonce: pot.nonce }), pot.id);
  assert.notEqual(potIdFor({ recipient: TEAM, token: "SOL", nonce: pot.nonce }), pot.id);
  assert.equal(pot.title, "Lisbon gift"); // the link is stripped
  assert.deepEqual([pot.token, pot.any_amount, pot.target, pot.suggested, pot.status, pot.requester_handle], ["USDC", true, "100", "10", "open", "rajkaria"]);
  const days = (Date.parse(pot.deadline) - Date.parse(pot.created_at)) / 86_400_000;
  assert.ok(Math.abs(days - 30) < 0.01, String(days));
  assert.deepEqual(pot.totals, { raised: "0", count: 0 });
  assert.equal(pot.link, `${BASE}/pot/${pot.id}`);
  assert.deepEqual(pot.links.transaction_request, [{ amount: "10", url: potTransactionRequestUrl(BASE, pot.id, "10") }]);
  assert.equal(pot.links.transaction_request[0].url, `solana:${encodeURIComponent(`${BASE}/api/v1/pay/${pot.id}?amount=10`)}`);
  assert.deepEqual(pot.links.x402, []);
});

it("POST /api/v1/pots: presets become x402 endpoints and transaction requests; a fixed-amount pot; an exact deadline", async () => {
  const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const pot = await newPot({ suggested: "10", presets: ["5", "10", "20"], any_amount: false, deadline });
  assert.deepEqual(pot.presets, ["5", "10", "20"]);
  assert.deepEqual(pot.links.transaction_request.map((l) => l.amount), ["10", "5", "20"]); // suggested first, each once
  assert.deepEqual(pot.links.x402, ["5", "10", "20"].map((a) => ({ amount: a, url: `${BASE}/x/pot/${pot.id}/${a}` })));
  assert.equal(Date.parse(pot.deadline), Math.floor(Date.parse(deadline) / 1000) * 1000);
  const sol = await newPot({ token: "SOL", suggested: "0.5", deadline_days: 7 });
  assert.equal(potIdFor({ recipient: TEAM, token: "SOL", nonce: sol.nonce }), sol.id);
});

it("POST /api/v1/pots: refusals (token account, SOL presets, duplicates, fixed without amounts, deadlines, sanctions, empty title)", async () => {
  const refused = async (body: Record<string, unknown>, code = "invalid_input", status = 400) => {
    const res = await createPotRoute(postJson("/api/v1/pots", { recipient: TEAM, title: "x", ...body }));
    assert.equal(res.status, status, JSON.stringify(body));
    const e = await errorOf(res);
    assert.equal(e.code, code);
    return e.message;
  };
  assert.match(await refused({ recipient: TEAM_ATA }), /not a token account/);
  assert.match(await refused({ token: "SOL", presets: ["1"] }), /USDC only/);
  assert.match(await refused({ presets: ["5", "5.0"] }), /different/);
  assert.match(await refused({ any_amount: false }), /needs a suggested amount or presets/);
  assert.match(await refused({ presets: ["1", "2", "3", "4", "5"] }), /at most 4/);
  assert.match(await refused({ deadline: new Date(Date.now() + 60_000).toISOString() }), /at least 10 minutes/);
  assert.match(await refused({ deadline: new Date(Date.now() + 91 * 86_400_000).toISOString() }), /at most 90 days/);
  assert.match(await refused({ deadline_days: 91 }), /at most 90/);
  assert.match(await refused({ deadline_days: 3, deadline: new Date(Date.now() + 86_400_000).toISOString() }), /not both/);
  assert.match(await refused({ suggested: "0" }), /suggested:/);
  assert.match(await refused({ title: "https://only.example/a-link" }), /title/);
  assert.match(await refused({ requester_handle: "not a handle!" }), /requester_handle/);
  const sanctioned = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"; // the first Solana address on the OFAC SDN list (lib/ofac-sdn.ts)
  assert.match(await refused({ recipient: sanctioned }, "blocked", 403), /sanctions/);
});

it("POST /api/v1/pots: brand words in the title, note, name or handle flag the pot and every contribution", async () => {
  const pot = await newPot({ title: "PayBox refund pool", requester_handle: "moonpay_help", suggested: "1" });
  assert.deepEqual([...pot.flags].sort(), ["brand_word:moonpay", "brand_word:paybox", "brand_word:refund"]);
  const c = await contribute(pot.id);
  assert.deepEqual([...c.flags].sort(), [...pot.flags].sort());
});

it("POST /api/v1/pots: rate limited per recipient", async () => {
  const recipient = wallet("busy recipient");
  for (let i = 0; i < 20; i++) {
    const res = await createPotRoute(postJson("/api/v1/pots", { recipient, title: `pot ${i}` }));
    assert.equal(res.status, 201);
  }
  const res = await createPotRoute(postJson("/api/v1/pots", { recipient, title: "one too many" }));
  assert.equal(res.status, 429);
  assert.match((await errorOf(res)).message, /for this recipient/);
});

// ---------------------------------------------------------------- read

it("GET /api/v1/pots/:id: 404 unknown, 400 malformed; a 12-character request id is not a pot", async () => {
  const unknown = await getPotRoute(new Request(`${BASE}/api/v1/pots/11111111111111`), ctx({ id: "11111111111111" }));
  assert.equal(unknown.status, 404);
  for (const bad of ["JArQ6g9JvoWr", "0OIl0OIl0OIl0O", "x"]) {
    const res = await getPotRoute(new Request(`${BASE}/api/v1/pots/${bad}`), ctx({ id: bad }));
    assert.equal(res.status, 400, bad);
  }
});

// ---------------------------------------------------------------- contributions

it("POST contributions: an ordinary request (hash of its terms) carrying the pot, its title as `for`, expiring in 24 h", async () => {
  const pot = await newPot({ suggested: "12.5", note: "thanks!", requester_name: "Raj" });
  const c = await contribute(pot.id);
  assert.equal(c.amount, "12.5");
  assert.equal(c.kind, "single");
  assert.equal(c.recipient, TEAM);
  assert.equal(c.id, requestIdFor({ recipient: TEAM, token: "USDC", amountAtomic: 12_500_000n, reference: c.reference }));
  assert.deepEqual(c.pot, { id: pot.id, title: "Team dinner", link: `${BASE}/pot/${pot.id}` });
  assert.deepEqual([c.for, c.note, c.requester_name, c.payer_name], ["Team dinner", "thanks!", "Raj", null]);
  assert.match(c.solana_pay_url!, new RegExp(`memo=owed%3A${c.id}`));
  assert.equal(c.x402_url, `${BASE}/x/${c.id}`);
  const hours = (Date.parse(c.expires_at!) - Date.parse(c.created_at)) / 3_600_000;
  assert.ok(Math.abs(hours - 24) < 0.01, String(hours));
  // Two clicks are two contributions with their own references.
  const d = await contribute(pot.id);
  assert.notEqual(d.reference, c.reference);
  // GET /api/v1/requests/:id shows the pot too.
  const res = await getRequestRoute(new Request(`${BASE}/api/v1/requests/${c.id}`), ctx({ id: c.id }));
  assert.deepEqual(PotContributionResponse.parse(await res.json()).pot, c.pot);
  const [row] = await sql("select pot_id, kind, payer_wallet from requests where id = $1", [c.id]);
  assert.deepEqual(row, { pot_id: pot.id, kind: "single", payer_wallet: null });
});

it("POST contributions: a contribution near the deadline expires with the pot, not 24 h later", async () => {
  const pot = await newPot({ suggested: "1", deadline: new Date(Date.now() + 2 * 3_600_000).toISOString() });
  const c = await contribute(pot.id);
  assert.equal(Date.parse(c.expires_at!), Date.parse(pot.deadline));
});

it("POST contributions: amount rules (default suggested, any amount, fixed amounts only, no amount at all)", async () => {
  const open = await newPot({ suggested: "10" });
  assert.equal((await contribute(open.id, { amount: "3.33" })).amount, "3.33");
  const fixed = await newPot({ suggested: "10", presets: ["5", "20"], any_amount: false });
  for (const a of ["5", "10", "20"]) assert.equal((await contribute(fixed.id, { amount: a })).amount, a);
  const no = await contributeRaw(fixed.id, { amount: "7" });
  assert.equal(no.status, 400);
  assert.match((await errorOf(no)).message, /takes 10 USDC, 5 USDC, 20 USDC only/);
  const bare = await newPot();
  const none = await contributeRaw(bare.id);
  assert.equal(none.status, 400);
  assert.match((await errorOf(none)).message, /no suggested amount.*pot page/);
  const tooPrecise = await contributeRaw(open.id, { amount: "0.0000001" });
  assert.equal(tooPrecise.status, 400);
  const unknown = await contributeRaw("11111111111111", { amount: "1" });
  assert.equal(unknown.status, 404);
});

it("POST contributions: rate limited per client per pot", async () => {
  const pot = await newPot({ suggested: "1" });
  const at = "198.51.100.77";
  for (let i = 0; i < CONTRIBUTION_LIMITS.perIpPerPotPerHour; i++) assert.equal((await contributeRaw(pot.id, {}, at)).status, 201);
  const res = await contributeRaw(pot.id, {}, at);
  assert.equal(res.status, 429);
  assert.match((await errorOf(res)).message, /from this client/);
  assert.equal((await contributeRaw(pot.id, {}, "198.51.100.78")).status, 201); // another client still can
});

// ---------------------------------------------------------------- acceptance

it("acceptance: three contributions from three wallets each count once, and the board total is the on-chain sum", async () => {
  const pot = await newPot({ title: "Farewell gift", target: "100", suggested: "10" });
  const a = await contribute(pot.id, { amount: "10" });
  const b = await contribute(pot.id, { amount: "25" });
  const c = await contribute(pot.id, { amount: "7.5" });
  await contribute(pot.id); // a click nobody paid: never counted
  const paid = [pay(ANA, 10_000_000n, [a.reference]), pay(BEN, 25_000_000n, [b.reference]), pay(CAL, 7_500_000n, [c.reference])];
  const onChain = paid.reduce((s, p) => s + p.credited, 0n);
  const read = await board(pot.id);
  assert.equal(read.chain_checked, true);
  assert.equal(read.totals.count, 3);
  assert.equal(read.totals.raised, "42.5");
  assert.equal(BigInt(Math.round(Number(read.totals.raised) * 1e6)), onChain);
  assert.deepEqual(new Set(read.contributions.map((x) => x.payer)), new Set([ANA, BEN, CAL]));
  assert.deepEqual(new Set(read.contributions.map((x) => x.signature)), new Set(paid.map((p) => p.sig)));
  assert.deepEqual(new Set(read.contributions.map((x) => x.id)), new Set([a.id, b.id, c.id]));
  // Reading again counts nothing twice.
  await new Promise((r) => setTimeout(r, 3100)); // lib/requests.ts checks a request on chain at most every 3 s
  const again = await board(pot.id);
  assert.deepEqual([again.totals.count, again.totals.raised], [3, "42.5"]);
  const rows = await sql("select count(*)::int as n from requests where pot_id = $1 and status = 'paid'", [pot.id]);
  assert.equal(Number(rows[0].n), 3);
});

it("the same wallet contributing twice counts twice", async () => {
  const pot = await newPot({ suggested: "5" });
  const a = await contribute(pot.id);
  const b = await contribute(pot.id);
  pay(ANA, 5_000_000n, [a.reference]);
  pay(ANA, 5_000_000n, [b.reference]);
  const read = await board(pot.id);
  assert.deepEqual([read.totals.count, read.totals.raised], [2, "10"]);
  assert.deepEqual(read.contributions.map((x) => x.payer), [ANA, ANA]);
});

it("one transfer can't settle two contributions", async () => {
  const pot = await newPot({ suggested: "4" });
  const a = await contribute(pot.id);
  const b = await contribute(pot.id);
  const { sig } = pay(BEN, 4_000_000n, [a.reference, b.reference]); // one transfer carrying both references
  const read = await board(pot.id);
  assert.deepEqual([read.totals.count, read.totals.raised], [1, "4"]);
  const statuses = (await sql("select status from requests where id = any($1::text[]) order by status", [[a.id, b.id]])).map((r) => r.status);
  assert.deepEqual(statuses, ["open", "paid"]);
  const open = (await sql("select id from requests where id = any($1::text[]) and status = 'open'", [[a.id, b.id]]))[0].id!;
  const [claimed] = await sql("select paid_instruction from requests where paid_signature = $1", [sig]);
  assert.equal(claimed.paid_instruction, "0"); // the transfer itself (F1), not the whole transaction
  await assert.rejects(pg.query("update requests set status = 'paid', paid_signature = $2, paid_instruction = 0 where id = $1", [open, sig]), /requests_paid_signature_key/);
});

it("a payment that lands after the deadline is still recorded and counts on the board (the chain is the truth)", async () => {
  const pot = await newPot({ suggested: "3" });
  const c = await contribute(pot.id);
  await endPot(pot.id);
  await expire(c.id);
  pay(CAL, 3_000_000n, [c.reference]);
  const read = await board(pot.id);
  assert.equal(read.status, "ended");
  assert.deepEqual([read.totals.count, read.totals.raised], [1, "3"]);
  assert.deepEqual(read.links.transaction_request, []);
});

// ---------------------------------------------------------------- transaction request

it("decoder: /api/v1/pay/<pot id>?amount=10 mints a contribution and returns exactly a 10 USDC transferChecked to the recipient's account, with its reference and memo", async () => {
  const pot = await newPot({ title: "Board QR", suggested: "5", presets: ["10"] });
  const before = Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n);
  const res = await scan(pot.id, ANA, "?amount=10");
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { transaction: string; message: string };
  assert.equal(body.message, `Contribute 10 USDC to ${TEAM.slice(0, 4)}…${TEAM.slice(-4)}`); // Owed's words only
  const minted = (await sql("select id, reference, amount_atomic::text as amount from requests where pot_id = $1 order by created_at desc, id limit 1", [pot.id]))[0];
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), before + 1);
  assert.equal(minted.amount, "10000000");

  const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
  assert.equal(tx.feePayer!.toBase58(), ANA);
  assert.equal(tx.recentBlockhash, BLOCKHASH);
  const programs = tx.instructions.map((ix) => ix.programId.toBase58());
  assert.deepEqual(programs, ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", MEMO, TOKEN_PROGRAM]);
  const memo = tx.instructions[1];
  assert.equal(Buffer.from(memo.data).toString("utf8"), `owed:${minted.id}`);
  const transfer = tx.instructions[2];
  assert.equal(transfer.data[0], 12); // transferChecked
  assert.equal(Buffer.from(transfer.data.subarray(1, 9)).readBigUInt64LE(0), 10_000_000n);
  assert.equal(transfer.data[9], 6);
  const mint = new PublicKey(USDC);
  const [source, mintKey, destination, owner, reference] = transfer.keys;
  assert.equal(source.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, new PublicKey(ANA)).toBase58());
  assert.equal(mintKey.pubkey.toBase58(), USDC);
  assert.equal(destination.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, new PublicKey(TEAM), true).toBase58());
  assert.equal(destination.pubkey.toBase58(), TEAM_ATA);
  assert.deepEqual([owner.pubkey.toBase58(), owner.isSigner], [ANA, true]);
  assert.deepEqual([reference.pubkey.toBase58(), reference.isSigner, reference.isWritable], [minted.reference, false, false]);
  assert.equal(transfer.keys.length, 5);
  // The minted contribution is the same request every other rail sees.
  const row = await getRequest(minted.id!);
  assert.deepEqual([row!.pot?.id, row!.amountAtomic, row!.status], [pot.id, 10_000_000n, "open"]);
  // GET (the wallet's label request) works for a pot id too.
  const label = await payLabelRoute(new Request(`${BASE}/api/v1/pay/${pot.id}`));
  assert.deepEqual(await label.json(), { label: "Owed", icon: `${BASE}/icon.svg` });
});

it("transaction request: each scan mints its own contribution; no amount uses the suggested one", async () => {
  const pot = await newPot({ suggested: "2" });
  for (const who of [ANA, BEN]) assert.equal((await scan(pot.id, who)).status, 200);
  const rows = await sql("select amount_atomic::text as a, reference from requests where pot_id = $1", [pot.id]);
  assert.deepEqual(rows.map((r) => r.a), ["2000000", "2000000"]);
  assert.notEqual(rows[0].reference, rows[1].reference);
});

it("transaction request: refusals mint nothing (no amount anywhere, an amount the pot doesn't take, the recipient paying itself, a bad account)", async () => {
  const bare = await newPot();
  const noAmount = await scan(bare.id, ANA);
  assert.equal(noAmount.status, 400);
  assert.match(((await noAmount.json()) as { message: string }).message, new RegExp(`Pick an amount on the pot page: ${BASE}/pot/${bare.id}`));
  const fixed = await newPot({ presets: ["5"], any_amount: false });
  const wrong = await scan(fixed.id, ANA, "?amount=6");
  assert.equal(wrong.status, 400);
  assert.match(((await wrong.json()) as { message: string }).message, /takes 5 USDC only/);
  const self = await scan(fixed.id, TEAM, "?amount=5");
  assert.equal(self.status, 400);
  const badAccount = await scan(fixed.id, TEAM_ATA, "?amount=5");
  assert.equal(badAccount.status, 400);
  const minted = await sql("select count(*)::int as n from requests where pot_id = any($1::text[])", [[bare.id, fixed.id]]);
  assert.equal(Number(minted[0].n), 0);
  const unknown = await scan("11111111111111", ANA, "?amount=1");
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------- x402 presets

interface PaymentsFixture {
  request: { id: string; recipient: string; amountAtomic: string; reference: string };
  headers: Record<"honestV2" | "tamperedAcceptedAmount" | "tamperedTxAmount" | "honestV1", string>;
}
const payments = parseJsonExact(readFileSync(new URL("fixtures/x402/payments.json", import.meta.url), "utf8")) as PaymentsFixture;
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const supported: Supported = { feePayers: { v1: FEE_PAYER, v2: FEE_PAYER }, signers: new Set([FEE_PAYER]) } as Supported;

function x402Deps(over: { verify?: Facilitator["verify"]; settle?: Facilitator["settle"]; calls?: string[] } = {}): X402Deps & PotX402Deps {
  const calls = over.calls ?? [];
  return {
    load: getRequest,
    refresh: async (row) => row,
    facilitator: {
      supported: async () => supported,
      verify: over.verify ?? (async (...args) => { calls.push("verify"); void args; return { isValid: true, payer: wallet("x402 payer") }; }),
      settle: over.settle ?? (async () => { calls.push("settle"); return { success: true, transaction: SETTLED_SIG, network: "solana", payer: wallet("x402 payer") }; }),
    } as Facilitator,
    store,
    waitForSettlement: async (sig, t) => {
      calls.push(`chain ${t.id}`);
      return { status: "verified", credit: { signature: sig, payer: wallet("x402 payer"), amountAtomic: t.amountAtomic, at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), slot: 1 } } as never;
    },
    now: Date.now,
    loadPot: getPot,
    mint: (pot, amountAtomic) => mintContribution(pot, amountAtomic, "web"),
  };
}
const SETTLED_SIG = bs58.encode(Buffer.concat([sha("x402 settled a"), sha("x402 settled b")]));
const x402Request = (path: string, header?: string) =>
  new Request(`${BASE}${path}`, { headers: header ? { "payment-signature": header } : {} });

it("x402 preset: no payment header → a 402 built from the pot's terms, and no row is written", async () => {
  const pot = await newPot({ recipient: payments.request.recipient, presets: ["0.01", "1"] });
  const res = await handlePotX402(x402Request(`/x/pot/${pot.id}/0.01`), pot.id, "0.01", BASE, x402Deps());
  assert.equal(res.status, 402);
  const v1 = (await res.json()) as { accepts: Array<{ payTo: string; maxAmountRequired: string; resource: string; description: string }> };
  assert.deepEqual([v1.accepts[0].payTo, v1.accepts[0].maxAmountRequired, v1.accepts[0].resource], [payments.request.recipient, "10000", `${BASE}/x/pot/${pot.id}/0.01`]);
  assert.match(v1.accepts[0].description, new RegExp(`^Owed pot ${pot.id}: a contribution of 0.01 USDC to`));
  const v2 = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString()) as { accepts: Array<{ amount: string; payTo: string }>; resource: { url: string } };
  assert.deepEqual([v2.accepts[0].amount, v2.accepts[0].payTo, v2.resource.url], ["10000", payments.request.recipient, `${BASE}/x/pot/${pot.id}/0.01`]);
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), 0);
  const notPreset = await handlePotX402(x402Request(`/x/pot/${pot.id}/2`), pot.id, "2", BASE, x402Deps());
  assert.equal(notPreset.status, 404);
  assert.match((await errorOf(notPreset)).message, /no x402 preset for 2 USDC; its presets are/);
});

it("x402 preset: a tampered payment is refused before /verify and mints nothing", async () => {
  const pot = await newPot({ recipient: payments.request.recipient, presets: ["0.01"] });
  const calls: string[] = [];
  for (const header of [payments.headers.tamperedAcceptedAmount, payments.headers.tamperedTxAmount]) {
    const res = await handlePotX402(x402Request(`/x/pot/${pot.id}/0.01`, header), pot.id, "0.01", BASE, x402Deps({ calls }));
    assert.equal(res.status, 402);
  }
  assert.deepEqual(calls, []);
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), 0);
  // An invalid payment at /verify mints nothing either.
  const invalid = await handlePotX402(x402Request(`/x/pot/${pot.id}/0.01`, payments.headers.honestV2), pot.id, "0.01", BASE,
    x402Deps({ verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) }));
  assert.equal(invalid.status, 402);
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), 0);
});

it("x402 preset: a verified payment mints one contribution, settles it like /x/<id>, and it counts on the board", async () => {
  const pot = await newPot({ recipient: payments.request.recipient, presets: ["0.01"] });
  const calls: string[] = [];
  const res = await handlePotX402(x402Request(`/x/pot/${pot.id}/0.01`, payments.headers.honestV2), pot.id, "0.01", BASE, x402Deps({ calls }));
  assert.equal(res.status, 200, await res.clone().text());
  const receipt = (await res.json()) as { paid: boolean; id: string; rail: string; signature: string; pot: { id: string; link: string } };
  assert.deepEqual([receipt.paid, receipt.rail, receipt.signature], [true, "x402", SETTLED_SIG]);
  assert.deepEqual(receipt.pot, { id: pot.id, link: `${BASE}/pot/${pot.id}` });
  assert.deepEqual(calls, ["verify", "settle", `chain ${receipt.id}`]);
  const row = await getRequest(receipt.id);
  assert.deepEqual([row!.status, row!.paidRail, row!.pot?.id, row!.amountAtomic], ["paid", "x402", pot.id, 10_000n]);
  const read = await board(pot.id);
  assert.deepEqual([read.totals.count, read.totals.raised, read.contributions[0].rail], [1, "0.01", "x402"]);
});

it("x402 preset: SOL pots and unknown pots are refused", async () => {
  const sol = await newPot({ token: "SOL", suggested: "1" });
  const res = await handlePotX402(x402Request(`/x/pot/${sol.id}/1`), sol.id, "1", BASE, x402Deps());
  assert.equal(res.status, 400);
  assert.match((await errorOf(res)).message, /USDC pots only/);
  const none = await handlePotX402(x402Request("/x/pot/11111111111111/1"), "11111111111111", "1", BASE, x402Deps());
  assert.equal(none.status, 404);
});

// ---------------------------------------------------------------- past the deadline, every rail refuses

it("deadline: the contributions API refuses an ended pot", async () => {
  const pot = await newPot({ suggested: "1" });
  await endPot(pot.id);
  const res = await contributeRaw(pot.id);
  assert.equal(res.status, 400);
  assert.match((await errorOf(res)).message, /This pot ended at .* no longer takes contributions/);
  assert.equal((await board(pot.id)).status, "ended");
});

it("deadline: the pot's transaction request (/api/v1/pay/<pot id>) refuses and mints nothing", async () => {
  const pot = await newPot({ suggested: "1" });
  await endPot(pot.id);
  const res = await scan(pot.id, ANA, "?amount=1");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /This pot ended/);
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), 0);
});

it("deadline: the x402 preset refuses with no challenge and no row (through the real route)", async () => {
  const pot = await newPot({ presets: ["1"] });
  await endPot(pot.id);
  const res = await potX402Route(new Request(`${BASE}/x/pot/${pot.id}/1`), ctx({ potId: pot.id, amount: "1" }));
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  assert.match((await errorOf(res)).message, /This pot ended/);
  assert.equal(Number((await sql("select count(*)::int as n from requests where pot_id = $1", [pot.id]))[0].n), 0);
});

it("deadline: minting itself refuses once the deadline has passed (one statement, database clock)", async () => {
  const pot = await newPot({ suggested: "1" });
  const loaded = (await getPot(pot.id))!;
  await endPot(pot.id); // ends after the pot was read: the insert's own check refuses
  await assert.rejects(mintContribution(loaded, 1_000_000n, "web"), /This pot ended/);
});

it("deadline: a contribution's own transaction request (/api/v1/pay/<contribution id>) refuses once it expired", async () => {
  const pot = await newPot({ suggested: "1" });
  const c = await contribute(pot.id);
  await expire(c.id);
  const res = await payRoute(postJson(`/api/v1/pay/${c.id}`, { account: ANA }), ctx({ id: c.id }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /expired/);
});

it("deadline: a contribution's x402 endpoint (/x/<contribution id>) refuses once it expired", async () => {
  const pot = await newPot({ suggested: "1" });
  const c = await contribute(pot.id);
  await expire(c.id);
  const res = await x402Route(new Request(`${BASE}/x/${c.id}`), ctx({ id: c.id }));
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  assert.match((await errorOf(res)).message, /expired/);
});

it("deadline: the card checkout (/api/moonpay/<contribution id>) sends the payer back instead of to MoonPay once it expired", async () => {
  const pot = await newPot({ suggested: "5" });
  const open = await contribute(pot.id);
  const ended = await contribute(pot.id);
  await expire(ended.id);
  const env = { NEXT_PUBLIC_OWED_MOONPAY: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_owedtest", MOONPAY_SECRET_KEY: "sk_test_owedtest", OWED_BASE_URL: BASE };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const { GET } = await import("@/app/api/moonpay/[id]/route");
    const call = (id: string) => GET(new Request(`${BASE}/api/moonpay/${id}`, { headers: { "x-real-ip": ip() } }), ctx({ id }));
    const refused = await call(ended.id);
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get("Location"), `${BASE}/r/${ended.id}`);
    const allowed = await call(open.id);
    assert.equal(allowed.status, 303);
    assert.match(allowed.headers.get("Location")!, /^https:\/\/buy-sandbox\.moonpay\.com\//);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

it("deadline: the pay page's request reads as expired (no pay controls) once the contribution expired", async () => {
  const pot = await newPot({ suggested: "1" });
  const c = await contribute(pot.id);
  await expire(c.id);
  const pub = await getPublicRequest(c.id);
  assert.equal(pub!.status, "expired");
  const { modelFromRequest } = await import("@/lib/view/request-view");
  assert.equal(modelFromRequest(pub!, BASE).initial.status, "expired");
});

// ---------------------------------------------------------------- who_owes_me and stats

it("ledger: open contributions are nobody's debt; paid ones are received; open pots are listed with what they raised", async () => {
  const recipient = wallet("ledger recipient");
  const create = (body: Record<string, unknown>) => newPot({ recipient, ...body });
  const pot = await create({ title: "Office plant", suggested: "2", target: "20" });
  const old = await create({ title: "Old pot", suggested: "1" });
  await endPot(old.id);
  const paidC = await contribute(pot.id);
  await contribute(pot.id); // never paid
  const partial = await contribute(pot.id, { amount: "3" });
  pay(ANA, 2_000_000n, [paidC.reference], recipient);
  pay(BEN, 1_000_000n, [partial.reference], recipient); // less than asked: a partly paid contribution
  await board(pot.id); // settles them
  const ledger = await withPots(await getLedger(recipient, { base: BASE }), { base: BASE });
  const parsed = LedgerPotsResponse.parse(ledger);
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.paid_recently.map((e) => [e.id, e.amount_paid, e.for]), [[paidC.id, "2", "Office plant"]]);
  assert.deepEqual(parsed.totals, [{ token: "USDC", outstanding: "0", received_30d: "3", open_count: 0, paid_count: 1 }]);
  assert.deepEqual(parsed.pots, [{
    id: pot.id, link: `${BASE}/pot/${pot.id}`, title: "Office plant", token: "USDC", raised: "3", count: 2, target: "20", deadline: pot.deadline, flags: [],
  }]);
  // A recipient with no open pot gets no pots field at all.
  const none = await withPots(await getLedger(wallet("nobody"), { base: BASE }), { base: BASE });
  assert.equal("pots" in none, false);
});

it("stats: pots and paid contributions are counted; unpaid contributions never inflate paid_count", async () => {
  const beforeRes = StatsPotsResponse.parse(await (await statsRoute()).json());
  const pot = await newPot({ suggested: "1" });
  const c = await contribute(pot.id);
  await contribute(pot.id); // unpaid
  pay(CAL, 1_000_000n, [c.reference]);
  await board(pot.id);
  const after = StatsPotsResponse.parse(await (await statsRoute()).json());
  assert.equal(after.pots!.count, beforeRes.pots!.count + 1);
  assert.equal(after.pots!.paid_contributions, beforeRes.pots!.paid_contributions + 1);
  assert.equal(after.paid_count, beforeRes.paid_count + 1);
});
