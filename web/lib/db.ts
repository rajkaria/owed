import "server-only";

// Postgres on Neon, queried over Neon's SQL-over-HTTP endpoint: one HTTPS POST per
// query (or per transaction batch), no connection pool to manage in serverless
// functions. Same wire protocol as @neondatabase/serverless's `neon()` (1.2.0):
// POST https://api.<region host>/sql with the connection string in a header,
// text values in array mode. Values come back as strings or null; callers cast.

export type SqlParam = string | number | bigint | boolean | null | readonly string[];
export type Row = Record<string, string | null>;

export interface Query {
  text: string;
  params?: readonly SqlParam[];
}

export class DbError extends Error {
  /** Postgres SQLSTATE, e.g. 23505 for unique_violation. */
  code?: string;
  constraint?: string;
}

const TIMEOUT_MS = 5000;

interface NeonResult {
  fields: { name: string; dataTypeID: number }[];
  rows: (string | null)[][];
}

function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new DbError("DATABASE_URL is not set");
  return url;
}

/** ep-xyz-pooler.us-east-1.aws.neon.tech -> https://api.us-east-1.aws.neon.tech/sql */
export function neonEndpoint(connection: string): string {
  const host = new URL(connection).hostname;
  return `https://${host.replace(/^[^.]+\./, "api.")}/sql`;
}

/** Postgres text-format array literal: {"a","b \"c\""} */
export function pgTextArray(items: readonly string[]): string {
  return `{${items.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export function encodeParam(p: SqlParam): string | null {
  if (p === null) return null;
  if (Array.isArray(p)) return pgTextArray(p);
  return String(p);
}

export function toRows(result: NeonResult): Row[] {
  const names = result.fields.map((f) => f.name);
  return result.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? null])));
}

async function post(body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const conn = connectionString();
  let res: Response;
  try {
    res = await fetch(neonEndpoint(conn), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": conn,
        "Neon-Raw-Text-Output": "true",
        "Neon-Array-Mode": "true",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new DbError(`database unreachable: ${e instanceof Error ? e.name : "error"}`);
  }
  if (res.ok) return res.json();
  if (res.status === 400) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string; code?: string; constraint?: string };
    const err = new DbError(detail.message ?? "query failed");
    err.code = detail.code;
    err.constraint = detail.constraint;
    throw err;
  }
  throw new DbError(`database error (HTTP ${res.status})`);
}

const encode = (q: Query) => ({ query: q.text, params: (q.params ?? []).map(encodeParam) });

/** Run one parameterized statement ($1, $2, …) and return its rows as text values. */
export async function sql(text: string, params: readonly SqlParam[] = []): Promise<Row[]> {
  return toRows((await post(encode({ text, params }))) as NeonResult);
}

/** Run several statements in one transaction; all commit or none do. */
export async function transaction(queries: readonly Query[]): Promise<Row[][]> {
  const out = (await post(
    { queries: queries.map(encode) },
    { "Neon-Batch-Isolation-Level": "ReadCommitted", "Neon-Batch-Read-Only": "false" },
  )) as { results: NeonResult[] };
  return out.results.map(toRows);
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  return e instanceof DbError && e.code === "23505" && (!constraint || e.constraint === constraint);
}

/** SQL fragment rendering a timestamptz column as "2026-10-17T05:00:09Z". */
export const isoUtc = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
