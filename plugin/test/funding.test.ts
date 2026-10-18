import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PYTH_SOL_USD_ACCOUNT, readSolUsdPrice, RpcError, type Rpc, type SolUsdPrice } from "../src/chain.ts";
import { fundingPlanSchema } from "../src/contract.ts";
import { BASE_USDC } from "../src/evm.ts";
import {
  baseFundingLine, centsForLamports, centsForUsdc, fundingPlanFromText, lamportsForUsdc, MOONX_BASE, MOONX_SOLANA, optionKinds,
  planFunding, planText, priceText, readUsablePrice, recordPlan, usablePrice, usdcForLamports, withPlanId, type PlanInput,
} from "../src/funding.ts";
import { USDC_MINT } from "../src/money.ts";
import { json, makeDeps, RECIPIENT, SENDER } from "./helpers.ts";

// F2 funding plan, the pure part: Pyth's SOL/USD price read from a recorded mainnet account, the swap and buy sizes
// it gives, and the options each shortfall gets (spec table: USDC short with SOL, other tokens, USDC on Base, nothing
// to swap, only the fee short; SOL payments too). pay_link_f2 / pay_all_f2 run the same through the tools.

interface Call { method: string; params: unknown[]; result: unknown }
const chainFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: Call[] };
function replay(calls: Call[]): Rpc {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded call ${method} ${JSON.stringify(params)}`);
      return structuredClone(hit.result) as T;
    },
  };
}
const PYTH = chainFixture("pyth-sol-usd");
/** The capture's own wall clock, 47 s after Pyth published the price. */
const CAPTURED = Date.parse("2026-10-18T08:05:21Z");

// ---------------------------------------------------------------------------------------------- Pyth

test("Pyth: the recorded SOL/USD account decodes to price, confidence, exponent and publish time", async () => {
  const p = await readSolUsdPrice(replay(PYTH.calls));
  assert.deepEqual(p, { price: 10_309_642_626n, conf: 3_303_936n, expo: -8, publishTime: 1_792_310_674 });
  assert.equal(new Date(p.publishTime * 1000).toISOString(), "2026-10-18T08:04:34.000Z");
  const u = usablePrice(p, CAPTURED)!;
  assert.equal(priceText(u), "103.09");
  assert.equal(u.low, 10_306_338_690n);
  assert.equal(u.high, 10_312_946_562n);
});

test("Pyth: another owner, a partially verified update or another feed is refused", async () => {
  const tweak = (edit: (v: { owner: string; data: [string, string] }, b: Buffer) => void) => {
    const calls = structuredClone(PYTH.calls);
    const v = (calls[0]!.result as { value: { owner: string; data: [string, string] } }).value;
    const b = Buffer.from(v.data[0], "base64");
    edit(v, b);
    v.data[0] = b.toString("base64");
    return replay(calls);
  };
  await assert.rejects(readSolUsdPrice(tweak((v) => { v.owner = "11111111111111111111111111111111"; })), RpcError);
  await assert.rejects(readSolUsdPrice(tweak((_v, b) => { b[40] = 0; })), /fully verified/);
  await assert.rejects(readSolUsdPrice(tweak((_v, b) => { b[41] ^= 0xff; })), /SOL\/USD feed/);
  await assert.rejects(readSolUsdPrice(replay([{ ...PYTH.calls[0]!, result: { context: {}, value: null } }])), RpcError);
  // The exact call: one getAccountInfo of Pyth's account, base64 (the replay refuses anything else).
  assert.deepEqual(PYTH.calls[0]!.params, [PYTH_SOL_USD_ACCOUNT, { encoding: "base64", commitment: "confirmed" }]);
});

test("Pyth: a price is used only while fresh (5 minutes) and tight (confidence within 1%)", async () => {
  const p = await readSolUsdPrice(replay(PYTH.calls));
  assert.ok(usablePrice(p, (p.publishTime + 300) * 1000));
  assert.equal(usablePrice(p, (p.publishTime + 301) * 1000), null, "stale");
  assert.equal(usablePrice(p, (p.publishTime - 61) * 1000), null, "from the future");
  assert.equal(usablePrice({ ...p, conf: p.price / 99n }, CAPTURED), null, "band over 1%");
  assert.equal(usablePrice({ ...p, price: 0n }, CAPTURED), null);
  assert.equal(usablePrice({ ...p, expo: 2 }, CAPTURED), null);
  assert.equal(usablePrice(null, CAPTURED), null);
});

test("readUsablePrice: a slow or failing read is no price, inside its budget", async () => {
  const { deps } = makeDeps({ now: () => CAPTURED, solUsdPrice: () => new Promise<SolUsdPrice>(() => {}) });
  const started = Date.now();
  assert.equal(await readUsablePrice(deps, 50), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await readUsablePrice(makeDeps({ now: () => CAPTURED }).deps, 500), null, "the default double throws");
  assert.equal(await readUsablePrice(deps, 0), null, "no budget, no read");
  const real = makeDeps({ now: () => CAPTURED, rpc: () => replay(PYTH.calls), solUsdPrice: readSolUsdPrice }).deps;
  assert.equal(priceText((await readUsablePrice(real, 1500))!), "103.09");
});

// ---------------------------------------------------------------------------------------------- sizes

test("sizes: the least lamports worth the USDC plus 1% at the low price, and the most cautious USDC/cents for SOL", async () => {
  const u = usablePrice(await readSolUsdPrice(replay(PYTH.calls)), CAPTURED)!;
  for (const usdc of [1n, 100_000n, 15_000_000n, 1_234_567_891n]) {
    const L = lamportsForUsdc(usdc, u);
    // L·low·10^-8 USD per SOL / 1e9 ≥ 1.01 · usdc / 1e6, and L − 1 falls short: exact ceiling.
    const worth = (l: bigint) => l * u.low * 10_000n;
    const want = usdc * 10_100n * 1000n * 100_000_000n;
    assert.ok(worth(L) >= want && worth(L - 1n) < want, `ceil for ${usdc}`);
  }
  assert.equal(lamportsForUsdc(15_000_000n, u), 146_996_916n); // 0.146996916 SOL ≈ 15.15 USDC at 103.06
  assert.equal(usdcForLamports(10_000_000n, u), 1_041_608n); // 0.01 SOL ≈ 1.04 USDC at 103.13, plus 1%
  assert.equal(centsForLamports(10_000_000n, u), 105n);
  assert.equal(centsForUsdc(100_000n), 10n);
  assert.equal(centsForUsdc(100_001n), 11n, "rounded up to the cent");
  assert.equal(centsForUsdc(15_000_000n), 1500n);
});

// ---------------------------------------------------------------------------------------------- options

const PRICE = { low: 10_306_338_690n, high: 10_312_946_562n, mid: 10_309_642_626n, expo: -8, publishTime: 1_792_310_674 };
const base = (over: Partial<PlanInput>): PlanInput => ({
  payTool: "pay_link", payArgs: { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER }, requestIds: ["JArQ6g9JvoWr"], sender: SENDER,
  sendUsdc: 15_000_000n, sendLamports: 0n, feeLamports: 3_000_000n,
  funds: { lamports: 0n, usdc: 0n, usdcAccount: false }, x402Rail: false, x402Possible: true, price: PRICE, ...over,
});
const kinds = (i: PlanInput) => optionKinds(planFunding(i)!);

test("nothing short: no plan", () => {
  assert.equal(planFunding(base({ funds: { lamports: 3_000_000n, usdc: 15_000_000n, usdcAccount: true } })), null);
  assert.equal(planFunding(base({ x402Rail: true, funds: { lamports: 0n, usdc: 15_000_000n, usdcAccount: true } })), null, "x402 needs no SOL");
});

test("USDC short, SOL above the fee reserve: swap SOL first, exact amount at Pyth's price, then pay_link again", () => {
  const plan = planFunding(base({ funds: { lamports: 5_211_577_354n, usdc: 0n, usdcAccount: false } }))!;
  assert.deepEqual(optionKinds(plan), ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"]);
  assert.deepEqual(plan.shortfall, { token: "USDC", atomic: "15000000", display: "15 USDC" });
  assert.deepEqual(plan.have, [{ token: "USDC", atomic: "0", display: "0 USDC" }, { token: "SOL", atomic: "5211577354", display: "5.211577354 SOL" }]);
  assert.deepEqual(plan.need, [{ token: "USDC", atomic: "15000000", display: "15 USDC" }, { token: "SOL", atomic: "3000000", display: "0.003 SOL" }]);
  const swap = plan.options[0]!;
  assert.deepEqual(swap.args, { src_chain: "solana:mainnet", src_token: "native", dst_token: USDC_MINT, amount: "146996916" });
  assert.equal(swap.credential_of, SENDER);
  assert.equal(swap.missing, undefined);
  assert.deepEqual(swap.then.map((s) => s.tool), ["get_request", "pay_link"]);
  assert.deepEqual(swap.then[1]!.args, { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER });
  assert.match(swap.why, /^0\.146996916 SOL is 15\.15 USDC at Pyth's SOL\/USD price \(103\.09 USD at 08:04 UTC/);
  assert.match(swap.why, / It leaves 0\.00603928 SOL for network fees \(this payment's and the swap's, and 0\.00203928 to open the wallet's USDC account\)\.$/);
  fundingPlanSchema.parse(plan);
});

test("USDC short, SOL above the reserve but too little to swap for all of it: no SOL swap, the other ways remain", () => {
  assert.deepEqual(kinds(base({ funds: { lamports: 100_000_000n, usdc: 0n, usdcAccount: true } })), ["bridge_base_usdc", "swap_other", "buy_usdc"]);
  // Just enough: the swap amount plus fees plus the swap's own fee (no new USDC account).
  const L = lamportsForUsdc(15_000_000n, PRICE);
  assert.deepEqual(kinds(base({ funds: { lamports: L + 3_000_000n + 1_000_000n, usdc: 0n, usdcAccount: true } }))[0], "swap_sol");
  assert.notEqual(kinds(base({ funds: { lamports: L + 3_000_000n + 1_000_000n - 1n, usdc: 0n, usdcAccount: true } }))[0], "swap_sol");
  // Opening the sender's USDC account costs rent too.
  assert.notEqual(kinds(base({ funds: { lamports: L + 3_000_000n + 1_000_000n, usdc: 0n, usdcAccount: false } }))[0], "swap_sol");
  assert.equal(kinds(base({ funds: { lamports: L + 3_000_000n + 1_000_000n + 2_039_280n, usdc: 0n, usdcAccount: false } }))[0], "swap_sol");
});

test("USDC short without a fresh price: the SOL swap leaves amount to the agent, with the most it may swap", () => {
  const plan = planFunding(base({ price: null, funds: { lamports: 5_211_577_354n, usdc: 0n, usdcAccount: false } }))!;
  const swap = plan.options[0]!;
  assert.equal(swap.kind, "swap_sol");
  assert.deepEqual(swap.args, { src_chain: "solana:mainnet", src_token: "native", dst_token: USDC_MINT });
  assert.deepEqual(swap.missing, ["amount"]);
  assert.match(swap.why, /and at most 5205538074 lamports\. It leaves 0\.00603928 SOL for network fees/);
  // A sliver of SOL over the reserve isn't worth a swap without a price.
  assert.deepEqual(kinds(base({ price: null, funds: { lamports: 9_000_000n, usdc: 0n, usdcAccount: true } })), ["bridge_base_usdc", "swap_other", "buy_usdc"]);
});

test("USDC on Base: a cross-chain swap to the sender's Solana wallet, after get_portfolio shows it", () => {
  const plan = planFunding(base({}))!;
  const bridge = plan.options.find((o) => o.kind === "bridge_base_usdc")!;
  assert.deepEqual(bridge.args, {
    src_chain: "eip155:8453", src_token: BASE_USDC, dst_chain: "solana:mainnet", dst_token: USDC_MINT, amount: "15150000", recipient: SENDER,
  });
  assert.equal(bridge.credential_of, "base_wallet");
  assert.deepEqual(bridge.check, {
    via: "paybox", tool: "get_portfolio", args: { network_id: MOONX_BASE, token: BASE_USDC }, credential_of: null,
    why: "Use this option only if one of the user's PayBox Base wallets holds at least 15.15 USDC on Base.",
  });
  assert.deepEqual(bridge.then.map((s) => s.tool), ["get_request", "pay_link"]);
});

test("USDC short, other tokens: get_portfolio, then a swap whose token and amount only the agent can fill in", () => {
  const other = planFunding(base({}))!.options.find((o) => o.kind === "swap_other")!;
  assert.deepEqual(other.args, { address: SENDER });
  const swap = other.then[0]!;
  assert.deepEqual(swap.args, { src_chain: "solana:mainnet", dst_token: USDC_MINT });
  assert.deepEqual(swap.missing, ["src_token", "amount"]);
  assert.match(other.why, /labels anyone can set, so confirm the mint/);
});

test("nothing to swap: a MoonPay buy link for the shortfall rounded up to the cent, at least 4.99, then wait for get_portfolio", () => {
  const buy = (usdc: bigint) => planFunding(base({ sendUsdc: usdc }))!.options.at(-1)!;
  assert.equal(buy(15_000_000n).kind, "buy_usdc");
  assert.deepEqual(buy(15_000_000n).args, { currency_code: "usdc_sol", amount_usd: 15 });
  assert.deepEqual(buy(15_000_001n).args, { currency_code: "usdc_sol", amount_usd: 15.01 });
  assert.deepEqual(buy(5_123_456n).args, { currency_code: "usdc_sol", amount_usd: 5.13 });
  assert.match(buy(15_000_000n).why, /^15\.00 USD is the 15 USDC short, rounded up to the cent\./);
  const small = buy(100_000n);
  assert.deepEqual(small.args, { currency_code: "usdc_sol", amount_usd: 4.99 });
  assert.match(small.why, /^The shortfall is 0\.1 USDC, but MoonPay's smallest purchase is 4\.99 USD, so the link asks for that/);
  assert.deepEqual(small.then[0], {
    via: "paybox", tool: "get_portfolio", args: { address: SENDER, network_id: MOONX_SOLANA, token: USDC_MINT }, credential_of: null,
    why: "After the user finishes checkout, read this until it shows at least 0.1 USDC (MoonPay can take a few minutes). Only say the funds arrived once it does.",
  });
  // An empty wallet whose request x402 can pay: funding USDC is enough, the payment then goes over x402.
  assert.deepEqual(small.then[1]!.args, { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER, rail: "x402" });
  assert.match(small.then[1]!.why, /facilitator pays the network fee/);
  // Without x402 (not an Owed request, or the recipient has no USDC account), pay_link plans the fee next.
  const noX402 = planFunding(base({ sendUsdc: 100_000n, x402Possible: false }))!.options.at(-1)!;
  assert.deepEqual(noX402.then[1]!.args, { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER });
  assert.match(noX402.then[1]!.why, /still need about 0\.003 SOL for fees; pay_link plans that next/);
});

test("only the SOL fee short: x402 first when it can pay, then a small USDC→SOL swap, then buy SOL", () => {
  const funds = { lamports: 2_000_000n, usdc: 69_575_440n, usdcAccount: true };
  const plan = planFunding(base({ funds }))!;
  assert.deepEqual(optionKinds(plan), ["x402", "swap_usdc_for_sol", "buy_sol"]);
  assert.deepEqual(plan.shortfall, { token: "SOL", atomic: "1000000", display: "0.001 SOL" });
  const [x402, swap, buy] = plan.options;
  assert.deepEqual(x402, {
    kind: "x402", via: "owed", tool: "pay_link", args: { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER, rail: "x402" }, credential_of: SENDER,
    why: "Pay over x402: the facilitator pays the network fee, so the wallet needs no SOL. The request is in USDC and the recipient's USDC account exists, which x402 needs. Nothing to fund.",
    then: [],
  });
  assert.deepEqual(swap!.args, { src_chain: "solana:mainnet", src_token: USDC_MINT, dst_token: "native", amount: "1041608" });
  assert.match(swap!.why, /^1\.041608 USDC buys about 0\.01 SOL at Pyth's SOL\/USD price \(103\.09 USD at 08:04 UTC\), plus 1%/);
  assert.match(swap!.why, /The wallet keeps 68\.533832 USDC, still enough for this payment/);
  assert.deepEqual(buy!.args, { amount_usd: 4.99 });
  assert.deepEqual(buy!.then[0]!.args, { address: SENDER, network_id: MOONX_SOLANA, token: "native" });
  // The recipient has no USDC account (x402 can't open one): no x402 option.
  assert.deepEqual(kinds(base({ funds, x402Possible: false })), ["swap_usdc_for_sol", "buy_sol"]);
  // No spare USDC beyond the payment: only the buy.
  assert.deepEqual(kinds(base({ funds: { lamports: 0n, usdc: 15_000_000n, usdcAccount: true }, x402Possible: false })), ["buy_sol"]);
  // No price: the swap is 2 USDC, said as an estimate.
  const fallback = planFunding(base({ funds, x402Possible: false, price: null }))!.options[0]!;
  assert.deepEqual(fallback.args, { src_chain: "solana:mainnet", src_token: USDC_MINT, dst_token: "native", amount: "2000000" });
  assert.match(fallback.why, /around 200 USD per SOL \(Owed couldn't read a fresh price\)/);
});

test("a SOL payment that's short: swap USDC for SOL (checked with get_portfolio when its USDC wasn't read), another token, or buy SOL", () => {
  const sol = base({ sendUsdc: 0n, sendLamports: 500_000_000n, funds: { lamports: 100_000_000n, usdc: null, usdcAccount: null }, x402Possible: false });
  const plan = planFunding(sol)!;
  assert.deepEqual(optionKinds(plan), ["swap_usdc_for_sol", "swap_other", "buy_sol"]);
  assert.deepEqual(plan.shortfall, { token: "SOL", atomic: "403000000", display: "0.403 SOL" });
  assert.deepEqual(plan.have, [{ token: "SOL", atomic: "100000000", display: "0.1 SOL" }]);
  const [swap, , buy] = plan.options;
  const usdcIn = usdcForLamports(404_000_000n, PRICE);
  assert.deepEqual(swap!.args, { src_chain: "solana:mainnet", src_token: USDC_MINT, dst_token: "native", amount: usdcIn.toString() });
  assert.deepEqual(swap!.check?.args, { address: SENDER, network_id: MOONX_SOLANA, token: USDC_MINT });
  assert.deepEqual(buy!.args, { amount_usd: Number(`${centsForLamports(404_000_000n, PRICE) / 100n}.${(centsForLamports(404_000_000n, PRICE) % 100n).toString().padStart(2, "0")}`) });
  // Without a price the buy leaves the amount to the user.
  const noPrice = planFunding({ ...sol, price: null })!;
  assert.deepEqual(optionKinds(noPrice), ["swap_other", "buy_sol"]);
  assert.deepEqual(noPrice.options.at(-1)!.missing, ["amount_usd"]);
  assert.deepEqual(noPrice.options.at(-1)!.args, {});
});

// ---------------------------------------------------------------------------------------------- plan_id, text

test("plan_id: added to the plan and to every Owed step (so the final pay_link echoes it), never to PayBox steps", () => {
  const plan = withPlanId(planFunding(base({ funds: { lamports: 2_000_000n, usdc: 69_575_440n, usdcAccount: true } }))!, "P1anAbCdEfGh");
  assert.equal(plan.plan_id, "P1anAbCdEfGh");
  const steps = plan.options.flatMap((o) => [o, ...o.then, ...(o.check ? [o.check] : [])]);
  for (const s of steps) assert.equal(s.args.plan_id, s.via === "owed" ? "P1anAbCdEfGh" : undefined, `${s.tool}`);
  fundingPlanSchema.parse(plan);
});

test("recordPlan: posts the shortfall and option kinds (no balances), reuses a plan_id it is given, and gives up quietly", async () => {
  const plan = planFunding(base({ funds: { lamports: 5_211_577_354n, usdc: 0n, usdcAccount: false } }))!;
  const posted: unknown[] = [];
  const ok = makeDeps({ routes: { "POST /api/v1/plans": (c) => { posted.push(c.body); return json(201, { plan_id: "P1anAbCdEfGh", created_at: "2026-10-18T08:06:00Z" }); } } });
  const { callContext } = await import("../src/deps.ts");
  const recorded = await recordPlan(plan, callContext(ok.deps), undefined, 2000);
  assert.equal(recorded.plan_id, "P1anAbCdEfGh");
  assert.deepEqual(posted, [{
    tool: "pay_link", sender: SENDER, request_ids: ["JArQ6g9JvoWr"], shortfall: { token: "USDC", atomic: "15000000" },
    options: ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"],
  }]);
  const reused = await recordPlan(plan, callContext(ok.deps), "Ex1st1ngP1an", 2000);
  assert.equal(reused.plan_id, "Ex1st1ngP1an");
  assert.equal(posted.length, 1, "a later step of the same plan records nothing");
  const slow = makeDeps({ routes: { "POST /api/v1/plans": () => "hang" } });
  const started = Date.now();
  assert.equal((await recordPlan(plan, callContext(slow.deps), undefined, 100)).plan_id, null);
  assert.ok(Date.now() - started < 1000);
  for (const r of [() => json(429, { error: { code: "rate_limited", message: "slow down" } }), () => "network_error" as const, () => json(200, { plan_id: "nope" })]) {
    assert.equal((await recordPlan(plan, callContext(makeDeps({ routes: { "POST /api/v1/plans": r } }).deps), undefined, 1000)).plan_id, null);
  }
});

test("plan text: the reason, what is held and needed, numbered options with exact calls, the rules, then the JSON that parses back", () => {
  const plan = withPlanId(planFunding(base({ funds: { lamports: 5_211_577_354n, usdc: 0n, usdcAccount: false } }))!, "P1anAbCdEfGh");
  const text = planText(plan, { link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: SENDER }, ["Your wallet has 0 USDC; this request is 15 USDC. Nothing was sent."], [], ["Recipient: X"]);
  const lines = text.split("\n");
  assert.equal(lines[0], "Your wallet has 0 USDC; this request is 15 USDC. Nothing was sent.");
  assert.equal(lines[1], "The wallet holds 0 USDC and 5.211577354 SOL; this needs 15 USDC and 0.003 SOL (network fees included). Short: 15 USDC.");
  assert.match(lines[2]!, /^Owed can't move money or call PayBox tools/);
  assert.match(lines[3]!, /^1\. Swap SOL for USDC\. Check first: PayBox get_portfolio \{"address":"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM","network_id":1399811149,"token":"native"\}\. PayBox's holding check before a swap: use this option only if it shows at least 0\.153036196 SOL \(Owed read 5\.211577354 SOL just now\)\./);
  assert.match(lines[3]!, / Run PayBox request_swap \{"src_chain":"solana:mainnet","src_token":"native","dst_token":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"146996916"\} with the credential_id of wallet 9WzD…AWWM\./);
  assert.match(lines[3]!, /Then: Owed's pay_link through PayBox use_plugin \(wallet_id 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\) with the same arguments as this call, plus plan_id "P1anAbCdEfGh"\./);
  assert.match(lines[4]!, /^2\. Bring USDC over from Base\. Check first: PayBox get_portfolio \{"network_id":8453,"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"\}/);
  assert.match(lines[4]!, /with the credential_id of the user's PayBox Base wallet/);
  assert.match(lines[5]!, /^3\. Swap another token for USDC\./);
  assert.match(lines[5]!, /\(you fill in src_token and amount\)/);
  assert.match(lines[6]!, /^4\. Buy USDC with MoonPay\. Run PayBox get_buy_link \{"currency_code":"usdc_sol","amount_usd":15\}/);
  assert.match(text, /run PayBox check_operation_readiness with operation set to the arguments you're about to pass \(credential_id included\)/);
  assert.match(text, /The last step is always pay_link again with plan_id "P1anAbCdEfGh": it re-runs every check \(the request, the payee, sanctions and the balance\)/);
  assert.deepEqual(fundingPlanFromText(text), plan);
  assert.equal(fundingPlanFromText("no plan here"), null);
});

test("Base request hint: what to check and buy on Base, at least MoonPay's 4.99", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  assert.equal(baseFundingLine(15_000_000n, W),
    `If your Base wallet holds less than 15 USDC on Base (check with PayBox get_portfolio {"address":"${W}","network_id":8453,"token":"${BASE_USDC}"}), don't approve yet: run PayBox get_buy_link {"currency_code":"usdc_base","amount_usd":15} with that wallet's credential_id, using amount_usd = what it lacks rounded up to the cent if it holds some (at least 4.99, MoonPay's smallest purchase). The link moves no money; wait until get_portfolio shows at least 15 USDC, then call pay_link again.`);
  assert.match(baseFundingLine(10_000n, W), /"amount_usd":4\.99/);
});

test("every plan the planner makes fits the contract (and its own size limits)", () => {
  const all: PlanInput[] = [
    base({}), base({ funds: { lamports: 5_211_577_354n, usdc: 0n, usdcAccount: false } }), base({ price: null }),
    base({ funds: { lamports: 2_000_000n, usdc: 69_575_440n, usdcAccount: true } }), base({ x402Rail: true, sendUsdc: 20_000_000n, funds: { lamports: 0n, usdc: 1n, usdcAccount: true } }),
    base({ sendUsdc: 0n, sendLamports: 500_000_000n, funds: { lamports: 0n, usdc: null, usdcAccount: null }, x402Possible: false }),
    base({ payTool: "pay_all", payArgs: { sender: SENDER, ids: ["JArQ6g9JvoWr"], max_total: "15" }, x402Possible: false, sendLamports: 10_000_000n }),
    base({ requestIds: [], payArgs: { link: `solana:${RECIPIENT}?amount=1`, sender: SENDER }, x402Possible: false }),
  ];
  for (const i of all) {
    const plan = planFunding(i)!;
    assert.ok(plan, JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.deepEqual(fundingPlanSchema.parse(plan), plan);
    for (const o of plan.options) assert.equal(o.then.at(-1)?.tool ?? o.tool, i.payTool, `${o.kind} ends with ${i.payTool}`);
  }
});
