import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCK_KEY,
  MigrationError,
  clientConfig,
  errorText,
  main,
  migrationDecision,
  readMigrationFiles,
  redact,
  runMigrations,
  secretsOf,
  summaryLine,
} from "../scripts/migrate-on-build.mjs";

// web/scripts/migrate-on-build.mjs, which `pnpm build` runs before `next build`: the env decision (pure),
// the node-postgres options, and runMigrations against PGlite with every real file in web/db/migrations.
// The CLI is run as a child process only where it never reaches a database (skip, refused localhost port).
// Skips the PGlite cases until @electric-sql/pglite is installed.

interface Pg {
  exec(sql: string): Promise<{ rows: Record<string, unknown>[] }[]>;
}
const PGLITE = "@electric-sql/pglite";
const mod = (await import(PGLITE).catch(() => null)) as { PGlite: new () => Pg } | null;
const it = mod ? test : test.skip;

const MIGRATIONS = new URL("../db/migrations/", import.meta.url);
const SCRIPT = fileURLToPath(new URL("../scripts/migrate-on-build.mjs", import.meta.url));
const REAL = readMigrationFiles(MIGRATIONS);
const VERSIONS = REAL.map((f) => f.name.replace(/\.sql$/, ""));
const NEON_URL = "postgresql://neondb_owner:npg_S3cretPassw0rd@ep-cool-darkness-a1b2c3d4-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const NEON_DIRECT = "postgresql://neondb_owner:npg_S3cretPassw0rd@ep-cool-darkness-a1b2c3d4.us-east-1.aws.neon.tech/neondb?sslmode=require";

/** A fresh PGlite plus the `query` runMigrations gets on Vercel (simple protocol, last statement's rows), recording every SQL string. */
function database() {
  const pg = new mod!.PGlite();
  const sent: string[] = [];
  const query = async (sql: string) => {
    sent.push(sql);
    const results = await pg.exec(sql);
    return results.at(-1)?.rows ?? [];
  };
  const rows = async (sql: string) => (await pg.exec(sql)).at(-1)?.rows ?? [];
  const recorded = async () => (await rows("select version from schema_migrations order by applied_at, version")).map((r) => String(r.version));
  const exists = async (table: string) => (await rows(`select to_regclass('${table}') is not null as ok`))[0].ok === true;
  const advisoryLocks = async () => Number((await rows("select count(*)::int as n from pg_locks where locktype = 'advisory'"))[0].n);
  return { pg, sent, query, rows, recorded, exists, advisoryLocks };
}

const migrationSql = (sent: string[]) => sent.filter((s) => REAL.some((f) => f.sql === s));

// ---------- when it runs ----------

test("runs only on Vercel production and preview builds that have a database URL", () => {
  assert.deepEqual(migrationDecision({}), { run: false, reason: "not a Vercel build: VERCEL is not 1" });
  assert.equal(migrationDecision({ VERCEL: "true", VERCEL_ENV: "production", DATABASE_URL: NEON_URL }).run, false);
  assert.equal(migrationDecision({ CI: "true", GITHUB_ACTIONS: "true", DATABASE_URL: NEON_URL }).run, false, "GitHub CI never migrates");

  const dev = migrationDecision({ VERCEL: "1", VERCEL_ENV: "development", DATABASE_URL_UNPOOLED: NEON_DIRECT });
  assert.deepEqual(dev, { run: false, reason: 'VERCEL_ENV is "development"; only production and preview builds migrate' });
  assert.deepEqual(migrationDecision({ VERCEL: "1", DATABASE_URL: NEON_URL }), { run: false, reason: "VERCEL_ENV is not set; only production and preview builds migrate" });

  const noUrl = migrationDecision({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" });
  assert.deepEqual(noUrl, { run: false, reason: "production build without DATABASE_URL_UNPOOLED or DATABASE_URL" });

  assert.deepEqual(migrationDecision({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: NEON_URL, DATABASE_URL_UNPOOLED: NEON_DIRECT }), {
    run: true, env: "production", url: NEON_DIRECT, source: "DATABASE_URL_UNPOOLED",
  });
  assert.deepEqual(migrationDecision({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: NEON_URL }), {
    run: true, env: "preview", url: NEON_URL, source: "DATABASE_URL",
  });
});

test("skip reasons never carry a URL or password", () => {
  for (const env of [
    { DATABASE_URL: NEON_URL },
    { VERCEL: "1", VERCEL_ENV: "development", DATABASE_URL: NEON_URL },
    { VERCEL: "1", DATABASE_URL_UNPOOLED: NEON_DIRECT },
  ]) {
    const d = migrationDecision(env);
    assert.equal(d.run, false);
    if (!d.run) assert.doesNotMatch(d.reason, /npg_|neon\.tech/);
  }
});

// ---------- connection options ----------

test("TLS with verification, the direct Neon host, decoded credentials", () => {
  const c = clientConfig(NEON_URL);
  assert.deepEqual(c, {
    host: "ep-cool-darkness-a1b2c3d4.us-east-1.aws.neon.tech",
    port: 5432,
    user: "neondb_owner",
    password: "npg_S3cretPassw0rd",
    database: "neondb",
    options: undefined,
    ssl: { rejectUnauthorized: true },
    application_name: "owed-migrate-on-build",
    connectionTimeoutMillis: 30_000,
    pooled: true,
  });
  const direct = clientConfig(NEON_DIRECT);
  assert.equal(direct.host, "ep-cool-darkness-a1b2c3d4.us-east-1.aws.neon.tech");
  assert.equal(direct.pooled, false);

  const odd = clientConfig("postgres://u%40x:p%2Fw%3Ad@db.example:6543/my%20db?options=endpoint%3Dep-x");
  assert.equal(odd.user, "u@x");
  assert.equal(odd.password, "p/w:d");
  assert.equal(odd.port, 6543);
  assert.equal(odd.database, "my db");
  assert.equal(odd.options, "endpoint=ep-x");
  assert.deepEqual(odd.ssl, { rejectUnauthorized: true }, "no sslmode still means TLS");

  assert.equal(clientConfig("postgres://u:p@127.0.0.1:5432/x?sslmode=disable").ssl, false);
  for (const mode of ["require", "prefer", "verify-ca", "verify-full", "allow"]) {
    assert.deepEqual(clientConfig(`postgres://u:p@h.example/x?sslmode=${mode}`).ssl, { rejectUnauthorized: true }, mode);
  }
});

test("a bad URL is refused without echoing it", () => {
  assert.throws(() => clientConfig("npg_S3cretPassw0rd"), (e: Error) => !e.message.includes("npg_") && /not a valid URL/.test(e.message));
  assert.throws(() => clientConfig("mysql://u:npg_S3cretPassw0rd@h/x"), (e: Error) => !e.message.includes("npg_") && /postgres:\/\//.test(e.message));
});

test("redaction removes the URL and the password, raw and percent-encoded", () => {
  const url = "postgresql://owner:p%2Fss%3Aw0rd@ep-x.us-east-1.aws.neon.tech/neondb";
  const secrets = secretsOf(url);
  assert.equal(redact(`could not use ${url}`, secrets), "could not use [redacted]");
  assert.equal(redact("auth p/ss:w0rd and p%2Fss%3Aw0rd", secrets), "auth [redacted] and [redacted]");
  assert.equal(redact('password authentication failed for user "owner"', secrets), 'password authentication failed for user "owner"');
});

test("error text: message, SQLSTATE, detail, hint and context, never the SQL", () => {
  assert.equal(
    errorText({ message: 'relation "nope" does not exist', code: "42P01", query: "insert into nope values (1)" }),
    'relation "nope" does not exist [42P01]',
  );
  assert.equal(
    errorText({ message: "boom", code: "P0001", detail: "d", hint: "h", where: "PL/pgSQL function inline_code_block line 1 at RAISE" }),
    "boom [P0001] · detail: d · hint: h · context: PL/pgSQL function inline_code_block line 1 at RAISE",
  );
  const aggregate = Object.assign(new AggregateError([new Error("connect ECONNREFUSED ::1:5432"), new Error("connect ECONNREFUSED 127.0.0.1:5432")], ""), { code: "ECONNREFUSED" });
  assert.equal(errorText(aggregate), "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
  assert.equal(errorText("plain"), "plain");
});

test("summary line", () => {
  assert.equal(summaryLine("production", { applied: ["0018_funding_plans", "0019_pots"], already: VERSIONS }), `migrate-on-build: production · applied 2 (0018_funding_plans, 0019_pots) · already applied ${VERSIONS.length}`);
  assert.equal(summaryLine("preview", { applied: [], already: ["0001_core"] }), "migrate-on-build: preview · applied 0 (none) · already applied 1");
});

// ---------- runMigrations on PGlite ----------

it("applies every real migration to an empty database, in file-name order, and records each", async () => {
  assert.ok(REAL.length >= 17, "reads web/db/migrations");
  assert.deepEqual(VERSIONS, [...VERSIONS].sort(), "sorted by file name");
  assert.ok(VERSIONS.indexOf("0001_core") < VERSIONS.indexOf("0001a_derived_ids"));
  const db = database();
  const logs: string[] = [];
  const shuffled = [...REAL].reverse();
  const result = await runMigrations({ query: db.query, files: shuffled, log: (l: string) => logs.push(l) });

  assert.deepEqual(result, { applied: VERSIONS, already: [], unknown: [] });
  assert.deepEqual(await db.recorded(), VERSIONS);
  assert.deepEqual(migrationSql(db.sent), REAL.map((f) => f.sql), "each file once, oldest first");
  assert.deepEqual(logs, VERSIONS.map((v) => `applying ${v}`));
  for (const table of ["requests", "rate_events", "schema_migrations", "cta_events"]) assert.ok(await db.exists(table), table);

  // Each file is its own transaction, committed together with its schema_migrations row.
  const i = db.sent.indexOf(REAL[0].sql);
  assert.deepEqual(db.sent.slice(i - 1, i + 3), ["begin", REAL[0].sql, "insert into schema_migrations (version) values ('0001_core')", "commit"]);
  // The advisory lock brackets the whole run and is released.
  assert.match(db.sent[0], new RegExp(`select pg_advisory_lock\\(${LOCK_KEY}\\)`));
  assert.match(db.sent[0], /set lock_timeout = '300s'/);
  assert.equal(db.sent.at(-1), `select pg_advisory_unlock(${LOCK_KEY})`);
  assert.equal(await db.advisoryLocks(), 0);
});

it("is idempotent: a second run applies nothing and runs no migration SQL", async () => {
  const db = database();
  await runMigrations({ query: db.query, files: REAL });
  db.sent.length = 0;
  const logs: string[] = [];
  const again = await runMigrations({ query: db.query, files: REAL, log: (l: string) => logs.push(l) });
  assert.deepEqual(again, { applied: [], already: VERSIONS, unknown: [] });
  assert.deepEqual(migrationSql(db.sent), []);
  assert.ok(!db.sent.includes("begin"));
  assert.deepEqual(logs, []);
  assert.deepEqual(await db.recorded(), VERSIONS);
  assert.equal(await db.advisoryLocks(), 0);
});

it("applies only the files migrate.sh has not recorded yet", async () => {
  const db = database();
  // The state scripts/migrate.sh leaves: its table, the first files applied and recorded.
  const done = REAL.slice(0, 10);
  await db.pg.exec("create table schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  for (const f of done) {
    await db.pg.exec(f.sql);
    await db.pg.exec(`insert into schema_migrations (version) values ('${f.name.replace(/\.sql$/, "")}')`);
  }
  await db.pg.exec("insert into schema_migrations (version) values ('0010_retired')");

  const result = await runMigrations({ query: db.query, files: REAL });
  assert.deepEqual(result.applied, VERSIONS.slice(10));
  assert.deepEqual(result.already, VERSIONS.slice(0, 10));
  assert.deepEqual(result.unknown, ["0010_retired"], "rows with no file are reported, not touched");
  assert.deepEqual(migrationSql(db.sent), REAL.slice(10).map((f) => f.sql));
  assert.deepEqual((await db.recorded()).sort(), [...VERSIONS, "0010_retired"].sort());
});

it("runs multi-statement files with comments, quotes and DO blocks", async () => {
  const db = database();
  const sql = `-- 0100_many: several statements in one file
create table many (n int not null, label text);
/* a block comment; with a semicolon */
insert into many values (1, 'it''s; fine');
do $$
begin
  insert into many values (2, 'from a DO block; still one statement');
  if (select count(*) from many) <> 2 then raise exception 'expected 2 rows'; end if;
end
$$;
insert into many (n) select 3;
`;
  const result = await runMigrations({ query: db.query, files: [{ name: "0100_many.sql", sql }] });
  assert.deepEqual(result.applied, ["0100_many"]);
  assert.deepEqual((await db.rows("select n, label from many order by n")).map((r) => [r.n, r.label]), [
    [1, "it's; fine"],
    [2, "from a DO block; still one statement"],
    [3, null],
  ]);
});

it("a failing migration rolls back completely, stops the run and names the file", async () => {
  const db = database();
  const files = [
    ...REAL,
    { name: "9001_ok.sql", sql: "create table ok_before (id int);" },
    { name: "9002_broken.sql", sql: "create table broken_partial (id int);\ninsert into broken_partial values (1);\ninsert into nope values (1);" },
    { name: "9003_after.sql", sql: "create table never_reached (id int);" },
  ];
  const logs: string[] = [];
  await assert.rejects(runMigrations({ query: db.query, files, log: (l: string) => logs.push(l) }), (e: unknown) => {
    assert.ok(e instanceof MigrationError);
    assert.equal(e.migration, "9002_broken");
    assert.equal(e.message, '9002_broken: relation "nope" does not exist [42P01] (rolled back)');
    return true;
  });
  assert.equal(await db.exists("broken_partial"), false, "no partial table");
  assert.equal(await db.exists("never_reached"), false, "later files are not attempted");
  assert.equal(await db.exists("ok_before"), true, "earlier files stay committed");
  const recorded = await db.recorded();
  assert.ok(recorded.includes("9001_ok"));
  assert.ok(!recorded.includes("9002_broken") && !recorded.includes("9003_after"));
  assert.deepEqual(logs.slice(-2), ["applying 9001_ok", "applying 9002_broken"]);
  assert.equal(db.sent.at(-2), "rollback");
  assert.equal(db.sent.at(-1), `select pg_advisory_unlock(${LOCK_KEY})`);
  assert.equal(await db.advisoryLocks(), 0, "the lock is released after a failure");

  // Fix the file and the next build picks up exactly where this one stopped.
  files[files.length - 2] = { name: "9002_broken.sql", sql: "create table broken_partial (id int);" };
  const retry = await runMigrations({ query: db.query, files });
  assert.deepEqual(retry.applied, ["9002_broken", "9003_after"]);
});

it("a syntax error anywhere in a file applies none of it", async () => {
  const db = database();
  await assert.rejects(
    runMigrations({ query: db.query, files: [{ name: "0100_typo.sql", sql: "create table typo_first (id int);\ncreat table typo_second (id int);" }] }),
    (e: unknown) => e instanceof MigrationError && /syntax error at or near "creat" \[42601\]/.test(e.message),
  );
  assert.equal(await db.exists("typo_first"), false);
  assert.deepEqual(await db.recorded(), []);
});

it("refuses unsafe or duplicate file names before touching the database", async () => {
  const db = database();
  await assert.rejects(runMigrations({ query: db.query, files: [{ name: "0100_x');drop table requests;--.sql", sql: "select 1" }] }), /refusing migration file name/);
  await assert.rejects(runMigrations({ query: db.query, files: [{ name: "0100_a.sql", sql: "" }, { name: "0100_a.sql", sql: "" }] }), /listed twice/);
  assert.deepEqual(db.sent, []);
});

test("a lock or bookkeeping failure is reported and the lock is still released", async () => {
  const sent: string[] = [];
  const query = async (sql: string) => {
    sent.push(sql);
    if (sql.startsWith("set client_min_messages")) throw Object.assign(new Error("permission denied for schema public"), { code: "42501" });
    return [];
  };
  await assert.rejects(runMigrations({ query, files: REAL }), /permission denied for schema public/);
  assert.equal(sent.at(-1), `select pg_advisory_unlock(${LOCK_KEY})`);

  const busy = async () => {
    throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  };
  await assert.rejects(runMigrations({ query: busy, files: REAL }), /another migration run held the lock for over 300s/);
});

// ---------- the CLI ----------

function cli(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

test("CLI: a local or CI build skips with exit 0 and opens no connection", () => {
  assert.deepEqual(cli({}), { status: 0, stdout: "migrate-on-build: skipped (not a Vercel build: VERCEL is not 1)", stderr: "" });
  assert.deepEqual(cli({ VERCEL: "1", VERCEL_ENV: "development", DATABASE_URL: "postgres://u:npg_pw123@127.0.0.1:1/x" }), {
    status: 0,
    stdout: 'migrate-on-build: skipped (VERCEL_ENV is "development"; only production and preview builds migrate)',
    stderr: "",
  });
  assert.equal(cli({ VERCEL: "1", VERCEL_ENV: "preview" }).stdout, "migrate-on-build: skipped (preview build without DATABASE_URL_UNPOOLED or DATABASE_URL)");
});

test("CLI: an unreachable database fails the build with exit 1 and no secrets", () => {
  // Port 1 on loopback refuses at once: this never reaches a real database.
  const r = cli({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: "postgres://owner:npg_TopSecret1@127.0.0.1:1/neondb?sslmode=disable" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^migrate-on-build: production · could not connect to the database \(DATABASE_URL_UNPOOLED host 127\.0\.0\.1\): connect ECONNREFUSED 127\.0\.0\.1:1/);
  assert.doesNotMatch(r.stderr, /npg_TopSecret1|postgres:\/\//);
});

test("CLI: a malformed URL fails with exit 1 and is not echoed", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: "npg_TopSecret1 is not a url" }, { out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["migrate-on-build: preview · DATABASE_URL: the database URL is not a valid URL"]);
});

test("CLI: an empty migrations directory is fine to read", () => {
  const dir = mkdtempSync(join(tmpdir(), "owed-migrate-"));
  writeFileSync(join(dir, "README.txt"), "not a migration");
  assert.deepEqual(readMigrationFiles(dir), []);
});
