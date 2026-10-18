#!/usr/bin/env node
// Apply pending web/db/migrations/*.sql during a Vercel build, before `next build`, so a deployment
// only goes live on a schema that has every migration it ships with. `pnpm build` runs it first.
//
// - Runs only on Vercel (VERCEL=1) for VERCEL_ENV production or preview, and only when
//   DATABASE_URL_UNPOOLED (preferred: a direct session, needed for the advisory lock and DDL) or
//   DATABASE_URL is set. Anything else (a laptop, GitHub CI, `vercel dev`, a Development build)
//   prints why it skipped and exits 0 without opening a connection.
// - Same bookkeeping as scripts/migrate.sh: table schema_migrations(version, applied_at); each pending
//   file runs in its own transaction together with its `insert into schema_migrations`, like
//   `psql --single-transaction`. Files go over the simple query protocol, so a file may hold many
//   statements, comments and DO blocks.
// - A session advisory lock (key LOCK_KEY) is held for the whole run, so two builds against the same
//   database (two pushes in a row, a redeploy) never race; the second waits, then finds them applied.
// - The new schema is live while the previous deployment still serves (and stays if `next build`
//   then fails), so every migration must work with the code already deployed.
// - Any failure (connect, lock, a migration) prints the migration and the Postgres error, never the
//   connection string or password, and exits 1: the Vercel build fails and the previous deployment
//   keeps serving.
//
// The logic is exported for web/test/migrate-on-build.test.ts (PGlite); the CLI at the bottom wraps it
// with a node-postgres Client.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** pg_advisory_lock key for migration runs: the ASCII bytes of "owed" (0x6f776564). */
export const LOCK_KEY = 1870095716;
/** How long a build waits for another build's migration run before failing (Postgres lock_timeout). */
export const LOCK_WAIT = "300s";
/** Gives up on an unreachable or still-waking database instead of hanging the build. */
export const CONNECT_TIMEOUT_MS = 30_000;

const PREFIX = "migrate-on-build:";
const MIGRATED_ENVS = new Set(["production", "preview"]);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;

/**
 * Should this process migrate, and against which URL? Pure: reads only the given env object.
 * @param {Record<string, string | undefined>} env
 * @returns {{ run: false, reason: string } | { run: true, env: string, url: string, source: "DATABASE_URL_UNPOOLED" | "DATABASE_URL" }}
 */
export function migrationDecision(env) {
  if (env.VERCEL !== "1") return { run: false, reason: "not a Vercel build: VERCEL is not 1" };
  const target = env.VERCEL_ENV ?? "";
  if (!MIGRATED_ENVS.has(target)) {
    return { run: false, reason: `VERCEL_ENV is ${target ? JSON.stringify(target) : "not set"}; only production and preview builds migrate` };
  }
  if (env.DATABASE_URL_UNPOOLED) return { run: true, env: target, url: env.DATABASE_URL_UNPOOLED, source: "DATABASE_URL_UNPOOLED" };
  if (env.DATABASE_URL) return { run: true, env: target, url: env.DATABASE_URL, source: "DATABASE_URL" };
  return { run: false, reason: `${target} build without DATABASE_URL_UNPOOLED or DATABASE_URL` };
}

/**
 * node-postgres Client options for a postgres:// URL. TLS with certificate and host verification
 * unless the URL says sslmode=disable (Neon always requires TLS; its certificates are publicly
 * trusted). A Neon pooler host (`ep-…-pooler.`) is swapped for the direct host of the same endpoint:
 * PgBouncer in transaction mode would hand the session advisory lock to a random server connection.
 * @param {string} url
 */
export function clientConfig(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the database URL is not a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("the database URL is not a postgres:// URL");
  const host = decodeURIComponent(u.hostname).replace(/^\[(.+)\]$/, "$1");
  const [first, ...rest] = host.split(".");
  const direct = first.endsWith("-pooler") && rest.length > 0 ? [first.slice(0, -"-pooler".length), ...rest].join(".") : host;
  const sslmode = u.searchParams.get("sslmode");
  return {
    host: direct,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || undefined,
    options: u.searchParams.get("options") ?? undefined,
    ssl: sslmode === "disable" ? false : { rejectUnauthorized: true },
    application_name: "owed-migrate-on-build",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    pooled: direct !== host,
  };
}

/**
 * Strings that must never reach a build log: the URL itself and its password, raw and decoded.
 * @param {string} url
 */
export function secretsOf(url) {
  const out = [url];
  try {
    const p = new URL(url).password;
    if (p) out.push(p, decodeURIComponent(p));
  } catch {
    // not a URL: the whole string is already listed
  }
  return [...new Set(out.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

/**
 * @param {string} text
 * @param {readonly string[]} secrets
 */
export function redact(text, secrets) {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * One line for a Postgres or network error: message, [SQLSTATE], detail, hint, context.
 * Never includes the SQL text (PGlite attaches it) or connection parameters.
 * @param {unknown} e
 */
export function errorText(e) {
  if (!e || typeof e !== "object") return String(e);
  const err = /** @type {{ message?: string, code?: string, detail?: string, hint?: string, where?: string, errors?: unknown[] }} */ (e);
  const nested = Array.isArray(err.errors) ? err.errors.map((x) => (x && typeof x === "object" && "message" in x ? String(x.message) : "")).filter(Boolean) : [];
  let line = err.message || nested.join("; ") || err.code || "unknown error";
  if (err.code && !line.includes(err.code)) line += ` [${err.code}]`;
  if (err.detail) line += ` · detail: ${err.detail}`;
  if (err.hint) line += ` · hint: ${err.hint}`;
  if (err.where) line += ` · context: ${err.where}`;
  return line.replace(/\s+/g, " ").trim();
}

/** A migration that failed and was rolled back. */
export class MigrationError extends Error {
  /**
   * @param {string} migration
   * @param {unknown} cause
   */
  constructor(migration, cause) {
    super(`${migration}: ${errorText(cause)} (rolled back)`, { cause });
    this.name = "MigrationError";
    this.migration = migration;
  }
}

/**
 * Migration files in a directory, sorted by file name (the order migrate.sh and the tests use).
 * @param {string | URL} dir
 * @returns {{ name: string, sql: string }[]}
 */
export function readMigrationFiles(dir) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  return readdirSync(base)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(base, name), "utf8") }));
}

/** @param {string} s */
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

/**
 * Apply every file whose version (file name without .sql) is not in schema_migrations, in file-name
 * order, each in its own transaction with its schema_migrations row, under one advisory lock.
 * Stops at the first failure, rolls that file back and throws MigrationError; files before it stay
 * applied (they committed), files after it are not attempted.
 * @param {{
 *   query: (sql: string) => Promise<Record<string, unknown>[]>,
 *   files: readonly { name: string, sql: string }[],
 *   log?: (line: string) => void,
 * }} opts `query` runs one SQL string over the simple query protocol and returns the last statement's rows.
 * @returns {Promise<{ applied: string[], already: string[], unknown: string[] }>}
 */
export async function runMigrations({ query, files, log = () => {} }) {
  const seen = new Set();
  for (const f of files) {
    if (!FILE_NAME.test(f.name)) throw new Error(`refusing migration file name ${JSON.stringify(f.name)} (letters, digits, _ . - and .sql only)`);
    if (seen.has(f.name)) throw new Error(`migration ${f.name} is listed twice`);
    seen.add(f.name);
  }
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  await query(`set lock_timeout = '${LOCK_WAIT}'; select pg_advisory_lock(${LOCK_KEY}); reset lock_timeout`).catch((e) => {
    const code = /** @type {{ code?: string }} */ (e)?.code;
    throw new Error(code === "55P03" ? `another migration run held the lock for over ${LOCK_WAIT}: ${errorText(e)}` : `could not take the migration lock: ${errorText(e)}`, { cause: e });
  });
  try {
    await query("set client_min_messages = warning; create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
    const recorded = new Set((await query("select version from schema_migrations order by version")).map((r) => String(r.version)));
    const applied = [];
    const already = [];
    for (const file of ordered) {
      const version = file.name.slice(0, -".sql".length);
      if (recorded.has(version)) {
        already.push(version);
        continue;
      }
      log(`applying ${version}`);
      try {
        await query("begin");
        await query(file.sql);
        await query(`insert into schema_migrations (version) values (${literal(version)})`);
        await query("commit");
      } catch (e) {
        await query("rollback").catch(() => {});
        throw new MigrationError(version, e);
      }
      applied.push(version);
    }
    const known = new Set(ordered.map((f) => f.name.slice(0, -".sql".length)));
    return { applied, already, unknown: [...recorded].filter((v) => !known.has(v)) };
  } finally {
    await query(`select pg_advisory_unlock(${LOCK_KEY})`).catch((e) => log(`could not release the migration lock (it ends with the session): ${errorText(e)}`));
  }
}

/**
 * @param {string} env
 * @param {{ applied: readonly string[], already: readonly string[] }} result
 */
export function summaryLine(env, { applied, already }) {
  return `${PREFIX} ${env} · applied ${applied.length} (${applied.length ? applied.join(", ") : "none"}) · already applied ${already.length}`;
}

/**
 * The CLI: decide, connect, migrate, print. Returns the exit code.
 * @param {Record<string, string | undefined>} env
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, dir?: string | URL }} [io]
 */
export async function main(env, { out = console.log, err = console.error, dir = new URL("../db/migrations/", import.meta.url) } = {}) {
  const decision = migrationDecision(env);
  if (!decision.run) {
    out(`${PREFIX} skipped (${decision.reason})`);
    return 0;
  }
  const secrets = secretsOf(decision.url);
  const fail = (/** @type {string} */ line) => {
    err(`${PREFIX} ${decision.env} · ${redact(line, secrets)}`);
    return 1;
  };

  let files;
  let config;
  try {
    files = readMigrationFiles(dir);
    config = clientConfig(decision.url);
  } catch (e) {
    return fail(`${decision.source}: ${errorText(e)}`);
  }
  const { pooled, ...options } = config;
  if (pooled) out(`${PREFIX} ${decision.env} · ${decision.source} is a pooler host; using the direct host of the same endpoint`);

  const { default: pg } = await import("pg");
  const client = new pg.Client(options);
  client.on("error", () => {}); // a dropped connection surfaces as the pending query's rejection
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => {});
    return fail(`could not connect to the database (${decision.source} host ${options.host}): ${errorText(e)}`);
  }
  try {
    const result = await runMigrations({
      files,
      log: (line) => out(`${PREFIX} ${decision.env} · ${line}`),
      query: async (sql) => {
        const r = await client.query(sql);
        const last = Array.isArray(r) ? r[r.length - 1] : r;
        return last?.rows ?? [];
      },
    });
    if (result.unknown.length) out(`${PREFIX} ${decision.env} · recorded in schema_migrations with no file here: ${result.unknown.join(", ")}`);
    out(summaryLine(decision.env, result));
    return 0;
  } catch (e) {
    return fail(e instanceof MigrationError ? `FAILED at ${e.message}` : `FAILED: ${errorText(e)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Is this file the process entry point (`node scripts/migrate-on-build.mjs`), not an import? */
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) process.exitCode = await main(process.env);
