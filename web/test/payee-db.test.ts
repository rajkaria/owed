import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { GET } from "@/app/api/v1/requests/[id]/route";
import { POST } from "@/app/api/v1/requests/route";
import { CreateRequestResponse, GetRequestResponse } from "@/lib/contract";
import { DbError, sql } from "@/lib/db";
import { createRequest, getRequest, toPublic } from "@/lib/requests";

// Verified payee on real Postgres: migrations 0001 → 0009, lib/requests.ts and both request routes,
// with PGlite (Postgres compiled to WASM) answering lib/db.ts's Neon-over-HTTP calls and DNS
// answered from plugin/test/fixtures/doh (real resolver captures). Any other network call fails.
// Skips until the devDependency @electric-sql/pglite is installed (the same one W2-B's store tests use).

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

// ---------------------------------------------------------------- DNS from real captures

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
interface DohFixture { query: { qname: string }; responses: Array<{ resolver: string; url: string; status: number; body: string }> }
const doh = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../plugin/test/fixtures/doh/${name}.json`, import.meta.url), "utf8")) as DohFixture;
/** The real example.com NODATA answer with these TXT values added, in each resolver's format. */
function withTxt(f: DohFixture, values: string[]): DohFixture {
  return {
    ...f,
    responses: f.responses.map((r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const quoted = r.resolver === "cloudflare-dns.com";
      body.Answer = values.map((v) => ({ name: f.query.qname, type: 16, TTL: 300, data: quoted ? `"${v}"` : v }));
      delete body.Authority;
      return { ...r, body: JSON.stringify(body) };
    }),
  };
}
let dns: DohFixture | "down" = doh("nodata-signed");
const dohUrls: string[] = [];

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  const realFetch = globalThis.fetch;
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
    if (/^https:\/\/(cloudflare-dns\.com|dns\.google)\//.test(url)) {
      dohUrls.push(url);
      if (dns === "down") throw new TypeError("fetch failed");
      const r = dns.responses.find((x) => x.url === url);
      if (!r) throw new TypeError(`unrecorded DNS request ${url}`);
      return new Response(r.body, { status: r.status });
    }
    void realFetch;
    throw new TypeError(`no network in this test: ${url}`); // Solana RPC: routes fall back to stored state
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

const create = (body: Record<string, unknown>) =>
  POST(new Request("https://owed-preview.example/api/v1/requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: RECIPIENT, amount: "0.01", source: "plugin", ...body }),
  }));
const read = (id: string) => GET(new Request(`https://owed-preview.example/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof GET>[1]);
const isoZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

it("POST with a domain that publishes the recipient → 201 with from_domain; GET returns it and the verified time", async () => {
  dns = withTxt(doh("nodata-signed"), [`owed-pay=${OTHER}`, `owed-pay=${RECIPIENT}`]);
  dohUrls.length = 0;
  const res = await create({ from_domain: "Example.COM.", for: "W2-H check" });
  assert.equal(res.status, 201);
  const body = CreateRequestResponse.parse(await res.json());
  assert.equal(body.from_domain, "example.com");
  assert.deepEqual(dohUrls, ["https://cloudflare-dns.com/dns-query?name=_owed.example.com&type=TXT"]);

  const got = await read(body.id);
  assert.equal(got.status, 200);
  const pub = GetRequestResponse.parse(await got.json());
  assert.equal(pub.from_domain, "example.com");
  assert.match(pub.from_domain_verified_at ?? "", isoZ);
  assert.equal(pub.status, "open");
});

it("POST with a domain that doesn't publish it → 400 with the record to add, and no row", async () => {
  dns = doh("nodata-signed");
  const before = (await sql("select count(*) as n from requests"))[0].n;
  const res = await create({ from_domain: "example.com" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: { code: "invalid_input", message:
    `from_domain: example.com does not publish this recipient. To verify it, add a DNS TXT record named _owed.example.com with the value owed-pay=${RECIPIENT}, then try again` } });
  assert.equal((await sql("select count(*) as n from requests"))[0].n, before);
});

it("POST when DNS can't be read → 503 upstream_unavailable; a malformed domain → 400", async () => {
  dns = "down";
  const down = await create({ from_domain: "example.com" });
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { error: { code: string } }).error.code, "upstream_unavailable");
  const bad = await create({ from_domain: "https://example.com/pay" });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { message: string } }).error.message, "from_domain must be a domain name like example.com");
});

it("POST without from_domain is unchanged: no DNS, nulls stored and returned", async () => {
  dohUrls.length = 0;
  const res = await create({ for: "no domain" });
  assert.equal(res.status, 201);
  const body = CreateRequestResponse.parse(await res.json());
  assert.equal(body.from_domain, null);
  assert.deepEqual(dohUrls, []);
  const pub = GetRequestResponse.parse(await (await read(body.id)).json());
  assert.equal(pub.from_domain, null);
  assert.equal(pub.from_domain_verified_at, null);
});

it("createRequest stamps from_domain_verified_at only with a domain; toPublic carries both", async () => {
  const input = { recipient: RECIPIENT, token: "USDC" as const, amountAtomic: 10_000n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web" as const };
  const withDomain = await createRequest({ ...input, fromDomain: "xn--mnchen-3ya.de" });
  assert.equal(withDomain.fromDomain, "xn--mnchen-3ya.de");
  assert.match(withDomain.fromDomainVerifiedAt ?? "", isoZ);
  const reread = (await getRequest(withDomain.id))!;
  assert.equal(toPublic(reread).from_domain, "xn--mnchen-3ya.de");
  const without = await createRequest(input);
  assert.equal(without.fromDomain, null);
  assert.equal(without.fromDomainVerifiedAt, null);
});

it("the check constraint refuses an un-normalized domain and a domain without a verified time", async () => {
  const row = (await sql("select id from requests where from_domain is null limit 1"))[0];
  for (const [domain, at] of [["Example.com", "now()"], ["münchen.de", "now()"], ["example", "now()"], ["example.com", "null"]] as const) {
    await assert.rejects(
      sql(`update requests set from_domain = $1, from_domain_verified_at = ${at} where id = $2`, [domain, row.id!]),
      (e: unknown) => e instanceof DbError && e.code === "23514" && e.constraint === "requests_from_domain_check",
      `${domain} / ${at}`,
    );
  }
});

it("0009 is safe to re-run, and adds the pair to invoices when that table exists", async () => {
  await pg.exec("create table if not exists invoices (id text primary key)");
  await pg.exec(readFileSync(new URL("0009_payee_domain.sql", MIGRATIONS), "utf8"));
  const cols = await pg.query<{ table_name: string; column_name: string; data_type: string }>(
    `select table_name, column_name, data_type from information_schema.columns
      where column_name in ('from_domain', 'from_domain_verified_at') and table_name in ('requests', 'invoices')
      order by table_name, column_name`);
  assert.deepEqual(cols.rows.map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`), [
    "invoices.from_domain text", "invoices.from_domain_verified_at timestamp with time zone",
    "requests.from_domain text", "requests.from_domain_verified_at timestamp with time zone",
  ]);
});
