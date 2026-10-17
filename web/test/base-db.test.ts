import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { toChecksumAddress } from "@/lib/evm/address";
import { BASE_USDC, eip681Transfer } from "@/lib/evm/base";
import { resetBaseThrottle, settleBaseRequests } from "@/lib/evm/settle";
import { requestIdFor } from "@/lib/ids";
import * as requests from "@/lib/requests";
import { store } from "@/lib/x402/store";
import { replay, scanFixture } from "./evm-helpers.ts";

// W3-B Base requests on real Postgres (PGlite answering lib/db.ts's Neon calls): migration 0011's
// rules, createRequest on Base, and settleBaseRequests against real Base logs replayed from
// test/fixtures/evm/scan.json. Skips until the devDependency @electric-sql/pglite is installed.

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
  resetBaseThrottle();
  if (mod) await pg.exec("delete from x402_receipts; delete from requests where chain = 'base'");
});

const RECIPIENT = toChecksumAddress(scanFixture.recipient);
const SOLANA = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const transfers = scanFixture.transfers;
const head = scanFixture.head;

const newBase = (amountAtomic: bigint, recipient = RECIPIENT) => requests.createRequest({
  recipient, token: "USDC", amountAtomic, payerName: null, forText: "base", note: null, requesterName: null, flags: [], source: "web", chain: "base",
});
async function setRow(id: string, createdUnix: number, cursor: number | null) {
  await pg.query("update requests set created_at = to_timestamp($2), chain_cursor = $3 where id = $1", [id, createdUnix, cursor]);
}
async function row(id: string) {
  const r = await requests.getRequest(id);
  assert.ok(r);
  return r;
}

it("0011 applies on top of every migration and is idempotent", async () => {
  await pg.exec(readFileSync(new URL("db/migrations/0011_base_requests.sql", WEB), "utf8"));
  const cols = await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'requests' and column_name = 'chain_cursor'");
  assert.equal(cols.rows.length, 1);
});

it("createRequest on Base: USDC at the Base contract, chain-aware id, EIP-681 pay_url, no Solana Pay URL", async () => {
  const r = await newBase(500_000n);
  assert.equal(r.chain, "base");
  assert.equal(r.mint, BASE_USDC);
  assert.equal(r.decimals, 6);
  assert.equal(r.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 500_000n, reference: r.reference, chain: "base" }));
  assert.notEqual(r.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 500_000n, reference: r.reference }));
  const pub = requests.toPublic(r, "https://owed.example");
  assert.equal(pub.chain, "base");
  assert.equal(pub.solana_pay_url, null);
  assert.equal(pub.pay_url, eip681Transfer(RECIPIENT, 500_000n));
  assert.equal(pub.x402_url, `https://owed.example/x/${r.id}`);
  assert.equal(pub.recipient, RECIPIENT);
  // Solana rows are unchanged, plus the two additive fields.
  const s = await requests.createRequest({ recipient: SOLANA, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web" });
  const sp = requests.toPublic(s);
  assert.equal(s.chain, "solana");
  assert.ok(sp.solana_pay_url?.startsWith(`solana:${SOLANA}?amount=0.01`));
  assert.equal(sp.pay_url, sp.solana_pay_url);
  assert.equal(sp.chain, "solana");
  await assert.rejects(requests.createRequest({ recipient: RECIPIENT, token: "SOL", amountAtomic: 1n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web", chain: "base" }), /USDC only/);
});

it("0011 refuses Base rows that aren't USDC to a 0x address, Solana rows paid by a Base transfer, and unknown chains", async () => {
  const r = await newBase(1_000_000n);
  const bad = [
    ["update requests set token = 'SOL', mint = null, decimals = 9 where id = $1", "requests_base_shape"],
    ["update requests set recipient = 'FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs' where id = $1", "requests_base_shape"],
    ["update requests set mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' where id = $1", "requests_base_shape"],
    ["update requests set status = 'paid', paid_rail = 'solana_pay', paid_signature = '0x" + "ab".repeat(32) + "' where id = $1", "requests_base_shape"],
    ["update requests set status = 'paid', paid_rail = 'base_transfer', paid_signature = '0xAB" + "ab".repeat(31) + "' where id = $1", "requests_base_shape"],
    ["update requests set chain = 'ethereum' where id = $1", "requests_chain_check"],
  ] as const;
  for (const [q, constraint] of bad) {
    await assert.rejects(pg.query(q, [r.id]), (e: { message: string }) => e.message.includes(constraint), q);
  }
  const s = await requests.createRequest({ recipient: SOLANA, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web" });
  await assert.rejects(pg.query("update requests set paid_rail = 'base_transfer' where id = $1", [s.id]), /requests_solana_rail/);
});

it("settleBaseRequests: real transfers settle the matching requests, oldest first, exact amount only", async () => {
  const [a, b, c] = transfers.filter((x) => x.value === "15880000"); // two real 15.88 USDC transfers
  assert.ok(a && b && !c, "fixture has exactly two 15.88 USDC transfers");
  const small = transfers.find((x) => x.value === "620000")!;
  const older = await newBase(15_880_000n);
  const newer = await newBase(15_880_000n);
  const odd = await newBase(15_880_001n); // one atomic unit off: never matches
  const sixtyTwo = await newBase(620_000n);
  const late = await newBase(1_270_000n); // created after its only matching transfer
  const cursor = scanFixture.recent_from - 1;
  await setRow(older.id, a.blockTimestamp - 300, cursor);
  await setRow(newer.id, a.blockTimestamp - 100, cursor);
  await setRow(odd.id, a.blockTimestamp - 300, cursor);
  await setRow(sixtyTwo.id, small.blockTimestamp - 50, cursor);
  const t127 = transfers.find((x) => x.value === "1270000")!;
  await setRow(late.id, t127.blockTimestamp + 60, cursor);

  const calls: string[] = [];
  const paid = await settleBaseRequests([await row(newer.id)], replay(scanFixture.exchanges, { calls }));
  // One head read and one log read for the recipient settle all of its open requests together.
  assert.deepEqual(calls, ["base-rpc.publicnode.com eth_getBlockByNumber", "base-rpc.publicnode.com eth_getLogs"]);
  assert.deepEqual([...paid].sort(), [older.id, newer.id, sixtyTwo.id].sort());

  const o = await row(older.id);
  const n = await row(newer.id);
  assert.deepEqual([o.status, o.paidSignature, o.paidRail, o.paidAmountAtomic, o.paidPayer], ["paid", a.txHash, "base_transfer", 15_880_000n, a.from]);
  assert.equal(o.paidAt, new Date(a.blockTimestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.equal(n.paidSignature, b.txHash, "the newer request takes the later transfer");
  assert.equal((await row(sixtyTwo.id)).paidSignature, small.txHash);
  for (const id of [odd.id, late.id]) {
    const r = await row(id);
    assert.equal(r.status, "open");
    assert.equal(r.chainCursor, BigInt(head.number - 10), "checked up to the head, minus the blocks re-read next time");
  }
  const pub = requests.toPublic(o);
  assert.deepEqual(pub.paid, { signature: a.txHash, payer: a.from, amount: "15.88", at: pub.paid!.at, rail: "base_transfer" });

  // Throttled for 3 s per recipient; after that a re-check reads from the cursor and settles nothing twice.
  assert.equal((await settleBaseRequests([await row(odd.id)], replay([], { calls }))).size, 0);
});

it("settleBaseRequests: a transaction that already paid a request never pays another; an x402 settlement on record is marked x402", async () => {
  const [a, b] = transfers.filter((x) => x.value === "15880000");
  const first = await newBase(15_880_000n);
  const second = await newBase(15_880_000n);
  const cursor = scanFixture.recent_from - 1;
  await setRow(first.id, a.blockTimestamp - 300, cursor);
  await setRow(second.id, a.blockTimestamp - 200, cursor);
  // `a` already settled some other request (say an earlier status check on another instance).
  const other = await newBase(15_880_000n);
  await pg.query("update requests set status = 'paid', paid_rail = 'base_transfer', paid_signature = $2, paid_payer = $3, paid_amount_atomic = 15880000, paid_at = now() where id = $1", [other.id, a.txHash, a.from]);
  // `b` is an x402 settlement the /x route recorded but couldn't confirm yet.
  const lock = await store.begin({ requestId: first.id, version: 2, network: "eip155:8453", amountAtomic: 15_880_000n, payer: b.from, feePayer: null });
  assert.ok(lock.ok);
  await store.settled(lock.receiptId, b.txHash, b.from);

  const paid = await settleBaseRequests([await row(second.id)], replay(scanFixture.exchanges));
  assert.deepEqual([...paid], [first.id]);
  const f = await row(first.id);
  assert.deepEqual([f.status, f.paidRail, f.paidSignature], ["paid", "x402", b.txHash]);
  assert.equal((await row(second.id)).status, "open", "no unused 15.88 transfer is left for it");
  const r = await pg.query<{ state: string }>("select state from x402_receipts where id = $1", [lock.receiptId]);
  assert.equal(r.rows[0]!.state, "verified");
});

it("settleBaseRequests: a never-scanned request starts a minute before its creation, checked against the real header", async () => {
  const small = transfers.find((x) => x.value === "620000")!;
  const r = await newBase(620_000n);
  // Created so the 2 s estimate starts exactly at recent_from, whose recorded header confirms it predates the request.
  await setRow(r.id, scanFixture.start_block_time + 60, null);
  const calls: string[] = [];
  const paid = await settleBaseRequests([await row(r.id)], replay(scanFixture.exchanges, { calls }));
  assert.deepEqual(calls, ["base-rpc.publicnode.com eth_getBlockByNumber", "base.gateway.tenderly.co eth_getBlockByNumber", "base-rpc.publicnode.com eth_getLogs"]);
  assert.deepEqual([...paid], [r.id]);
  assert.equal((await row(r.id)).paidSignature, small.txHash);
});

it("settleBaseRequests: Base unreachable -> throws, nothing written", async () => {
  const r = await newBase(620_000n);
  await setRow(r.id, scanFixture.start_block_time + 60, scanFixture.recent_from - 1);
  await assert.rejects(settleBaseRequests([await row(r.id)], replay(scanFixture.exchanges, { down: ["base-rpc.publicnode.com", "base.gateway.tenderly.co"] })));
  const after = await row(r.id);
  assert.equal(after.status, "open");
  assert.equal(after.chainCursor, BigInt(scanFixture.recent_from - 1));
});
