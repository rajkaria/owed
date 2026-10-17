// Owned by sprint W1-B (tx + chain). Solana mainnet reads: JSON-RPC transport, payment lookup by
// Solana Pay reference, and a payer readiness check before building a transaction.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fromAtomic, USDC_MINT } from "./money.js";

export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** An RPC failure. `code` is the JSON-RPC error code when the node sent one. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

// Errors in the request itself: every node would answer the same, so trying the next url only burns
// the time budget. Anything else (timeouts, HTTP errors, rate limits, "node is behind", missing
// history) moves on to the next url.
const REQUEST_ERRORS = new Set([-32600, -32601, -32602]);

/** JSON-RPC over fetch; tries urls in order; 3 s timeout per url by default. */
export function makeRpc(urls: string[], timeoutMs = 3000): Rpc {
  if (urls.length === 0) throw new Error("makeRpc needs at least one url");
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let last = new RpcError(`${method}: no RPC url answered`);
      for (const url of urls) {
        const host = hostOf(url);
        let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            last = new RpcError(`${method}: ${host} answered HTTP ${res.status}`);
            continue;
          }
          body = (await res.json()) as typeof body;
        } catch (e) {
          last = (e as Error).name === "TimeoutError"
            ? new RpcError(`${method}: ${host} did not answer within ${timeoutMs} ms`)
            : (e as Error).name === "SyntaxError"
              ? new RpcError(`${method}: ${host} sent a response that is not valid JSON-RPC`)
              : new RpcError(`${method}: ${host} could not be reached`);
          continue;
        }
        if (body === null || typeof body !== "object") {
          last = new RpcError(`${method}: ${host} sent a response that is not valid JSON-RPC`);
          continue;
        }
        if (body.error) {
          const code = typeof body.error.code === "number" ? body.error.code : undefined;
          const err = new RpcError(`${method}: ${String(body.error.message ?? "unknown error")}`, code);
          if (code !== undefined && REQUEST_ERRORS.has(code)) throw err;
          last = err;
          continue;
        }
        if (!("result" in body)) {
          last = new RpcError(`${method}: ${host} sent a response that is not valid JSON-RPC`);
          continue;
        }
        return body.result as T;
      }
      throw last;
    },
  };
}

export interface PaymentCheck {
  status: "open" | "paid" | "underpaid";
  signature?: string;
  payer?: string;
  amountPaidAtomic?: bigint;
  paidAt?: string;
}

/** Total RPC time per check. The plugin has 10 s per call and also talks to the Owed API. */
export const RPC_BUDGET_MS = 5500;

// getTransaction must accept v1 transactions: mainnet (solana-core 4.3, Oct 2026) carries them, and
// maxSupportedTransactionVersion 0 makes the node refuse the whole call with -32015.
// A reference is public (it is in the solana: URL), so anyone can add it to cheap transactions:
// ask for the whole history the node keeps per call, drop failed ones, read the oldest first (QA-04).
const SIGNATURES_OPTS = { limit: 1000, commitment: "confirmed" } as const;
/** Transactions read per check, oldest successful first; a fresh reference's first one is normally the payment. */
export const MAX_TX_READS = 8;
const TX_OPTS = { maxSupportedTransactionVersion: 1, commitment: "confirmed", encoding: "jsonParsed" } as const;
const ACCOUNTS_OPTS = { encoding: "jsonParsed", commitment: "confirmed" } as const;

interface SignatureInfo { signature: string; err: unknown; blockTime?: number | null }
interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface ParsedTx {
  blockTime?: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
}

/**
 * Strict validation (SPEC §4): a request is paid only by one confirmed, successful transaction that
 * references it and credits the recipient (net USDC across the recipient's USDC accounts, or net
 * lamports) with at least the amount. Signatures are checked oldest first; the first full payment
 * wins, otherwise the oldest partial one is reported as underpaid. Credits to anyone else, other
 * mints and failed transactions are ignored.
 */
export async function findPayment(
  rpc: Rpc,
  q: { reference: string; recipient: string; token: "USDC" | "SOL"; amountAtomic: bigint },
  budgetMs = RPC_BUDGET_MS,
): Promise<PaymentCheck> {
  address(q.reference, "reference");
  address(q.recipient, "recipient");
  const deadline = Date.now() + budgetMs;

  const sigs = await within(deadline, rpc.call<SignatureInfo[]>("getSignaturesForAddress", [q.reference, SIGNATURES_OPTS]));
  if (!Array.isArray(sigs)) throw new RpcError("getSignaturesForAddress: unexpected response");
  let underpaid: PaymentCheck | undefined;
  let failure: unknown;
  for (const s of [...sigs].reverse().filter((x) => !x.err).slice(0, MAX_TX_READS)) {
    let tx: ParsedTx | null;
    try {
      tx = await within(deadline, rpc.call<ParsedTx | null>("getTransaction", [s.signature, TX_OPTS]));
    } catch (e) {
      failure = e;
      if (e instanceof DeadlineError) break;
      continue;
    }
    if (!tx?.meta || tx.meta.err) continue;

    const credit = q.token === "USDC" ? usdcCredit(tx, q.recipient) : lamportCredit(tx, q.recipient);
    if (credit <= 0n) continue;
    const found: PaymentCheck = {
      status: credit >= q.amountAtomic ? "paid" : "underpaid",
      signature: s.signature,
      payer: keyAt(tx, 0),
      amountPaidAtomic: credit,
    };
    if (typeof tx.blockTime === "number") found.paidAt = isoSeconds(tx.blockTime);
    if (found.status === "paid") return found;
    underpaid ??= found;
  }
  // A transaction we could not read might be the payment: say so instead of reporting "open".
  if (failure !== undefined) throw failure;
  return underpaid ?? { status: "open" };
}

/** Lamports a SOL payment needs on top of the amount: fees, plus rent when a USDC account is created. */
export const FEE_RESERVE_LAMPORTS = 3_000_000n;

interface ParsedAccount {
  lamports: number;
  data: { parsed?: { info?: { mint?: string; owner?: string; state?: string; tokenAmount?: { amount: string } } } } | unknown[];
}

/**
 * One getMultipleAccounts read (plus a rent query only when a SOL payee has no account yet).
 * USDC reads [sender, sender USDC account, recipient USDC account]; SOL reads [sender, recipient].
 * `recipientAtaExists` is always true for SOL: there is no token account to create.
 */
export async function payerReadiness(
  rpc: Rpc,
  q: { sender: string; recipient: string; token: "USDC" | "SOL"; amountAtomic: bigint },
  budgetMs = RPC_BUDGET_MS,
): Promise<{ ok: boolean; reason?: string; recipientAtaExists: boolean }> {
  const sender = address(q.sender, "sender");
  const recipient = address(q.recipient, "recipient");
  const deadline = Date.now() + budgetMs;
  const want = q.amountAtomic;

  if (q.token === "USDC") {
    const mint = new PublicKey(USDC_MINT);
    const keys = [sender, getAssociatedTokenAddressSync(mint, sender, true), getAssociatedTokenAddressSync(mint, recipient, true)];
    const [payer = null, from = null, to = null] = await accounts(rpc, keys, deadline);
    const recipientAtaExists = to !== null;
    const no = (reason: string) => ({ ok: false, reason, recipientAtaExists });

    const held = tokenInfo(from)?.amount;
    const balance = held === undefined ? 0n : BigInt(held);
    if (balance < want) return no(`Your wallet has ${usdc(balance)} USDC; this request is ${usdc(want)} USDC.`);
    if (tokenInfo(from)?.state === "frozen") return no("Your USDC account is frozen, so it cannot send.");
    if (tokenInfo(to)?.state === "frozen") return no("The recipient's USDC account is frozen, so it cannot receive.");
    const lamports = lamportsOf(payer);
    if (lamports < FEE_RESERVE_LAMPORTS) {
      return no(`Your wallet needs about ${sol(FEE_RESERVE_LAMPORTS)} SOL for fees; it has ${sol(lamports)} SOL.`);
    }
    return { ok: true, recipientAtaExists };
  }

  const [payer = null, payee = null] = await accounts(rpc, [sender, recipient], deadline);
  const no = (reason: string) => ({ ok: false, reason, recipientAtaExists: true });
  const lamports = lamportsOf(payer);
  if (lamports < want) return no(`Your wallet has ${sol(lamports)} SOL; this request is ${sol(want)} SOL.`);
  if (lamports < want + FEE_RESERVE_LAMPORTS) {
    return no(`Your wallet needs about ${sol(FEE_RESERVE_LAMPORTS)} SOL for fees on top of the ${sol(want)} SOL request; it has ${sol(lamports)} SOL.`);
  }
  if (payee === null) {
    // A transfer that creates an account must leave it rent-exempt; ask the cluster for the minimum.
    const min = BigInt(await within(deadline, rpc.call<number>("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }])));
    if (want < min) return no(`This address has never been used, so the first payment must be at least ${sol(min)} SOL.`);
  }
  return { ok: true, recipientAtaExists: true };
}

export const DEFAULT_RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

// ---------------------------------------------------------------------------------------------

class DeadlineError extends RpcError {}

async function within<T>(deadline: number, p: Promise<T>): Promise<T> {
  const left = deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("Solana RPC did not answer in time. Try again in a moment.")), Math.max(0, left));
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function accounts(rpc: Rpc, keys: PublicKey[], deadline: number): Promise<Array<ParsedAccount | null>> {
  const res = await within(deadline, rpc.call<{ value: Array<ParsedAccount | null> }>("getMultipleAccounts", [keys.map((k) => k.toBase58()), ACCOUNTS_OPTS]));
  return keys.map((_, i) => res.value[i] ?? null);
}

function tokenInfo(a: ParsedAccount | null) {
  if (!a || Array.isArray(a.data)) return undefined;
  const info = a.data.parsed?.info;
  if (!info || info.mint !== USDC_MINT || !info.tokenAmount) return undefined;
  return { amount: info.tokenAmount.amount, state: info.state };
}

const lamportsOf = (a: ParsedAccount | null) => (a ? BigInt(a.lamports) : 0n);

function usdcCredit(tx: ParsedTx, owner: string): bigint {
  const sum = (balances: TokenBalance[] | null | undefined) =>
    (balances ?? [])
      .filter((b) => b.mint === USDC_MINT && b.owner === owner)
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

function lamportCredit(tx: ParsedTx, owner: string): bigint {
  const keys = tx.transaction.message.accountKeys;
  const i = keys.findIndex((k) => (typeof k === "string" ? k : k.pubkey) === owner);
  if (i < 0 || !tx.meta) return 0n;
  const pre = tx.meta.preBalances[i];
  const post = tx.meta.postBalances[i];
  return pre === undefined || post === undefined ? 0n : BigInt(post) - BigInt(pre);
}

function keyAt(tx: ParsedTx, i: number): string | undefined {
  const k = tx.transaction.message.accountKeys[i];
  return k === undefined ? undefined : typeof k === "string" ? k : k.pubkey;
}

/** "2026-10-17T05:00:09Z" (whole seconds, as the API contract uses). */
const isoSeconds = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function address(value: string, role: string): PublicKey {
  try {
    const k = new PublicKey(value);
    if (k.toBase58() === value) return k;
  } catch {
    // fall through
  }
  throw new Error(`The ${role} is not a valid Solana address.`);
}

const usdc = (atomic: bigint) => fromAtomic(atomic, "USDC");
const sol = (lamports: bigint) => fromAtomic(lamports, "SOL");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "RPC";
  }
}
