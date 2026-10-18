import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { POST as autopayRoute } from "@/app/api/v1/autopay/route";
import { POST as revokeRoute } from "@/app/api/v1/autopay/revoke/route";
import { POST as inboxRoute } from "@/app/api/v1/inbox/route";
import { POST as blockRoute } from "@/app/api/v1/inbox/block/route";
import { POST as createRequestRoute } from "@/app/api/v1/requests/route";
import { GET as getOne } from "@/app/api/v1/requests/[id]/route";
import { POST as createInvoiceRoute } from "@/app/api/v1/invoices/route";
import { GET as getInvoiceRoute } from "@/app/api/v1/invoices/[id]/route";
import { POST as statusRoute } from "@/app/api/v1/status/route";
import { POST as ledgerRoute } from "@/app/api/v1/ledger/route";
import {
  AutopayCreateResponse, AutopayRevokeResponse, CreateRequestResponse, GetRequestResponse, InboxBlockResponse, InboxResponse, InvoiceResponse,
  LedgerResponse, StatusResponse,
} from "@/lib/contract";
import { autopayMessage, isoDate } from "@/lib/autopay-core";
import { createAutopayRule } from "@/lib/autopay";
import { sql } from "@/lib/db";

// F5 autopay and the F3 deposit link on real Postgres: migration 0022, POST /api/v1/autopay (signed, once, rebuilt from
// the fields), replacing and revoking rules, the inbox verdicts (eligible / over_limit / not_covered, the month cap across
// lines and across a payment made earlier this month, revoked, ended, brand caution, no USDC account, Solana unreadable),
// and deposit_url on POST /api/v1/requests and /api/v1/invoices (stored beside the request, shown by GET, flagged by
// /status and the ledger). PGlite answers lib/db.ts's Neon-over-HTTP calls; Solana answers from `accounts` below. Any
// other network call fails. Skips until @electric-sql/pglite is installed.

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

/** A deterministic ed25519 wallet that signs like PayBox request_wallet_sign {op:"solanaMessage"} (UTF-8 bytes, hex out). */
function wallet(label: string) {
  const seed = createHash("sha256").update(`owed autopay-db test: ${label}`, "utf8").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
  return { address, sign: (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("hex") };
}
type Wallet = ReturnType<typeof wallet>;
const LANDLORD = wallet("landlord");
const PLUMBER = wallet("plumber"); // has no USDC account
const FLAKY = wallet("flaky"); // its USDC account can't be read
const STRANGER = wallet("stranger"); // no rule covers it
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const TEAM_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // off curve: a token account
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ataOf = (owner: string) => getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(owner), true).toBase58();
const EXISTING_ATAS = new Set([ataOf(LANDLORD.address), ataOf(STRANGER.address), ataOf(TEAM)]);
const BROKEN_ATAS = new Set([ataOf(FLAKY.address)]);
const DEPOSIT = "https://deposit.paybox.sh/d/7f3a9c2e";

// Every signed message must differ (a message works once): each takes the next earlier whole second.
const startSecond = Math.floor(Date.now() / 1000);
let signedSeconds = 0;
const nextMs = () => (startSecond - ++signedSeconds) * 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const inDays = (days: number) => isoDate(Date.now() + days * 86_400_000);

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
let rpcCalls: Array<{ method: string; params: unknown[] }> = [];
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
        rpcCalls.push({ method: m.method, params: m.params });
        if (m.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: m.id, result: [] };
        if (m.method === "getMultipleAccounts") {
          const keys = m.params[0] as string[];
          if (keys.some((k) => BROKEN_ATAS.has(k))) throw new TypeError("RPC down for this account");
          return { jsonrpc: "2.0", id: m.id, result: { context: { slot: 1 }, value: keys.map((k) => (EXISTING_ATAS.has(k) ? { lamports: 2039280, data: ["", "base64"], owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false, rentEpoch: 0 } : null)) } };
        }
        if (m.method === "getAccountInfo") return { jsonrpc: "2.0", id: m.id, result: { context: { slot: 1 }, value: { lamports: 1 } } };
        if (m.method === "getMinimumBalanceForRentExemption") return { jsonrpc: "2.0", id: m.id, result: 890880 };
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
const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown, ip = `198.51.100.${(++ipSeq % 250) + 1}`) =>
  route(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) }));
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

interface RuleArgs { requester?: string; max?: string; month?: string; ends?: string; handle?: string; atMs?: number; signer?: Wallet; body?: Record<string, unknown> }
function ruleBody(payer: Wallet, a: RuleArgs = {}) {
  const requester = a.requester ?? LANDLORD.address;
  const max = a.max ?? "1500";
  const month = a.month ?? max;
  const ends = a.ends ?? inDays(30);
  const message = autopayMessage({ payer: payer.address, requester, maxPerRequestAtomic: BigInt(Math.round(Number(max) * 1e6)), maxPerMonthAtomic: BigInt(Math.round(Number(month) * 1e6)), ends }, a.atMs ?? nextMs());
  return {
    payer: payer.address, requester: { wallet: requester, ...(a.handle && { handle: a.handle }) }, max_per_request: max, max_per_month: month, ends,
    signed_message: message, signature: (a.signer ?? payer).sign(message), ...a.body,
  };
}
async function setRule(payer: Wallet, a: RuleArgs = {}) {
  const res = await post(autopayRoute, "/api/v1/autopay", ruleBody(payer, a));
  assert.equal(res.status, 201, await res.clone().text());
  return AutopayCreateResponse.parse(await res.json());
}
async function revoke(payer: Wallet, ruleId: string, signer = payer) {
  const message = `Owed autopay revoke ${ruleId} for ${payer.address} at ${iso(nextMs())}`;
  return post(revokeRoute, "/api/v1/autopay/revoke", { payer: payer.address, rule_id: ruleId, signed_message: message, signature: signer.sign(message) });
}
async function inbox(payer: Wallet) {
  const message = `Owed inbox access for ${payer.address} at ${iso(nextMs())}`;
  const res = await post(inboxRoute, "/api/v1/inbox", { payer: payer.address, signed_message: message, signature: payer.sign(message) });
  assert.equal(res.status, 200, await res.clone().text());
  const json = await res.json();
  return { raw: json as Record<string, unknown>, inbox: InboxResponse.parse(json) };
}
async function ask(payer: Wallet, from: string, amount: string, extra: Record<string, unknown> = {}) {
  const res = await post(createRequestRoute, "/api/v1/requests", { recipient: from, amount, token: "USDC", source: "plugin", payer: { wallet: payer.address }, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return CreateRequestResponse.parse(await res.json());
}
const verdictOf = (ib: InboxResponse, id: string) => ib.owed.find((e) => e.id === id)?.autopay;

// ---------------------------------------------------------------- rules

it("a signed rule is stored once, and the reply is the rule as the payer signed it", async () => {
  const payer = wallet("payer: store");
  const body = ruleBody(payer, { handle: "@Landlord_Bob" });
  const res = await post(autopayRoute, "/api/v1/autopay", body);
  assert.equal(res.status, 201, await res.clone().text());
  const { rule, replaced } = AutopayCreateResponse.parse(await res.json());
  assert.equal(replaced, null);
  assert.equal(rule.payer, payer.address);
  assert.deepEqual(rule.requester, { wallet: LANDLORD.address, handle: "landlord_bob", sns: null });
  assert.equal(rule.max_per_request, "1500");
  assert.equal(rule.max_per_month, "1500");
  assert.equal(rule.status, "active");
  assert.equal(rule.used_this_month, "0");
  assert.equal(rule.ends, body.ends);
  assert.equal(rule.ends_at, `${isoDate(Date.parse(`${body.ends}T00:00:00Z`) + 86_400_000)}T00:00:00Z`);
  assert.equal(rule.signed_message, body.signed_message);
  // The same signed message can't be used again.
  const again = await post(autopayRoute, "/api/v1/autopay", body);
  assert.equal(again.status, 400);
  assert.match((await errorOf(again)).message, /already used/);
  const [row] = await sql("select count(*)::int as n from autopay_rules where payer_wallet = $1", [payer.address]);
  assert.equal(row!.n, "1");
});

it("refused before anything is stored: stale, another signer, tampered fields, a different grammar", async () => {
  const payer = wallet("payer: refusals");
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [ruleBody(payer, { atMs: Date.now() - 6 * 60_000 }), /more than 5 minutes old/],
    [ruleBody(payer, { atMs: Date.now() + 5 * 60_000 }), /dated in the future/],
    [ruleBody(payer, { signer: STRANGER }), /doesn't match this message for wallet/],
    [{ ...ruleBody(payer), max_per_request: "1600", max_per_month: "1600" }, /must read "Owed autopay for .* up to 1600 USDC per request/],
    [{ ...ruleBody(payer), requester: { wallet: STRANGER.address } }, /must read "Owed autopay for .*: pay [1-9A-HJ-NP-Za-km-z]+ up to/],
    [{ ...ruleBody(payer), ends: inDays(31) }, /must read/],
  ];
  // Amounts are written as fromAtomic writes them: a message saying "1500.00" isn't the text the server rebuilds.
  const padded = ruleBody(payer);
  const paddedText = String(padded.signed_message).replace(" up to 1500 USDC per request", " up to 1500.00 USDC per request");
  cases.push([{ ...padded, max_per_request: "1500.00", signed_message: paddedText, signature: payer.sign(paddedText) }, /must read "Owed autopay for .* up to 1500 USDC per request/]);
  for (const [body, why] of cases) {
    const res = await post(autopayRoute, "/api/v1/autopay", body);
    assert.equal(res.status, 400, why.source);
    const err = await errorOf(res);
    assert.equal(err.code, "invalid_input");
    assert.match(err.message, why);
  }
  // A message in the inbox's "at <time>" form is not the rule's grammar.
  const b = ruleBody(payer);
  const atForm = String(b.signed_message).replace(/ \(at (.+)\)$/, " at $1");
  const res = await post(autopayRoute, "/api/v1/autopay", { ...b, signed_message: atForm, signature: payer.sign(atForm) });
  assert.match((await errorOf(res)).message, /\(at <time>\)/);
  const [row] = await sql("select count(*)::int as n from autopay_rules where payer_wallet = $1", [payer.address]);
  assert.equal(row!.n, "0");
});

it("field checks: the payer's own wallet, a token account, limits, end dates, handles, the token", async () => {
  const payer = wallet("payer: fields");
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [ruleBody(payer, { requester: payer.address }), /that is the payer's own wallet/],
    [ruleBody(payer, { requester: TEAM_ATA }), /must be a wallet, not a token account/],
    [ruleBody(payer, { requester: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }), /the Solana wallet the requests pay/],
    [ruleBody(payer, { max: "1500", month: "1000" }), /max_per_month must be at least max_per_request/],
    [ruleBody(payer, { max: "0" }), /max_per_request: amount must be a positive decimal/],
    [ruleBody(payer, { max: "1.0000001" }), /max_per_request: amount must be a positive decimal with at most 6 decimal places/],
    [ruleBody(payer, { max: "1000001" }), /at most 1000000 USDC/],
    [ruleBody(payer, { ends: inDays(-1) }), /in the past/],
    [ruleBody(payer, { ends: inDays(400) }), /at most a year away/],
    [ruleBody(payer, { handle: "not a handle" }), /requester.handle: an X handle/],
    [{ ...ruleBody(payer), token: "SOL" }, /USDC|Invalid input/],
  ];
  for (const [body, why] of cases) {
    const res = await post(autopayRoute, "/api/v1/autopay", body);
    assert.equal(res.status, 400, why.source);
    assert.match((await errorOf(res)).message, why);
  }
});

it("an .sns label is stored only when it names the requester's wallet right now", async () => {
  const payer = wallet("payer: sns");
  const resolveTo = (w: string) => async (name: string) => ({ ok: true as const, name, wallet: w, source: "owner" as const, warnings: [] });
  const body = ruleBody(payer);
  await assert.rejects(
    createAutopayRule({ ...body, token: "USDC", requester: { wallet: LANDLORD.address, sns: "landlord.sns" } }, { resolve: resolveTo(STRANGER.address) }),
    /requester.sns: landlord.sns points to .* not to the requester wallet/,
  );
  // That refusal didn't spend the signature: the same message stores the rule once the name checks out.
  const { rule } = await createAutopayRule({ ...body, token: "USDC", requester: { wallet: LANDLORD.address, sns: "landlord.sns" } }, { resolve: resolveTo(LANDLORD.address) });
  assert.deepEqual(rule.requester, { wallet: LANDLORD.address, handle: null, sns: "landlord.sns" });
});

it("a new rule for the same requester replaces the live one in the same transaction", async () => {
  const payer = wallet("payer: replace");
  const first = await setRule(payer, { max: "1000", month: "1000" });
  const second = await setRule(payer, { max: "1500", month: "3000" });
  assert.equal(second.replaced, first.rule.id);
  const rows = await sql("select id, (revoked_at is not null)::text as revoked, replaced_by from autopay_rules where payer_wallet = $1 order by created_at", [payer.address]);
  assert.deepEqual(rows.map((r) => [r.id, r.revoked, r.replaced_by]), [[first.rule.id, "true", second.rule.id], [second.rule.id, "false", null]]);
  // One live rule per (payer, requester): the database refuses a second one.
  await assert.rejects(
    pg.query(`insert into autopay_rules (id, payer_wallet, requester_wallet, max_per_request_atomic, max_per_month_atomic, ends_at, signed_message, signature)
              values ('Dup1aaaaaaaa', $1, $2, 1, 1, now() + interval '1 day', 'x', 'y')`, [payer.address, LANDLORD.address]),
    /autopay_rules_live_key/,
  );
  // A rule for another requester lives beside it.
  const other = await setRule(payer, { requester: STRANGER.address, max: "5" });
  assert.equal(other.replaced, null);
});

it("revoke: signed by the payer, once; revoking again changes nothing; another payer's rule isn't found", async () => {
  const payer = wallet("payer: revoke");
  const { rule } = await setRule(payer);
  const wrong = await revoke(payer, rule.id, STRANGER);
  assert.equal(wrong.status, 400);
  assert.match((await errorOf(wrong)).message, /doesn't match this message/);
  const res = await revoke(payer, rule.id);
  assert.equal(res.status, 200, await res.clone().text());
  const done = AutopayRevokeResponse.parse(await res.json());
  assert.equal(done.already_revoked, false);
  assert.equal(done.rule.status, "revoked");
  assert.ok(done.rule.revoked_at);
  const twice = AutopayRevokeResponse.parse(await (await revoke(payer, rule.id)).json());
  assert.equal(twice.already_revoked, true);
  const [row] = await sql("select revoke_message, revoke_signature from autopay_rules where id = $1", [rule.id]);
  assert.match(row!.revoke_message!, new RegExp(`^Owed autopay revoke ${rule.id} for ${payer.address} at `));
  const other = wallet("payer: someone else");
  const notMine = await revoke(other, rule.id);
  assert.equal(notMine.status, 404);
  assert.equal((await errorOf(notMine)).code, "not_found");
});

// ---------------------------------------------------------------- the inbox

it("inbox: a payer without a rule gets the inbox exactly as before", async () => {
  const payer = wallet("payer: no rule");
  await ask(payer, LANDLORD.address, "12");
  const { raw, inbox: ib } = await inbox(payer);
  assert.equal("autopay_rules" in raw, false);
  assert.equal(ib.owed.length, 1);
  assert.equal("autopay" in (raw.owed as Record<string, unknown>[])[0]!, false);
});

it("inbox verdicts: eligible, the month cap across two lines, SOL, no rule, brand caution, oldest first", async () => {
  const payer = wallet("payer: verdicts");
  const { rule } = await setRule(payer, { max: "1500", month: "1500" });
  const rent1 = await ask(payer, LANDLORD.address, "1000", { for: "October rent" });
  const rent2 = await ask(payer, LANDLORD.address, "1000", { for: "November rent" });
  const sol = await ask(payer, LANDLORD.address, "1", { token: "SOL" });
  const stranger = await ask(payer, STRANGER.address, "5");
  const brand = await ask(payer, LANDLORD.address, "10", { for: "PayBox support fee" });
  rpcCalls = [];
  const { inbox: ib } = await inbox(payer);
  assert.deepEqual(verdictOf(ib, rent1.id), { status: "eligible", rule_id: rule.id, reason: "Within the rule: 1000 USDC of 1500 USDC per request, 1000 USDC of 1500 USDC this month (UTC)." });
  assert.equal(verdictOf(ib, rent2.id)!.status, "over_limit");
  assert.match(verdictOf(ib, rent2.id)!.reason, /would make 2000 USDC this month/);
  assert.equal(verdictOf(ib, sol.id)!.status, "not_covered");
  assert.match(verdictOf(ib, sol.id)!.reason, /USDC requests on Solana only/);
  assert.deepEqual(verdictOf(ib, stranger.id), { status: "not_covered", reason: "No autopay rule covers this requester's wallet." });
  assert.equal(verdictOf(ib, brand.id)!.status, "not_covered");
  assert.match(verdictOf(ib, brand.id)!.reason, /brand word/);
  assert.equal(ib.autopay_rules?.length, 1);
  assert.equal(ib.autopay_rules![0]!.id, rule.id);
  // One getMultipleAccounts read, for the landlord's USDC account only (the stranger has no rule).
  const reads = rpcCalls.filter((c) => c.method === "getMultipleAccounts");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]!.params[0], [ataOf(LANDLORD.address)]);
});

it("inbox verdicts: a payment made earlier this month counts toward the monthly maximum", async () => {
  const payer = wallet("payer: month to date");
  await setRule(payer, { max: "1500", month: "1500" });
  const paid = await ask(payer, LANDLORD.address, "600");
  await pg.query(
    `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = amount_atomic, paid_at = now(), paid_rail = 'x402' where id = $1`,
    [paid.id, bs58.encode(createHash("sha512").update(`paid ${paid.id}`).digest()), payer.address],
  );
  const rent = await ask(payer, LANDLORD.address, "1000");
  const small = await ask(payer, LANDLORD.address, "900");
  const { inbox: ib } = await inbox(payer);
  assert.equal(verdictOf(ib, rent.id)!.status, "over_limit");
  assert.match(verdictOf(ib, rent.id)!.reason, /1600 USDC this month \(UTC\), above the rule's 1500 USDC per month \(600 USDC already counted\)/);
  assert.equal(verdictOf(ib, small.id)!.status, "eligible");
  assert.equal(ib.autopay_rules![0]!.used_this_month, "600");
  // A payment made before the rule existed doesn't count: a new rule starts its month from zero.
  const { rule } = await setRule(payer, { max: "1500", month: "1500" });
  assert.equal(rule.used_this_month, "0");
});

it("inbox verdicts: no USDC account, Solana unreadable, revoked, ended", async () => {
  const payer = wallet("payer: not covered");
  await setRule(payer, { requester: PLUMBER.address, max: "200" });
  await setRule(payer, { requester: FLAKY.address, max: "200" });
  const revoked = await setRule(payer, { requester: STRANGER.address, max: "200" });
  const ended = await setRule(payer, { requester: LANDLORD.address, max: "200" });
  const plumber = await ask(payer, PLUMBER.address, "80");
  const flaky = await ask(payer, FLAKY.address, "80");
  const stranger = await ask(payer, STRANGER.address, "80");
  const landlord = await ask(payer, LANDLORD.address, "80");
  assert.equal((await revoke(payer, revoked.rule.id)).status, 200);
  await pg.query("update autopay_rules set created_at = now() - interval '40 days', ends_at = now() - interval '1 day' where id = $1", [ended.rule.id]);
  const { inbox: ib } = await inbox(payer);
  // The plumber's and the flaky requester's accounts are read together: one read fails for both, so neither is eligible.
  assert.equal(verdictOf(ib, plumber.id)!.status, "not_covered");
  assert.equal(verdictOf(ib, flaky.id)!.status, "not_covered");
  assert.match(verdictOf(ib, flaky.id)!.reason, /couldn't be read to check the requester's USDC account/);
  assert.match(verdictOf(ib, stranger.id)!.reason, /revoked on \d{4}-\d{2}-\d{2}/);
  assert.match(verdictOf(ib, landlord.id)!.reason, /ended on \d{4}-\d{2}-\d{2}/);
  assert.deepEqual(ib.autopay_rules!.map((r) => r.status).sort(), ["active", "active", "ended"]);
  // Alone, the plumber's missing account is reported as missing.
  const solo = wallet("payer: plumber only");
  await setRule(solo, { requester: PLUMBER.address, max: "200" });
  const p2 = await ask(solo, PLUMBER.address, "80");
  const { inbox: ib2 } = await inbox(solo);
  assert.match(verdictOf(ib2, p2.id)!.reason, /no USDC account yet, and an x402 payment can't open one/);
});

it("the block route's inbox carries the verdicts too", async () => {
  const payer = wallet("payer: block");
  await setRule(payer, { max: "50" });
  const r = await ask(payer, LANDLORD.address, "20");
  const message = `Owed block ${STRANGER.address} for ${payer.address} at ${iso(nextMs())}`;
  const res = await post(blockRoute, "/api/v1/inbox/block", { payer: payer.address, requester: STRANGER.address, action: "block", signed_message: message, signature: payer.sign(message) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = InboxBlockResponse.parse(await res.json());
  assert.equal(body.inbox.owed.find((e) => e.id === r.id)?.autopay?.status, "eligible");
  assert.equal(body.inbox.autopay_rules?.length, 1);
});

// ---------------------------------------------------------------- F3 deposit link

const readOne = (id: string) => getOne(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getOne>[1]);

it("deposit_url: stored beside a USDC request, shown by GET, flagged by /status and the ledger, never in the id", async () => {
  const res = await post(createRequestRoute, "/api/v1/requests", { recipient: LANDLORD.address, amount: "12", token: "USDC", source: "plugin", deposit_url: DEPOSIT });
  assert.equal(res.status, 201, await res.clone().text());
  const created = CreateRequestResponse.parse(await res.json());
  assert.equal(created.deposit_url, DEPOSIT);
  const got = GetRequestResponse.parse(await (await readOne(created.id)).json());
  assert.equal(got.deposit_url, DEPOSIT);
  assert.ok(got.deposit_url_added_at && Math.abs(Date.parse(got.deposit_url_added_at) - Date.now()) < 120_000);
  const status = StatusResponse.parse(await (await post(statusRoute, "/api/v1/status", { ids: [created.id] })).json());
  assert.equal(status.results[0]!.deposit_link, true);
  const message = `Owed ledger access for ${LANDLORD.address} at ${iso(nextMs())}`;
  const ledgerRes = await post(ledgerRoute, "/api/v1/ledger", { recipient: LANDLORD.address, signed_message: message, signature: LANDLORD.sign(message) });
  assert.equal(ledgerRes.status, 200, await ledgerRes.clone().text());
  const ledger = LedgerResponse.parse(await ledgerRes.json());
  assert.equal(ledger.open.find((e) => e.id === created.id)?.deposit_link, true);
  // A request without one carries none of the fields.
  const plain = await ask(wallet("payer: plain"), LANDLORD.address, "3");
  const plainGot = await (await readOne(plain.id)).json() as Record<string, unknown>;
  assert.equal("deposit_url" in plainGot, false);
});

it("deposit_url: another host, http, credentials, too long, SOL, Base and local-currency asks are refused, and nothing is created", async () => {
  const [before] = await sql("select count(*)::int as n from requests");
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ deposit_url: "https://evil.example/d/1" }, /PayBox Deposit link on paybox\.sh/],
    [{ deposit_url: "http://deposit.paybox.sh/d/1" }, /must be an https URL/],
    [{ deposit_url: "https://u:p@deposit.paybox.sh/d/1" }, /user name or password/],
    [{ deposit_url: `https://deposit.paybox.sh/${"x".repeat(520)}` }, /at most 512 characters/],
    [{ deposit_url: DEPOSIT, token: "SOL", amount: "1" }, /USDC requests on Solana only/],
    [{ deposit_url: DEPOSIT, chain: "base", recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, /USDC requests on Solana only/],
    [{ deposit_url: DEPOSIT, currency: "INR", amount: "1200" }, /ask in USDC \(not a local currency\)/],
  ];
  for (const [extra, why] of cases) {
    const res = await post(createRequestRoute, "/api/v1/requests", { recipient: LANDLORD.address, amount: "12", token: "USDC", source: "plugin", ...extra });
    assert.equal(res.status, 400, why.source);
    assert.match((await errorOf(res)).message, why);
  }
  const [after] = await sql("select count(*)::int as n from requests");
  assert.equal(after!.n, before!.n);
  // The database holds the same line: a SOL request can't carry one.
  const sol = await post(createRequestRoute, "/api/v1/requests", { recipient: LANDLORD.address, amount: "1", token: "SOL", source: "plugin" });
  const solId = CreateRequestResponse.parse(await sol.json()).id;
  await assert.rejects(pg.query("update requests set deposit_url = $2, deposit_url_added_at = now() where id = $1", [solId, DEPOSIT]), /requests_deposit_url_check/);
});

it("deposit_url on invoices: a plain USDC invoice carries it; installments, SOL and other hosts are refused", async () => {
  const invoice = (extra: Record<string, unknown> = {}) => post(createInvoiceRoute, "/api/v1/invoices", {
    recipient: LANDLORD.address, token: "USDC", business_name: "Bob's Flats", client_name: "Sam", items: [{ description: "October rent", unit_price: "1000" }],
    due_date: inDays(10), source: "plugin", ...extra,
  });
  const ok = await invoice({ deposit_url: DEPOSIT });
  assert.equal(ok.status, 201, await ok.clone().text());
  const created = InvoiceResponse.parse(await ok.json());
  assert.equal(created.deposit_url, DEPOSIT);
  const got = await getInvoiceRoute(new Request(`${BASE}/api/v1/invoices/${created.id}`), { params: Promise.resolve({ id: created.id }) } as Parameters<typeof getInvoiceRoute>[1]);
  assert.equal(((await got.json()) as { deposit_url?: string }).deposit_url, DEPOSIT);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ deposit_url: DEPOSIT, installments: { count: 2, interval: "monthly" } }, /plain invoice only/],
    [{ deposit_url: DEPOSIT, token: "SOL" }, /USDC invoices on Solana only/],
    [{ deposit_url: "https://paybox.sh.evil.example/x" }, /on paybox\.sh/],
  ];
  for (const [extra, why] of cases) {
    const res = await invoice(extra);
    assert.equal(res.status, 400, why.source);
    assert.match((await errorOf(res)).message, why);
  }
});
