import { ATA_RENT_LAMPORTS, type PayerFunds, type SolUsdPrice } from "./chain.js";
import type { FundingPlan, PlanAmount, PlanOption, PlanOptionKind, PlanStep } from "./contract.js";
import { refusal, within, type CallContext, type Deps } from "./deps.js";
import { BASE_CAIP2, BASE_USDC } from "./evm.js";
import { fromAtomic, USDC_MINT, type Token } from "./money.js";
import { shortAddress } from "./text.js";

// F2 funding plan. When the sender's wallet can't cover a payment, pay_link and pay_all return the exact PayBox calls
// that fix it instead of a dead-end refusal: swap SOL for USDC, bring USDC over from Base, swap another token, buy
// with MoonPay, or (fee only) pay over x402. A plugin can't call PayBox tools, so the plan is data the agent follows,
// one approval per step; every option ends with the same pay_link / pay_all call, which re-runs every check.
//
// What the plugin knows: the sender's SOL and USDC on Solana (payerReadiness / readBatchAccounts, one RPC read) and
// Pyth's SOL/USD price (one more RPC read, same hosts). What it can't know without a new network host: Base balances
// and other SPL tokens. Options that need them start with a PayBox get_portfolio check and say what to look for.
//
// Swap sizing: PayBox's request_swap takes the SOURCE amount (`amount`, smallest units). Its schema has a
// `swap_direction` field, but its description documents no exact-output mode, so Owed doesn't use it: the input is
// sized at Pyth's price, on the cautious side of its confidence band, plus 1% for price movement and swap fees. PayBox
// quotes the swap before the user approves, and if less arrives the next pay_link plans the rest.
//
// The result is a refusal-shaped MCP result (isError, text only): pay_link's and pay_all's output schemas are PayBox's
// strict proposal envelope, and an MCP client validates any structuredContent against them, so the plan travels as a
// ```json block at the end of the text. fundingPlanFromText() reads it back.

export const SOLANA_CAIP2 = "solana:mainnet";
/** MoonX network ids PayBox get_portfolio takes with `token`. */
export const MOONX_SOLANA = 1399811149;
export const MOONX_BASE = 8453;
/** MoonPay's smallest purchase of USDC on Solana (usdc_sol minBuyAmount, web/lib/moonpay/config.ts): 4.99 USD. */
export const MOONPAY_MIN_CENTS = 499n;
/** Swaps are sized 1% over what they must deliver. */
export const BUFFER_BPS = 100n;
/** SOL kept back for a swap's own network fee. */
export const SWAP_FEE_LAMPORTS = 1_000_000n;
/** A fee top-up: about 0.01 SOL, enough for a few payments' fees and a new USDC account. */
export const FEE_TOPUP_LAMPORTS = 10_000_000n;
/** USDC swapped for the fee top-up when no SOL price can be read (about 0.01 SOL at 200 USD). */
export const FEE_TOPUP_USDC_FALLBACK = 2_000_000n;
/** A Pyth price older than this, or with a confidence band wider than 1%, isn't used to size a swap. */
export const MAX_PRICE_AGE_S = 300;
export const MAX_CONF_BPS = 100n;
/** Budgets inside pay_link's 8.5 s: the price read, and the server recording the plan. */
export const PRICE_BUDGET_MS = 1500;
export const PLAN_RECORD_BUDGET_MS = 2000;
export const PLAN_USED_BUDGET_MS = 1500;

export const PLAN_MARKER = "Funding plan (machine-readable):";
const AGAIN = "It re-runs every check and proposes the payment.";

// ---------------------------------------------------------------------------------------------- price math

/** A Pyth price fit for sizing: low = price − conf (selling SOL), high = price + conf (buying SOL). */
export interface UsablePrice {
  low: bigint;
  high: bigint;
  mid: bigint;
  expo: number;
  publishTime: number;
}

/** null when the price is missing, non-positive, older than 5 minutes (or from the future), or its band is over 1%. */
export function usablePrice(p: SolUsdPrice | null | undefined, nowMs: number): UsablePrice | null {
  if (!p) return null;
  if (p.price <= 0n || p.conf < 0n || !Number.isInteger(p.expo) || p.expo > 0 || p.expo < -18) return null;
  const age = nowMs / 1000 - p.publishTime;
  if (!(age <= MAX_PRICE_AGE_S && age >= -60)) return null;
  if (p.conf * 10_000n > p.price * MAX_CONF_BPS) return null;
  return { low: p.price - p.conf, high: p.price + p.conf, mid: p.price, expo: p.expo, publishTime: p.publishTime };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const scale = (p: UsablePrice) => 10n ** BigInt(-p.expo);
const buffered = (x: bigint) => x * (10_000n + BUFFER_BPS);

/** Lamports to sell for `usdc` (atomic) at the low price, plus 1%: the least L with L·low ≥ 1.01·usdc. */
export function lamportsForUsdc(usdc: bigint, p: UsablePrice): bigint {
  // SOL = USD / (low·10^expo); lamports = SOL·1e9; USD = usdc / 1e6.
  return ceilDiv(buffered(usdc) * 1000n * scale(p), 10_000n * p.low);
}

/** USDC (atomic) to sell for `lamports` at the high price, plus 1%. */
export function usdcForLamports(lamports: bigint, p: UsablePrice): bigint {
  return ceilDiv(buffered(lamports) * p.high, 10_000n * 1000n * scale(p));
}

/** USD cents to spend on `lamports` of SOL at the high price, plus 1%. */
export function centsForLamports(lamports: bigint, p: UsablePrice): bigint {
  return ceilDiv(buffered(lamports) * p.high * 100n, 10_000n * 1_000_000_000n * scale(p));
}

/** USDC (atomic) rounded UP to the cent. */
export const centsForUsdc = (usdc: bigint) => ceilDiv(usdc, 10_000n);

/** "4.99" from 499n. */
export const centsText = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;

/**
 * PayBox get_buy_link's amount_usd is a JSON number (its schema says double). Built from the cents' decimal string, it
 * prints back exactly ("4.99" → 4.99): the only number Owed hands out that isn't a decimal string.
 */
const usdNumber = (cents: bigint) => Number(centsText(cents));

/** "103.10" USD per SOL (mid price, 2 decimals). */
export function priceText(p: UsablePrice): string {
  const cents = (p.mid * 100n) / scale(p);
  return centsText(cents);
}

/** "08:04 UTC". */
const timeText = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)} UTC`;

// ---------------------------------------------------------------------------------------------- the plan

export interface PlanInput {
  payTool: "pay_link" | "pay_all";
  /** The arguments of the call to make again once funded (the user's own call, without plan_id). */
  payArgs: Record<string, unknown>;
  /** Owed request ids being paid (empty for a link that isn't an Owed request). */
  requestIds: string[];
  sender: string;
  /** What the payment sends: USDC and SOL, atomic. */
  sendUsdc: bigint;
  sendLamports: bigint;
  /** What the Solana Pay transaction needs on top: network fees and new USDC accounts' rent. */
  feeLamports: bigint;
  funds: PayerFunds;
  /** The call already asked for rail "x402": the facilitator pays the network fee. */
  x402Rail: boolean;
  /** pay_link could pay over x402 instead (an Owed USDC request whose recipient's USDC account exists). */
  x402Possible: boolean;
  price: UsablePrice | null;
}

const usdc = (atomic: bigint) => fromAtomic(atomic, "USDC");
const sol = (atomic: bigint) => fromAtomic(atomic, "SOL");
const amountOf = (token: Token, atomic: bigint): PlanAmount => ({ token, atomic: atomic.toString(), display: `${fromAtomic(atomic, token)} ${token}` });

/**
 * The options that fix a shortfall, best first, or null when nothing is short. Pure: balances, price and what is
 * being paid in, the plan out. Every option ends with the pay call again (plan_id is added once the server records it).
 */
export function planFunding(i: PlanInput): FundingPlan | null {
  const lamports = i.funds.lamports;
  const heldUsdc = i.funds.usdc ?? 0n;
  const finalFee = i.x402Rail ? 0n : i.feeLamports;
  const usdcShort = i.sendUsdc > heldUsdc ? i.sendUsdc - heldUsdc : 0n;
  const solNeed = i.sendLamports + finalFee;
  const solShort = solNeed > lamports ? solNeed - lamports : 0n;
  if (usdcShort === 0n && solShort === 0n) return null;
  // Only the fee is short, or USDC and the fee: paying over x402 needs no SOL at all (pay_link, USDC only).
  const switchToX402 = !i.x402Rail && i.x402Possible && i.sendLamports === 0n && solShort > 0n;
  const pay = (why: string, rail?: "x402"): PlanStep => ({
    via: "owed", tool: i.payTool, args: { ...i.payArgs, ...(rail && { rail }) }, credential_of: i.sender, why,
  });
  const S = i.sender;
  const options: PlanOption[] = [];
  // PayBox's request_swap asks for a get_portfolio check of the source holding first, even though Owed just read it.
  const holding = (token: "native" | typeof USDC_MINT, atLeast: string, read: string | null): PlanStep => ({
    via: "paybox", tool: "get_portfolio", args: { address: S, network_id: MOONX_SOLANA, token }, credential_of: null,
    why: `PayBox's holding check before a swap: use this option only if it shows at least ${atLeast}${read ? ` (Owed read ${read} just now)` : " (Owed didn't read this wallet's USDC)"}.`,
  });
  const poll = (what: string): PlanStep => ({
    via: "paybox", tool: "get_request", args: {}, credential_of: null, missing: ["request_id"],
    why: `Poll with the request_id ${what} returned until it is terminal; never call ${what} again for the same swap.`,
  });

  let shortfall: PlanAmount;
  if (usdcShort > 0n) {
    shortfall = amountOf("USDC", usdcShort);
    const target = usdc(usdcShort);
    const withBuffer = ceilDiv(buffered(usdcShort), 10_000n);
    const afterwards = switchToX402
      ? `Over x402 (rail "x402") the facilitator pays the network fee, so the wallet needs no SOL.`
      : solShort > 0n
        ? `The wallet will still need about ${sol(solShort)} SOL for fees; ${i.payTool} plans that next.`
        : AGAIN;
    const payAgain = pay(afterwards, switchToX402 ? "x402" : undefined);

    // 1. SOL the wallet holds beyond what the payment, its fees and the swap's own fee need.
    if (solShort === 0n) {
      const opensAccount = i.funds.usdcAccount !== true;
      const swapReserve = SWAP_FEE_LAMPORTS + (opensAccount ? ATA_RENT_LAMPORTS : 0n);
      const spare = lamports - solNeed - swapReserve;
      const keep = solNeed + swapReserve;
      const leaves = `It leaves ${sol(keep)} SOL for network fees (this payment's and the swap's${opensAccount ? `, and ${sol(ATA_RENT_LAMPORTS)} to open the wallet's USDC account` : ""}).`;
      if (spare > 0n) {
        const args = { src_chain: SOLANA_CAIP2, src_token: "native", dst_token: USDC_MINT };
        if (i.price) {
          const L = lamportsForUsdc(usdcShort, i.price);
          if (L <= spare) {
            options.push({
              kind: "swap_sol", via: "paybox", tool: "request_swap", args: { ...args, amount: L.toString() }, credential_of: S, check: holding("native", `${sol(L + keep)} SOL`, `${sol(lamports)} SOL`),
              why: `${sol(L)} SOL is ${usdc(withBuffer)} USDC at Pyth's SOL/USD price (${priceText(i.price)} USD at ${timeText(i.price.publishTime)}, on the cautious side of its confidence band): the ${target} USDC short plus 1% for price movement and swap fees. PayBox quotes the swap before the user approves; if its quote gives less than ${target} USDC, raise amount by the same proportion. ${leaves}`,
              then: [poll("request_swap"), payAgain],
            });
          }
        } else if (spare > FEE_TOPUP_LAMPORTS) {
          options.push({
            kind: "swap_sol", via: "paybox", tool: "request_swap", args, credential_of: S, missing: ["amount"], check: holding("native", `the amount you pick plus ${sol(keep)} SOL`, `${sol(lamports)} SOL`),
            why: `Owed couldn't read a fresh SOL price, so amount is yours to fill in: the lamports worth ${usdc(withBuffer)} USDC (the ${target} USDC short plus 1%) at the SOL price PayBox's get_portfolio shows (USD value ÷ balance), and at most ${spare} lamports. ${leaves} PayBox quotes the swap before the user approves.`,
            then: [poll("request_swap"), payAgain],
          });
        }
      }
    }

    // 2. USDC on Base, bridged to this wallet on Solana. Owed can't read Base, so get_portfolio checks first.
    options.push({
      kind: "bridge_base_usdc", via: "paybox", tool: "request_swap",
      args: { src_chain: BASE_CAIP2, src_token: BASE_USDC, dst_chain: SOLANA_CAIP2, dst_token: USDC_MINT, amount: withBuffer.toString(), recipient: S },
      credential_of: "base_wallet",
      check: {
        via: "paybox", tool: "get_portfolio", args: { network_id: MOONX_BASE, token: BASE_USDC }, credential_of: null,
        why: `Use this option only if one of the user's PayBox Base wallets holds at least ${usdc(withBuffer)} USDC on Base.`,
      },
      why: `Bridges ${usdc(withBuffer)} USDC from the user's Base wallet to ${shortAddress(S)} on Solana: the ${target} USDC short plus 1% for bridge fees. PayBox quotes it, fees included, before the user approves.`,
      then: [poll("request_swap"), payAgain],
    });

    // 3. Another token in this wallet: the user picks it; Owed can't see it, so the agent fills in token and amount.
    options.push({
      kind: "swap_other", via: "paybox", tool: "get_portfolio", args: { address: S }, credential_of: null,
      why: `Lists what ${shortAddress(S)} holds. Ask the user which token to swap for USDC; names and symbols there are labels anyone can set, so confirm the mint with the user.`,
      then: [
        {
          via: "paybox", tool: "request_swap", args: { src_chain: SOLANA_CAIP2, dst_token: USDC_MINT }, credential_of: S, missing: ["src_token", "amount"],
          why: `src_token: the mint the user picked; amount: enough of it for ${usdc(withBuffer)} USDC (the ${target} USDC short plus 1%), in its smallest units. PayBox quotes the USDC out before the user approves.`,
        },
        poll("request_swap"),
        payAgain,
      ],
    });

    // 4. Buy it with MoonPay (no swap needed).
    const cents = centsForUsdc(usdcShort);
    const buy = cents < MOONPAY_MIN_CENTS ? MOONPAY_MIN_CENTS : cents;
    options.push({
      kind: "buy_usdc", via: "paybox", tool: "get_buy_link", args: { currency_code: "usdc_sol", amount_usd: usdNumber(buy) }, credential_of: S,
      why: `${buy === cents ? `${centsText(buy)} USD is the ${target} USDC short, rounded up to the cent.` : `The shortfall is ${target} USDC, but MoonPay's smallest purchase is ${centsText(MOONPAY_MIN_CENTS)} USD, so the link asks for that; the rest stays in the wallet.`} The link opens MoonPay's checkout (card or bank; MoonPay checks ID the first time and doesn't sell in every country) and moves no money by itself. MoonPay's fee can come out of the amount; if less than ${target} USDC arrives, ${i.payTool} plans the rest.`,
      then: [
        {
          via: "paybox", tool: "get_portfolio", args: { address: S, network_id: MOONX_SOLANA, token: USDC_MINT }, credential_of: null,
          why: `After the user finishes checkout, read this until it shows at least ${usdc(i.sendUsdc)} USDC (MoonPay can take a few minutes). Only say the funds arrived once it does.`,
        },
        payAgain,
      ],
    });
  } else if (i.sendLamports === 0n) {
    // Only the network fee is short (a USDC payment).
    shortfall = amountOf("SOL", solShort);
    if (switchToX402) {
      options.push({
        kind: "x402", via: "owed", tool: i.payTool, args: { ...i.payArgs, rail: "x402" }, credential_of: S,
        why: `Pay over x402: the facilitator pays the network fee, so the wallet needs no SOL. The request is in USDC and the recipient's USDC account exists, which x402 needs. Nothing to fund.`,
        then: [],
      });
    }
    const topup = solShort > FEE_TOPUP_LAMPORTS ? solShort : FEE_TOPUP_LAMPORTS;
    const swapUsdc = i.price ? usdcForLamports(topup, i.price) : FEE_TOPUP_USDC_FALLBACK;
    if (i.funds.usdc !== null && heldUsdc - i.sendUsdc >= swapUsdc) {
      options.push({
        kind: "swap_usdc_for_sol", via: "paybox", tool: "request_swap", args: { src_chain: SOLANA_CAIP2, src_token: USDC_MINT, dst_token: "native", amount: swapUsdc.toString() }, credential_of: S,
        check: holding(USDC_MINT, `${usdc(i.sendUsdc + swapUsdc)} USDC`, `${usdc(heldUsdc)} USDC`),
        why: `${usdc(swapUsdc)} USDC buys about ${sol(topup)} SOL${i.price ? ` at Pyth's SOL/USD price (${priceText(i.price)} USD at ${timeText(i.price.publishTime)}), plus 1%` : " at around 200 USD per SOL (Owed couldn't read a fresh price)"}: the ${sol(solShort)} SOL short and some for later fees. The wallet keeps ${usdc(heldUsdc - swapUsdc)} USDC, still enough for this payment. If PayBox answers that the swap itself needs SOL for its network fee, use the next option.`,
        then: [poll("request_swap"), pay(AGAIN)],
      });
    }
    options.push(buySol(i, solShort, solNeed, null));
  } else {
    // A SOL payment (pay_link on a SOL request, or pay_all with SOL requests): SOL itself is short.
    shortfall = amountOf("SOL", solShort);
    const target = solShort + SWAP_FEE_LAMPORTS;
    const payAgain = pay(AGAIN);
    const swapArgs = { src_chain: SOLANA_CAIP2, src_token: USDC_MINT, dst_token: "native" };
    if (i.price) {
      const swapUsdc = usdcForLamports(target, i.price);
      const enough = i.funds.usdc === null ? null : heldUsdc - i.sendUsdc >= swapUsdc;
      if (enough !== false) {
        options.push({
          kind: "swap_usdc_for_sol", via: "paybox", tool: "request_swap", args: { ...swapArgs, amount: swapUsdc.toString() }, credential_of: S,
          check: holding(USDC_MINT, `${usdc(i.sendUsdc + swapUsdc)} USDC`, enough === null ? null : `${usdc(heldUsdc)} USDC`),
          why: `${usdc(swapUsdc)} USDC buys about ${sol(target)} SOL at Pyth's SOL/USD price (${priceText(i.price)} USD at ${timeText(i.price.publishTime)}), plus 1%: the ${sol(solShort)} SOL short and the swap's own fee. PayBox quotes the swap before the user approves.`,
          then: [poll("request_swap"), payAgain],
        });
      }
    }
    options.push({
      kind: "swap_other", via: "paybox", tool: "get_portfolio", args: { address: S }, credential_of: null,
      why: `Lists what ${shortAddress(S)} holds. Ask the user which token to swap for SOL; names and symbols there are labels anyone can set, so confirm the mint with the user.`,
      then: [
        {
          via: "paybox", tool: "request_swap", args: { src_chain: SOLANA_CAIP2, dst_token: "native" }, credential_of: S, missing: ["src_token", "amount"],
          why: `src_token: the mint the user picked; amount: enough of it for ${sol(target)} SOL (the ${sol(solShort)} SOL short and the swap's fee) plus 1%, in its smallest units. PayBox quotes the SOL out before the user approves.`,
        },
        poll("request_swap"),
        payAgain,
      ],
    });
    options.push(buySol(i, solShort, solNeed, i.price));
  }

  const have: PlanAmount[] = [...(i.funds.usdc !== null ? [amountOf("USDC", heldUsdc)] : []), amountOf("SOL", lamports)];
  const need: PlanAmount[] = [...(i.sendUsdc > 0n ? [amountOf("USDC", i.sendUsdc)] : []), ...(solNeed > 0n ? [amountOf("SOL", solNeed)] : [])];
  return { plan_id: null, pay_tool: i.payTool, request_ids: [...i.requestIds], sender: i.sender, shortfall, have, need, options };
}

/** Buy SOL with MoonPay: the fee top-up (at MoonPay's minimum), or a SOL payment's shortfall sized at Pyth's price. */
function buySol(i: PlanInput, solShort: bigint, solNeed: bigint, price: UsablePrice | null): PlanOption {
  const S = i.sender;
  let args: Record<string, unknown> = {};
  let missing: string[] | undefined;
  let why: string;
  const tail = "The link opens MoonPay's checkout (card or bank; MoonPay checks ID the first time and doesn't sell in every country) and moves no money by itself; native SOL needs no currency_code. MoonPay's checkout shows its own minimum for SOL.";
  if (i.sendLamports === 0n) {
    args = { amount_usd: usdNumber(MOONPAY_MIN_CENTS) };
    why = `The wallet needs about ${sol(solShort)} SOL more for fees. ${centsText(MOONPAY_MIN_CENTS)} USD is the smallest MoonPay purchase Owed knows of (its minimum for USDC on Solana), far more than the fee; the rest stays in the wallet for later fees. ${tail}`;
  } else if (price) {
    const cents = centsForLamports(solShort + SWAP_FEE_LAMPORTS, price);
    const buy = cents < MOONPAY_MIN_CENTS ? MOONPAY_MIN_CENTS : cents;
    args = { amount_usd: usdNumber(buy) };
    why = `${centsText(buy)} USD ${buy === cents ? `buys the ${sol(solShort)} SOL short at Pyth's SOL/USD price (${priceText(price)} USD), plus 1%, rounded up to the cent` : `is MoonPay's smallest purchase; the ${sol(solShort)} SOL short costs less`}. MoonPay's fee can come out of the amount; if less arrives, ${i.payTool} plans the rest. ${tail}`;
  } else {
    missing = ["amount_usd"];
    why = `Owed couldn't read a fresh SOL price: amount_usd is the USD price of ${sol(solShort)} SOL plus 1%, rounded up to the cent (at least ${centsText(MOONPAY_MIN_CENTS)}); or leave it out and let the user choose at least ${sol(solShort)} SOL in checkout. ${tail}`;
  }
  return {
    kind: "buy_sol", via: "paybox", tool: "get_buy_link", args, credential_of: S, ...(missing && { missing }), why,
    then: [
      {
        via: "paybox", tool: "get_portfolio", args: { address: S, network_id: MOONX_SOLANA, token: "native" }, credential_of: null,
        why: `After the user finishes checkout, read this until it shows at least ${sol(solNeed)} SOL (MoonPay can take a few minutes). Only say the funds arrived once it does.`,
      },
      { via: "owed", tool: i.payTool, args: { ...i.payArgs }, credential_of: S, why: AGAIN },
    ],
  };
}

/** The plan with its plan_id, also passed to every Owed step so the final pay_link / pay_all can echo it. */
export function withPlanId(plan: FundingPlan, planId: string | null): FundingPlan {
  if (planId === null) return plan;
  const tag = <T extends PlanStep>(s: T): T => (s.via === "owed" ? { ...s, args: { ...s.args, plan_id: planId } } : s);
  return { ...plan, plan_id: planId, options: plan.options.map((o) => ({ ...tag(o), then: o.then.map(tag) })) };
}

/** The kinds the server records ("which ways out were offered"), in order. */
export const optionKinds = (plan: FundingPlan): PlanOptionKind[] => plan.options.map((o) => o.kind);

// ---------------------------------------------------------------------------------------------- server

/**
 * Records the plan with Owed's server (best effort: within the budget, else the plan goes out without a plan_id).
 * A call that already carries a plan_id is a later step of the same plan: the id is reused, nothing is recorded.
 */
export async function recordPlan(plan: FundingPlan, ctx: Pick<CallContext, "api">, existing: string | undefined, budgetMs: number): Promise<FundingPlan> {
  if (existing !== undefined) return withPlanId(plan, existing);
  if (budgetMs <= 0) return plan;
  const id = await within(
    ctx.api.createPlan({
      tool: plan.pay_tool, sender: plan.sender, request_ids: plan.request_ids,
      shortfall: { token: plan.shortfall.token, atomic: plan.shortfall.atomic }, options: optionKinds(plan),
    }).then((r) => r.plan_id, () => null),
    budgetMs, () => null,
  );
  return withPlanId(plan, id);
}

/** The final pay_link / pay_all proposed a payment for a plan: tell the server (best effort, bounded). */
export async function markPlanUsed(planId: string | undefined, sender: string, ctx: Pick<CallContext, "api">, budgetMs: number): Promise<void> {
  if (planId === undefined || budgetMs <= 0) return;
  await within(ctx.api.planUsed(planId, { sender }).then(() => undefined, () => undefined), budgetMs, () => undefined);
}

// ---------------------------------------------------------------------------------------------- text

const TITLES: Record<PlanOptionKind, (p: FundingPlan) => string> = {
  swap_sol: () => "Swap SOL for USDC",
  bridge_base_usdc: () => "Bring USDC over from Base",
  swap_other: (p) => `Swap another token for ${p.shortfall.token}`,
  buy_usdc: () => "Buy USDC with MoonPay",
  x402: () => "Pay over x402 instead (no SOL needed)",
  swap_usdc_for_sol: (p) => (p.need.some((n) => n.token === "USDC") ? "Swap a little USDC for SOL" : "Swap USDC for SOL"),
  buy_sol: () => "Buy SOL with MoonPay",
};

function credentialText(s: PlanStep): string {
  if (s.via === "owed") return ` through PayBox use_plugin (wallet_id ${s.credential_of})`;
  if (s.credential_of === "base_wallet") return " with the credential_id of the user's PayBox Base wallet";
  if (s.credential_of) return ` with the credential_id of wallet ${shortAddress(s.credential_of)}`;
  return "";
}

/** A PayBox step with its exact arguments; an Owed step relative to the call being answered (its args can be long). */
function stepText(s: PlanStep, base: Record<string, unknown>): string {
  if (s.via === "owed") {
    const changed = Object.keys(s.args).filter((k) => JSON.stringify(s.args[k]) !== JSON.stringify(base[k]));
    const extra = changed.map((k) => `${k} ${JSON.stringify(s.args[k])}`).join(" and ");
    return `Owed's ${s.tool}${credentialText(s)} with the same arguments as this call${extra ? `, plus ${extra}` : ""}. ${s.why}`;
  }
  const missing = s.missing?.length ? ` (you fill in ${s.missing.join(" and ")})` : "";
  return `PayBox ${s.tool} ${JSON.stringify(s.args)}${credentialText(s)}${missing}. ${s.why}`;
}

/**
 * The plan in words: what is short, the options in order with their exact calls, and the rules that keep it safe.
 * `lead` opens it (the old refusal sentence, so the user sees the same reason); `before` comes before any option
 * (a handle check: a request that fails it must not be funded); `context` follows (payee, notes, skips).
 */
type Lines = ReadonlyArray<string | null | undefined>;

export function planText(plan: FundingPlan, base: Record<string, unknown>, lead: Lines, before: Lines, context: Lines): string {
  const holds = plan.have.map((h) => h.display).join(" and ");
  const needs = plan.need.map((n) => n.display).join(" and ");
  const lines: Lines[number][] = [
    ...lead,
    `The wallet holds ${holds}; this needs ${needs} (network fees included). Short: ${plan.shortfall.display}.`,
    ...before,
    "Owed can't move money or call PayBox tools, so here are the PayBox calls that fix it, best first. Ask the user which to use; nothing moves until they approve each step in PayBox.",
  ];
  plan.options.forEach((o, n) => {
    const check = o.check ? `Check first: ${stepText(o.check, base)} ` : "";
    const then = o.then.map((s) => `Then: ${stepText(s, base)}`).join(" ");
    lines.push(`${n + 1}. ${TITLES[o.kind](plan)}. ${check}${o.via === "owed" ? "Call " : "Run "}${stepText(o, base)}${then ? ` ${then}` : ""}`);
  });
  lines.push(
    "Before each PayBox step, run PayBox check_operation_readiness with operation set to the arguments you're about to pass (credential_id included) and fix any blocker it names.",
    `The last step is always ${plan.pay_tool} again${plan.plan_id ? ` with plan_id "${plan.plan_id}"` : ""}: it re-runs every check (the request, the payee, sanctions and the balance) before it proposes anything, and the user approves that payment in PayBox too.`,
    ...context,
    PLAN_MARKER,
    "```json",
    JSON.stringify({ funding_plan: plan }),
    "```",
  );
  return lines.filter(Boolean).join("\n");
}

/** The tool result for a plan: refusal-shaped (isError, text only), see the note at the top. */
export function planResult(plan: FundingPlan, base: Record<string, unknown>, lead: Lines, before: Lines, context: Lines) {
  return refusal(planText(plan, base, lead, before, context));
}

/** Pyth's SOL/USD price if it can be read fresh within the budget, else null (the plan then leaves swap sizes to the agent). */
export async function readUsablePrice(deps: Pick<Deps, "solUsdPrice" | "rpc" | "now">, budgetMs: number): Promise<UsablePrice | null> {
  if (budgetMs <= 0) return null;
  try {
    const p = await within(deps.solUsdPrice(deps.rpc(), budgetMs).catch(() => null), budgetMs, () => null);
    return usablePrice(p, deps.now());
  } catch {
    return null;
  }
}

/** The funding_plan inside a tool's text, or null. */
export function fundingPlanFromText(text: string): FundingPlan | null {
  const at = text.indexOf(`${PLAN_MARKER}\n\`\`\`json\n`);
  if (at < 0) return null;
  const start = at + PLAN_MARKER.length + "\n```json\n".length;
  const end = text.indexOf("\n```", start);
  if (end < 0) return null;
  try {
    const doc = JSON.parse(text.slice(start, end)) as { funding_plan?: FundingPlan };
    return doc.funding_plan ?? null;
  } catch {
    return null;
  }
}

/**
 * Base requests: the plugin can't read Base (no new host), so a short Base wallet can't be detected before PayBox
 * pays. The proposal says what to do if it is short: check get_portfolio, buy the difference on Base, pay again.
 */
export function baseFundingLine(amountAtomic: bigint, sender: string): string {
  const cents = centsForUsdc(amountAtomic);
  const full = cents < MOONPAY_MIN_CENTS ? MOONPAY_MIN_CENTS : cents;
  const amount = usdc(amountAtomic);
  return `If your Base wallet holds less than ${amount} USDC on Base (check with PayBox get_portfolio ${JSON.stringify({ address: sender, network_id: MOONX_BASE, token: BASE_USDC })}), don't approve yet: run PayBox get_buy_link ${JSON.stringify({ currency_code: "usdc_base", amount_usd: usdNumber(full) })} with that wallet's credential_id, using amount_usd = what it lacks rounded up to the cent if it holds some (at least ${centsText(MOONPAY_MIN_CENTS)}, MoonPay's smallest purchase). The link moves no money; wait until get_portfolio shows at least ${amount} USDC, then call pay_link again.`;
}
