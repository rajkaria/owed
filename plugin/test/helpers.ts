// Test doubles for the tools. W1-A/W1-B functions use the real module once it is implemented
// (the stubs throw "not implemented: ..."), so these tests rerun against real code after those merges.
// API replies come from contract/fixtures (the canonical shapes); addresses are real mainnet keys.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import type { Rpc } from "../src/chain.ts";
import type { Deps } from "../src/deps.ts";
import * as money from "../src/money.ts";
import * as solanaPay from "../src/solana-pay.ts";
import { LinkError, type ParsedLink, type TransferRequest } from "../src/solana-pay.ts";
import * as tx from "../src/tx.ts";

export const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"; // team wallet sol-default
export const SENDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
export const SIGNATURE = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
export const USDC_MINT = money.USDC_MINT;
export const BASE = "https://owed-omega.vercel.app";

const fixturesDir = fileURLToPath(new URL("../../contract/fixtures/", import.meta.url));
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8")) as T;
}

/**
 * F2: a contract fixture that IS the plugin's output (a funding plan, the body it posts). OWED_WRITE_PLAN_FIXTURES=1
 * writes it from the real code; otherwise the output must equal the committed file, so the fixture can't drift.
 */
export function pinnedFixture(name: string, value: unknown): void {
  if (process.env.OWED_WRITE_PLAN_FIXTURES === "1") {
    writeFileSync(`${fixturesDir}${name}`, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  assert.deepEqual(value, fixture(name), `contract/fixtures/${name} drifted from the code: rerun with OWED_WRITE_PLAN_FIXTURES=1 and review the diff`);
}

function implemented(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (error) {
    return !(error instanceof Error && error.message.startsWith("not implemented"));
  }
}

// ---- doubles (used only while the real module is still a stub) ----

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
function toAtomicDouble(amount: string, token: money.Token): bigint {
  const decimals = money.TOKENS[token].decimals;
  if (!DECIMAL.test(amount)) throw new Error("Use a decimal amount like 15 or 2.5.");
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new Error(`${token} has at most ${decimals} decimal places.`);
  const atomic = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (atomic === 0n) throw new Error("The amount must be more than zero.");
  if (atomic > 2n ** 64n - 1n) throw new Error("The amount is too large.");
  return atomic;
}
function fromAtomicDouble(atomic: bigint, token: money.Token): string {
  const decimals = money.TOKENS[token].decimals;
  const s = atomic.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const fraction = s.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
function isSolanaAddressDouble(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}
function parseLinkDouble(input: string, owedHosts: string[]): ParsedLink {
  if (/^[1-9A-HJ-NP-Za-km-z]{10}$/.test(input)) return { kind: "owed", id: input };
  if (input.startsWith("https://")) {
    const url = new URL(input);
    if (!owedHosts.includes(url.host)) throw new LinkError("This link isn't an Owed or Solana Pay link.");
    const m = /^\/r\/([1-9A-HJ-NP-Za-km-z]{10})$/.exec(url.pathname);
    if (m) return { kind: "owed", id: m[1]! };
    const inner = url.searchParams.get("u");
    if (url.pathname === "/p" && inner) return parseLinkDouble(inner, owedHosts);
    throw new LinkError("This Owed link isn't a payment request.");
  }
  if (!input.startsWith("solana:")) throw new LinkError("This link isn't an Owed or Solana Pay link.");
  const rest = input.slice("solana:".length);
  if (/^https(:|%3A)/i.test(rest)) return { kind: "transaction", link: input };
  const [path, query = ""] = rest.split("?");
  const recipient = decodeURIComponent(path!);
  if (!isSolanaAddressDouble(recipient)) throw new LinkError("The recipient isn't a Solana address.");
  const params = new URLSearchParams(query);
  const request: TransferRequest = { recipient, references: params.getAll("reference") };
  const amount = params.get("amount");
  if (amount !== null) {
    if (!DECIMAL.test(amount)) throw new LinkError("The amount isn't a decimal number.");
    request.amount = amount;
  }
  const splToken = params.get("spl-token");
  if (splToken !== null) {
    if (splToken !== USDC_MINT) throw new LinkError("Owed pays USDC or SOL links only.");
    request.splToken = splToken;
  }
  for (const r of request.references) if (!isSolanaAddressDouble(r)) throw new LinkError("A reference isn't a 32-byte key.");
  for (const key of ["label", "message", "memo"] as const) {
    const value = params.get(key);
    if (value !== null) request[key] = value;
  }
  return { kind: "transfer", request };
}
function buildTransferUrlDouble(r: TransferRequest): string {
  const q: string[] = [];
  if (r.amount !== undefined) q.push(`amount=${r.amount}`);
  if (r.splToken !== undefined) q.push(`spl-token=${r.splToken}`);
  for (const ref of r.references) q.push(`reference=${ref}`);
  for (const key of ["label", "message", "memo"] as const) if (r[key] !== undefined) q.push(`${key}=${encodeURIComponent(r[key]!)}`);
  return `solana:${r.recipient}${q.length ? `?${q.join("&")}` : ""}`;
}
// 1 signature slot + a 199-byte body: canonical base64 of plausible size. Real tx bytes come from tx.ts once merged.
const FAKE_TX = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.alloc(199, 7)]).toString("base64");
function buildTransferTxDouble(): ReturnType<typeof tx.buildTransferTx> {
  return { transactionBase64: FAKE_TX, bytes: 264, instructions: ["transfer"] };
}

const real = {
  toAtomic: implemented(() => money.toAtomic("1", "USDC")),
  fromAtomic: implemented(() => money.fromAtomic(1n, "USDC")),
  parseLink: implemented(() => solanaPay.parseLink("JArQ6g9JvoWr", ["owed.link"])),
  buildTransferUrl: implemented(() => solanaPay.buildTransferUrl({ recipient: RECIPIENT, references: [] })),
  newReference: implemented(() => solanaPay.newReference()),
  isSolanaAddress: implemented(() => solanaPay.isSolanaAddress(RECIPIENT)),
  buildTransferTx: implemented(() => tx.buildTransferTx({
    sender: SENDER, request: { recipient: RECIPIENT, amount: "1", references: [] }, token: "SOL", amountAtomic: 1n, createRecipientAta: false,
  })),
};
export const usingReal = real;

// ---- fetch double ----

export interface Call { method: string; url: string; body?: unknown; init?: RequestInit }
export type Route = (call: Call) => Response | Promise<Response> | "network_error" | "hang";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
export function html(status: number): Response {
  return new Response("<!doctype html><title>404</title>", { status, headers: { "content-type": "text/html" } });
}

export function fakeFetch(routes: Record<string, Route>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: Call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, init };
    calls.push(call);
    const path = url.replace(/^https:\/\/[^/]+/, "");
    const route = routes[`${method} ${path}`] ?? routes[`${method} *`];
    if (!route) return json(404, { error: { code: "not_found", message: `no route ${method} ${path}` } });
    const out = await route(call);
    if (out === "network_error") throw new TypeError("fetch failed");
    if (out === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
      });
    }
    return out;
  }) as typeof fetch;
}

// ---- deps ----

export interface Recorder {
  calls: Call[];
  findPayment: Array<Parameters<Deps["findPayment"]>[1]>;
  readiness: Array<Parameters<Deps["payerReadiness"]>[1]>;
  built: Array<Parameters<Deps["buildTransferTx"]>[0]>;
}

export const nullRpc: Rpc = { call: async () => { throw new Error("rpc double: unexpected call"); } };

export function makeDeps(overrides: Partial<Deps> & { routes?: Record<string, Route>; env?: Record<string, string | undefined> } = {}) {
  const rec: Recorder = { calls: [], findPayment: [], readiness: [], built: [] };
  const { routes = {}, env = {}, ...rest } = overrides;
  const buildTransferTx = real.buildTransferTx ? tx.buildTransferTx : buildTransferTxDouble;
  const deps: Deps = {
    env: () => env,
    fetch: fakeFetch(routes, rec.calls),
    rpc: () => nullRpc,
    now: () => Date.parse("2026-10-17T07:14:00Z"),
    toAtomic: real.toAtomic ? money.toAtomic : toAtomicDouble,
    fromAtomic: real.fromAtomic ? money.fromAtomic : fromAtomicDouble,
    parseLink: real.parseLink ? solanaPay.parseLink : parseLinkDouble,
    buildTransferUrl: real.buildTransferUrl ? solanaPay.buildTransferUrl : buildTransferUrlDouble,
    newReference: real.newReference ? solanaPay.newReference : () => REFERENCE,
    isSolanaAddress: real.isSolanaAddress ? solanaPay.isSolanaAddress : isSolanaAddressDouble,
    buildTransferTx: (input) => {
      rec.built.push(input);
      return buildTransferTx(input);
    },
    findPayment: async (_rpc, q) => {
      rec.findPayment.push(q);
      return { status: "open" };
    },
    payerReadiness: async (_rpc, q) => {
      rec.readiness.push(q);
      return { ok: true, recipientAtaExists: true };
    },
    // No sanctions lookup unless a test asks for one (pass screenRecipient from src/screen.ts plus routes).
    screenRecipient: async () => ({ ok: true, screening: "clear" }),
    // F1 pay_all: a sender with plenty of USDC and SOL, every recipient's USDC account open, unless a test says otherwise.
    readBatchAccounts: async (_rpc, q) => ({
      senderLamports: 10_000_000_000n, senderUsdc: 1_000_000_000n, senderUsdcFrozen: false,
      usdcAccounts: new Map(q.usdcRecipients.map((r) => [r, { exists: true, frozen: false }])), newSolWallets: new Set<string>(), rentMinimum: null,
    }),
    planBatch: tx.planBatch,
    // F2: no SOL price unless a test passes one (a funding plan then leaves swap sizes to the agent).
    solUsdPrice: async () => { throw new Error("price double: no SOL price in this test"); },
    ...rest,
  };
  // Keep recording when a test overrides a chain double.
  if (rest.findPayment) {
    const inner = rest.findPayment;
    deps.findPayment = (rpc, q) => { rec.findPayment.push(q); return inner(rpc, q); };
  }
  if (rest.payerReadiness) {
    const inner = rest.payerReadiness;
    deps.payerReadiness = (rpc, q) => { rec.readiness.push(q); return inner(rpc, q); };
  }
  return { deps, rec };
}

export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}
