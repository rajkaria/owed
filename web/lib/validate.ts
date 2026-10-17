import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKENS, type Token } from "./money";
import { rpcBatch, rpcEach, type RpcOptions } from "./solana";

// Strict payment validation (SPEC §4). A request is paid only by one confirmed,
// error-free transaction that carries its reference key and credits the recipient
// (the recipient's USDC associated token account for USDC, the wallet for SOL)
// with at least the requested amount. Less is underpaid. A transaction that
// mentions the reference but credits nothing is ignored.

export interface PaymentTarget {
  reference: string;
  recipient: string;
  token: Token;
}

export interface PaymentQuery extends PaymentTarget {
  /** null = any positive credit counts (a Solana Pay link without an amount). */
  amountAtomic: bigint | null;
  /** Signatures already settling another request: one transaction pays one request. */
  excludeSignatures?: ReadonlySet<string>;
}

export interface Credit {
  signature: string;
  payer: string;
  amountAtomic: bigint;
  /** "2026-10-17T05:00:09Z" */
  at: string;
  slot: number;
}

export interface PaymentCheck {
  status: "open" | "paid" | "underpaid";
  payment?: Credit;
}

interface ParsedAccountKey {
  pubkey: string;
  signer?: boolean;
  writable?: boolean;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface ParsedInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

/** The subset of a `getTransaction` (jsonParsed) result this module reads. */
export interface ParsedTransaction {
  slot: number;
  blockTime: number | bigint | null;
  meta: {
    err: unknown;
    preBalances: (number | bigint)[];
    postBalances: (number | bigint)[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: { instructions: ParsedInstruction[] }[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (ParsedAccountKey | string)[]; instructions: ParsedInstruction[] };
  };
}

const ataCache = new Map<string, string>();

/** The recipient's associated token account for USDC (owner may be off-curve). */
export function usdcAta(recipient: string): string {
  let ata = ataCache.get(recipient);
  if (!ata) {
    ata = getAssociatedTokenAddressSync(new PublicKey(TOKENS.USDC.mint!), new PublicKey(recipient), true).toBase58();
    ataCache.set(recipient, ata);
  }
  return ata;
}

export function isoSeconds(unixSeconds: number | bigint | null): string {
  const ms = unixSeconds == null ? Date.now() : Number(unixSeconds) * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
  return [...tx.transaction.message.instructions, ...inner];
}

/** Who sent the money: the authority of the transfer into `destination`, else the fee payer. */
function findPayer(tx: ParsedTransaction, keys: string[], destination: string, token: Token): string {
  for (const ix of allInstructions(tx)) {
    if (typeof ix.parsed !== "object" || !ix.parsed?.info) continue;
    const info = ix.parsed.info;
    if (info.destination !== destination) continue;
    if (token === "USDC" && ix.program === "spl-token" && /^transfer(Checked)?$/.test(ix.parsed.type ?? "")) {
      const who = info.authority ?? info.multisigAuthority;
      if (typeof who === "string") return who;
    }
    if (token === "SOL" && ix.program === "system" && /^transfer(WithSeed)?$/.test(ix.parsed.type ?? "")) {
      if (typeof info.source === "string") return info.source;
    }
  }
  return keys[0];
}

/** What one transaction credited the recipient for this request, or null if it doesn't count. */
export function creditFromTransaction(tx: ParsedTransaction | null, target: PaymentTarget): Credit | null {
  if (!tx?.meta || tx.meta.err != null) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  if (!keys.includes(target.reference)) return null;

  let destination: string;
  let credited: bigint;
  if (target.token === "USDC") {
    destination = usdcAta(target.recipient);
    const index = keys.indexOf(destination);
    if (index === -1) return null;
    const mint = TOKENS.USDC.mint!;
    const balance = (list: TokenBalance[] | null | undefined) => {
      const entry = (list ?? []).find((b) => b.accountIndex === index && b.mint === mint);
      return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
    };
    const post = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === index);
    if (post && post.owner && post.owner !== target.recipient) return null;
    credited = balance(tx.meta.postTokenBalances) - balance(tx.meta.preTokenBalances);
  } else {
    destination = target.recipient;
    const index = keys.indexOf(destination);
    if (index === -1) return null;
    credited = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
  }
  if (credited <= 0n) return null;

  return {
    signature: tx.transaction.signatures[0],
    payer: findPayer(tx, keys, destination, target.token),
    amountAtomic: credited,
    at: isoSeconds(tx.blockTime),
    slot: tx.slot,
  };
}

/** Earliest transaction that pays in full wins; otherwise the largest partial credit. */
export function decide(credits: readonly Credit[], amountAtomic: bigint | null): PaymentCheck {
  const ordered = [...credits].sort((a, b) => a.slot - b.slot);
  const full = ordered.find((c) => amountAtomic === null || c.amountAtomic >= amountAtomic);
  if (full) return { status: "paid", payment: full };
  if (ordered.length === 0) return { status: "open" };
  const best = ordered.reduce((a, b) => (b.amountAtomic > a.amountAtomic ? b : a));
  return { status: "underpaid", payment: best };
}

interface SignatureInfo {
  signature: string;
  err: unknown;
}

const SIGNATURES_PER_REFERENCE = 10;
/** Bounds the work one status call can cause, even if references are spammed. */
const MAX_TRANSACTIONS = 60;

/**
 * Check many requests against the chain in two RPC rounds: one batch of
 * reference -> signatures, then the parsed transactions fetched in parallel.
 */
export async function findPayments(queries: readonly PaymentQuery[], rpc: RpcOptions = {}): Promise<PaymentCheck[]> {
  if (queries.length === 0) return [];
  const sigLists = (await rpcBatch(
    queries.map((q) => ({
      method: "getSignaturesForAddress",
      params: [q.reference, { limit: SIGNATURES_PER_REFERENCE, commitment: "confirmed" }],
    })),
    rpc,
  )) as (SignatureInfo[] | null)[];

  const perQuery = queries.map((q, i) =>
    (sigLists[i] ?? [])
      .filter((s) => s.err == null && !q.excludeSignatures?.has(s.signature))
      .map((s) => s.signature),
  );
  const unique = [...new Set(perQuery.flat())].slice(0, MAX_TRANSACTIONS);
  const txs = (await rpcEach(
    unique.map((sig) => ({
      method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    })),
    rpc,
  )) as (ParsedTransaction | null)[];
  const bySig = new Map(unique.map((sig, i) => [sig, txs[i]]));

  return queries.map((q, i) => {
    const credits = perQuery[i]
      .map((sig) => creditFromTransaction(bySig.get(sig) ?? null, q))
      .filter((c): c is Credit => c !== null);
    return decide(credits, q.amountAtomic);
  });
}
