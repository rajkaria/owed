import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { readBatchAccounts, readSolUsdPrice, type BatchAccounts, type Rpc } from "../src/chain.ts";
import { fundingPlanSchema, type FundingPlan } from "../src/contract.ts";
import { fundingPlanFromText, lamportsForUsdc, PLAN_MARKER, usablePrice } from "../src/funding.ts";
import { toAtomic } from "../src/money.ts";
import { solanaOutputSchema } from "../src/paybox.ts";
import { requestIdFor } from "../src/request-id.ts";
import { buildTransferUrl } from "../src/solana-pay.ts";
import { inputSchema, payAll } from "../src/tools/pay_all.ts";
import { fixture, json, makeDeps, pinnedFixture, RECIPIENT, SENDER, textOf, USDC_MINT, type Call, type Route } from "./helpers.ts";

// F2 in pay_all: the funding plan covers exactly the requests that passed every check (skipped and cautioned ones
// never), pays them with pay_all again, is one Solana Pay transaction (no x402 option), and echoes plan_id.
// The batch read is the real readBatchAccounts on a captured mainnet answer.

interface RpcCall { method: string; params: unknown[]; result: unknown }
const chain = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RpcCall[] };
function replay(...calls: RpcCall[]): Rpc {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded call ${method} ${JSON.stringify(params).slice(0, 120)}`);
      return structuredClone(hit.result) as T;
    },
  };
}
const PYTH = chain("pyth-sol-usd").calls;
const CAPTURED = Date.parse("2026-10-18T08:05:21Z");
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg"; // 5.211577354 SOL, no USDC account (captured)
const PLAN_ID = "P1anAbCdEfGh";

const key = (label: string) => bs58.encode(createHash("sha256").update(`pay_all F2 test: ${label}`).digest());
function request(label: string, { recipient = RECIPIENT, amount = "0.05", token = "USDC" as "USDC" | "SOL", ...extra }: Record<string, unknown> = {}) {
  const reference = key(`reference ${label}`);
  const tok = token as "USDC" | "SOL";
  const id = requestIdFor({ recipient: recipient as string, token: tok, amountAtomic: toAtomic(amount as string, tok), reference });
  const url = buildTransferUrl({ recipient: recipient as string, amount: amount as string, references: [reference], ...(tok === "USDC" && { splToken: USDC_MINT }), label: "Raj", message: label, memo: `owed:${id}` });
  return {
    id, kind: "single", recipient, amount, token: tok, payer_name: null, for: label, note: null, requester_name: "Raj", status: "open",
    solana_pay_url: url, reference, x402_url: null, created_at: "2026-10-18T08:00:00Z", paid: null, flags: [], from_domain: null, chain: "solana", pay_url: url, ...extra,
  };
}
type Req = ReturnType<typeof request>;

function setup(requests: Array<Req | Record<string, unknown>>, over: { accounts?: () => Promise<BatchAccounts>; plans?: Route } = {}) {
  const posted: Call[] = [];
  const made = makeDeps({
    now: () => CAPTURED,
    rpc: () => replay(...chain("readiness-usdc-sol-only-sender").calls, ...PYTH),
    solUsdPrice: readSolUsdPrice,
    ...(over.accounts ? { readBatchAccounts: over.accounts } : { readBatchAccounts }),
    routes: {
      "GET *": (c) => {
        const ids = (new URL(c.url).searchParams.get("ids") ?? "").split(",");
        return json(200, { requests: ids.map((id) => requests.find((r) => r.id === id)).filter(Boolean), not_found: ids.filter((id) => !requests.some((r) => r.id === id)) });
      },
      "POST /api/v1/plans": over.plans ?? ((c) => { posted.push(c); return json(201, fixture("plans.create.res.json")); }),
      [`POST /api/v1/plans/${PLAN_ID}/used`]: (c) => { posted.push(c); return json(200, fixture("plans.used.res.json")); },
    },
  });
  return { ...made, posted };
}
type Out = Awaited<ReturnType<typeof payAll>>;
function planOf(r: Out): { plan: FundingPlan; lines: string[] } {
  assert.equal("isError" in r && r.isError, true, `expected a plan, got: ${textOf(r)}`);
  const plan = fundingPlanFromText(textOf(r));
  assert.ok(plan, textOf(r));
  assert.deepEqual(fundingPlanSchema.parse(plan), plan);
  return { plan, lines: textOf(r).split("\n") };
}

test("pay_all short of USDC (recorded wallet: SOL, no USDC): a plan for the batch total, ending with pay_all again", async () => {
  const a = request("climbing a", { amount: "0.1" });
  const b = request("climbing b", { amount: "0.1" });
  const { deps, posted, rec } = setup([a, b]);
  const args = { sender: SOL_PAYER, ids: [a.id, b.id], max_total: "0.2" };
  const { plan, lines } = planOf(await payAll(inputSchema.parse(args), deps));
  assert.equal(lines[0], "Your wallet has 0 USDC; these 2 requests total 0.2 USDC. Nothing was sent.");
  assert.equal(plan.pay_tool, "pay_all");
  assert.deepEqual(plan.request_ids, [a.id, b.id]);
  assert.deepEqual(plan.options.map((o) => o.kind), ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"], "one Solana Pay transaction: never x402");
  const price = usablePrice({ price: 10_309_642_626n, conf: 3_303_936n, expo: -8, publishTime: 1_792_310_674 }, CAPTURED)!;
  assert.equal(plan.options[0]!.args.amount, lamportsForUsdc(200_000n, price).toString());
  for (const o of plan.options) assert.deepEqual(o.then.at(-1)!.args, { ...args, plan_id: PLAN_ID });
  assert.deepEqual(posted.map((c) => c.body), [{ tool: "pay_all", sender: SOL_PAYER, request_ids: [a.id, b.id], shortfall: { token: "USDC", atomic: "200000" }, options: ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"] }]);
  assert.ok(lines.includes(`The plan covers these 2 requests (0.2 USDC), the ones that passed every check:`));
  assert.equal(rec.built.length, 0);
  pinnedFixture("funding-plan.pay-all.json", { funding_plan: plan });
});

test("pay_all: skipped requests (paid, Base, a brand caution) are never in the plan; a named cautioned one is", async () => {
  const good = request("good", { amount: "0.1" });
  const cautioned = request("PayBox support fee", { amount: "0.1" });
  const paid = { ...request("paid"), status: "paid", paid: { signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", payer: SENDER, amount: "0.05", at: "2026-10-18T08:01:00Z", rail: "solana_pay" } };
  const base = { ...fixture("base.get-request.res.json"), status: "open", paid: null };
  const ids = [good.id, cautioned.id, paid.id, base.id as string];
  const { deps, posted } = setup([good, cautioned, paid, base]);
  const { plan, lines } = planOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids, max_total: "1" }), deps));
  assert.deepEqual(plan.request_ids, [good.id]);
  assert.deepEqual(plan.shortfall, { token: "USDC", atomic: "100000", display: "0.1 USDC" });
  assert.deepEqual((posted[0]!.body as { request_ids: string[] }).request_ids, [good.id]);
  for (const id of [cautioned.id, paid.id, base.id]) assert.ok(lines.some((l) => l.startsWith(`- Skipped ${id}:`)), `${id} listed as skipped`);
  // The user named the cautioned one: it is in the plan, with its caution.
  const named = setup([good, cautioned]);
  const withIt = planOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [good.id, cautioned.id], max_total: "1", include_cautioned: true }), named.deps));
  assert.deepEqual(withIt.plan.request_ids, [good.id, cautioned.id]);
  assert.ok(withIt.lines.some((l) => l.includes(`request ${cautioned.id}`) && l.includes(`Caution: it mentions "PayBox"; included because the user named it.`)), withIt.lines.join("\n"));
});

test("pay_all: above max_total, a frozen account or a below-rent SOL payment refuses with no plan", async () => {
  const a = request("max a", { amount: "0.1" });
  const b = request("max b", { amount: "0.1" });
  const over = setup([a, b]);
  const text = textOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [a.id, b.id], max_total: "0.1" }), over.deps));
  assert.match(text, /above max_total 0\.1 USDC\. Nothing was sent/);
  assert.ok(!text.includes(PLAN_MARKER));
  const frozen = setup([a], { accounts: async () => ({ senderLamports: 0n, senderUsdc: 0n, senderUsdcFrozen: true, senderUsdcAccount: true, usdcAccounts: new Map([[RECIPIENT, { exists: true, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null }) });
  const f = textOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [a.id], max_total: "1" }), frozen.deps));
  assert.equal(f, "Your USDC account is frozen, so it cannot send. Nothing was sent.");
  const fresh = key("never used wallet");
  const sol = request("sol below rent", { recipient: fresh, token: "SOL", amount: "0.0001" });
  const rent = setup([sol], { accounts: async () => ({ senderLamports: 0n, senderUsdc: 0n, senderUsdcFrozen: false, senderUsdcAccount: false, usdcAccounts: new Map(), newSolWallets: new Set([fresh]), rentMinimum: 890_880n }) });
  const r = textOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [sol.id], max_total: "1", max_total_sol: "1" }), rent.deps));
  assert.match(r, /has never been used, so the first payment to it must be at least 0\.00089088 SOL\. Nothing was sent\.$/);
  assert.equal(over.posted.length + frozen.posted.length + rent.posted.length, 0);
});

test("pay_all: every request's handle check comes before the funding steps", async () => {
  const a = request("handle a", { amount: "0.1", requester_handle: "rajkaria" });
  const b = request("handle b", { amount: "0.1", requester_handle: "lena_s" });
  const { deps } = setup([a, b]);
  const { lines } = planOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [a.id, b.id], max_total: "1" }), deps));
  const first = lines.findIndex((l) => l.startsWith("1. "));
  for (const [id, h] of [[a.id, "rajkaria"], [b.id, "lena_s"]]) {
    const at = lines.indexOf(`First, before any step: request ${id} says it is from @${h} (not verified by Owed). Call PayBox resolve_username('@${h}'); if its Solana address isn't ${RECIPIENT}, tell the user and stop: don't fund or pay it.`);
    assert.ok(at > 0 && at < first, `${h} before option 1`);
  }
});

test("pay_all short of SOL for its SOL requests (USDC read): an exact USDC→SOL swap, another token, or buy SOL", async () => {
  const sol = request("sol share", { recipient: key("sol friend"), token: "SOL", amount: "0.5" });
  const { deps } = setup([sol], {
    accounts: async () => ({ senderLamports: 100_000_000n, senderUsdc: 80_000_000n, senderUsdcFrozen: false, senderUsdcAccount: true, usdcAccounts: new Map(), newSolWallets: new Set(), rentMinimum: null }),
  });
  const { plan } = planOf(await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [sol.id], max_total: "1", max_total_sol: "1" }), deps));
  assert.deepEqual(plan.shortfall, { token: "SOL", atomic: "403000000", display: "0.403 SOL" });
  assert.deepEqual(plan.options.map((o) => o.kind), ["swap_usdc_for_sol", "swap_other", "buy_sol"]);
  assert.match(plan.options[0]!.check!.why, /\(Owed read 80 USDC just now\)\.$/, "PayBox's holding check, with what the batch read saw");
  assert.equal(plan.options[0]!.args.dst_token, "native");
});

test("pay_all: plan_id is echoed when the funded call proposes the transaction", async () => {
  const a = request("echo", { amount: "0.1" });
  const { deps, posted } = setup([a], { accounts: async () => ({ senderLamports: 1_000_000_000n, senderUsdc: 1_000_000n, senderUsdcFrozen: false, senderUsdcAccount: true, usdcAccounts: new Map([[RECIPIENT, { exists: true, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null }) });
  const r = await payAll(inputSchema.parse({ sender: SOL_PAYER, ids: [a.id], max_total: "1", plan_id: PLAN_ID }), deps);
  solanaOutputSchema.parse((r as { structuredContent: unknown }).structuredContent);
  assert.deepEqual(posted.map((c) => [c.url.replace(/^https:\/\/[^/]+/, ""), c.body]), [[`/api/v1/plans/${PLAN_ID}/used`, { sender: SOL_PAYER }]]);
});
