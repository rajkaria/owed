import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as requests from "@/lib/requests";
import { parseSupported } from "@/lib/x402/facilitator";
import { handleX402, type X402Deps } from "@/lib/x402/handler";
import { settlePendingX402 } from "@/lib/x402/settle";
import { store } from "@/lib/x402/store";

// The x402 receipts SQL (migration 0004 + lib/x402/store.ts) on real Postgres: PGlite (Postgres
// compiled to WASM) answers lib/db.ts's Neon-over-HTTP calls. Skips until the devDependency
// @electric-sql/pglite is installed (LEAD adds it, pinned).

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

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SIG = (n: number) => `5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUY${"abcdefghij"[n]}`;

type BeginInput = Parameters<typeof store.begin>[0];
const beginInput = (requestId: string, version: 1 | 2 = 2): BeginInput =>
  ({ requestId, version, network: version === 2 ? NETWORK : "solana", amountAtomic: 10_000n, payer: PAYER, feePayer: FEE_PAYER });
async function lock(input: BeginInput): Promise<string> {
  const r = await store.begin(input);
  assert.ok(r.ok, "expected to take the lock");
  return r.receiptId;
}
async function load(id: string): Promise<requests.RequestRow> {
  const row = await requests.getRequest(id);
  assert.ok(row, `request ${id} exists`);
  return row;
}
const newRequest = () => requests.createRequest({
  recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: "it", note: null, requesterName: null, flags: [], source: "web",
});
const credit = (n: number, at: string) => ({ signature: SIG(n), payer: PAYER, amountAtomic: 10_000n, at, slot: n });

it("migrations apply in order on a clean database", async () => {
  const r = await pg.query<{ n: number }>("select count(*)::int as n from x402_receipts");
  assert.equal(r.rows[0]!.n, 0);
});

it("begin takes the lock once; a second begin sees the holder; fail releases it", async () => {
  const row = await newRequest();
  const a = await lock(beginInput(row.id));
  const b = await store.begin(beginInput(row.id));
  assert.ok(!b.ok);
  assert.equal(b.holder?.state, "settling");
  assert.equal(b.holder?.requestId, row.id);
  assert.equal(b.holder?.amountAtomic, 10_000n);
  await store.fail(a, "failed", "insufficient_funds");
  await store.fail(await lock(beginInput(row.id)), "failed", "x");
});

it("an unknown (timed-out) settlement keeps the lock until it expires, then begin abandons it", async () => {
  const row = await newRequest();
  const a = await lock(beginInput(row.id, 1));
  await store.fail(a, "unknown", "facilitator /settle timed out");
  assert.equal((await store.begin(beginInput(row.id, 1))).ok, false);
  await pg.query("update x402_receipts set created_at = now() - interval '151 seconds' where id = $1", [a]);
  await lock(beginInput(row.id, 1));
  const states = await pg.query<{ state: string; error: string | null }>("select state, error from x402_receipts where request_id = $1 order by id", [row.id]);
  assert.deepEqual(states.rows, [{ state: "abandoned", error: "facilitator /settle timed out" }, { state: "settling", error: null }]);
});

it("settled -> pending -> verified marks the request paid over x402, once", async () => {
  const row = await newRequest();
  const a = await lock(beginInput(row.id));
  await store.settled(a, SIG(1), PAYER);
  const pending = await store.pending([row.id]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.signature, SIG(1));
  assert.ok(pending[0]!.ageSeconds >= 0 && pending[0]!.ageSeconds < 5);
  assert.equal(await store.verified({ id: a, requestId: row.id }, credit(1, "2026-10-17T09:00:00Z")), true);
  const paid = await load(row.id);
  assert.deepEqual([paid.status, paid.paidRail, paid.paidSignature, paid.paidPayer, paid.paidAmountAtomic, paid.paidAt], ["paid", "x402", SIG(1), PAYER, 10_000n, "2026-10-17T09:00:00Z"]);
  const pub = requests.toPublic(paid, "https://owed.example");
  assert.equal(pub.paid?.rail, "x402");
  assert.equal(pub.x402_url, `https://owed.example/x/${row.id}`);
  assert.deepEqual(await store.pending([row.id]), []);
  // Verified again (a racing status check): the request is not touched twice.
  assert.equal(await store.verified({ id: a, requestId: row.id }, credit(1, "2026-10-17T09:00:00Z")), false);
});

it("a transaction already settling another request is refused and the receipt released", async () => {
  const first = await newRequest();
  const second = await newRequest();
  await pg.query("update requests set status = 'paid', paid_signature = $2, paid_rail = 'solana_pay' where id = $1", [first.id, SIG(2)]);
  const a = await lock(beginInput(second.id));
  await store.settled(a, SIG(3), PAYER);
  assert.equal(await store.verified({ id: a, requestId: second.id }, credit(2, "2026-10-17T09:00:00Z")), false);
  const r = await pg.query<{ state: string }>("select state from x402_receipts where id = $1", [a]);
  assert.equal(r.rows[0]!.state, "mismatch");
  assert.equal((await load(second.id)).status, "open");
});

it("the status-check hook flips a pending receipt to paid without a reference scan", async () => {
  const row = await newRequest();
  const a = await lock(beginInput(row.id));
  await store.settled(a, SIG(4), PAYER);
  const ids = await settlePendingX402([row], {}, { store, check: async () => ({ status: "verified", credit: credit(4, "2026-10-17T09:01:00Z") }) });
  assert.deepEqual([...ids], [row.id]);
  assert.equal((await load(row.id)).paidRail, "x402");
});

it("handler end to end on Postgres: two agents pay at once, exactly one settles", async () => {
  const row = await newRequest();
  const payments = JSON.parse(readFileSync(new URL("test/fixtures/x402/payments.json", WEB), "utf8"));
  // The fixture payment pays preview request 4tHguZSCqHmE's terms; give this row that id and reference.
  const fx = payments.request as { id: string; reference: string };
  await pg.query("update requests set id = $1, reference = $2 where id = $3", [fx.id, fx.reference, row.id]);
  const supported = parseSupported(JSON.parse(readFileSync(new URL("test/fixtures/x402/supported.json", WEB), "utf8")));
  let settles = 0;
  const deps: X402Deps = {
    load: requests.getRequest,
    refresh: async (r) => r,
    facilitator: {
      url: "https://facilitator.example",
      supported: async () => supported,
      verify: async () => ({ isValid: true, payer: payments.payer }),
      settle: async () => {
        settles++;
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, transaction: SIG(5), network: NETWORK, payer: payments.payer };
      },
    },
    store,
    waitForSettlement: async () => ({ status: "verified", credit: { ...credit(5, "2026-10-17T09:02:00Z"), payer: payments.payer } }),
    now: Date.now,
  };
  const req = () => new Request(`https://owed.example/x/${fx.id}`, { headers: { "payment-signature": payments.headers.honestV2 } });
  const [r1, r2] = await Promise.all([handleX402(req(), fx.id, "https://owed.example", deps), handleX402(req(), fx.id, "https://owed.example", deps)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(settles, 1);
  const paid = await load(fx.id);
  assert.deepEqual([paid.status, paid.paidRail, paid.paidSignature], ["paid", "x402", SIG(5)]);
  // A third agent afterwards gets the receipt, and nothing more is settled.
  const r3 = await handleX402(req(), fx.id, "https://owed.example", deps);
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).rail, "x402");
  assert.equal(settles, 1);
});
