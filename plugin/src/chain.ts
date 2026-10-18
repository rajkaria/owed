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
 * F1 pay_all: one transaction may pay several requests, even two to one recipient for one amount, so the
 * reference is paired with the transfer instruction that carries it (pairedAmount, the same rule as
 * web/lib/validate.ts pairedCredit): each request counts exactly its own transfer.
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

    let credit = pairedAmount(tx as RichTx, q);
    if (credit === "raw") {
      // Two or more SOL transfers into the recipient: read each instruction's accounts to find the one carrying the reference.
      let raw: RawTx | null = null;
      try {
        raw = await within(deadline, rpc.call<RawTx | null>("getTransaction", [s.signature, RAW_TX_OPTS]));
      } catch (e) {
        if (e instanceof DeadlineError) { failure = e; break; }
        raw = null; // can't tell them apart: the whole transaction's credit, as before F1
      }
      credit = pairedAmount(tx as RichTx, q, raw);
    }
    if (credit === "raw" || credit <= 0n) continue;
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
// 0012 match_payments: incoming transfers that may have lost their Solana Pay reference.

/** One transfer into the recipient, read from the chain. */
export interface IncomingTransfer {
  signature: string;
  /** Who sent it: the token authority (USDC) or source (SOL) of the transfer into the recipient, else the fee payer. */
  payer: string;
  amountAtomic: bigint;
  /** Block time, "2026-10-17T17:14:15Z". */
  at: string;
  slot: number;
  /** The transaction's memo, when it has one (a wallet that kept Owed's "owed:<id>" memo but dropped the reference). */
  memo?: string;
  /** Every account key, so Owed can tell whether it names any request's reference. */
  keys: string[];
}

export interface IncomingScan {
  /** The account read: the recipient's USDC account, or the wallet itself for SOL. */
  account: string;
  transfers: IncomingTransfer[];
  /** Successful transactions since `sinceUnix` that were read. */
  read: number;
  /** Successful transactions since `sinceUnix` that weren't read (over the cap or out of time). */
  unread: number;
  /** False when the account has more history since `sinceUnix` than one signature page shows. */
  complete: boolean;
}

/** Newest transactions read per scan: each is one getTransaction inside the plugin's 10 s. */
export const MAX_INCOMING_READS = 24;
const INCOMING_PAGE = { limit: 100, commitment: "confirmed" } as const;
const PARALLEL_READS = 6;

interface ParsedIx { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } | string }
interface RichTx extends ParsedTx {
  slot: number;
  transaction: {
    signatures?: string[];
    message: { accountKeys: Array<string | { pubkey: string; signer?: boolean }>; instructions?: ParsedIx[] };
  };
  meta: (ParsedTx["meta"] & { innerInstructions?: Array<{ instructions: ParsedIx[] }> | null }) | null;
}

/**
 * Successful transfers into `recipient` since `sinceUnix`, newest first: its USDC account's history for USDC (net USDC
 * across every USDC account it owns, the same rule as findPayment), its wallet's for SOL (net lamports). Transactions
 * the recipient signed itself (its own swaps and transfers) are skipped, and so are signatures in `skip`. At most
 * MAX_INCOMING_READS transactions are read; the rest are counted in `unread` so the caller can say so.
 */
export async function incomingTransfers(
  rpc: Rpc,
  q: { recipient: string; token: "USDC" | "SOL"; sinceUnix: number; skip?: ReadonlySet<string> },
  budgetMs = RPC_BUDGET_MS,
): Promise<IncomingScan> {
  const owner = address(q.recipient, "recipient");
  const account = q.token === "USDC" ? getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, true).toBase58() : q.recipient;
  const deadline = Date.now() + budgetMs;

  const sigs = await within(deadline, rpc.call<SignatureInfo[]>("getSignaturesForAddress", [account, INCOMING_PAGE]));
  if (!Array.isArray(sigs)) throw new RpcError("getSignaturesForAddress: unexpected response");
  const recent = sigs.filter((s) => typeof s.blockTime === "number" && s.blockTime >= q.sinceUnix);
  const complete = sigs.length < INCOMING_PAGE.limit || recent.length < sigs.length;
  const wanted = recent.filter((s) => !s.err && !q.skip?.has(s.signature));
  const toRead = wanted.slice(0, MAX_INCOMING_READS);

  const txs: Array<RichTx | null | undefined> = new Array(toRead.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < toRead.length) {
      const i = next++;
      try {
        txs[i] = await within(deadline, rpc.call<RichTx | null>("getTransaction", [toRead[i]!.signature, TX_OPTS]));
      } catch (e) {
        failure ??= e;
        if (e instanceof DeadlineError) return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, toRead.length) }, worker));
  const read = txs.filter((t) => t !== undefined).length;
  // Nothing could be read at all: an outage, not "no transfers".
  if (toRead.length > 0 && read === 0 && failure !== undefined) throw failure;

  const transfers: IncomingTransfer[] = [];
  toRead.forEach((s, i) => {
    const found = incomingFrom(txs[i], s.signature, q.recipient, q.token, account, s.blockTime ?? undefined);
    if (found) transfers.push(found);
  });
  return { account, transfers, read, unread: wanted.length - read, complete };
}

export type TransferCheck =
  | { ok: true; transfer: IncomingTransfer }
  | { ok: false; reason: "not_found" | "failed" | "no_credit" | "own" };

/**
 * One transaction, read the way incomingTransfers reads it: what it credited `recipient`. match_payments checks a
 * transaction this way before asking the user to sign; Owed's server checks it again before it records anything.
 */
export async function readTransfer(
  rpc: Rpc,
  q: { signature: string; recipient: string; token: "USDC" | "SOL" },
  budgetMs = RPC_BUDGET_MS,
): Promise<TransferCheck> {
  const owner = address(q.recipient, "recipient");
  const account = q.token === "USDC" ? getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, true).toBase58() : q.recipient;
  const tx = await within(Date.now() + budgetMs, rpc.call<RichTx | null>("getTransaction", [q.signature, TX_OPTS]));
  if (!tx) return { ok: false, reason: "not_found" };
  if (!tx.meta || tx.meta.err) return { ok: false, reason: "failed" };
  if (signedBy(tx, q.recipient)) return { ok: false, reason: "own" };
  const transfer = incomingFrom(tx, q.signature, q.recipient, q.token, account);
  return transfer ? { ok: true, transfer } : { ok: false, reason: "no_credit" };
}

function signedBy(tx: RichTx, who: string): boolean {
  return tx.transaction.message.accountKeys.some((k, j) =>
    (typeof k === "string" ? j === 0 : k.signer === true) && (typeof k === "string" ? k : k.pubkey) === who);
}

function incomingFrom(tx: RichTx | null | undefined, signature: string, recipient: string, token: "USDC" | "SOL", account: string, blockTime?: number): IncomingTransfer | null {
  if (!tx?.meta || tx.meta.err) return null;
  if (signedBy(tx, recipient)) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const credit = token === "USDC" ? usdcCredit(tx, recipient) : lamportCredit(tx, recipient);
  if (credit <= 0n) return null;
  const time = typeof tx.blockTime === "number" ? tx.blockTime : blockTime;
  if (time === undefined) return null;
  const found: IncomingTransfer = {
    signature,
    payer: senderOf(tx, token === "USDC" ? account : recipient, token) ?? keys[0] ?? "",
    amountAtomic: credit,
    at: isoSeconds(time),
    slot: tx.slot,
    keys,
  };
  const memo = memoOf(tx);
  if (memo !== undefined) found.memo = memo;
  return found;
}

function instructionsOf(tx: RichTx): ParsedIx[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  return [...(tx.transaction.message.instructions ?? []), ...inner];
}

/** The authority of a token transfer (or source of a SOL transfer) into `destination`. */
function senderOf(tx: RichTx, destination: string, token: "USDC" | "SOL"): string | undefined {
  for (const ix of instructionsOf(tx)) {
    if (typeof ix.parsed !== "object" || !ix.parsed?.info || ix.parsed.info.destination !== destination) continue;
    const info = ix.parsed.info;
    if (token === "USDC" && ix.program === "spl-token" && /^transfer(Checked)?$/.test(ix.parsed.type ?? "")) {
      const who = info.authority ?? info.multisigAuthority;
      if (typeof who === "string") return who;
    }
    if (token === "SOL" && ix.program === "system" && /^transfer(WithSeed)?$/.test(ix.parsed.type ?? "") && typeof info.source === "string") {
      return info.source;
    }
  }
  return undefined;
}

function memoOf(tx: RichTx): string | undefined {
  for (const ix of instructionsOf(tx)) {
    if (ix.program === "spl-memo" && typeof ix.parsed === "string") return ix.parsed.slice(0, 200);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// F1: pairing a reference with its transfer instruction (web/lib/validate.ts pairedCredit is the same rule).

/** getTransaction with encoding "json": each instruction's account list (jsonParsed drops a SOL transfer's extras). */
export const RAW_TX_OPTS = { maxSupportedTransactionVersion: 1, commitment: "confirmed", encoding: "json" } as const;

interface RawIx { programIdIndex: number; accounts: number[] }
export interface RawTx {
  meta: { loadedAddresses?: { writable?: string[]; readonly?: string[] } | null; innerInstructions?: Array<{ instructions: RawIx[] }> | null } | null;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
}

interface TransferInto { index: number; amountAtomic: bigint; refs: string[] | null }

const atomicOf = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v)
    : typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v)
      : typeof v === "bigint" && v >= 0n ? v : null;

function rawAccountLists(raw: RawTx): string[][] {
  const keys = [...raw.transaction.message.accountKeys, ...(raw.meta?.loadedAddresses?.writable ?? []), ...(raw.meta?.loadedAddresses?.readonly ?? [])];
  const list = [...raw.transaction.message.instructions, ...(raw.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? [])];
  return list.map((ix) => (ix.accounts ?? []).map((i) => keys[i] ?? ""));
}

/** USDC transfers into an account `recipient` owns, or SOL transfers to it; refs = the transfer's extra accounts (null: not visible). */
export function transfersInto(tx: RichTx, recipient: string, token: "USDC" | "SOL", raw?: RawTx | null): TransferInto[] {
  if (!tx.meta) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const rawLists = raw ? rawAccountLists(raw) : null;
  const destinations = token === "USDC"
    ? new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
      .filter((b) => b.mint === USDC_MINT && b.owner === recipient).map((b) => keys[b.accountIndex]))
    : new Set([recipient]);
  const out: TransferInto[] = [];
  instructionsOf(tx).forEach((ix, index) => {
    if (typeof ix.parsed !== "object" || !ix.parsed?.info) return;
    const info = ix.parsed.info;
    const type = ix.parsed.type ?? "";
    if (typeof info.destination !== "string" || !destinations.has(info.destination)) return;
    if (token === "USDC" && ix.program === "spl-token" && (type === "transfer" || type === "transferChecked")) {
      if (type === "transferChecked" && info.mint !== USDC_MINT) return;
      const amount = atomicOf(type === "transferChecked" ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount : info.amount);
      if (amount === null) return;
      out.push({ index, amountAtomic: amount, refs: Array.isArray(info.signers) ? info.signers.filter((x): x is string => typeof x === "string") : [] });
    }
    if (token === "SOL" && ix.program === "system" && (type === "transfer" || type === "transferWithSeed")) {
      const amount = atomicOf(info.lamports);
      if (amount === null) return;
      out.push({ index, amountAtomic: amount, refs: rawLists ? (rawLists[index]?.slice(type === "transfer" ? 2 : 3) ?? []) : null });
    }
  });
  return out;
}

/**
 * What this transaction paid this request: the transfers into the recipient that carry the reference (capped at the
 * net credit); else the net credit when one transfer goes into the recipient, or when several do and their
 * references can't be seen even with `raw` (the rule before F1). "raw": read the transaction with RAW_TX_OPTS and ask
 * again (two SOL transfers into one wallet). 0n: nothing.
 */
export function pairedAmount(tx: RichTx, q: { reference: string; recipient: string; token: "USDC" | "SOL" }, raw?: RawTx | null): bigint | "raw" {
  const net = q.token === "USDC" ? usdcCredit(tx, q.recipient) : lamportCredit(tx, q.recipient);
  if (net <= 0n) return 0n;
  const into = transfersInto(tx, q.recipient, q.token, raw);
  const carriers = into.filter((t) => t.refs !== null && t.refs.includes(q.reference));
  if (carriers.length > 0) {
    const sum = carriers.reduce((n, t) => n + t.amountAtomic, 0n);
    return sum < net ? sum : net;
  }
  if (into.length > 1 && raw === undefined && into.some((t) => t.refs === null)) return "raw";
  return net;
}

// ---------------------------------------------------------------------------------------------
// F1 pay_all: one read for every wallet a batch touches, then a pure check of what the batch needs.

/** Rent a new USDC account takes (165 bytes), paid by the sender for each recipient that has none. */
export const ATA_RENT_LAMPORTS = 2_039_280n;

export interface BatchAccounts {
  senderLamports: bigint;
  senderUsdc: bigint;
  senderUsdcFrozen: boolean;
  /** recipient wallet → its USDC account (null: none yet; frozen as read). USDC recipients only. */
  usdcAccounts: Map<string, { exists: boolean; frozen: boolean }>;
  /** SOL recipients whose account doesn't exist yet. */
  newSolWallets: Set<string>;
  /** Solana's rent-exempt minimum for a 0-byte account, read only when a SOL recipient is new. */
  rentMinimum: bigint | null;
}

/** One getMultipleAccounts read: [sender, sender's USDC account, each USDC recipient's USDC account, each SOL recipient]. */
export async function readBatchAccounts(
  rpc: Rpc, q: { sender: string; usdcRecipients: string[]; solRecipients: string[] }, budgetMs = RPC_BUDGET_MS,
): Promise<BatchAccounts> {
  const sender = address(q.sender, "sender");
  const mint = new PublicKey(USDC_MINT);
  const usdc = [...new Set(q.usdcRecipients)];
  const sol = [...new Set(q.solRecipients)];
  const deadline = Date.now() + budgetMs;
  const keys = [
    sender, getAssociatedTokenAddressSync(mint, sender, true),
    ...usdc.map((r) => getAssociatedTokenAddressSync(mint, address(r, "recipient"), true)),
    ...sol.map((r) => address(r, "recipient")),
  ];
  const got = await accounts(rpc, keys, deadline);
  const from = tokenInfo(got[1] ?? null);
  const usdcAccounts = new Map(usdc.map((r, i) => {
    const a = got[2 + i] ?? null;
    return [r, { exists: a !== null, frozen: tokenInfo(a)?.state === "frozen" }] as const;
  }));
  const newSolWallets = new Set(sol.filter((_, i) => (got[2 + usdc.length + i] ?? null) === null));
  const rentMinimum = newSolWallets.size > 0
    ? BigInt(await within(deadline, rpc.call<number>("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }])))
    : null;
  return {
    senderLamports: lamportsOf(got[0] ?? null), senderUsdc: from?.amount === undefined ? 0n : BigInt(from.amount),
    senderUsdcFrozen: from?.state === "frozen", usdcAccounts, newSolWallets, rentMinimum,
  };
}

export interface BatchNeed {
  ok: boolean;
  reason?: string;
  usdcTotal: bigint;
  solTotal: bigint;
  /** USDC recipients (wallets) whose account the batch opens, once each. */
  opensAccountFor: string[];
  /** Lamports the sender needs besides the SOL it sends: fees and new USDC accounts. */
  feeLamports: bigint;
}

/** Whether `sender` covers every item: the sum per token, the fee reserve and the rent of each USDC account opened. */
export function assessBatch(a: BatchAccounts, items: ReadonlyArray<{ recipient: string; token: "USDC" | "SOL"; amountAtomic: bigint }>): BatchNeed {
  let usdcTotal = 0n;
  let solTotal = 0n;
  const solTo = new Map<string, bigint>();
  const opens: string[] = [];
  for (const it of items) {
    if (it.token === "USDC") {
      usdcTotal += it.amountAtomic;
      if (!a.usdcAccounts.get(it.recipient)?.exists && !opens.includes(it.recipient)) opens.push(it.recipient);
    } else {
      solTotal += it.amountAtomic;
      solTo.set(it.recipient, (solTo.get(it.recipient) ?? 0n) + it.amountAtomic);
    }
  }
  const feeLamports = FEE_RESERVE_LAMPORTS + (opens.length > 1 ? BigInt(opens.length - 1) * ATA_RENT_LAMPORTS : 0n);
  const base = { usdcTotal, solTotal, opensAccountFor: opens, feeLamports };
  const no = (reason: string): BatchNeed => ({ ok: false, reason, ...base });
  const count = (token: "USDC" | "SOL") => items.filter((i) => i.token === token).length;
  if (usdcTotal > 0n) {
    if (a.senderUsdc < usdcTotal) return no(`Your wallet has ${usdc(a.senderUsdc)} USDC; ${count("USDC") === 1 ? "this request is" : `these ${count("USDC")} requests total`} ${usdc(usdcTotal)} USDC.`);
    if (a.senderUsdcFrozen) return no("Your USDC account is frozen, so it cannot send.");
    for (const it of items) {
      if (it.token === "USDC" && a.usdcAccounts.get(it.recipient)?.frozen) return no(`The USDC account of ${it.recipient} is frozen, so it cannot receive.`);
    }
  }
  if (a.senderLamports < solTotal + feeLamports) {
    return no(solTotal > 0n
      ? `Your wallet needs ${sol(solTotal)} SOL for the SOL requests plus about ${sol(feeLamports)} SOL for fees${opens.length ? " and new USDC accounts" : ""}; it has ${sol(a.senderLamports)} SOL.`
      : `Your wallet needs about ${sol(feeLamports)} SOL for fees${opens.length ? ` (it also opens ${opens.length} recipient USDC ${opens.length === 1 ? "account" : "accounts"})` : ""}; it has ${sol(a.senderLamports)} SOL.`);
  }
  for (const wallet of a.newSolWallets) {
    const sent = solTo.get(wallet) ?? 0n;
    if (a.rentMinimum !== null && sent > 0n && sent < a.rentMinimum) {
      return no(`${wallet} has never been used, so the first payment to it must be at least ${sol(a.rentMinimum)} SOL.`);
    }
  }
  return { ok: true, ...base };
}

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
