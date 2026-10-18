import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { GET as getOne } from "@/app/api/v1/requests/[id]/route";
import { GET as getBulk, POST as createRequestRoute } from "@/app/api/v1/requests/route";
import { POST as createGroupRoute } from "@/app/api/v1/groups/route";
import { POST as createInvoiceRoute } from "@/app/api/v1/invoices/route";
import { POST as createScheduleRoute } from "@/app/api/v1/schedules/route";
import { POST as inboxRoute } from "@/app/api/v1/inbox/route";
import { POST as blockRoute } from "@/app/api/v1/inbox/block/route";
import {
  BulkRequestsResponse, CreateRequestResponse, GetRequestResponse, GroupResponse, InboxBlockResponse, InboxResponse, InvoiceResponse,
  ScheduleResponse,
} from "@/lib/contract";
import { sql } from "@/lib/db";
import { INBOX_CAUTION } from "@/lib/inbox";
import { PAYER_ASK_LIMITS } from "@/lib/inbox-payer";

// F1 on real Postgres: migration 0017, the payer fields on every create route, the signed inbox and block routes,
// bulk terms for pay_all, the per-requester limit, and pay_all's one-transaction-many-requests settlement (two
// requests to the same recipient for the same amount, each paid by its own transfer). PGlite answers lib/db.ts's
// Neon-over-HTTP calls; Solana answers from plugin/test/fixtures/sns (real captures, for .sns payers) and from the
// transactions a test puts on `chain`. Any other network call fails. Skips until @electric-sql/pglite is installed.

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

// ---------------------------------------------------------------- keys and wallets

/** A deterministic ed25519 wallet that signs like PayBox request_wallet_sign {op:"solanaMessage"} (UTF-8 bytes, hex out). */
function wallet(label: string) {
  const seed = createHash("sha256").update(`owed inbox-db test: ${label}`, "utf8").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
  return { address, sign: (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("hex") };
}
const PAYER = wallet("payer sam");
const OTHER_PAYER = wallet("payer ana");
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const TEAM_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // TEAM's USDC account (off curve: never a payer)
const REQUESTER_2 = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";
const REQUESTER_3 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v"; // bonfida.sns's owner
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Every signed message must differ (a message works once), and these tests sign several within one second: each
// takes the next earlier whole second, all well inside the 5-minute window.
const startSecond = Math.floor(Date.now() / 1000);
let signedSeconds = 0;
const isoNow = () => new Date((startSecond - ++signedSeconds) * 1000).toISOString().replace(".000Z", "Z");

// ---------------------------------------------------------------- Solana

interface SnsFixture { calls: Array<{ method: string; params: unknown[]; result: unknown }> }
const snsDir = new URL("../../plugin/test/fixtures/sns/", import.meta.url);
const recorded = readdirSync(snsDir).filter((f) => f.endsWith(".json"))
  .flatMap((f) => (JSON.parse(readFileSync(new URL(f, snsDir), "utf8")) as SnsFixture).calls);
/** Transactions on "chain" for this test: references → parsed (jsonParsed) transaction. */
const chain: Array<{ refs: string[]; tx: Record<string, unknown> }> = [];

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
        if (m.method === "getMultipleAccounts") {
          const hit = recorded.find((c) => c.method === m.method && JSON.stringify(c.params) === JSON.stringify(m.params));
          if (!hit) throw new TypeError(`unrecorded RPC call ${JSON.stringify(m.params)}`);
          return { jsonrpc: "2.0", id: m.id, result: hit.result };
        }
        if (m.method === "getSignaturesForAddress") {
          const list = chain.filter((t) => t.refs.includes(m.params[0] as string));
          if (list.length === 0) throw new TypeError("no chain for this reference"); // stored state, as with an outage
          return { jsonrpc: "2.0", id: m.id, result: list.map((t) => ({ signature: (t.tx.transaction as { signatures: string[] }).signatures[0], err: null })) };
        }
        if (m.method === "getTransaction") {
          const t = chain.find((c) => (c.tx.transaction as { signatures: string[] }).signatures[0] === m.params[0]);
          return { jsonrpc: "2.0", id: m.id, result: t?.tx ?? null };
        }
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
/** A fresh client IP per call, so the per-IP create limit never decides a test about another limit. */
const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown, ip = `198.51.100.${(++ipSeq % 250) + 1}`) =>
  route(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) }));
const ask = (body: Record<string, unknown>) => post(createRequestRoute, "/api/v1/requests", { recipient: TEAM, amount: "0.1", token: "USDC", source: "plugin", ...body });
const readOne = (id: string) => getOne(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getOne>[1]);
const readBulk = (ids: string) => getBulk(new Request(`${BASE}/api/v1/requests?ids=${ids}`));
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
async function inbox(who = PAYER) {
  const message = `Owed inbox access for ${who.address} at ${isoNow()}`;
  return post(inboxRoute, "/api/v1/inbox", { payer: who.address, signed_message: message, signature: who.sign(message) });
}
async function block(action: "block" | "unblock", requester: string, who = PAYER) {
  const message = `Owed ${action} ${requester} for ${who.address} at ${isoNow()}`;
  return post(blockRoute, "/api/v1/inbox/block", { payer: who.address, requester, action, signed_message: message, signature: who.sign(message) });
}
async function created(res: Response) {
  assert.equal(res.status, 201, await res.clone().text());
  return CreateRequestResponse.parse(await res.json());
}

// ---------------------------------------------------------------- tests

it("POST /requests with payer {handle, wallet} and requester_handle: stored and echoed lower case without @; the id is unchanged", async () => {
  const body = await created(await ask({ payer: { handle: "@Sam_OK", wallet: PAYER.address }, requester_handle: "@Raj", for: "dinner" }));
  assert.deepEqual(body.payer, { wallet: PAYER.address, handle: "sam_ok", sns: null });
  assert.equal(body.requester_handle, "raj");
  const [row] = await sql("select payer_wallet, payer_handle, payer_sns, requester_handle from requests where id = $1", [body.id]);
  assert.deepEqual(row, { payer_wallet: PAYER.address, payer_handle: "sam_ok", payer_sns: null, requester_handle: "raj" });
  const pub = GetRequestResponse.parse(await (await readOne(body.id)).json());
  assert.deepEqual(pub.payer, { wallet: PAYER.address, handle: "sam_ok", sns: null });
  assert.equal(pub.requester_handle, "raj");
  // The id is still the hash of recipient, asset, amount and reference only.
  const digest = createHash("sha256").update(`owed-request:v1\n${TEAM}\n${USDC}\n100000\n${body.reference}`, "utf8").digest();
  assert.equal(bs58.encode(digest).slice(-12), body.id);
});

it("an unaddressed request's reply and public shape carry no payer fields at all", async () => {
  const body = await created(await ask({ for: "plain" }));
  assert.equal("payer" in body, false);
  assert.equal("requester_handle" in body, false);
  const pub = (await (await readOne(body.id)).json()) as Record<string, unknown>;
  assert.equal("payer" in pub, false);
  assert.equal("requester_handle" in pub, false);
});

it("refuses a handle without its wallet, a bad handle, the recipient as payer, an off-curve payer and a bad requester_handle", async () => {
  const before = Number((await sql("select count(*)::text as n from requests"))[0]!.n);
  for (const [body, why] of [
    [{ payer: { handle: "@sam" } }, /resolve payer\.handle with PayBox resolve_username first/],
    [{ payer: { handle: "@sixteen_chars_xx", wallet: PAYER.address } }, /payer\.handle: an X handle is 1 to 15/],
    [{ payer: { handle: "@sa-m", wallet: PAYER.address } }, /payer\.handle/],
    [{ payer: { wallet: TEAM } }, /recipient's own wallet/],
    [{ payer: { wallet: TEAM_ATA } }, /a wallet that can sign/],
    [{ payer: { wallet: "not-a-wallet" } }, /Solana wallet address/],
    [{ payer: {} }, /give the payer's wallet/],
    [{ requester_handle: "raj kaur" }, /requester_handle/],
  ] as const) {
    const res = await ask(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await errorOf(res)).message, why, JSON.stringify(body));
  }
  assert.equal(Number((await sql("select count(*)::text as n from requests"))[0]!.n), before);
});

it("payer {sns}: resolved on Solana to its wallet and stored with the name; a wallet it doesn't point to is refused", async () => {
  const body = await created(await ask({ payer: { sns: "Bonfida.sns" } }));
  assert.deepEqual(body.payer, { wallet: BONFIDA, handle: null, sns: "bonfida.sns" });
  const both = await created(await ask({ payer: { sns: "bonfida.sns", wallet: BONFIDA } }));
  assert.equal(both.payer?.wallet, BONFIDA);
  const wrong = await ask({ payer: { sns: "bonfida.sns", wallet: PAYER.address } });
  assert.equal(wrong.status, 400);
  assert.match((await errorOf(wrong)).message, /bonfida\.sns points to Fw1ETan\S+ \(its owner\), not to the payer wallet/);
});

it("a brand word in requester_handle flags the request like one in its text", async () => {
  const body = await created(await ask({ requester_handle: "@PayBox_Help", payer: { wallet: PAYER.address } }));
  assert.ok(body.flags.includes("brand_word:paybox"), JSON.stringify(body.flags));
});

it("the database refuses malformed payer and handle columns, and a paid_instruction without a payment", async () => {
  const insert = (cols: string, vals: unknown[]) => pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, flags, source, ${cols})
     values ('${bs58.encode(createHash("sha256").update(String(Math.random())).digest()).slice(-12)}', $1, 'USDC', '${USDC}', 6, 1, '${bs58.encode(createHash("sha256").update(String(Math.random())).digest())}', '{}', 'web', ${vals.map((_, i) => `$${i + 2}`).join(", ")})`,
    [TEAM, ...vals],
  );
  await assert.rejects(insert("payer_handle", ["sam"]), /requests_payer_check/);
  await assert.rejects(insert("payer_wallet, payer_handle", [PAYER.address, "Sam"]), /requests_payer_check/);
  await assert.rejects(insert("payer_wallet", [TEAM]), /requests_payer_check/);
  await assert.rejects(insert("payer_wallet, payer_sns", [PAYER.address, "Bonfida.sns"]), /requests_payer_check/);
  await assert.rejects(insert("requester_handle", ["@raj"]), /requests_requester_handle_check/);
  await assert.rejects(insert("paid_instruction", [0]), /requests_paid_instruction_check/);
});

it("POST /inbox lists only the signer's open requests, oldest first, with totals, cautions and first_time", async () => {
  const mine1 = await created(await ask({ payer: { handle: "sam", wallet: PAYER.address }, requester_name: "Raj", requester_handle: "raj", for: "pizza" }));
  const mine2 = await created(await ask({ recipient: REQUESTER_2, amount: "2.5", payer: { wallet: PAYER.address }, for: "tickets" }));
  const notMine = await created(await ask({ payer: { wallet: OTHER_PAYER.address }, for: "someone else's" }));
  const res = await inbox();
  assert.equal(res.status, 200, await res.clone().text());
  const box = InboxResponse.parse(await res.json());
  assert.equal(box.payer, PAYER.address);
  assert.equal(box.caution, INBOX_CAUTION);
  const ids = box.owed.map((e) => e.id);
  assert.ok(ids.includes(mine1.id) && ids.includes(mine2.id));
  assert.ok(!ids.includes(notMine.id), "never another payer's requests");
  assert.ok(ids.indexOf(mine1.id) < ids.indexOf(mine2.id), "oldest first");
  const e1 = box.owed.find((e) => e.id === mine1.id)!;
  assert.deepEqual(
    [e1.amount, e1.amount_due, e1.token, e1.chain, e1.recipient, e1.requester_name, e1.requester_handle, e1.for, e1.first_time, e1.addressed_as],
    ["0.1", "0.1", "USDC", "solana", TEAM, "Raj", "raj", "pizza", true, { handle: "sam", sns: null }],
  );
  assert.equal(e1.link, `${BASE}/r/${mine1.id}`);
  const usdc = box.totals.find((t) => t.token === "USDC" && t.chain === "solana")!;
  const expected = box.owed.reduce((n, e) => n + BigInt(Math.round(Number(e.amount_due) * 1e6)), 0n);
  assert.equal(BigInt(Math.round(Number(usdc.amount_due) * 1e6)), expected);
  assert.equal(usdc.count, box.owed.length);
  assert.deepEqual(box.base, []);
});

it("POST /inbox: a signature works once, only from the payer's own wallet, and only fresh", async () => {
  const message = `Owed inbox access for ${PAYER.address} at ${isoNow()}`;
  const body = { payer: PAYER.address, signed_message: message, signature: PAYER.sign(message) };
  const first = await post(inboxRoute, "/api/v1/inbox", body);
  assert.equal(first.status, 200, await first.clone().text());
  const again = await post(inboxRoute, "/api/v1/inbox", body);
  assert.equal(again.status, 400);
  assert.match((await errorOf(again)).message, /already used/);
  const forged = `Owed inbox access for ${PAYER.address} at ${isoNow()}`;
  const wrong = await post(inboxRoute, "/api/v1/inbox", { payer: PAYER.address, signed_message: forged, signature: OTHER_PAYER.sign(forged) });
  assert.equal(wrong.status, 400);
  const old = `Owed inbox access for ${PAYER.address} at ${new Date(Date.now() - 6 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const stale = await post(inboxRoute, "/api/v1/inbox", { payer: PAYER.address, signed_message: old, signature: PAYER.sign(old) });
  assert.equal(stale.status, 400);
  assert.match((await errorOf(stale)).message, /more than 5 minutes old/);
  const ledgerWording = `Owed ledger access for ${PAYER.address} at ${isoNow()}`;
  const other = await post(inboxRoute, "/api/v1/inbox", { payer: PAYER.address, signed_message: ledgerWording, signature: PAYER.sign(ledgerWording) });
  assert.equal(other.status, 400, "a ledger signature doesn't open the inbox");
});

it("first_time turns false once this payer has paid that requester through Owed", async () => {
  const [paid] = await sql(
    `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = amount_atomic, paid_at = now(), paid_rail = 'solana_pay'
      where id = (select id from requests where recipient = $1 and payer_wallet = $3 and status = 'open' order by created_at limit 1) returning id`,
    [TEAM, "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK", PAYER.address],
  );
  assert.ok(paid);
  const box = InboxResponse.parse(await (await inbox()).json());
  assert.ok(!box.owed.some((e) => e.id === paid!.id), "a paid request leaves the inbox");
  for (const e of box.owed) assert.equal(e.first_time, e.recipient !== TEAM, `${e.recipient} ${e.id}`);
});

it("POST /inbox/block hides a requester's requests (answering with the inbox); unblock shows them again", async () => {
  const before = InboxResponse.parse(await (await inbox()).json());
  const fromTwo = before.owed.filter((e) => e.recipient === REQUESTER_2).length;
  assert.ok(fromTwo >= 1);
  const res = await block("block", REQUESTER_2);
  assert.equal(res.status, 200, await res.clone().text());
  const blocked = InboxBlockResponse.parse(await res.json());
  assert.deepEqual([blocked.blocked, blocked.changed, blocked.requester], [true, true, REQUESTER_2]);
  assert.equal(blocked.inbox.owed.filter((e) => e.recipient === REQUESTER_2).length, 0);
  assert.equal(blocked.inbox.blocked_hidden, fromTwo);
  assert.deepEqual(blocked.inbox.blocked_requesters, [REQUESTER_2]);
  const twice = InboxBlockResponse.parse(await (await block("block", REQUESTER_2)).json());
  assert.equal(twice.changed, false);
  // Blocking only hides: the request is still open and payable.
  const id = before.owed.find((e) => e.recipient === REQUESTER_2)!.id;
  assert.equal(GetRequestResponse.parse(await (await readOne(id)).json()).status, "open");
  const shown = InboxBlockResponse.parse(await (await block("unblock", REQUESTER_2)).json());
  assert.deepEqual([shown.blocked, shown.changed], [false, true]);
  assert.equal(shown.inbox.owed.filter((e) => e.recipient === REQUESTER_2).length, fromTwo);
  // The signed text must name the action and the requester.
  const message = `Owed block ${REQUESTER_2} for ${PAYER.address} at ${isoNow()}`;
  const swapped = await post(blockRoute, "/api/v1/inbox/block", { payer: PAYER.address, requester: REQUESTER_2, action: "unblock", signed_message: message, signature: PAYER.sign(message) });
  assert.equal(swapped.status, 400);
  assert.equal((await block("block", "nope")).status, 400);
});

it("GET /requests?ids= returns each request in its GET shape, in order, with unknown ids apart", async () => {
  const a = await created(await ask({ for: "bulk a", requester_handle: "raj", payer: { wallet: PAYER.address } }));
  const b = await created(await ask({ for: "bulk b" }));
  const unknown = "1111111111ab";
  const res = await readBulk(`${b.id},${a.id},${unknown},${a.id}`);
  assert.equal(res.status, 200, await res.clone().text());
  const bulk = BulkRequestsResponse.parse(await res.json());
  assert.deepEqual(bulk.requests.map((r) => r.id), [b.id, a.id]);
  assert.deepEqual(bulk.not_found, [unknown]);
  const single = (await (await readOne(a.id)).json()) as Record<string, unknown>;
  assert.deepEqual(bulk.requests[1], GetRequestResponse.parse(single));
  assert.equal(bulk.requests[1]!.requester_handle, "raj");
  for (const ids of ["", "nope", Array.from({ length: 21 }, (_, i) => `${"1".repeat(10)}${"ab"[i % 2]}${String.fromCharCode(65 + i)}`).join(",")]) {
    assert.equal((await readBulk(ids)).status, 400, ids.slice(0, 30));
  }
});

it(`addressed requests are limited to ${PAYER_ASK_LIMITS.perPairPerHour} per requester and payer per hour`, async () => {
  const payer = wallet("rate-limited payer");
  for (let i = 0; i < PAYER_ASK_LIMITS.perPairPerHour; i++) await created(await ask({ recipient: REQUESTER_3, payer: { wallet: payer.address } }));
  const res = await ask({ recipient: REQUESTER_3, payer: { wallet: payer.address } });
  assert.equal(res.status, 429);
  assert.match((await errorOf(res)).message, /addressed to this payer/);
  // Unaddressed requests from the same wallet aren't affected.
  await created(await ask({ recipient: REQUESTER_3 }));
});

it("split_bill: per-person payer on each share; the share is in that payer's inbox with the bill's title", async () => {
  const res = await post(createGroupRoute, "/api/v1/groups", {
    recipient: TEAM, total: "0.3", token: "USDC", title: "Pizza night", source: "plugin", requester_handle: "@raj",
    people: [{ name: "Sam", payer: { handle: "@sam", wallet: PAYER.address } }, { name: "Ana" }, { name: "Lee", payer: { wallet: OTHER_PAYER.address } }],
  });
  assert.equal(res.status, 201, await res.clone().text());
  const group = GroupResponse.parse(await res.json());
  assert.deepEqual(group.shares.map((s) => s.payer ?? null), [
    { wallet: PAYER.address, handle: "sam", sns: null }, null, { wallet: OTHER_PAYER.address, handle: null, sns: null },
  ]);
  assert.equal(group.requester_handle, "raj");
  const box = InboxResponse.parse(await (await inbox()).json());
  const share = box.owed.find((e) => e.id === group.shares[0]!.id)!;
  assert.deepEqual([share.kind, share.group_title, share.requester_handle], ["split_share", "Pizza night", "raj"]);
  assert.ok(!box.owed.some((e) => e.id === group.shares[2]!.id));
  const bad = await post(createGroupRoute, "/api/v1/groups", {
    recipient: TEAM, total: "0.2", token: "USDC", title: "x", source: "plugin", people: [{ name: "A", payer: { handle: "a" } }, { name: "B" }],
  });
  assert.equal(bad.status, 400);
  assert.match((await errorOf(bad)).message, /people\.0\.payer\.wallet/);
});

it("create_invoice: the client as payer; the inbox shows the invoice number and due date and links the invoice page", async () => {
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const res = await post(createInvoiceRoute, "/api/v1/invoices", {
    recipient: TEAM, token: "USDC", business_name: "Raj Studio", client_name: "Sam", items: [{ description: "Logo", unit_price: "0.05" }],
    due_date: due, invoice_number: "INV-7", source: "plugin", payer: { handle: "sam", wallet: PAYER.address }, requester_handle: "rajstudio",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const invoice = InvoiceResponse.parse(await res.json());
  assert.deepEqual(invoice.payer, { wallet: PAYER.address, handle: "sam", sns: null });
  assert.equal(invoice.requester_handle, "rajstudio");
  const box = InboxResponse.parse(await (await inbox()).json());
  const line = box.owed.find((e) => e.id === invoice.id)!;
  assert.deepEqual([line.kind, line.invoice_number, line.due_date, line.link], ["invoice", "INV-7", due, `${BASE}/i/${invoice.id}`]);
});

it("ask_every_month: the schedule stores the payer and this month's request is addressed to it", async () => {
  const today = new Date().getUTCDate();
  const res = await post(createScheduleRoute, "/api/v1/schedules", {
    recipient: TEAM, amount: "0.2", token: "USDC", payer_name: "Sam", for: "rent", day_of_month: Math.min(today, 28), source: "plugin",
    payer: { handle: "sam", wallet: PAYER.address }, requester_handle: "raj",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const schedule = ScheduleResponse.parse(await res.json());
  assert.deepEqual(schedule.payer, { wallet: PAYER.address, handle: "sam", sns: null });
  assert.equal(schedule.requester_handle, "raj");
  const [row] = await sql("select payer_wallet, payer_handle, requester_handle from schedules where id = $1", [schedule.id]);
  assert.deepEqual(row, { payer_wallet: PAYER.address, payer_handle: "sam", requester_handle: "raj" });
  if (today <= 28) {
    assert.ok(schedule.first_request);
    const [first] = await sql("select payer_wallet, payer_handle, requester_handle from requests where id = $1", [schedule.first_request!.id]);
    assert.deepEqual(first, { payer_wallet: PAYER.address, payer_handle: "sam", requester_handle: "raj" });
  }
});

// ---------------------------------------------------------------- pay_all settlement

/** A pay_all transaction (jsonParsed shape): one transferChecked per request into TEAM's USDC account, then a memo. */
function payAllTx(sig: string, transfers: Array<{ amount: bigint; refs: string[] }>) {
  const refs = [...new Set(transfers.flatMap((t) => t.refs))];
  const keys = [PAYER.address, "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi", TEAM_ATA, USDC, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ...refs];
  const total = transfers.reduce((s, t) => s + t.amount, 0n);
  return {
    slot: 400_000_000, blockTime: Math.floor(Date.now() / 1000), version: "legacy",
    meta: {
      err: null, preBalances: keys.map(() => 1_000_000), postBalances: keys.map(() => 1_000_000),
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: PAYER.address, uiTokenAmount: { amount: "9000000" } },
        { accountIndex: 2, mint: USDC, owner: TEAM, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: PAYER.address, uiTokenAmount: { amount: String(9_000_000n - total) } },
        { accountIndex: 2, mint: USDC, owner: TEAM, uiTokenAmount: { amount: String(total) } },
      ],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [
          ...transfers.map((t) => ({
            program: "spl-token",
            parsed: { type: "transferChecked", info: { source: keys[1], mint: USDC, destination: TEAM_ATA, multisigAuthority: PAYER.address, signers: t.refs, tokenAmount: { amount: String(t.amount), decimals: 6 } } },
          })),
          { program: "spl-memo", parsed: "owed:a owed:b" },
        ],
      },
    },
  };
}

it("pay_all: two requests to the same recipient for the same amount, one transaction, each paid by its own transfer", async () => {
  const a = await created(await ask({ amount: "0.07", payer: { wallet: OTHER_PAYER.address }, for: "pay_all a" }));
  const b = await created(await ask({ amount: "0.07", payer: { wallet: OTHER_PAYER.address }, for: "pay_all b" }));
  const sig = "4hXNMruxqBthk8t9Srp1nqTTMtUqKqHMBfzbYjeRY1QRWbMGRcNjEhWhvn5w9m5J3h5zH8Dr3nWwYzvT1T4E5nSG";
  chain.push({ refs: [a.reference, b.reference], tx: payAllTx(sig, [{ amount: 70_000n, refs: [a.reference] }, { amount: 70_000n, refs: [b.reference] }]) });
  const bulk = BulkRequestsResponse.parse(await (await readBulk(`${a.id},${b.id}`)).json());
  assert.deepEqual(bulk.requests.map((r) => [r.status, r.paid?.signature, r.paid?.amount]), [["paid", sig, "0.07"], ["paid", sig, "0.07"]]);
  const rows = await sql("select id, paid_signature, paid_instruction, paid_amount_atomic::text as paid from requests where id = any($1::text[]) order by paid_instruction", [[a.id, b.id]]);
  assert.deepEqual(rows.map((r) => [r.id, r.paid_signature, r.paid_instruction, r.paid]), [[a.id, sig, "0", "70000"], [b.id, sig, "1", "70000"]]);
  // Reading again changes nothing (each keeps its own transfer).
  const again = BulkRequestsResponse.parse(await (await readBulk(`${b.id},${a.id}`)).json());
  assert.deepEqual(again.requests.map((r) => r.status), ["paid", "paid"]);
});

it("one transfer carrying two requests' references pays only one of them, and the database refuses a second claim on it", async () => {
  const a = await created(await ask({ amount: "0.03", for: "shared a" }));
  const b = await created(await ask({ amount: "0.03", for: "shared b" }));
  const sig = "3F8Yk5RAPVzM4ivRMPXHPdUqLzZ8i9k1W2nsQ3qT1F3cB5eUcfQf6vX7jS4x5zU8Lt9gP7Fh6r8aQm3eNw2kDs4Y";
  chain.push({ refs: [a.reference, b.reference], tx: payAllTx(sig, [{ amount: 30_000n, refs: [a.reference, b.reference] }]) });
  const bulk = BulkRequestsResponse.parse(await (await readBulk(`${a.id},${b.id}`)).json());
  assert.deepEqual(bulk.requests.map((r) => r.status).sort(), ["open", "paid"]);
  const open = bulk.requests.find((r) => r.status === "open")!;
  await assert.rejects(
    pg.query("update requests set status = 'paid', paid_signature = $2, paid_instruction = 0 where id = $1", [open.id, sig]),
    /requests_paid_signature_key/,
  );
});
