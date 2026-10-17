// Shared harness for W2-G's web repro tests: every migration on PGlite (Postgres in WASM) behind
// lib/db.ts's Neon-over-HTTP calls (same shim as web/test/x402-store.test.ts), and a local
// JSON-RPC server that answers getSignaturesForAddress / getTransaction from a table the test fills.
// Transactions follow the jsonParsed shape of the real mainnet captures in web/test/fixtures/chain/.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

interface PgResult { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }
interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], options?: Record<string, unknown>): Promise<{ rows: T[] } & Partial<PgResult>>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
}

const PGLITE = "@electric-sql/pglite";
// Resolved from web/, where the devDependency lives (this file sits outside web/).
const fromWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const mod = (await (async () => {
  try {
    return await import(pathToFileURL(fromWeb.resolve(PGLITE)).href);
  } catch {
    return null;
  }
})()) as { PGlite: new () => Pg } | null;
export const hasPglite = mod !== null;
export const pg = mod ? new mod.PGlite() : (null as unknown as Pg);
const WEB = new URL("../../../web/", import.meta.url);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));
const NEON = "https://api.us-east-1.aws.neon.tech/sql";

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

export async function startDb(): Promise<void> {
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
}

// ------------------------------------------------------------------ chain double

export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGYPeXFLv7xpLAeMG9qnP5a8";
const PAYER_ATA = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const RECIPIENT_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";

export interface ChainTx { signature: string; slot: number; blockTime: number; refs: string[]; credit: bigint; err?: unknown }

/** A USDC transferChecked from `payer` to `recipient`'s token account carrying `refs`, crediting `credit` atomic units. */
export function usdcTransfer(t: ChainTx, payer: string, recipient: string, before: bigint) {
  const keys = [payer, PAYER_ATA, RECIPIENT_ATA, USDC, ...t.refs, TOKEN_PROGRAM];
  return {
    slot: t.slot,
    blockTime: t.blockTime,
    meta: {
      err: t.err ?? null,
      fee: 5000,
      preBalances: keys.map(() => 1_000_000), postBalances: keys.map((_, i) => (i === 0 ? 995_000 : 1_000_000)),
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: String(before), decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: String(before + t.credit), decimals: 6 } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [t.signature],
      message: {
        accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: i < 3 })),
        instructions: [{
          program: "spl-token", programId: TOKEN_PROGRAM,
          parsed: { type: "transferChecked", info: { source: PAYER_ATA, destination: RECIPIENT_ATA, mint: USDC, multisigAuthority: payer, tokenAmount: { amount: String(t.credit), decimals: 6 } } },
        }],
      },
    },
    version: "legacy",
  };
}

/** Local JSON-RPC: signatures per reference newest first (honouring `limit`), parsed transactions by signature. */
export async function startChain() {
  const sigs = new Map<string, Array<{ signature: string; slot: number; err: unknown; blockTime: number }>>();
  const txs = new Map<string, unknown>();
  const log: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = (m: { id: number; method: string; params: unknown[] }) => {
        log.push(m.method);
        if (m.method === "getSignaturesForAddress") {
          const limit = (m.params[1] as { limit?: number } | undefined)?.limit ?? 1000;
          const list = [...(sigs.get(String(m.params[0])) ?? [])].sort((a, b) => b.slot - a.slot).slice(0, limit);
          return { jsonrpc: "2.0", id: m.id, result: list.map((s) => ({ ...s, memo: null, confirmationStatus: "finalized" })) };
        }
        if (m.method === "getTransaction") return { jsonrpc: "2.0", id: m.id, result: txs.get(String(m.params[0])) ?? null };
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unexpected ${m.method}` } };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    rpc: { urls: [url], timeoutMs: 15_000 },
    log,
    close: () => server.close(),
    /** Put a transaction on the double's chain: it is listed under every reference it carries. */
    land(t: ChainTx, payer: string, recipient: string, before: bigint) {
      txs.set(t.signature, usdcTransfer(t, payer, recipient, before));
      for (const r of t.refs) {
        if (!sigs.has(r)) sigs.set(r, []);
        sigs.get(r)!.push({ signature: t.signature, slot: t.slot, err: t.err ?? null, blockTime: t.blockTime });
      }
    },
  };
}

/** 88-char base58 signature-looking strings, distinct per n. */
export const sig = (n: number) => `${"5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2s"}${String(n).padStart(3, "1").replace(/0/g, "z")}`;
