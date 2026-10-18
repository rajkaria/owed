import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import bs58 from "bs58";
import { POST as helius } from "@/app/api/hooks/helius/route";
import { POST as telegramHook } from "@/app/api/hooks/telegram/route";
import { POST as createAlertRoute } from "@/app/api/v1/alerts/route";
import { GET as confirmGet, POST as confirmPost } from "@/app/api/v1/alerts/confirm/route";
import { GET as unsubscribeGet, POST as unsubscribePost } from "@/app/api/v1/alerts/unsubscribe/route";
import { GET as readRequest } from "@/app/api/v1/requests/[id]/route";
import { GET as cronRoute } from "@/app/api/cron/schedules/route";
import { alertChannels } from "@/lib/alerts/config";
import { deliverDueAlerts, MAX_ATTEMPTS } from "@/lib/alerts/deliver";
import { alertsMessage } from "@/lib/alerts/grammar";
import { ALERT_LIMITS, telegramStop, viewToken } from "@/lib/alerts/subscribe";
import { ConfirmAlertResponse, CreateAlertResponse, UnsubscribeAlertResponse } from "@/lib/contract";
import { DbError, sql } from "@/lib/db";
import { requestIdFor } from "@/lib/ids";
import { TOKENS, type Token } from "@/lib/money";
import { drain } from "@/lib/notify/defer";
import { store as x402Store } from "@/lib/x402/store";
import { deliveryTiming } from "@/lib/notify/webhook";
import { parseJsonExact } from "@/lib/solana";

// S1 paid alerts on real Postgres: migration 0025 on PGlite (every migration, in order) answering lib/db.ts's
// Neon-over-HTTP calls. Payments settle through the real paths: Helius deliveries and status reads re-check Solana,
// answered from real mainnet recordings (test/fixtures/chain, the same ones as helius-webhook.test.ts). The Telegram
// Bot API and Resend are stubs that record what would have been sent; nothing is ever sent for real, and any other
// network call fails the test.

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
const FIXTURES = new URL("../../contract/fixtures/", import.meta.url);
const WRITE_FIXTURES = process.env.OWED_WRITE_ALERT_FIXTURES === "1";
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

// ---------------------------------------------------------------- wallets that sign like PayBox (hex) or a browser wallet (base58)

function wallet(label: string) {
  const seed = createHash("sha256").update(`owed alerts test: ${label}`, "utf8").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
  const raw = (message: string) => sign(null, Buffer.from(message, "utf8"), key);
  return { address, sign: (message: string) => raw(message).toString("hex"), signBase58: (message: string) => bs58.encode(raw(message)) };
}
const ALICE = wallet("alice");
const BOB = wallet("bob");
const FIXTURE_WALLET = wallet("fixture");
// Every signed message must differ (a message works once): each takes the next earlier whole second.
const startSecond = Math.floor(Date.now() / 1000);
let signedSeconds = 0;
const nextMs = () => (startSecond - ++signedSeconds) * 1000;
function proof(w: ReturnType<typeof wallet>, encoding: "hex" | "base58" = "hex") {
  const signed_message = alertsMessage(w.address, nextMs());
  return { wallet: w.address, signed_message, signature: encoding === "hex" ? w.sign(signed_message) : w.signBase58(signed_message) };
}

// ---------------------------------------------------------------- recorded mainnet RPC (as helius-webhook.test.ts)

interface RecordedCall { method: string; params: unknown[]; result: unknown }
const chain = (name: string) =>
  parseJsonExact(readFileSync(new URL(`fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RecordedCall[] };
const RECORDED = [...chain("usdc-appended-key-transfers").calls, ...chain("sol-reference-payment").calls, ...chain("unused-reference").calls];
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));
const USDC_REF = "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg";
const OLDEST = "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK";
const MIDDLE = "3ZdwwA4rYiiXodsuZ7374PEahd9iXeiq1VSvVXz17acEcpv1XhV45hu2gPZCXgun4gbm3Sh7vS72NS59rzTsmD2a";
const OLDEST_OWNER = "iksxPfWrHBzj7iZfD3Up3ft5Mz5DSGwm328v2349Zcc";
const GAQ = "GAqbB5TDD6G6KSZwtuTMicuKiyZH9XwkanBkdDs2FLie";
const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const txOf = (signature: string) => RECORDED.find((c) => c.method === "getTransaction" && c.params[0] === signature)!.result;
const delivery = (...signatures: string[]) => toJson(signatures.map(txOf));
const RPC_HOSTS = /^https:\/\/(solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com)\/?$/;
function answerRpc(body: string): Response {
  const parsed = JSON.parse(body);
  const answer = (m: { id: number; method: string; params: unknown[] }) => {
    const hit = RECORDED.find((c) => c.method === m.method && c.params[0] === m.params[0]);
    return hit ? { jsonrpc: "2.0", id: m.id, result: hit.result } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "unrecorded call" } };
  };
  return new Response(toJson(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)), { headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- Telegram Bot API and Resend stubs

const BOT_TOKEN = "123456789:AAH_test-token_0123456789abcdefghijkl";
const BOT = "OwedAlertsBot";
const TG_SECRET = "tg-secret_0123456789abcdef";
const RESEND_KEY = "re_test_0123456789abcdefghij";
type TgMode = "ok" | "500" | "403" | "429" | "throw" | "fail-once";
const tg = { mode: "ok" as TgMode, sent: [] as Array<{ chat_id: string; text: string; parse_mode?: string; link_preview_options?: unknown }>, calls: 0 };
function answerTelegram(url: string, init: RequestInit): Response {
  tg.calls += 1;
  if (url !== `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`) return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
  if (tg.mode === "throw") throw new TypeError("fetch failed");
  if (tg.mode === "500") return Response.json({ ok: false, error_code: 500, description: "Internal Server Error" }, { status: 500 });
  if (tg.mode === "fail-once") {
    tg.mode = "ok";
    return new Response("<html>bad gateway</html>", { status: 502 });
  }
  if (tg.mode === "403") return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
  if (tg.mode === "429") return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } }, { status: 429 });
  const body = JSON.parse(String(init.body)) as (typeof tg.sent)[number];
  tg.sent.push(body);
  return Response.json({ ok: true, result: { message_id: tg.sent.length, chat: { id: Number(body.chat_id), type: "private" }, date: 1792300000, text: body.text } });
}
const resend = { mode: "ok" as "ok" | "500", sent: [] as Array<{ headers: Record<string, string>; body: Record<string, unknown> }> };
function answerResend(init: RequestInit): Response {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (headers.authorization !== `Bearer ${RESEND_KEY}`) return Response.json({ statusCode: 401, message: "API key is invalid", name: "validation_error" }, { status: 401 });
  if (resend.mode === "500") return Response.json({ statusCode: 500, message: "Internal server error", name: "internal_server_error" }, { status: 500 });
  resend.sent.push({ headers, body: JSON.parse(String(init.body)) as Record<string, unknown> });
  return Response.json({ id: `00000000-0000-4000-8000-${String(resend.sent.length).padStart(12, "0")}` });
}

// ---------------------------------------------------------------- wiring

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const BASE = "https://owed.example";
const HELIUS_SECRET = "whsec-test-0123456789abcdef";
const warnings: string[] = [];
const noSleep = { sleep: async () => undefined };

function telegramOn() {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_BOT_USERNAME = `@${BOT}`;
  process.env.TELEGRAM_WEBHOOK_SECRET = TG_SECRET;
}
function telegramOff() {
  for (const n of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"]) delete process.env[n];
}
function emailOn() {
  process.env.RESEND_API_KEY = RESEND_KEY;
  process.env.OWED_ALERTS_FROM = "Owed alerts <alerts@owed.example>";
}
function emailOff() {
  delete process.env.RESEND_API_KEY;
  delete process.env.OWED_ALERTS_FROM;
}

before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
      const body = JSON.parse(String(init.body));
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
    if (RPC_HOSTS.test(url)) return answerRpc(String(init.body));
    if (url.startsWith("https://api.telegram.org/")) return answerTelegram(url, init);
    if (url === "https://api.resend.com/emails") return answerResend(init);
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    warnings.push(line);
    if (!/^(alerts|helius):/.test(line)) warn(...args);
  };
  console.log = () => undefined;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.HELIUS_WEBHOOK_SECRET = HELIUS_SECRET;
  process.env.OWED_BASE_URL = BASE;
  for (const name of ["HELIUS_API_KEY", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "RESEND_API_KEY", "OWED_ALERTS_FROM"]) delete process.env[name];
  deliveryTiming.attempts = 2;
  deliveryTiming.retryMs = 5;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await drain();
  tg.mode = "ok";
  tg.sent = [];
  tg.calls = 0;
  resend.mode = "ok";
  resend.sent = [];
  warnings.length = 0;
  telegramOn();
  emailOff();
  await sql(`delete from rate_events`);
  // Each test starts with no active subscription and nothing due, so one test's alerts never show up in another's.
  await sql(`update alert_deliveries set status = 'skipped', claimed_at = null where status in ('pending', 'sending')`);
  await sql(`update alert_subscriptions set status = 'unsubscribed', unsubscribed_at = now(), ended_by = 'telegram_stop', telegram_chat_id = null, email = null where status = 'active'`);
});

// ---------------------------------------------------------------- helpers

const createAlert = (body: Record<string, unknown>) =>
  createAlertRoute(new Request(`${BASE}/api/v1/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
let updateId = 1;
function update(chatId: number, text: string, type = "private") {
  return { update_id: ++updateId, message: { message_id: updateId, from: { id: chatId, is_bot: false, first_name: "Sam" }, chat: { id: chatId, type }, date: 1792300000, text } };
}
const hook = (body: unknown, secret: string | null = TG_SECRET) =>
  telegramHook(new Request(`${BASE}/api/hooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== null && { "x-telegram-bot-api-secret-token": secret }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const heliusPost = (body: string) =>
  helius(new Request(`${BASE}/api/hooks/helius`, { method: "POST", headers: { "content-type": "application/json", authorization: HELIUS_SECRET }, body }));
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

async function insertRequest(recipient: string, token: Token, amountAtomic: bigint, reference: string, extra: { forText?: string; flags?: string[] } = {}): Promise<string> {
  const id = requestIdFor({ recipient, token, amountAtomic, reference });
  await sql(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, for_text, flags) values ($1, $2, $3, $4, $5, $6, $7, 'web', $8, $9::text[])`,
    [id, recipient, token, TOKENS[token].mint, TOKENS[token].decimals, amountAtomic, reference, extra.forText ?? null, extra.flags ?? []],
  );
  return id;
}
/** A request paid over another rail (x402 here): the 0025 trigger queues alerts whatever wrote the payment. */
async function payDirectly(recipient: string, extra: { forText?: string; flags?: string[]; atomic?: bigint } = {}): Promise<string> {
  const reference = bs58.encode(randomBytes(32));
  const atomic = extra.atomic ?? 1_250_000n;
  const id = await insertRequest(recipient, "USDC", atomic, reference, extra);
  await sql(
    `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = $4, paid_at = now(), paid_rail = 'x402' where id = $1`,
    [id, bs58.encode(randomBytes(64)), OLDEST_OWNER, atomic],
  );
  return id;
}
let chatSeq = 5000;
async function activeSubscription(wallet: string, opts: { chat?: number; email?: string } = {}): Promise<{ id: string; chat: number | null }> {
  const id = bs58.encode(randomBytes(16)).slice(-12);
  const chat = opts.email ? null : (opts.chat ?? ++chatSeq);
  await sql(
    `insert into alert_subscriptions (id, wallet, channel, status, telegram_chat_id, email, confirm_hash, confirm_expires_at, proof_message, proof_signature, activated_at)
     values ($1, $2, $3, 'active', $4::bigint, $5, $6, now(), 'Owed alerts for test', 'test signature', now())`,
    [id, wallet, opts.email ? "email" : "telegram", chat === null ? null : String(chat), opts.email ?? null, createHash("sha256").update(id).digest("hex")],
  );
  return { id, chat };
}
const deliveries = async (subscriptionId: string) =>
  sql(`select request_id, status, attempts::int as attempts, error, sent_at is not null as sent, (next_attempt_at > now())::text as later from alert_deliveries where subscription_id = $1 order by id`, [subscriptionId]);
const subscription = async (id: string) =>
  (await sql(`select status, telegram_chat_id::text as chat, email, ended_by, activated_at is not null as activated from alert_subscriptions where id = $1`, [id]))[0];
const sentTo = (chat: number | null) => tg.sent.filter((m) => m.chat_id === String(chat));

/** Same keys and value kinds, recursively: a live answer and its checked-in fixture have one shape. */
function sameShape(a: unknown, b: unknown, path = "$"): void {
  const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  assert.equal(kind(a), kind(b), `${path}: ${kind(a)} vs ${kind(b)}`);
  if (kind(a) === "object") {
    assert.deepEqual(Object.keys(a as object).sort(), Object.keys(b as object).sort(), path);
    for (const k of Object.keys(a as object)) sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
  }
}
function fixture(name: string, live: unknown): void {
  const file = new URL(name, FIXTURES);
  if (WRITE_FIXTURES) writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
  sameShape(live, JSON.parse(readFileSync(file, "utf8")));
}

// ---------------------------------------------------------------- unconfigured

it("nothing configured: the hook is 404, sign-ups are refused before the signature is spent, nothing is sent", async () => {
  telegramOff();
  assert.deepEqual(alertChannels(), { telegram: false, email: false });
  const res = await hook(update(1, "/start abc"));
  assert.equal(res.status, 404);
  const body = proof(ALICE);
  const refused = await createAlert({ ...body, channel: "telegram" });
  assert.equal(refused.status, 503);
  assert.deepEqual(await errorOf(refused), { code: "upstream_unavailable", message: "Telegram alerts aren't switched on on this deployment yet" });
  const email = await createAlert({ ...proof(ALICE), channel: "email", email: "alice@example.com" });
  assert.equal(email.status, 503);
  assert.match((await errorOf(email)).message, /email alerts aren't switched on/);
  assert.deepEqual(await deliverDueAlerts(), { status: "off" });
  // Half a Telegram config is no config.
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_BOT_USERNAME = BOT;
  assert.equal(alertChannels().telegram, false);
  process.env.TELEGRAM_WEBHOOK_SECRET = "not allowed: spaces";
  assert.equal(alertChannels().telegram, false, "a secret Telegram would refuse");
  telegramOn();
  // The refused call didn't spend the signature: the same one works now.
  const ok = await createAlert({ ...body, channel: "telegram" });
  assert.equal(ok.status, 201);
  assert.equal((await sql(`select count(*)::int as n from alert_subscriptions`))[0].n, "1");
  assert.equal(tg.calls, 0);
});

// ---------------------------------------------------------------- the Telegram webhook

it("webhook: a missing or wrong secret is 401 and nothing happens; other text, groups and other bots are ignored", async () => {
  for (const secret of [null, "", "wrong", TG_SECRET.slice(1), `${TG_SECRET}x`, TG_SECRET.toUpperCase()]) {
    const res = await hook(update(42, "/stop"), secret);
    assert.equal(res.status, 401, String(secret));
    assert.deepEqual(await res.json(), { error: { code: "unauthorized", message: "missing or wrong secret token" } });
  }
  for (const u of [
    update(42, "hello"),
    update(42, "/help"),
    update(42, "/stop", "group"),
    update(42, `/start@SomeOtherBot ${"a".repeat(22)}`),
    { update_id: 9, edited_message: update(42, "/stop").message },
    { update_id: 10, my_chat_member: { chat: { id: 42, type: "private" } } },
  ]) {
    const res = await hook(u);
    assert.equal(res.status, 200, JSON.stringify(u));
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(tg.calls, 0, "no reply to anything ignored");
  const bad = await hook("{not json");
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- sign-up

it("sign-up: a fresh proof gives a pending link; stale, wrong-wallet, tampered and reused proofs are refused", async () => {
  const good = proof(FIXTURE_WALLET);
  const req = { ...good, channel: "telegram" };
  const res = await createAlert(req);
  assert.equal(res.status, 201);
  const raw = await res.json();
  const created = CreateAlertResponse.parse(raw);
  assert.equal(created.channel, "telegram");
  if (created.channel !== "telegram") return;
  assert.equal(created.status, "pending");
  assert.equal(created.wallet, FIXTURE_WALLET.address);
  assert.match(created.telegram.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(created.telegram.link, `https://t.me/${BOT}?start=${created.telegram.code}`);
  assert.equal(Date.parse(created.expires_at) - Date.parse(created.created_at), 15 * 60_000);
  const [row] = await sql(`select confirm_hash, proof_message, proof_signature from alert_subscriptions where id = $1`, [created.id]);
  assert.equal(row.confirm_hash, createHash("sha256").update(created.telegram.code).digest("hex"), "only the code's hash is stored");
  assert.ok(!JSON.stringify(await sql(`select * from alert_subscriptions where id = $1`, [created.id])).includes(created.telegram.code));
  assert.deepEqual({ m: row.proof_message, s: row.proof_signature }, { m: good.signed_message, s: good.signature });
  fixture("alerts.create.telegram.req.json", req);
  fixture("alerts.create.telegram.res.json", raw);

  // A browser wallet's base58 signature works the same way.
  assert.equal((await createAlert({ ...proof(ALICE, "base58"), channel: "telegram" })).status, 201);

  const refusals: Array<[Record<string, unknown>, RegExp]> = [];
  const stale = alertsMessage(ALICE.address, Date.now() - 6 * 60_000);
  refusals.push([{ wallet: ALICE.address, signed_message: stale, signature: ALICE.sign(stale) }, /more than 5 minutes old/]);
  const future = alertsMessage(ALICE.address, Date.now() + 3 * 60_000);
  refusals.push([{ wallet: ALICE.address, signed_message: future, signature: ALICE.sign(future) }, /dated in the future/]);
  const forAlice = alertsMessage(ALICE.address, nextMs());
  refusals.push([{ wallet: ALICE.address, signed_message: forAlice, signature: BOB.sign(forAlice) }, /doesn't match this message for wallet/]);
  const forBob = alertsMessage(BOB.address, nextMs());
  refusals.push([{ wallet: ALICE.address, signed_message: forBob, signature: BOB.sign(forBob) }, /must read "Owed alerts for/]);
  const signedAt = nextMs();
  const tampered = alertsMessage(ALICE.address, signedAt - 1000); // still fresh, one second off: not what was signed
  refusals.push([{ wallet: ALICE.address, signed_message: tampered, signature: ALICE.sign(alertsMessage(ALICE.address, signedAt)) }, /doesn't match this message for wallet/]);
  refusals.push([{ wallet: ALICE.address, signed_message: `Owed ledger access for ${ALICE.address} at 2026-10-18T00:00:00Z`, signature: "00".repeat(64) }, /must read "Owed alerts for/]);
  for (const [body, why] of refusals) {
    const r = await createAlert({ ...body, channel: "telegram" });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match((await errorOf(r)).message, why);
  }
  const reused = await createAlert({ ...good, channel: "telegram" });
  assert.equal(reused.status, 400);
  assert.match((await errorOf(reused)).message, /already used/);
  const malformed = await createAlert({ ...proof(ALICE), channel: "sms" });
  assert.equal(malformed.status, 400);
  const extra = await createAlert({ ...proof(ALICE), channel: "telegram", email: "x@example.com" });
  assert.equal(extra.status, 400, "a telegram body takes no email");
});

it("sign-up caps: 5 active links per wallet, 5 waiting, and the per-client limit", async () => {
  const w = wallet("capped");
  for (let i = 0; i < ALERT_LIMITS.activePerWallet; i++) await activeSubscription(w.address);
  const full = await createAlert({ ...proof(w), channel: "telegram" });
  assert.equal(full.status, 400);
  assert.match((await errorOf(full)).message, /already has 5 active alert links/);
  await sql(`delete from alert_subscriptions where wallet = $1`, [w.address]);
  for (let i = 0; i < ALERT_LIMITS.pendingPerWallet; i++) assert.equal((await createAlert({ ...proof(w), channel: "telegram" })).status, 201);
  const waiting = await createAlert({ ...proof(w), channel: "telegram" });
  assert.equal(waiting.status, 429);
  assert.match((await errorOf(waiting)).message, /unused alert links waiting/);
  await sql(`delete from alert_subscriptions where wallet = $1`, [w.address]);
  await sql(`delete from rate_events`);
  await sql(`insert into rate_events (key) select 'alerts:create:ip:unknown' from generate_series(1, $1::int)`, [String(ALERT_LIMITS.createPerIpPerHour)]);
  const limited = await createAlert({ ...proof(w), channel: "telegram" });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
});

// ---------------------------------------------------------------- the bot

it("/start: a valid code links the chat and the bot names the wallet; reused, expired and unknown codes don't", async () => {
  const res = await createAlert({ ...proof(BOB), channel: "telegram" });
  const created = CreateAlertResponse.parse(await res.json());
  if (created.channel !== "telegram") throw new Error("telegram expected");
  const code = created.telegram.code;
  const CHAT = 777001;

  assert.equal((await hook(update(CHAT, `/start ${code}`))).status, 200);
  const [reply] = sentTo(CHAT);
  assert.ok(reply, "the bot replied");
  assert.equal(reply.parse_mode, "HTML");
  assert.deepEqual(reply.link_preview_options, { is_disabled: true });
  assert.match(reply.text, new RegExp(`Owed paid alerts are on for wallet ${BOB.address}\\.`));
  assert.match(reply.text, /Send \/stop to turn them off/);
  assert.deepEqual(await subscription(created.id), { status: "active", chat: String(CHAT), email: null, ended_by: null, activated: "t" });

  // Telegram redelivering the same update: same chat, same code.
  await hook(update(CHAT, `/start ${code}`));
  assert.match(sentTo(CHAT)[1].text, /already on in this chat for wallet/);
  // Someone else with the code (the link was forwarded): one-time.
  await hook(update(777002, `/start@${BOT} ${code}`));
  assert.match(sentTo(777002)[0].text, /That link was already used/);
  // Expired.
  const late = CreateAlertResponse.parse(await (await createAlert({ ...proof(BOB), channel: "telegram" })).json());
  if (late.channel !== "telegram") throw new Error("telegram expected");
  await sql(`update alert_subscriptions set confirm_expires_at = now() - interval '1 second' where id = $1`, [late.id]);
  await hook(update(777003, `/start ${late.telegram.code}`));
  assert.match(sentTo(777003)[0].text, /That link has expired/);
  assert.equal((await subscription(late.id)).status, "pending");
  // Unknown, malformed, missing.
  await hook(update(777004, `/start ${"Z".repeat(22)}`));
  assert.match(sentTo(777004)[0].text, /That link isn't valid/);
  await hook(update(777004, "/start <script>"));
  assert.match(sentTo(777004)[1].text, /That link isn't valid/);
  await hook(update(777004, "/start"));
  assert.match(sentTo(777004)[2].text, new RegExp(`open ${BASE}/alerts`));
  assert.equal(tg.sent.length, 7);
});

it("/stop ends every subscription of the chat and scrubs it; a second /stop finds nothing", async () => {
  const CHAT = 888001;
  const a = await activeSubscription(ALICE.address, { chat: CHAT });
  const b = await activeSubscription(BOB.address, { chat: CHAT });
  const other = await activeSubscription(ALICE.address, { chat: 888002 });
  await hook(update(CHAT, "/stop"));
  assert.match(sentTo(CHAT)[0].text, /Owed paid alerts are off in this chat \(2 wallets\)/);
  for (const s of [a, b]) assert.deepEqual(await subscription(s.id), { status: "unsubscribed", chat: null, email: null, ended_by: "telegram_stop", activated: "t" });
  assert.equal((await subscription(other.id)).status, "active", "another chat keeps its alerts");
  await hook(update(CHAT, `/stop@${BOT}`));
  assert.match(sentTo(CHAT)[1].text, /No Owed paid alerts were on in this chat/);
});

// ---------------------------------------------------------------- alerts on paid

it("exactly one alert per request across repeated Helius deliveries, status-read settles and concurrent runs", async () => {
  const gaq = await activeSubscription(GAQ);
  const payee = await activeSubscription(SOL_PAYEE);
  const off = await activeSubscription(GAQ);
  await telegramStop(String(off.chat)); // unsubscribed before anything was paid
  await sql(`insert into alert_subscriptions (id, wallet, channel, confirm_hash, confirm_expires_at, proof_message, proof_signature)
             values ('PendingSub11', $1, 'telegram', $2, now() + interval '15 minutes', 'Owed alerts for test', 'sig')`, [GAQ, "ab".repeat(32)]);

  // Helius path: the delivery re-checks the chain, recordPayment writes paid, the trigger queues, the kick sends.
  const id = await insertRequest(GAQ, "USDC", 387n, USDC_REF, { forText: "Dinner at Sam's" });
  assert.equal((await heliusPost(delivery(OLDEST))).status, 200);
  await drain();
  assert.equal((await sql(`select status from requests where id = $1`, [id]))[0].status, "paid");
  const sent = sentTo(gaq.chat);
  assert.equal(sent.length, 1, "one alert");
  const text = sent[0].text;
  assert.equal(sent[0].parse_mode, "HTML");
  assert.match(text, /^<b>Paid: 0\.000387 USDC<\/b>/);
  assert.match(text, /To wallet <code>GAqb…FLie<\/code>/);
  assert.match(text, /For: <code>&quot;Dinner at Sam's&quot;<\/code> \(the requester's words, not checked by Owed\)/);
  assert.match(text, /From <code>iksx…9Zcc<\/code> · Solana Pay/);
  assert.ok(text.includes(`<a href="${BASE}/r/${id}">Request</a>`));
  assert.ok(text.includes(`<a href="https://solscan.io/tx/${OLDEST}">Solscan</a>`));
  assert.match(text, /Send \/stop to turn off these alerts\.$/);
  assert.equal(sentTo(off.chat).length, 0, "an unsubscribed chat gets nothing");
  assert.deepEqual(await deliveries(gaq.id), [{ request_id: id, status: "sent", attempts: "1", error: null, sent: "t", later: "false" }]);
  assert.deepEqual(await deliveries(off.id), [], "nothing is even queued for it");
  assert.deepEqual(await deliveries("PendingSub11"), []);

  // Helius retries the delivery, twice at once: nothing new.
  await Promise.all([heliusPost(delivery(OLDEST)), heliusPost(delivery(OLDEST))]);
  await drain();
  // Three runs at once (two kicks and the cron, say): nothing left to send.
  await Promise.all([deliverDueAlerts(), deliverDueAlerts(), deliverDueAlerts()]);
  assert.equal(sentTo(gaq.chat).length, 1);

  // Status-read path: two reads at once settle the request on chain; one alert.
  const solId = await insertRequest(SOL_PAYEE, "SOL", 3_027_000n, SOL_REF);
  const read = () => readRequest(new Request(`${BASE}/api/v1/requests/${solId}`), { params: Promise.resolve({ id: solId }) } as Parameters<typeof readRequest>[1]);
  const answers = await Promise.all([read(), read()]);
  assert.ok(answers.every((r) => r.status === 200));
  await drain();
  await Promise.all([deliverDueAlerts(), deliverDueAlerts()]);
  assert.equal((await sql(`select status from requests where id = $1`, [solId]))[0].status, "paid");
  const solSent = sentTo(payee.chat);
  assert.equal(solSent.length, 1);
  assert.match(solSent[0].text, /^<b>Paid: 0\.003027 SOL<\/b>/);
  assert.ok(solSent[0].text.includes(`https://solscan.io/tx/${SOL_SIG}`));
  assert.ok(!solSent[0].text.includes("For:"), "no reason, no For line");
  // Reading it again (paid now) queues nothing.
  await read();
  await drain();
  assert.equal(sentTo(payee.chat).length, 1);
  assert.equal(tg.sent.length, 2);
});

it("a part payment says part paid; paying the rest later sends nothing more (one alert per request)", async () => {
  await sql(`delete from requests where reference = $1`, [USDC_REF]);
  const sub = await activeSubscription(GAQ);
  const id = await insertRequest(GAQ, "USDC", 200_000n, USDC_REF);
  await heliusPost(delivery(MIDDLE));
  await drain();
  assert.equal((await sql(`select status from requests where id = $1`, [id]))[0].status, "underpaid");
  const [alert] = sentTo(sub.chat);
  assert.match(alert.text, /^<b>Part paid: 0\.000387 of 0\.2 USDC<\/b>/);
  // The rest arrives (any path that writes paid): still one alert.
  await sql(`update requests set status = 'paid', paid_amount_atomic = 200000 where id = $1`, [id]);
  await deliverDueAlerts(noSleep);
  assert.equal(sentTo(sub.chat).length, 1);
  assert.equal((await deliveries(sub.id)).length, 1);
});

it("any rail queues the alert (x402 written directly here); requester text is cleaned, quoted and escaped", async () => {
  const sub = await activeSubscription(ALICE.address);
  const id = await payDirectly(ALICE.address, {
    forText: `<b>Refund</b> & "verify" @helpdesk https://evil.example/claim [click] \`x\``,
    flags: ["brand_word:paypal"],
  });
  await deliverDueAlerts(noSleep);
  const [alert] = sentTo(sub.chat);
  assert.ok(alert, "sent");
  const text = alert.text;
  assert.ok(!text.includes("evil.example"), "links never reach an alert");
  assert.ok(!text.includes("<b>Refund"), "requester markup is not markup");
  assert.match(text, /For: <code>&quot;b Refund \/b &amp; 'verify' @helpdesk click x&quot;<\/code>/);
  assert.match(text, /Caution: the text mentions &quot;paypal&quot;; Owed hasn't verified who made this request\./i);
  assert.match(text, /· x402/);
  // Every tag in the message is one Owed wrote.
  for (const tag of text.match(/<[^>]*>/g) ?? []) assert.match(tag, /^<(\/?(b|code|a)|a href="[^"<>]*")>$/, tag);
  assert.ok(text.includes(`${BASE}/r/${id}`));
});

it("the x402 paid write kicks the sender itself: the alert goes out after the response, no run needed", async () => {
  const sub = await activeSubscription(BOB.address);
  const id = await insertRequest(BOB.address, "USDC", 2_000_000n, bs58.encode(randomBytes(32)));
  const [receipt] = await sql(
    `insert into x402_receipts (request_id, state, x402_version, network, amount_atomic, payer) values ($1, 'settled', 2, 'solana', 2000000, $2) returning id::text as id`,
    [id, OLDEST_OWNER],
  );
  const marked = await x402Store.verified({ id: receipt.id!, requestId: id }, { signature: bs58.encode(randomBytes(64)), payer: OLDEST_OWNER, amountAtomic: 2_000_000n, at: "2026-10-18T12:00:00Z", slot: 1 });
  assert.equal(marked, true);
  await drain(); // what after() runs once the response is sent
  const [alert] = sentTo(sub.chat);
  assert.ok(alert, "sent by the kick");
  assert.match(alert.text, /^<b>Paid: 2 USDC<\/b>/);
  assert.match(alert.text, /· x402\n/);
});

it("turned off after it was queued: skipped, nothing sent", async () => {
  const sub = await activeSubscription(BOB.address);
  telegramOff(); // no channel: rows queue but nothing claims them
  await payDirectly(BOB.address);
  assert.deepEqual(await deliverDueAlerts(), { status: "off" });
  assert.equal((await deliveries(sub.id))[0].status, "pending");
  await telegramStop(String(sub.chat));
  telegramOn();
  const summary = await deliverDueAlerts(noSleep);
  assert.equal(summary.status === "ran" && summary.skipped, 1);
  assert.equal(sentTo(sub.chat).length, 0);
  assert.equal((await deliveries(sub.id))[0].status, "skipped");
});

it("a failing send is retried a bounded number of times, then given up; the token never reaches a log or the table", async () => {
  const sub = await activeSubscription(ALICE.address);
  tg.mode = "500";
  await payDirectly(ALICE.address);
  const sleeps: number[] = [];
  const timing = { sleep: async (ms: number) => void sleeps.push(ms) };
  let summary = await deliverDueAlerts(timing);
  assert.equal(summary.status === "ran" && summary.retrying, 1);
  assert.deepEqual(sleeps, [1000, 4000], "three tries in the run: now, after 1 s, after 4 s");
  let [row] = await deliveries(sub.id);
  assert.deepEqual({ status: row.status, attempts: row.attempts, later: row.later }, { status: "pending", attempts: "3", later: "true" });
  assert.match(row.error!, /Telegram Bot API answered HTTP 500: Internal Server Error/);
  // Not due yet: a run now takes nothing.
  summary = await deliverDueAlerts(timing);
  assert.equal(summary.status === "ran" && summary.claimed, 0);
  // Due again (the next kick or the cron): two more tries, then it gives up.
  await sql(`update alert_deliveries set next_attempt_at = now() - interval '1 second' where subscription_id = $1`, [sub.id]);
  summary = await deliverDueAlerts(timing);
  assert.equal(summary.status === "ran" && summary.failed, 1);
  [row] = await deliveries(sub.id);
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "failed", attempts: String(MAX_ATTEMPTS) });
  assert.match(row.error!, /^gave up after 5 attempts: Telegram Bot API answered HTTP 500/);
  assert.equal(tg.sent.length, 0);
  assert.equal(tg.calls, 5);

  // Network down: same handling; the token appears in no warning and no stored error.
  tg.mode = "throw";
  await payDirectly(ALICE.address);
  await deliverDueAlerts(noSleep);
  const all = await sql(`select error from alert_deliveries where subscription_id = $1`, [sub.id]);
  assert.ok(all.some((r) => r.error === "Telegram Bot API unreachable"));
  assert.ok(warnings.length > 0);
  for (const line of [...warnings, ...all.map((r) => r.error ?? "")]) assert.ok(!line.includes(BOT_TOKEN) && !line.includes("AAH_test"), line);

  // A blip: fails once, the in-run retry sends it.
  tg.mode = "fail-once";
  const blip = await activeSubscription(BOB.address);
  await payDirectly(BOB.address);
  await deliverDueAlerts(noSleep);
  assert.deepEqual((await deliveries(blip.id)).map((r) => [r.status, r.attempts]), [["sent", "2"]]);
  assert.equal(sentTo(blip.chat).length, 1);
});

it("flood control waits as long as Telegram says; a blocked bot ends the subscription at once", async () => {
  const flood = await activeSubscription(ALICE.address);
  tg.mode = "429";
  await payDirectly(ALICE.address);
  await deliverDueAlerts(noSleep);
  const [row] = await sql(`select status, attempts::int as attempts, extract(epoch from next_attempt_at - now())::int as wait from alert_deliveries where subscription_id = $1`, [flood.id]);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, "1", "retry_after 30 s is too long to wait in the run");
  assert.ok(Number(row.wait) >= 590 && Number(row.wait) <= 600, row.wait!);

  tg.mode = "403";
  const blocked = await activeSubscription(BOB.address);
  await payDirectly(BOB.address);
  await deliverDueAlerts(noSleep);
  assert.deepEqual((await deliveries(blocked.id)).map((r) => [r.status, r.attempts, r.error]), [["failed", "1", "Telegram Bot API answered HTTP 403: Forbidden: bot was blocked by the user"]]);
  assert.deepEqual(await subscription(blocked.id), { status: "unsubscribed", chat: null, email: null, ended_by: "bot_blocked", activated: "t" });
  tg.mode = "ok";
  await payDirectly(BOB.address);
  await deliverDueAlerts(noSleep);
  assert.equal(tg.sent.length, 0, "nothing more goes to a chat that blocked the bot");
});

it("an alert not sent within 48 hours is dropped, not sent late", async () => {
  const sub = await activeSubscription(ALICE.address);
  telegramOff();
  await payDirectly(ALICE.address);
  await sql(`update alert_deliveries set created_at = now() - interval '49 hours' where subscription_id = $1`, [sub.id]);
  telegramOn();
  await deliverDueAlerts(noSleep);
  const [row] = await deliveries(sub.id);
  assert.equal(row.status, "failed");
  assert.match(row.error!, /not sent within 48 hours/);
  assert.equal(tg.sent.length, 0);
});

// ---------------------------------------------------------------- email (dormant until configured)

it("email: refused unless configured; configured, it confirms by POST only, alerts carry one-click unsubscribe", async () => {
  const w = wallet("email user");
  // Not configured: refused, not offered.
  const refused = await createAlert({ ...proof(w), channel: "email", email: "Pat@Example.com" });
  assert.equal(refused.status, 503);
  assert.equal(alertChannels().email, false);
  assert.equal(resend.sent.length, 0);

  emailOn();
  assert.equal(alertChannels().email, true);
  const req = { ...proof(FIXTURE_WALLET), channel: "email", email: "Pat@Example.com" };
  const res = await createAlert(req);
  assert.equal(res.status, 201);
  const raw = await res.json();
  const created = CreateAlertResponse.parse(raw);
  if (created.channel !== "email") throw new Error("email expected");
  assert.equal(created.email.address, "pat@example.com", "stored lower-cased");
  assert.equal(Date.parse(created.expires_at) - Date.parse(created.created_at), 24 * 3600_000);
  fixture("alerts.create.email.req.json", req);
  fixture("alerts.create.email.res.json", raw);
  assert.equal(resend.sent.length, 1);
  const confirmMail = resend.sent[0];
  assert.deepEqual(confirmMail.body.to, ["pat@example.com"]);
  assert.equal(confirmMail.body.from, "Owed alerts <alerts@owed.example>");
  assert.equal(confirmMail.headers["idempotency-key"], `owed-alert-confirm-${created.id}`);
  const token = /\/alerts\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(String(confirmMail.body.text))![1];
  assert.ok(String(confirmMail.body.html).includes(`${BASE}/alerts/confirm?token=${token}`));
  assert.ok(!JSON.stringify(await sql(`select * from alert_subscriptions where id = $1`, [created.id])).includes(token), "only the token's hash is stored");

  // Opening the link (or a mail scanner opening it) changes nothing.
  const opened = await confirmGet(new Request(`${BASE}/api/v1/alerts/confirm?token=${token}`));
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get("location"), `${BASE}/alerts/confirm?token=${token}`);
  assert.deepEqual(await viewToken("confirm", token), { wallet: FIXTURE_WALLET.address, channel: "email", status: "pending", email: "pat@example.com", expired: false });
  assert.equal((await subscription(created.id)).status, "pending");

  const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const confirmReq = { token };
  const confirmed = await confirmPost(post(`${BASE}/api/v1/alerts/confirm`, confirmReq));
  assert.equal(confirmed.status, 200);
  const confirmedRaw = await confirmed.json();
  const confirmedBody = ConfirmAlertResponse.parse(confirmedRaw);
  assert.deepEqual({ status: confirmedBody.status, already: confirmedBody.already_active }, { status: "active", already: false });
  fixture("alerts.confirm.req.json", confirmReq);
  fixture("alerts.confirm.res.json", confirmedRaw);
  const again = ConfirmAlertResponse.parse(await (await confirmPost(post(`${BASE}/api/v1/alerts/confirm`, confirmReq))).json());
  assert.equal(again.already_active, true);

  // A request to that wallet is paid: one alert email.
  const id = await payDirectly(FIXTURE_WALLET.address, { forText: "Design <work> \"invoice\"" });
  await deliverDueAlerts(noSleep);
  assert.equal(resend.sent.length, 2);
  const alert = resend.sent[1];
  assert.equal(alert.body.subject, `Paid: 1.25 USDC to ${FIXTURE_WALLET.address.slice(0, 4)}…${FIXTURE_WALLET.address.slice(-4)}`, "only Owed's words in the subject");
  const headers = alert.body.headers as Record<string, string>;
  const unsub = /^<(https:\/\/owed\.example\/api\/v1\/alerts\/unsubscribe\?token=([A-Za-z0-9_-]{43}))>$/.exec(headers["List-Unsubscribe"])!;
  assert.ok(unsub, headers["List-Unsubscribe"]);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(alert.headers["idempotency-key"], /^owed-alert-\d+-[0-9a-f]{16}$/);
  const unsubToken = unsub[2];
  assert.ok(String(alert.body.text).includes(`Turn them off: ${BASE}/alerts/unsubscribe?token=${unsubToken}`));
  assert.ok(String(alert.body.text).includes(`For: "Design work 'invoice'" (the requester's words, not checked by Owed)`));
  assert.ok(String(alert.body.html).includes("<q>Design work &#x27;invoice&#x27;</q>") || String(alert.body.html).includes("<q>Design work 'invoice'</q>"));
  assert.ok(!String(alert.body.html).includes("<work>"));
  assert.ok(String(alert.body.text).includes(`${BASE}/r/${id}`));

  // GET on the unsubscribe URL (a scanner, or a click on the header link) changes nothing.
  const scanned = await unsubscribeGet(new Request(`${BASE}/api/v1/alerts/unsubscribe?token=${unsubToken}`));
  assert.equal(scanned.status, 303);
  assert.equal(scanned.headers.get("location"), `${BASE}/alerts/unsubscribe?token=${unsubToken}`);
  assert.equal((await viewToken("unsubscribe", unsubToken))?.status, "active");
  assert.equal((await subscription(created.id)).status, "active");

  // A mail app's one-click POST (RFC 8058) turns it off and scrubs the address.
  const oneClick = await unsubscribePost(new Request(`${BASE}/api/v1/alerts/unsubscribe?token=${unsubToken}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
  }));
  assert.equal(oneClick.status, 200);
  const offRaw = await oneClick.json();
  const off = UnsubscribeAlertResponse.parse(offRaw);
  assert.deepEqual({ status: off.status, already: off.already_unsubscribed, channel: off.channel }, { status: "unsubscribed", already: false, channel: "email" });
  assert.deepEqual(await subscription(created.id), { status: "unsubscribed", chat: null, email: null, ended_by: "unsubscribe_link", activated: "t" });
  // The page's button (JSON body) on an already-off link: idempotent.
  const unsubReq = { token: unsubToken };
  const twice = await unsubscribePost(post(`${BASE}/api/v1/alerts/unsubscribe`, unsubReq));
  const twiceBody = UnsubscribeAlertResponse.parse(await twice.json());
  assert.equal(twiceBody.already_unsubscribed, true);
  fixture("alerts.unsubscribe.req.json", unsubReq);
  fixture("alerts.unsubscribe.res.json", offRaw);
  // Unsubscribed: the next payment sends nothing.
  await payDirectly(FIXTURE_WALLET.address);
  await deliverDueAlerts(noSleep);
  assert.equal(resend.sent.length, 2);
  // Unsubscribing keeps working with email switched off again.
  emailOff();
  assert.equal((await unsubscribePost(post(`${BASE}/api/v1/alerts/unsubscribe`, unsubReq))).status, 200);
  const bogus = await unsubscribePost(post(`${BASE}/api/v1/alerts/unsubscribe`, { token: "A".repeat(43) }));
  assert.equal(bogus.status, 404);
});

it("email: expired, unknown and undeliverable confirmations", async () => {
  emailOn();
  const w = wallet("email edge");
  const created = CreateAlertResponse.parse(await (await createAlert({ ...proof(w), channel: "email", email: "edge@example.com" })).json());
  const token = /token=([A-Za-z0-9_-]{43})/.exec(String(resend.sent[0].body.text))![1];
  await sql(`update alert_subscriptions set confirm_expires_at = now() - interval '1 second' where id = $1`, [created.id]);
  const post = (body: unknown) => confirmPost(new Request(`${BASE}/api/v1/alerts/confirm`, { method: "POST", body: JSON.stringify(body) }));
  const expired = await post({ token });
  assert.equal(expired.status, 400);
  assert.match((await errorOf(expired)).message, /expired/);
  assert.equal((await viewToken("confirm", token))?.expired, true);
  assert.equal((await post({ token: "B".repeat(43) })).status, 404);
  assert.equal((await post({ token: "short" })).status, 400);
  // The same address for the same wallet twice: refused once one is active.
  const second = CreateAlertResponse.parse(await (await createAlert({ ...proof(w), channel: "email", email: "edge@example.com" })).json());
  const token2 = /token=([A-Za-z0-9_-]{43})/.exec(String(resend.sent[1].body.text))![1];
  assert.equal((await post({ token: token2 })).status, 200);
  const dup = await createAlert({ ...proof(w), channel: "email", email: "EDGE@example.com" });
  assert.equal(dup.status, 400);
  assert.match((await errorOf(dup)).message, /already go to this address/);
  assert.equal(second.status, "pending");
  // Resend down: 503, and the link that was never sent is expired at once.
  resend.mode = "500";
  const failed = await createAlert({ ...proof(w), channel: "email", email: "other@example.com" });
  assert.equal(failed.status, 503);
  const [row] = await sql(`select status, confirm_expires_at <= now() as dead from alert_subscriptions where email = 'other@example.com'`);
  assert.deepEqual(row, { status: "pending", dead: "t" });
  assert.ok(warnings.every((l) => !l.includes(RESEND_KEY)));
});

// ---------------------------------------------------------------- cron, constraints

it("the daily cron sends what is due and purges week-old unused links", async () => {
  process.env.CRON_SECRET = "cron-secret-0123456789";
  const sub = await activeSubscription(ALICE.address);
  await payDirectly(ALICE.address);
  await sql(`insert into alert_subscriptions (id, wallet, channel, confirm_hash, confirm_expires_at, proof_message, proof_signature, created_at)
             values ('XxdPending11', $1, 'telegram', $2, now() - interval '8 days', 'Owed alerts for test', 'sig', now() - interval '8 days')`, [ALICE.address, "cd".repeat(32)]);
  const res = await cronRoute(new Request(`${BASE}/api/cron/schedules`, { headers: { authorization: "Bearer cron-secret-0123456789" } }));
  const body = (await res.json()) as { alerts?: { status: string; sent: number; purged_pending: number } };
  assert.equal(body.alerts?.status, "ran");
  assert.equal(body.alerts?.sent, 1);
  assert.equal(body.alerts?.purged_pending, 1);
  assert.equal(sentTo(sub.chat).length, 1);
  assert.equal((await sql(`select count(*)::int as n from alert_subscriptions where id = 'XxdPending11'`))[0].n, "0");
});

it("0025 constraints: wallet shape, state rules, one delivery per (subscription, request)", async () => {
  const bad = async (text: string, params: (string | null)[] = []) =>
    assert.rejects(sql(text, params), (e: unknown) => e instanceof DbError && (e.code === "23514" || e.code === "23505"), text);
  const hash = () => randomBytes(32).toString("hex");
  const cols = `(id, wallet, channel, status, telegram_chat_id, email, confirm_hash, confirm_expires_at, proof_message, proof_signature, activated_at)`;
  await bad(`insert into alert_subscriptions ${cols} values ('BadWallet111', 'not-a-wallet', 'telegram', 'pending', null, null, $1, now(), 'm', 's', null)`, [hash()]);
  await bad(`insert into alert_subscriptions ${cols} values ('NoChat111111', $1, 'telegram', 'active', null, null, $2, now(), 'm', 's', now())`, [ALICE.address, hash()]);
  await bad(`insert into alert_subscriptions ${cols} values ('Upper1111111', $1, 'email', 'pending', null, 'Pat@Example.com', $2, now(), 'm', 's', null)`, [ALICE.address, hash()]);
  await bad(`insert into alert_subscriptions ${cols} values ('Mixed1111111', $1, 'email', 'pending', 5, 'pat@example.com', $2, now(), 'm', 's', null)`, [ALICE.address, hash()]);
  const sub = await activeSubscription(BOB.address, { chat: 991 });
  await bad(`insert into alert_subscriptions ${cols} values ('DupChat11111', $1, 'telegram', 'active', 991, null, $2, now(), 'm', 's', now())`, [BOB.address, hash()]);
  const id = await payDirectly(BOB.address);
  await bad(`insert into alert_deliveries (subscription_id, request_id) values ($1, $2)`, [sub.id, id]);
  await bad(`update alert_subscriptions set status = 'unsubscribed', unsubscribed_at = now(), ended_by = 'telegram_stop' where id = $1`, [sub.id]);
});
