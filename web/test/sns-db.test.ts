import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { GET } from "@/app/api/v1/requests/[id]/route";
import { POST } from "@/app/api/v1/requests/route";
import { CreateRequestResponse, GetRequestResponse } from "@/lib/contract";
import { sql } from "@/lib/db";

// W3-S SNS name payees on real Postgres: every migration (0015 included), lib/requests.ts and both request routes,
// with PGlite answering lib/db.ts's Neon-over-HTTP calls and Solana RPC answered from plugin/test/fixtures/sns
// (real mainnet captures). Any other network call fails. Skips until @electric-sql/pglite is installed.

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

// ---------------------------------------------------------------- Solana from real captures

const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v"; // bonfida.sns's owner
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
interface SnsFixture { calls: Array<{ method: string; params: unknown[]; result: unknown }> }
const snsDir = new URL("../../plugin/test/fixtures/sns/", import.meta.url);
const recorded = readdirSync(snsDir).filter((f) => f.endsWith(".json"))
  .flatMap((f) => (JSON.parse(readFileSync(new URL(f, snsDir), "utf8")) as SnsFixture).calls);
let rpcDown = false;
const rpcAsked: string[] = [];

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
      const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
      if (body.method === "getMultipleAccounts") {
        rpcAsked.push(url);
        if (rpcDown) throw new TypeError("fetch failed");
        const hit = recorded.find((c) => c.method === body.method && JSON.stringify(c.params) === JSON.stringify(body.params));
        if (!hit) throw new TypeError(`unrecorded RPC call ${JSON.stringify(body.params)}`);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: hit.result });
      }
    }
    throw new TypeError(`no network in this test: ${url}`); // payment checks fall back to stored state
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

const create = (body: Record<string, unknown>) =>
  POST(new Request("https://owed-preview.example/api/v1/requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: BONFIDA, amount: "0.01", token: "USDC", source: "plugin", ...body }),
  }));
const read = (id: string) => GET(new Request(`https://owed-preview.example/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof GET>[1]);
const isoZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seq = 0;
/** Distinct base58 strings for hand-inserted rows (ids and references must be base58). */
const base58 = (n: number) => Array.from({ length: n }, (_, i) => B58[(seq * 7 + i * 13 + (i === 0 ? ++seq : 0)) % 58]).join("");
const count = async () => Number((await sql("select count(*)::text as n from requests"))[0]!.n);

it("POST with a name that points to the recipient → 201 with sns_name and sns_source; GET returns them and the time", async () => {
  rpcDown = false;
  const res = await create({ sns_name: "Bonfida.SNS", for: "W3-S check" });
  assert.equal(res.status, 201, await res.clone().text());
  const body = CreateRequestResponse.parse(await res.json());
  assert.equal(body.sns_name, "bonfida.sns");
  assert.equal(body.sns_source, "owner");
  assert.deepEqual(body.flags, []);

  const got = await read(body.id);
  assert.equal(got.status, 200);
  const pub = GetRequestResponse.parse(await got.json());
  assert.equal(pub.sns_name, "bonfida.sns");
  assert.equal(pub.sns_source, "owner");
  assert.match(pub.sns_resolved_at ?? "", isoZ);
  assert.equal(pub.recipient, BONFIDA);

  const [row] = await sql("select sns_wallet, recipient from requests where id = $1", [body.id]);
  assert.equal(row!.sns_wallet, BONFIDA);
});

it("POST with a name that points elsewhere → 400 naming both wallets, and no row", async () => {
  const before = await count();
  const res = await create({ recipient: TEAM, sns_name: "bonfida.sns" });
  assert.equal(res.status, 400);
  const err = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(err.error.code, "invalid_input");
  assert.match(err.error.message, /bonfida\.sns points to Fw1ETan\S+ \(its owner\), not to the recipient FN6G4/);
  assert.equal(await count(), before);
});

it("POST with .sol, a tokenized name, a lookalike or an unregistered name → 400 before anything is stored", async () => {
  const before = await count();
  for (const [name, why] of [
    ["raj.sol", /\.sol name.*raj\.sns/],
    ["sns-ip-5-wallet-1.sns", /tokenized/],
    ["bоnfida.sns", /can pass for others/],
    ["owed-sns-fixture-unregistered-7f3a.sns", /isn't registered/],
  ] as const) {
    const res = await create({ sns_name: name });
    assert.equal(res.status, 400, name);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, why, name);
  }
  assert.equal(await count(), before);
});

it("Solana unreachable → 503 upstream_unavailable, no row (the plugin then makes an offline link without the name)", async () => {
  rpcDown = true;
  rpcAsked.length = 0;
  const before = await count();
  const res = await create({ sns_name: "bonfida.sns" });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "upstream_unavailable");
  assert.ok(rpcAsked.length >= 1);
  assert.equal(await count(), before);
  rpcDown = false;
});

it("the database refuses a name stored against another wallet, upper case, .sol, or without its source and time", async () => {
  const insert = (name: string | null, wallet: string | null, source: string | null, at: string | null) => pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, flags, source, sns_name, sns_wallet, sns_source, sns_resolved_at)
     values ($6, $1, 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 10000, $7, '{}', 'web', $2, $3, $4, $5::timestamptz)`,
    [BONFIDA, name, wallet, source, at, base58(12), base58(44)],
  );
  const now = "2026-10-18T00:00:00Z";
  for (const [name, wallet, source, at] of [
    ["bonfida.sns", TEAM, "owner", now],
    ["Bonfida.sns", BONFIDA, "owner", now],
    ["bonfida.sol", BONFIDA, "owner", now],
    ["a.b.c.sns", BONFIDA, "owner", now],
    ["bonfida.sns", BONFIDA, "nft", now],
    ["bonfida.sns", BONFIDA, null, now],
    ["bonfida.sns", BONFIDA, "owner", null],
    ["bonfida.sns", null, "owner", now],
    [null, BONFIDA, "owner", now],
    [null, BONFIDA, null, null],
  ] as const) {
    await assert.rejects(insert(name, wallet, source, at), /requests_sns_check/, `${name} ${wallet} ${source} ${at}`);
  }
  await insert("sub-0.wallet-guide-3.sns", BONFIDA, "sol_record_v2", now);
});

it("a Base request can't carry an SNS name", async () => {
  const res = await create({ chain: "base", recipient: "0x1111111111111111111111111111111111111111", sns_name: "bonfida.sns" });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /sns_name/);
});
