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
  /** The stored request this query is for, so a transaction it already owns is never excluded by `claimed`. */
  requestId?: string;
}

export interface FindOptions {
  /**
   * Which of these signatures already settle a stored request (signature -> request id). A
   * transaction carrying several references settles only one request; the others keep looking
   * for their own payment instead of re-picking that transaction forever (QA-03).
   */
  claimed?: (signatures: readonly string[]) => Promise<ReadonlyMap<string, string>>;
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
  if (!accountKeys(tx).includes(target.reference)) return null;
  return creditTo(tx, target.recipient, target.token);
}

export function accountKeys(tx: ParsedTransaction): string[] {
  return tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
}

/**
 * What one confirmed, successful transaction credited `recipient`, reference or not: the net change of every
 * USDC account it owns, or of its lamports. null for a failed transaction or no credit. 0012's match check
 * (lib/match.ts) reads payments that carry no reference with exactly this rule.
 */
export function creditTo(tx: ParsedTransaction | null, recipient: string, token: Token): Credit | null {
  if (!tx?.meta || tx.meta.err != null) return null;
  const keys = accountKeys(tx);
  let destinations: Set<string>;
  let credited: bigint;
  if (token === "USDC") {
    const owned = (list: TokenBalance[] | null | undefined) =>
      (list ?? []).filter((b) => b.mint === TOKENS.USDC.mint && b.owner === recipient);
    const total = (list: TokenBalance[]) => list.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    const post = owned(tx.meta.postTokenBalances);
    destinations = new Set(post.map((b) => keys[b.accountIndex]));
    credited = total(post) - total(owned(tx.meta.preTokenBalances));
  } else {
    const index = keys.indexOf(recipient);
    if (index === -1) return null;
    destinations = new Set([recipient]);
    credited = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
  }
  if (credited <= 0n) return null;

  return {
    signature: tx.transaction.signatures[0],
    payer: findPayer(tx, keys, destinations, token),
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

/**
 * A reference is public (it is in the solana: URL), so anyone can add it to cheap transactions.
 * Ask for the whole history the node keeps per call, drop failed ones, and read the oldest first:
 * a fresh reference's first successful transaction is normally the payment (QA-04).
 */
const SIGNATURES_PER_REFERENCE = 1000;
/** Bounds the work one status call can cause, even if references are spammed. */
const MAX_TRANSACTIONS = 60;
/** Transactions read per request in the first round; each later round doubles it. */
const FIRST_ROUND = 4;
/** Don't start another round of reads with less time than this left. */
const ROUND_MIN_MS = 750;

export const TX_PARAMS = { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" } as const;

/**
 * Check many requests against the chain: one batch of reference -> signatures, then parsed
 * transactions oldest first, in rounds, until each request has a full payment or runs out of
 * candidates, bounded by MAX_TRANSACTIONS reads and the RPC deadline.
 */
export async function findPayments(queries: readonly PaymentQuery[], rpc: RpcOptions = {}, options: FindOptions = {}): Promise<PaymentCheck[]> {
  if (queries.length === 0) return [];
  const sigLists = (await rpcBatch(
    queries.map((q) => ({
      method: "getSignaturesForAddress",
      params: [q.reference, { limit: SIGNATURES_PER_REFERENCE, commitment: "confirmed" }],
    })),
    rpc,
  )) as (SignatureInfo[] | null)[];

  // Successful, not excluded, oldest first; never more per request than could ever be read.
  let candidates = queries.map((q, i) =>
    (sigLists[i] ?? [])
      .filter((s) => s.err == null && !q.excludeSignatures?.has(s.signature))
      .map((s) => s.signature)
      .reverse()
      .slice(0, MAX_TRANSACTIONS),
  );
  if (options.claimed) {
    const all = [...new Set(candidates.flat())];
    const owners = all.length ? await options.claimed(all) : new Map<string, string>();
    candidates = candidates.map((list, i) => list.filter((sig) => {
      const owner = owners.get(sig);
      return owner === undefined || owner === queries[i].requestId;
    }));
  }

  // Mainnet carries v1 transactions; asking for at most v0 makes the node refuse them.
  const bySig = new Map<string, ParsedTransaction | null>();
  const credits: Credit[][] = queries.map(() => []);
  const cursor = queries.map(() => 0);
  const settled = (i: number) => allocate(queries, credits)[i].status === "paid";
  const deadline = rpc.deadline ?? Infinity;
  for (let round = 0, size = FIRST_ROUND; ; round++, size *= 2) {
    const want = new Set<string>();
    const taken: string[][] = queries.map(() => []);
    for (let i = 0; i < queries.length; i++) {
      if (settled(i)) continue;
      while (taken[i].length < size && cursor[i] < candidates[i].length) {
        const sig = candidates[i][cursor[i]++];
        taken[i].push(sig);
        if (!bySig.has(sig)) want.add(sig);
      }
    }
    const room = MAX_TRANSACTIONS - bySig.size;
    const batch = [...want].slice(0, Math.max(0, room));
    if (batch.length === 0 && taken.every((t) => t.length === 0)) break;
    if (round > 0 && deadline - Date.now() < ROUND_MIN_MS) break;
    const txs = (await rpcEach(batch.map((sig) => ({ method: "getTransaction", params: [sig, TX_PARAMS] })), rpc)) as (ParsedTransaction | null)[];
    batch.forEach((sig, k) => bySig.set(sig, txs[k]));
    for (let i = 0; i < queries.length; i++) {
      for (const sig of taken[i]) {
        if (!bySig.has(sig)) continue; // over the read cap
        const credit = creditFromTransaction(bySig.get(sig) ?? null, queries[i]);
        if (credit) credits[i].push(credit);
      }
    }
    if (bySig.size >= MAX_TRANSACTIONS) break;
  }
  return allocate(queries, credits);
}

const bySlot = (a: Credit, b: Credit) => a.slot - b.slot;

/**
 * decide() for several requests at once, where one transaction can pay only one of them: a
 * transaction naming two requests' references goes to the request with fewer alternatives, and
 * the other keeps its own payment (QA-03). For a single request this is exactly decide().
 */
export function allocate(queries: readonly Pick<PaymentQuery, "amountAtomic">[], credits: readonly (readonly Credit[])[]): PaymentCheck[] {
  const full = queries.map((q, i) => credits[i].filter((c) => q.amountAtomic === null || c.amountAtomic >= q.amountAtomic).sort(bySlot));
  const order = queries.map((_, i) => i).sort((a, b) => full[a].length - full[b].length || a - b);
  const used = new Set<string>();
  const out: PaymentCheck[] = queries.map(() => ({ status: "open" }));
  for (const i of order) {
    const pick = full[i].find((c) => !used.has(c.signature));
    if (pick) {
      used.add(pick.signature);
      out[i] = { status: "paid", payment: pick };
    }
  }
  for (const i of order) {
    if (out[i].status === "paid") continue;
    const partial = [...credits[i]].sort(bySlot).find((c) => !used.has(c.signature));
    if (partial) {
      used.add(partial.signature);
      out[i] = { status: "underpaid", payment: partial };
    }
  }
  return out;
}
