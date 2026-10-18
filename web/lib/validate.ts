import { TOKENS, type Token } from "./money";
import { rpcBatch, rpcEach, type RpcOptions } from "./solana";

// Strict payment validation (SPEC §4). A request is paid only by one confirmed,
// error-free transaction that carries its reference key and credits the recipient with
// at least the requested amount: for USDC, the net change of every USDC token account
// the recipient owns (normally their associated account); for SOL, the wallet's lamports.
// Less is underpaid. A transaction that mentions the reference but credits nothing is
// ignored. Same rules as the plugin's direct-RPC check (plugin/src/chain.ts).
//
// F1 pay_all: one transaction can pay several requests, even two to the same recipient for the same amount. Each
// reference is paired with the transfer INSTRUCTION that carries it as an account (Solana Pay puts references on the
// transfer), so a request counts exactly its own transfer and one transfer never counts for two requests
// (pairedCredit, allocate). A transaction whose reference rides on another instruction keeps the old rule: the net
// credit of the whole transaction, and the whole transaction is used up by the request it pays.

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

/** A stored payment: the request it settles and the transfer instruction that paid it (null: the whole transaction). */
export interface ClaimedUnit {
  requestId: string;
  instruction: number | null;
}

export interface FindOptions {
  /**
   * Which of these signatures already settle a stored request (signature -> request id), each as a whole
   * transaction. A transaction carrying several references settles only one request; the others keep looking
   * for their own payment instead of re-picking that transaction forever (QA-03).
   */
  claimed?: (signatures: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /**
   * F1: the same, per transfer instruction (lib/requests.ts reads paid_instruction). Wins over `claimed`. A
   * transaction that paid several requests (pay_all) stays a candidate for the others; only a transfer another
   * request already counts is skipped.
   */
  claimedUnits?: (signatures: readonly string[]) => Promise<ReadonlyMap<string, readonly ClaimedUnit[]>>;
}

export interface Credit {
  signature: string;
  payer: string;
  amountAtomic: bigint;
  /** "2026-10-17T05:00:09Z" */
  at: string;
  slot: number;
  /**
   * F1: the transfer instruction this credit pairs with (its index in the transaction's instructions, inner ones
   * after the top-level ones). Absent: the credit is the whole transaction's.
   */
  instruction?: number;
  /** F1: that transfer carries this request's reference itself (so it wins over a credit that only shares it). */
  byReference?: true;
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

interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
}

/**
 * The subset of a `getTransaction` (encoding "json") result pairedCredit reads: each instruction's account list.
 * jsonParsed drops the extra accounts of a SOL transfer (the references), so a transaction with two SOL transfers
 * into the same wallet is read once more this way to tell them apart.
 */
export interface RawTransaction {
  meta: {
    err?: unknown;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    innerInstructions?: { instructions: RawInstruction[] }[] | null;
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: RawInstruction[] } };
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

// ---------------------------------------------------------------- F1: pairing a reference with its transfer

/** One transfer instruction into the recipient. `refs` = the accounts after its fixed ones; null = not visible. */
export interface TransferInto {
  /** Index in the transaction's instructions, inner ones after the top-level ones (allInstructions order). */
  index: number;
  amountAtomic: bigint;
  /** The token owner (USDC) or source wallet (SOL). */
  authority: string | null;
  refs: string[] | null;
}

/** Each instruction's accounts, from the "json" encoding, in allInstructions order. */
function rawAccountLists(raw: RawTransaction): string[][] {
  const keys = [
    ...raw.transaction.message.accountKeys,
    ...(raw.meta?.loadedAddresses?.writable ?? []),
    ...(raw.meta?.loadedAddresses?.readonly ?? []),
  ];
  const list = [...raw.transaction.message.instructions, ...(raw.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  return list.map((ix) => (ix.accounts ?? []).map((i) => keys[i] ?? ""));
}

const atomicOf = (value: unknown): bigint | null => {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return BigInt(value);
  return null;
};

/**
 * Every USDC transfer (transfer / transferChecked) into an account `recipient` owns, or every SOL transfer to
 * `recipient`. jsonParsed shows the extra accounts of a token transfer as `signers` (the references Solana Pay
 * appends), but drops them from a SOL transfer: those come from `raw` when it is given, else refs is null.
 */
export function transfersInto(tx: ParsedTransaction, recipient: string, token: Token, raw?: RawTransaction | null): TransferInto[] {
  if (!tx.meta) return [];
  const keys = accountKeys(tx);
  const rawLists = raw ? rawAccountLists(raw) : null;
  const destinations = token === "USDC"
    ? new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
      .filter((b) => b.mint === TOKENS.USDC.mint && b.owner === recipient).map((b) => keys[b.accountIndex]))
    : new Set([recipient]);
  const out: TransferInto[] = [];
  allInstructions(tx).forEach((ix, index) => {
    if (typeof ix.parsed !== "object" || !ix.parsed?.info) return;
    const info = ix.parsed.info;
    const type = ix.parsed.type ?? "";
    if (typeof info.destination !== "string" || !destinations.has(info.destination)) return;
    if (token === "USDC" && ix.program === "spl-token" && (type === "transfer" || type === "transferChecked")) {
      if (type === "transferChecked" && info.mint !== TOKENS.USDC.mint) return;
      const amount = atomicOf(type === "transferChecked" ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount : info.amount);
      if (amount === null) return;
      const signers = Array.isArray(info.signers) ? info.signers.filter((s): s is string => typeof s === "string") : [];
      const who = typeof info.authority === "string" ? info.authority : typeof info.multisigAuthority === "string" ? info.multisigAuthority : null;
      out.push({ index, amountAtomic: amount, authority: who, refs: signers });
    }
    if (token === "SOL" && ix.program === "system" && (type === "transfer" || type === "transferWithSeed")) {
      const amount = atomicOf(info.lamports);
      if (amount === null) return;
      // transfer: [from, to, ...extra]; transferWithSeed: [from, base, to, ...extra].
      const fixed = type === "transfer" ? 2 : 3;
      const refs = rawLists ? (rawLists[index]?.slice(fixed) ?? []) : null;
      out.push({ index, amountAtomic: amount, authority: typeof info.source === "string" ? info.source : null, refs });
    }
  });
  return out;
}

/**
 * What this transaction paid this request, F1 rules:
 * - the transfers into the recipient that carry the reference (its "carriers"): their sum, capped at the net
 *   credit, paired with the first carrier's instruction;
 * - else, when exactly one transfer goes into the recipient: the net credit (today's rule, for wallets that put the
 *   reference on another instruction), paired with that transfer;
 * - else the net credit of the whole transaction (no instruction), as before F1.
 * "raw" means two or more SOL transfers go into the recipient and jsonParsed can't say which carries the reference:
 * read the transaction with RAW_TX_PARAMS and call again with it (null when that read failed: whole transaction).
 */
export function pairedCredit(tx: ParsedTransaction | null, target: PaymentTarget, raw?: RawTransaction | null): Credit | null | "raw" {
  if (!tx?.meta || tx.meta.err != null) return null;
  if (!accountKeys(tx).includes(target.reference)) return null;
  const net = creditTo(tx, target.recipient, target.token);
  if (!net) return null;
  const into = transfersInto(tx, target.recipient, target.token, raw);
  const carriers = into.filter((t) => t.refs !== null && t.refs.includes(target.reference));
  if (carriers.length > 0) {
    const sum = carriers.reduce((s, t) => s + t.amountAtomic, 0n);
    const amountAtomic = sum < net.amountAtomic ? sum : net.amountAtomic;
    if (amountAtomic <= 0n) return null;
    return { ...net, amountAtomic, payer: carriers[0].authority ?? net.payer, instruction: carriers[0].index, byReference: true };
  }
  // One transfer into the recipient: it is the payment, whatever else it carries (wallets append extra signer
  // accounts too). If it also carries another request's reference, allocate() gives it to only one of them.
  if (into.length === 1) return { ...net, instruction: into[0].index };
  if (into.length > 1 && raw === undefined && into.some((t) => t.refs === null)) return "raw";
  return net;
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
/** F1: the same transaction with each instruction's account list (pairedCredit's "raw"). */
export const RAW_TX_PARAMS = { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" } as const;

/** The claims of other requests on this signature that block `credit` for request `requestId`. */
function blockedByClaims(units: readonly ClaimedUnit[] | undefined, requestId: string | undefined, credit: Credit): boolean {
  return (units ?? []).some((u) => u.requestId !== requestId
    && (u.instruction === null || credit.instruction === undefined || u.instruction === credit.instruction));
}

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
  // Stored payments: per transfer with claimedUnits (F1), else per whole transaction with claimed.
  let units = new Map<string, readonly ClaimedUnit[]>();
  const all = [...new Set(candidates.flat())];
  if (options.claimedUnits) {
    units = all.length ? new Map(await options.claimedUnits(all)) : new Map();
  } else if (options.claimed) {
    const owners = all.length ? await options.claimed(all) : new Map<string, string>();
    units = new Map([...owners].map(([sig, requestId]) => [sig, [{ requestId, instruction: null }]]));
  }
  if (units.size > 0) {
    // A transaction another request holds as a whole is never a candidate (QA-03).
    candidates = candidates.map((list, i) => list.filter((sig) =>
      !(units.get(sig) ?? []).some((u) => u.instruction === null && u.requestId !== queries[i].requestId)));
  }

  // Mainnet carries v1 transactions; asking for at most v0 makes the node refuse them.
  const bySig = new Map<string, ParsedTransaction | null>();
  const rawBySig = new Map<string, RawTransaction | null>();
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
    // F1: several SOL transfers into one wallet need each instruction's accounts to pair references (once per tx).
    const rawWanted = new Set<string>();
    for (let i = 0; i < queries.length; i++) {
      for (const sig of taken[i]) {
        if (bySig.has(sig) && !rawBySig.has(sig) && pairedCredit(bySig.get(sig) ?? null, queries[i]) === "raw") rawWanted.add(sig);
      }
    }
    if (rawWanted.size > 0) {
      const list = [...rawWanted];
      let raws: (RawTransaction | null)[];
      try {
        raws = (await rpcEach(list.map((sig) => ({ method: "getTransaction", params: [sig, RAW_TX_PARAMS] })), rpc)) as (RawTransaction | null)[];
      } catch {
        raws = list.map(() => null); // can't tell the transfers apart: the whole transaction, as before F1
      }
      list.forEach((sig, k) => rawBySig.set(sig, raws[k] ?? null));
    }
    for (let i = 0; i < queries.length; i++) {
      for (const sig of taken[i]) {
        if (!bySig.has(sig)) continue; // over the read cap
        const credit = pairedCredit(bySig.get(sig) ?? null, queries[i], rawBySig.has(sig) ? rawBySig.get(sig) : undefined);
        if (!credit || credit === "raw") continue;
        if (blockedByClaims(units.get(sig), queries[i].requestId, credit)) continue;
        credits[i].push(credit);
      }
    }
    if (bySig.size >= MAX_TRANSACTIONS) break;
  }
  return allocate(queries, credits);
}

const bySlot = (a: Credit, b: Credit) => a.slot - b.slot;

/** What credits use up: a credit's transfer instruction, or (without one) its whole transaction. */
function usedUnits() {
  const whole = new Set<string>();
  const any = new Set<string>();
  const transfers = new Set<string>();
  return {
    free(c: Credit): boolean {
      if (c.instruction === undefined) return !any.has(c.signature);
      return !whole.has(c.signature) && !transfers.has(`${c.signature}#${c.instruction}`);
    },
    take(c: Credit): void {
      any.add(c.signature);
      if (c.instruction === undefined) whole.add(c.signature);
      else transfers.add(`${c.signature}#${c.instruction}`);
    },
  };
}

/**
 * decide() for several requests at once, where one transfer can pay only one of them: a
 * transaction naming two requests' references on one transfer goes to the request with fewer
 * alternatives, and the other keeps its own payment (QA-03). F1: separate transfers in one transaction
 * (pay_all) pay their own requests. For a single request this is exactly decide().
 */
export function allocate(queries: readonly Pick<PaymentQuery, "amountAtomic">[], credits: readonly (readonly Credit[])[]): PaymentCheck[] {
  const full = queries.map((q, i) => credits[i].filter((c) => q.amountAtomic === null || c.amountAtomic >= q.amountAtomic).sort(bySlot));
  const order = queries.map((_, i) => i).sort((a, b) => full[a].length - full[b].length || a - b);
  const used = usedUnits();
  // F1: a transfer that carries a request's own reference belongs to that request. Another request that only shares
  // the transaction (its reference rides elsewhere, or a whole-transaction credit) never takes it.
  const carried = new Set<string>();
  const carriedTx = new Set<string>();
  for (const list of credits) {
    for (const c of list) {
      if (!c.byReference) continue;
      carried.add(`${c.signature}#${c.instruction}`);
      carriedTx.add(c.signature);
    }
  }
  const own = (c: Credit) => c.byReference === true
    || (c.instruction === undefined ? !carriedTx.has(c.signature) : !carried.has(`${c.signature}#${c.instruction}`));
  const out: PaymentCheck[] = queries.map(() => ({ status: "open" }));
  for (const i of order) {
    const pick = full[i].find((c) => own(c) && used.free(c));
    if (pick) {
      used.take(pick);
      out[i] = { status: "paid", payment: pick };
    }
  }
  for (const i of order) {
    if (out[i].status === "paid") continue;
    const partial = [...credits[i]].sort(bySlot).find((c) => own(c) && used.free(c));
    if (partial) {
      used.take(partial);
      out[i] = { status: "underpaid", payment: partial };
    }
  }
  return out;
}
