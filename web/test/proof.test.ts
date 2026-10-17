import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadProof } from "@/app/proof/data";
import { requestIdFor } from "@/lib/ids";
import { parseJsonExact } from "@/lib/solana";
import * as requests from "@/lib/requests";
import { isTeamSql, teamMismatchSql, teamWallets } from "@/lib/team";
import { sql } from "@/lib/db";
import { store } from "@/lib/x402/store";

// /proof and the is_team rule (lib/team.ts) on real Postgres: PGlite runs every migration and answers
// lib/db.ts's Neon-over-HTTP calls. Settlement goes through the real settleFromChain → recordPayment
// path, with Solana JSON-RPC answered from W1-B's mainnet recording (fixtures/chain/sol-reference-payment).
// Skips until the devDependency @electric-sql/pglite is installed.

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

// ---------------------------------------------------------------- mainnet RPC replay

interface RecordedCall { method: string; params: unknown[]; result: unknown }
const SOL_PAY = parseJsonExact(readFileSync(new URL("fixtures/chain/sol-reference-payment.json", import.meta.url), "utf8")) as { calls: RecordedCall[] };
const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const keyOf = (method: string, params: unknown[]) => `${method} ${String(params[0])}`;
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));
const rpcServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const answer = (m: { id: number; method: string; params: unknown[] }) => {
      const hit = SOL_PAY.calls.find((c) => keyOf(c.method, c.params) === keyOf(m.method, m.params));
      return hit
        ? { jsonrpc: "2.0", id: m.id, result: hit.result }
        : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `unrecorded call ${keyOf(m.method, m.params)}` } };
    };
    res.end(toJson(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
});
await new Promise<void>((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
// The replay server answers in-process; a long timeout keeps a loaded machine from failing the test.
const rpc = { urls: [`http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`], timeoutMs: 30_000 };
after(() => rpcServer.close());

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith(NEON)) return realFetch(input, init);
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
  const dir = new URL("db/migrations/", WEB);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
});

beforeEach(async () => {
  delete process.env.OWED_TEAM_WALLETS;
  if (mod) await pg.exec("delete from x402_receipts; delete from requests;");
});

/** A request row with the given reference, inserted the way createRequest stores one (id hashes the terms). */
async function insertRequest(recipient: string, token: "USDC" | "SOL", amountAtomic: bigint, reference: string, extra = ""): Promise<string> {
  const id = requestIdFor({ recipient, token, amountAtomic, reference });
  const mint = token === "USDC" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : null;
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, for_text)
     values ($1, $2, $3, $4, $5, $6, $7, 'plugin', $8)`,
    [id, recipient, token, mint, token === "USDC" ? 6 : 9, amountAtomic.toString(), reference, extra || null],
  );
  return id;
}
// settleFromChain re-checks an id at most every 3 s, so every SOL request gets fresh terms (and so a fresh id).
// Anything at or below the recorded 3,027,000 lamports is paid in full by the recorded transaction.
let nextLamports = 3_027_000n;
const solRequest = () => insertRequest(SOL_PAYEE, "SOL", nextLamports--, SOL_REF, "dinner https://evil.example");
const isTeam = async (id: string) => (await pg.query<{ is_team: boolean }>("select is_team from requests where id = $1", [id])).rows[0]!.is_team;

// ---------------------------------------------------------------- the rule

test("teamWallets: valid Solana addresses only, trimmed, de-duplicated, in order", () => {
  assert.deepEqual(teamWallets({}), []);
  assert.deepEqual(teamWallets({ OWED_TEAM_WALLETS: "" }), []);
  assert.deepEqual(
    teamWallets({ OWED_TEAM_WALLETS: ` ${TEAM} ,not-an-address,${OTHER},${TEAM},,0x52908400098527886E0F7030069857D2E4169EE7` }),
    [TEAM, OTHER],
  );
});

it("a Solana Pay payment from a team wallet is recorded with is_team, and /proof lists it", async () => {
  process.env.OWED_TEAM_WALLETS = `${OTHER},${SOL_PAYER}`;
  const id = await solRequest();
  const [row] = await requests.settleFromChain([(await requests.getRequest(id))!], rpc);
  assert.equal(row!.status, "paid");
  assert.equal(row!.paidPayer, SOL_PAYER);
  assert.equal(await isTeam(id), true);

  const proof = await loadProof();
  assert.equal(proof.count, 1);
  assert.deepEqual(proof.rails, { solana_pay: 1, x402: 0 });
  assert.equal(proof.sol, "0.003027");
  assert.equal(proof.usdc, "0");
  assert.equal(proof.payments.length, 1);
  const p = proof.payments[0]!;
  assert.deepEqual(
    { id: p.id, kind: p.kind, token: p.token, amount: p.amount, rail: p.rail, signature: p.signature, fromDomain: p.fromDomain },
    { id, kind: "single", token: "SOL", amount: "0.003027", rail: "solana_pay", signature: SOL_SIG, fromDomain: null },
  );
  assert.match(p.paidAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Nothing requester-written is carried to the page.
  assert.ok(!JSON.stringify(proof).includes("dinner"));
});

it("QA-19: a stranger paying a request into a team wallet does not count; only the payer decides", async () => {
  process.env.OWED_TEAM_WALLETS = SOL_PAYEE; // the recipient is a team wallet, the payer isn't
  const id = await solRequest();
  const [row] = await requests.settleFromChain([(await requests.getRequest(id))!], rpc);
  assert.equal(row!.status, "paid");
  assert.equal(await isTeam(id), false);
  assert.equal((await loadProof()).count, 0);
});

it("with no team wallets configured, or none involved, the payment is recorded but stays off /proof", async () => {
  const id = await solRequest();
  const [row] = await requests.settleFromChain([(await requests.getRequest(id))!], rpc);
  assert.equal(row!.status, "paid");
  assert.equal(await isTeam(id), false);
  assert.deepEqual((await loadProof()).payments, []);

  await pg.exec("delete from requests");
  process.env.OWED_TEAM_WALLETS = `${TEAM},${OTHER}`;
  const id2 = await solRequest();
  await requests.settleFromChain([(await requests.getRequest(id2))!], rpc);
  assert.equal(await isTeam(id2), false);
  assert.equal((await loadProof()).count, 0);
});

it("an underpayment from a team wallet is flagged but not listed: /proof shows paid rows only", async () => {
  process.env.OWED_TEAM_WALLETS = SOL_PAYER;
  const id = await insertRequest(SOL_PAYEE, "SOL", 3_027_001n, SOL_REF);
  const [row] = await requests.settleFromChain([(await requests.getRequest(id))!], rpc);
  assert.equal(row!.status, "underpaid");
  assert.equal(await isTeam(id), true);
  assert.equal((await loadProof()).count, 0);
});

it("an x402 settlement from a team wallet is recorded with is_team and listed with rail x402", async () => {
  process.env.OWED_TEAM_WALLETS = OTHER;
  const row = await requests.createRequest({
    recipient: TEAM, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web",
  });
  const begun = await store.begin({ requestId: row.id, version: 2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountAtomic: 10_000n, payer: OTHER, feePayer: SOL_PAYER });
  assert.ok(begun.ok);
  await store.settled(begun.receiptId, SOL_SIG, OTHER);
  assert.equal(await store.verified({ id: begun.receiptId, requestId: row.id }, { signature: SOL_SIG, payer: OTHER, amountAtomic: 10_000n, at: "2026-10-17T13:00:00Z", slot: 1 }), true);
  assert.equal(await isTeam(row.id), true);
  const proof = await loadProof();
  assert.deepEqual(proof.rails, { solana_pay: 0, x402: 1 });
  assert.equal(proof.usdc, "0.01");
  assert.deepEqual([proof.payments[0]!.rail, proof.payments[0]!.amount, proof.payments[0]!.token], ["x402", "0.01", "USDC"]);
});

it("loadProof: newest first, kinds and verified domains carried, open and non-team rows left out", async () => {
  const mk = async (n: number, kind: "single" | "split_share" | "invoice", paidAt: string | null, team: boolean, domain: string | null) => {
    const reference = `Ref${n}`.padEnd(43, "1");
    const id = await insertRequest(TEAM, "USDC", 500_000n + BigInt(n), reference);
    if (kind === "invoice") {
      await pg.query("update requests set kind = 'invoice', invoice_id = id where id = $1", [id]);
    }
    if (kind === "split_share") {
      const gid = `G${n}`.padEnd(12, "2");
      await pg.query("insert into groups (id, recipient, token, total_atomic, source) values ($1, $2, 'USDC', 1000000, 'plugin')", [gid, TEAM]);
      await pg.query("update requests set kind = 'split_share', group_id = $2, group_position = 0 where id = $1", [id, gid]);
    }
    if (domain) await pg.query("update requests set from_domain = $2, from_domain_verified_at = '2026-10-17T11:19:12Z' where id = $1", [id, domain]);
    if (paidAt) {
      await pg.query(
        `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = amount_atomic,
                paid_at = $4::timestamptz, paid_rail = 'solana_pay', is_team = $5 where id = $1`,
        [id, `${SOL_SIG.slice(0, 80)}${n}`, OTHER, paidAt, team],
      );
    }
    return id;
  };
  const older = await mk(1, "split_share", "2026-10-17T12:00:00Z", true, "getowed.xyz");
  const newer = await mk(2, "invoice", "2026-10-17T13:30:00Z", true, null);
  await mk(3, "single", "2026-10-17T14:00:00Z", false, null); // paid, not the team's
  await mk(4, "single", null, false, "getowed.xyz"); // open
  const proof = await loadProof();
  assert.deepEqual(proof.payments.map((p) => p.id), [newer, older]);
  assert.deepEqual(proof.payments.map((p) => p.kind), ["invoice", "split_share"]);
  assert.equal(proof.payments[1]!.groupId, "G1".padEnd(12, "2"));
  assert.deepEqual([proof.payments[1]!.fromDomain, proof.payments[1]!.fromDomainVerifiedAt], ["getowed.xyz", "2026-10-17T11:19:12Z"]);
  assert.equal(proof.count, 2);
  assert.equal(proof.usdc, "1.000003");
  assert.equal((await loadProof(1)).payments.length, 1);
});

it("scripts/mark-team.ts SQL: flags older settled rows by the same rule, clears stale flags, leaves open rows alone", async () => {
  const mk = async (n: number, recipient: string, payer: string | null, isTeamNow: boolean) => {
    const id = await insertRequest(recipient, "USDC", 10_000n + BigInt(n), `Mark${n}`.padEnd(43, "1"));
    if (payer !== null) {
      await pg.query(
        `update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = amount_atomic,
                paid_at = now(), paid_rail = 'solana_pay', is_team = $4 where id = $1`,
        [id, `${SOL_SIG.slice(0, 80)}${n}`, payer, isTeamNow],
      );
    }
    return id;
  };
  const fromTeam = await mk(1, OTHER, TEAM, false); // paid by the team before the env var existed
  const toTeam = await mk(2, TEAM, SOL_PAYER, false); // a stranger paid into a team wallet: stays off
  const stale = await mk(3, SOL_PAYEE, SOL_PAYER, true); // flagged, but its payer is no longer on the list
  const oldRule = await mk(6, TEAM, OTHER, true); // flagged by the earlier recipient-or-payer rule (QA-19)
  const already = await mk(4, TEAM, TEAM, true);
  const open = await mk(5, TEAM, null, false);
  const wallets = teamWallets({ OWED_TEAM_WALLETS: TEAM });
  const pending = await sql(`select id from requests where ${teamMismatchSql("$1")} order by id`, [wallets]);
  assert.deepEqual(pending.map((r) => r.id), [fromTeam, stale, oldRule].sort());
  const updated = await sql(`update requests set is_team = ${isTeamSql("$1", "paid_payer")} where ${teamMismatchSql("$1")} returning id`, [wallets]);
  assert.equal(updated.length, 3);
  assert.deepEqual(
    await Promise.all([fromTeam, toTeam, stale, oldRule, already, open].map(isTeam)),
    [true, false, false, false, true, false],
  );
  assert.equal((await sql(`select id from requests where ${teamMismatchSql("$1")}`, [wallets])).length, 0);
  assert.deepEqual((await loadProof()).payments.map((p) => p.id).sort(), [already, fromTeam].sort());
});
