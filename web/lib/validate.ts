import { TOKENS, type Token } from "./money";
import { rpcBatch, rpcEach, type RpcOptions } from "./solana";

// Strict payment validation (SPEC §4). A request is paid only by one confirmed,
// error-free transaction that carries its reference key and credits the recipient with
// at least the requested amount: for USDC, the net change of every USDC token account
// the recipient owns (normally their associated account); for SOL, the wallet's lamports.
// Less is underpaid. A transaction that mentions the reference but credits nothing is
// ignored. Same rules as the plugin's direct-RPC check (plugin/src/chain.ts).

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

export function isoSeconds(unixSeconds: number | bigint | null): string {
  const ms = unixSeconds == null ? Date.now() : Number(unixSeconds) * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
  return [...tx.transaction.message.instructions, ...inner];
}

/**
 * Who sent the money: the owner of the tokens (or lamports) moved into the recipient's
 * account, else the fee payer. With a Solana Pay reference appended to transferChecked,
 * jsonParsed names the owner `multisigAuthority` (and the reference as a signer).
 */
function findPayer(tx: ParsedTransaction, keys: string[], destinations: ReadonlySet<string>, token: Token): string {
  for (const ix of allInstructions(tx)) {
    if (typeof ix.parsed !== "object" || !ix.parsed?.info) continue;
    const info = ix.parsed.info;
    if (typeof info.destination !== "string" || !destinations.has(info.destination)) continue;
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

  let destinations: Set<string>;
  let credited: bigint;
  if (target.token === "USDC") {
    const owned = (list: TokenBalance[] | null | undefined) =>
      (list ?? []).filter((b) => b.mint === TOKENS.USDC.mint && b.owner === target.recipient);
    const total = (list: TokenBalance[]) => list.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    const post = owned(tx.meta.postTokenBalances);
    destinations = new Set(post.map((b) => keys[b.accountIndex]));
    credited = total(post) - total(owned(tx.meta.preTokenBalances));
  } else {
    const index = keys.indexOf(target.recipient);
    if (index === -1) return null;
    destinations = new Set([target.recipient]);
    credited = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
  }
  if (credited <= 0n) return null;

  return {
    signature: tx.transaction.signatures[0],
    payer: findPayer(tx, keys, destinations, target.token),
    amountAtomic: credited,
    at: isoSeconds(tx.blockTime),
    slot: tx.slot,
  };
}

/**
 * Earliest transaction that pays in full wins; otherwise the earliest partial credit is
 * reported as underpaid. Same rule as the plugin's direct-RPC check (plugin/src/chain.ts).
 */
export function decide(credits: readonly Credit[], amountAtomic: bigint | null): PaymentCheck {
  const ordered = [...credits].sort((a, b) => a.slot - b.slot);
  const full = ordered.find((c) => amountAtomic === null || c.amountAtomic >= amountAtomic);
  if (full) return { status: "paid", payment: full };
  return ordered.length ? { status: "underpaid", payment: ordered[0] } : { status: "open" };
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
      // Mainnet carries v1 transactions; asking for at most v0 makes the node refuse them.
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
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
