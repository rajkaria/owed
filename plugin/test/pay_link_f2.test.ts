import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { payerReadiness, readSolUsdPrice, type Rpc } from "../src/chain.ts";
import { fundingPlanSchema, type FundingPlan } from "../src/contract.ts";
import { fundingPlanFromText, PLAN_MARKER } from "../src/funding.ts";
import { toAtomic } from "../src/money.ts";
import { solanaOutputSchema, x402OutputSchema } from "../src/paybox.ts";
import { requestIdFor } from "../src/request-id.ts";
import { buildTransferUrl } from "../src/solana-pay.ts";
import { inputSchema, payLink, REFUSE_ALREADY_PAID, REFUSE_TAMPERED, REFUSE_X402_NO_ACCOUNT } from "../src/tools/pay_link.ts";
import { fixture, json, makeDeps, pinnedFixture, RECIPIENT, textOf, USDC_MINT, type Call, type Route } from "./helpers.ts";
import { dohFixture, dohRoutes } from "./payee-helpers.ts";

// F2 in pay_link, against recorded mainnet answers: real payerReadiness on captured accounts (test/fixtures/chain),
// Pyth's SOL/USD price from a captured account, Owed's server answered by a stand-in. Each row of the spec table,
// the refusals that must never get a plan, plan_id recording and echo.

interface RpcCall { method: string; params: unknown[]; result: unknown }
const chain = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RpcCall[]; query: { fresh?: string } };
const sns = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sns/${name}.json`, import.meta.url)), "utf8")) as { calls: RpcCall[] };
function replay(...calls: RpcCall[]): Rpc {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded call ${method} ${JSON.stringify(params).slice(0, 120)}`);
      return structuredClone(hit.result) as T;
    },
  };
}
/** A recorded readiness answer with the sender's lamports changed (the way chain.test.ts derives the fee cases). */
function withLamports(name: string, lamports: number): RpcCall[] {
  const calls = structuredClone(chain(name).calls);
  (calls[0]!.result as { value: Array<{ lamports: number }> }).value[0]!.lamports = lamports;
  return calls;
}

const PYTH = chain("pyth-sol-usd").calls;
const CAPTURED = Date.parse("2026-10-18T08:05:21Z");
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg"; // 5.211577354 SOL, no USDC account (captured)
const ACTIVE = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT"; // 69.57544 USDC and SOL (captured)
const EMPTY = chain("readiness-usdc-empty-sender").query.fresh!; // no SOL, no USDC account
const NO_ATA = chain("readiness-usdc-new-recipient").query.fresh!; // a wallet with no USDC account
const PLAN_ID = "P1anAbCdEfGh";

const paid = fixture("get-request.res.json"); // 15 USDC to the team wallet, JArQ6g9JvoWr
const open = { ...paid, status: "open", paid: null };
const ID = open.id as string;

const key = (label: string) => bs58.encode(createHash("sha256").update(`pay_link F2 test: ${label}`).digest());
/** An open Owed request built the way the server builds it (the id hashes its terms). */
function request(label: string, recipient: string, amount: string, token: "USDC" | "SOL" = "USDC", extra: Record<string, unknown> = {}) {
  const reference = key(label);
  const id = requestIdFor({ recipient, token, amountAtomic: toAtomic(amount, token), reference });
  const url = buildTransferUrl({ recipient, amount, references: [reference], ...(token === "USDC" && { splToken: USDC_MINT }), label: "Raj", message: label, memo: `owed:${id}` });
  return {
    id, kind: "single", recipient, amount, token, payer_name: null, for: label, note: null, requester_name: "Raj", status: "open", solana_pay_url: url,
    reference, x402_url: null, created_at: "2026-10-18T08:00:00Z", paid: null, flags: [], from_domain: null, chain: "solana", pay_url: url, ...extra,
  };
}

interface Setup { rpc: RpcCall[]; requests?: Array<{ id: string }>; routes?: Record<string, Route>; plans?: Route; now?: number }
function setup({ rpc, requests = [open], routes = {}, plans, now = CAPTURED }: Setup) {
  const posted: Call[] = [];
  const all: Record<string, Route> = {
    ...Object.fromEntries(requests.map((r) => [`GET /api/v1/requests/${r.id}`, () => json(200, r)])),
    "POST /api/v1/plans": plans ?? ((c) => { posted.push(c); return json(201, fixture("plans.create.res.json")); }),
    [`POST /api/v1/plans/${PLAN_ID}/used`]: (c) => { posted.push(c); return json(200, fixture("plans.used.res.json")); },
    ...routes,
  };
  const made = makeDeps({ routes: all, now: () => now, rpc: () => replay(...rpc, ...PYTH), payerReadiness, solUsdPrice: readSolUsdPrice });
  return { ...made, posted };
}
const pay = (sender: string, extra: Record<string, unknown> = {}) => inputSchema.parse({ link: `https://www.getowed.xyz/r/${ID}`, sender, ...extra });

type Result = Awaited<ReturnType<typeof payLink>>;
function planOf(r: Result): { plan: FundingPlan; text: string; lines: string[] } {
  assert.equal("isError" in r && r.isError, true, `expected a plan, got a proposal: ${textOf(r)}`);
  assert.equal("structuredContent" in r, false, "a plan is text only: the output schema is PayBox's proposal envelope");
  const text = textOf(r);
  const plan = fundingPlanFromText(text);
  assert.ok(plan, `no funding plan in: ${text}`);
  assert.deepEqual(fundingPlanSchema.parse(plan), plan);
  return { plan, text, lines: text.split("\n") };
}
function refused(r: Result): string {
  assert.equal("isError" in r && r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  const text = textOf(r);
  assert.ok(!text.includes(PLAN_MARKER), `a refused request got a plan: ${text}`);
  return text;
}
const kinds = (p: FundingPlan) => p.options.map((o) => o.kind);

// ---------------------------------------------------------------------------------------------- the table

test("USDC short, SOL above the fee reserve: plan = swap SOL for exactly the shortfall + 1%, recorded with Owed, then pay_link again", async () => {
  const { deps, rec, posted } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  const { plan, lines, text } = planOf(await payLink(pay(SOL_PAYER), deps));
  assert.equal(lines[0], "Your wallet has 0 USDC; this request is 15 USDC. Nothing was sent.");
  assert.equal(lines[1], "The wallet holds 0 USDC and 5.211577354 SOL; this needs 15 USDC and 0.003 SOL (network fees included). Short: 15 USDC.");
  assert.deepEqual(kinds(plan), ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"]);
  assert.equal(plan.plan_id, PLAN_ID);
  assert.deepEqual(plan.request_ids, [ID]);
  assert.deepEqual(plan.options[0]!.args, { src_chain: "solana:mainnet", src_token: "native", dst_token: USDC_MINT, amount: "146996916" });
  assert.deepEqual(plan.options[0]!.then.at(-1)!.args, { link: `https://www.getowed.xyz/r/${ID}`, sender: SOL_PAYER, plan_id: PLAN_ID });
  // The server learns the shortfall and which ways out were offered; never a balance.
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.body, {
    tool: "pay_link", sender: SOL_PAYER, request_ids: [ID], shortfall: { token: "USDC", atomic: "15000000" }, options: ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"],
  });
  assert.equal(rec.built.length, 0, "nothing is built while short");
  pinnedFixture("funding-plan.swap.json", { funding_plan: plan });
  pinnedFixture("plans.create.req.json", posted[0]!.body);
  // Requester text stays quoted and labelled, as in a proposal.
  assert.ok(lines.includes(`Paying 15 USDC to FN6G…cbvs. Requester's note, unverified: "dinner", "Thanks for coming!". Requester's name, unverified: "Raj".`), text);
  assert.ok(lines.includes(`Recipient: ${RECIPIENT}`));
});

test("USDC short, other tokens held: the plan says to read get_portfolio and swap from the token the user picks", async () => {
  const { deps } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  const { plan, text } = planOf(await payLink(pay(SOL_PAYER), deps));
  const other = plan.options.find((o) => o.kind === "swap_other")!;
  assert.deepEqual(other.args, { address: SOL_PAYER });
  assert.deepEqual(other.then[0]!.missing, ["src_token", "amount"]);
  assert.match(text, /3\. Swap another token for USDC\. Run PayBox get_portfolio \{"address":"ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg"\}/);
});

test("USDC on Base, not on Solana: a cross-chain request_swap from Base USDC to the sender's Solana wallet", async () => {
  const { deps } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  const bridge = planOf(await payLink(pay(SOL_PAYER), deps)).plan.options.find((o) => o.kind === "bridge_base_usdc")!;
  assert.deepEqual(bridge.args, {
    src_chain: "eip155:8453", src_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dst_chain: "solana:mainnet", dst_token: USDC_MINT, amount: "15150000", recipient: SOL_PAYER,
  });
  assert.equal(bridge.credential_of, "base_wallet");
});

test("nothing to swap: get_buy_link usdc_sol at MoonPay's 4.99 minimum (said why), get_portfolio, then pay over x402 (no SOL needed)", async () => {
  const small = request("nothing to swap", ACTIVE, "0.1");
  const { deps } = setup({ rpc: chain("readiness-usdc-empty-sender").calls, requests: [small] });
  const { plan, text } = planOf(await payLink(inputSchema.parse({ link: small.id, sender: EMPTY }), deps));
  assert.deepEqual(kinds(plan), ["bridge_base_usdc", "swap_other", "buy_usdc"], "no SOL to swap");
  assert.deepEqual(plan.have, [{ token: "USDC", atomic: "0", display: "0 USDC" }, { token: "SOL", atomic: "0", display: "0 SOL" }]);
  const buy = plan.options.at(-1)!;
  assert.deepEqual(buy.args, { currency_code: "usdc_sol", amount_usd: 4.99 });
  assert.match(buy.why, /The shortfall is 0\.1 USDC, but MoonPay's smallest purchase is 4\.99 USD, so the link asks for that/);
  assert.deepEqual(buy.then.map((s) => s.tool), ["get_portfolio", "pay_link"]);
  assert.deepEqual(buy.then[1]!.args, { link: small.id, sender: EMPTY, rail: "x402", plan_id: PLAN_ID });
  assert.match(text, /\n3\. Buy USDC with MoonPay\. Run PayBox get_buy_link \{"currency_code":"usdc_sol","amount_usd":4\.99\} with the credential_id of wallet A59x…zxbF\. The shortfall is 0\.1 USDC/);
  assert.match(text, /plus rail "x402" and plan_id "P1anAbCdEfGh"\. Over x402 \(rail "x402"\) the facilitator pays the network fee/);
  pinnedFixture("funding-plan.buy.json", { funding_plan: plan });
});

test("only the SOL fee short, recipient's USDC account exists: rail x402 first (no swap), then a small USDC→SOL swap, then buy SOL", async () => {
  const { deps, posted } = setup({ rpc: withLamports("readiness-usdc-existing-recipient", 2_000_000) });
  const { plan, lines } = planOf(await payLink(pay(ACTIVE), deps));
  assert.equal(lines[0], "Your wallet needs about 0.003 SOL for fees; it has 0.002 SOL. Nothing was sent.");
  assert.deepEqual(kinds(plan), ["x402", "swap_usdc_for_sol", "buy_sol"]);
  assert.deepEqual(plan.shortfall, { token: "SOL", atomic: "1000000", display: "0.001 SOL" });
  assert.deepEqual(plan.options[0]!.args, { link: `https://www.getowed.xyz/r/${ID}`, sender: ACTIVE, rail: "x402", plan_id: PLAN_ID });
  assert.match(lines.find((l) => l.startsWith("1. "))!, /^1\. Pay over x402 instead \(no SOL needed\)\. Call Owed's pay_link through PayBox use_plugin \(wallet_id FHpc\S+\) with the same arguments as this call, plus rail "x402" and plan_id "P1anAbCdEfGh"\./);
  assert.deepEqual(plan.options[1]!.args, { src_chain: "solana:mainnet", src_token: USDC_MINT, dst_token: "native", amount: "1041608" });
  assert.deepEqual(posted.map((c) => c.url.replace(/^https:\/\/[^/]+/, "")), ["/api/v1/plans"]);
  pinnedFixture("funding-plan.fee.json", { funding_plan: plan });

  // Following option 1: the same call with rail "x402" and the plan_id proposes the x402 payment and tells Owed.
  const challenge = () => {
    const accepts = [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "15000000", asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300 }];
    return new Response(JSON.stringify({ x402Version: 1, accepts: accepts.map(({ amount, network: _n, ...a }) => ({ ...a, network: "solana", maxAmountRequired: amount })) }), {
      status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") },
    });
  };
  const next = setup({ rpc: withLamports("readiness-usdc-existing-recipient", 2_000_000), routes: { [`GET /x/${ID}`]: challenge } });
  const r = await payLink(inputSchema.parse(plan.options[0]!.args), next.deps);
  assert.ok(!("isError" in r && r.isError), textOf(r));
  assert.equal(x402OutputSchema.parse((r as { structuredContent: unknown }).structuredContent)["io.paybox/transactionProposal"].kind, "x402");
  assert.deepEqual(next.posted.map((c) => [c.url.replace(/^https:\/\/[^/]+/, ""), c.body]), [[`/api/v1/plans/${PLAN_ID}/used`, { sender: ACTIVE }]]);
  pinnedFixture("plans.used.req.json", next.posted[0]!.body);
});

test("only the SOL fee short, recipient has no USDC account (x402 can't open one): a small USDC→SOL swap or buy SOL", async () => {
  const toNoAta = request("fee short no account", NO_ATA, "1");
  const { deps } = setup({ rpc: withLamports("readiness-usdc-new-recipient", 0), requests: [toNoAta] });
  const { plan } = planOf(await payLink(inputSchema.parse({ link: toNoAta.id, sender: ACTIVE }), deps));
  assert.deepEqual(kinds(plan), ["swap_usdc_for_sol", "buy_sol"]);
  assert.deepEqual(plan.options[1]!.args, { amount_usd: 4.99 });
  // Asked over x402 anyway: refused with the Solana Pay alternative before anyone funds anything.
  const x = setup({ rpc: withLamports("readiness-usdc-new-recipient", 0), requests: [toNoAta] });
  assert.equal(refused(await payLink(inputSchema.parse({ link: toNoAta.id, sender: ACTIVE, rail: "x402" }), x.deps)), REFUSE_X402_NO_ACCOUNT);
  assert.equal(x.posted.length, 0);
});

test("a Solana Pay link that isn't an Owed request: a plan with no request ids and no x402 option", async () => {
  const link = `solana:${RECIPIENT}?amount=7&spl-token=${USDC_MINT}&reference=${key("raw link reference")}`;
  const { deps, posted } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  const { plan } = planOf(await payLink(inputSchema.parse({ link, sender: SOL_PAYER }), deps));
  assert.deepEqual(plan.request_ids, []);
  assert.equal(kinds(plan).includes("x402"), false);
  assert.deepEqual((posted[0]!.body as { request_ids: unknown }).request_ids, []);
});

test("Base request: the proposal says how to fund a short Base wallet (get_buy_link usdc_base, the amount)", async () => {
  const base = { ...fixture("base.get-request.res.json"), status: "open", paid: null };
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "500000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: base.recipient, maxTimeoutSeconds: 300 }];
  const { deps } = makeDeps({
    routes: {
      [`GET /api/v1/requests/${base.id}`]: () => json(200, base),
      [`GET /x/${base.id}`]: () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } }),
    },
  });
  const wallet = "0x52908400098527886E0F7030069857D2E4169EE7"; // the payer's PayBox Base wallet (an EIP-55 test vector)
  const r = await payLink(inputSchema.parse({ link: base.id, sender: wallet }), deps);
  assert.ok(!("isError" in r && r.isError), textOf(r));
  assert.equal(base.amount, "0.5", "fixture: 0.5 USDC on Base");
  assert.match(textOf(r), /If your Base wallet holds less than 0\.5 USDC on Base \(check with PayBox get_portfolio \{"address":"0x52908400098527886E0F7030069857D2E4169EE7","network_id":8453,"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"\}\), don't approve yet: run PayBox get_buy_link \{"currency_code":"usdc_base","amount_usd":4\.99\}/);
});

// ---------------------------------------------------------------------------------------------- never a plan

test("refused requests never get a plan, even from a wallet that would get one: paid, cancelled, expired, tampered", async () => {
  const cases: Array<[unknown, string | RegExp]> = [
    [paid, REFUSE_ALREADY_PAID],
    [{ ...open, status: "cancelled" }, "This request was cancelled by the requester."],
    [{ ...open, expires_at: "2026-10-18T08:00:00Z" }, /expired at 2026-10-18T08:00:00Z/],
    [{ ...open, amount: "1.5" }, /payment link that doesn't match the request|details don't match its id/],
    [{ ...open, reference: key("swapped reference") }, REFUSE_TAMPERED],
  ];
  for (const [body, want] of cases) {
    const { deps, posted, rec } = setup({ rpc: chain("readiness-usdc-empty-sender").calls, requests: [{ ...(body as object), id: ID }] });
    const text = refused(await payLink(pay(EMPTY), deps));
    if (typeof want === "string") assert.equal(text, want);
    else assert.match(text, want);
    assert.equal(posted.length, 0, "nothing recorded");
    assert.equal(rec.readiness.length, 0, "refused before the balance is read");
  }
});

test("refused requests never get a plan: a sanctioned recipient, a domain that doesn't list the wallet, an .sns name that moved", async () => {
  const empty = chain("readiness-usdc-empty-sender").calls;
  const toActive = request("sanctions and DNS", ACTIVE, "0.1");
  // Sanctions: the recipient is on the list (the screen runs beside the balance read and wins).
  const listed = setup({ rpc: empty, requests: [toActive] });
  listed.deps.screenRecipient = async () => ({ ok: false, message: "This address is on the U.S. Treasury's OFAC SDN list (sanctions)." });
  assert.match(refused(await payLink(inputSchema.parse({ link: toActive.id, sender: EMPTY }), listed.deps)), /sanctions\)\. Nothing was sent\.$/);
  assert.equal(listed.posted.length, 0);
  // DNS: the request claims example.com, which publishes no Owed record for the wallet.
  const dns = setup({ rpc: empty, requests: [{ ...toActive, from_domain: "example.com" }], routes: dohRoutes(dohFixture("nodata-signed")) });
  assert.match(refused(await payLink(inputSchema.parse({ link: toActive.id, sender: EMPTY }), dns.deps)), /does not publish this wallet/);
  assert.equal(dns.posted.length, 0);
  // SNS: a request for bonfida.sns that pays the team wallet, while the name points to Bonfida's wallet.
  const moved = { ...open, sns_name: "bonfida.sns", sns_source: "owner", sns_resolved_at: "2026-10-17T07:00:00Z" };
  const name = setup({ rpc: [...chain("readiness-usdc-sol-only-sender").calls, ...sns("bonfida").calls], requests: [moved] });
  assert.match(refused(await payLink(pay(SOL_PAYER), name.deps)), /^bonfida\.sns now points to a different wallet than when this request was made/);
  assert.equal(name.posted.length, 0);
});

test("never a plan for what funding can't fix: a frozen USDC account, a first SOL payment below rent", async () => {
  const frozen = structuredClone(chain("readiness-usdc-existing-recipient").calls);
  const v = (frozen[0]!.result as { value: Array<{ lamports: number; data: { parsed: { info: { state: string } } } }> }).value;
  v[1]!.data.parsed.info.state = "frozen";
  v[0]!.lamports = 0; // also short of SOL: the frozen account still wins
  const f = setup({ rpc: frozen });
  assert.equal(refused(await payLink(pay(ACTIVE), f.deps)), "Your USDC account is frozen, so it cannot send.");
  const fresh = chain("readiness-sol-new-recipient");
  const sol = request("below rent", fresh.query.fresh!, "0.0001", "SOL");
  const r = setup({ rpc: fresh.calls, requests: [sol] }); // the SOL fixtures' payer is SOL_PAYER (29.29 SOL then)
  assert.match(refused(await payLink(inputSchema.parse({ link: sol.id, sender: SOL_PAYER }), r.deps)), /first payment must be at least 0\.00065024 SOL/);
  assert.equal(f.posted.length + r.posted.length, 0);
});

test("a request with the requester's X handle: the handle check comes before every funding step", async () => {
  const withHandle = { ...open, requester_handle: "rajkaria" };
  const { deps } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls, requests: [withHandle] });
  const { lines } = planOf(await payLink(pay(SOL_PAYER), deps));
  const check = lines.findIndex((l) => l.startsWith("First, before any step: this request says it is from @rajkaria (not verified by Owed)."));
  assert.ok(check > 0, lines.join("\n"));
  assert.equal(lines[check], `First, before any step: this request says it is from @rajkaria (not verified by Owed). Call PayBox resolve_username('@rajkaria'); if its Solana address isn't ${RECIPIENT}, tell the user and stop: don't fund or pay it.`);
  assert.ok(check < lines.findIndex((l) => l.startsWith("1. ")), "before option 1");
});

test("a brand-word caution leads the plan, as it leads a proposal", async () => {
  const cautioned = request("PayBox support refund", ACTIVE, "0.1");
  const { deps } = setup({ rpc: chain("readiness-usdc-empty-sender").calls, requests: [cautioned] });
  const { lines } = planOf(await payLink(inputSchema.parse({ link: cautioned.id, sender: EMPTY }), deps));
  assert.match(lines[0]!, /^Caution: .*PayBox/);
});

// ---------------------------------------------------------------------------------------------- plan_id

test("plan_id: a funded wallet's proposal echoes it to Owed; without one nothing is sent; a slow server can't hold the proposal", async () => {
  const funded = chain("readiness-usdc-existing-recipient").calls;
  const a = setup({ rpc: funded });
  const r = await payLink(pay(ACTIVE, { plan_id: PLAN_ID }), a.deps);
  solanaOutputSchema.parse((r as { structuredContent: unknown }).structuredContent);
  assert.deepEqual(a.posted.map((c) => [c.method, c.url.replace(/^https:\/\/[^/]+/, ""), c.body]), [["POST", `/api/v1/plans/${PLAN_ID}/used`, { sender: ACTIVE }]]);
  const b = setup({ rpc: funded });
  await payLink(pay(ACTIVE), b.deps);
  assert.equal(b.posted.length, 0);
  const c = setup({ rpc: funded, routes: { [`POST /api/v1/plans/${PLAN_ID}/used`]: () => "hang" } });
  const started = Date.now();
  const slow = await payLink(pay(ACTIVE, { plan_id: PLAN_ID }), c.deps);
  assert.ok(Date.now() - started < 2500, "bounded by its 1.5 s budget");
  solanaOutputSchema.parse((slow as { structuredContent: unknown }).structuredContent);
  for (const down of [() => "network_error" as const, () => json(404, { error: { code: "not_found", message: "no such plan" } })]) {
    const d = setup({ rpc: funded, routes: { [`POST /api/v1/plans/${PLAN_ID}/used`]: down } });
    solanaOutputSchema.parse(((await payLink(pay(ACTIVE, { plan_id: PLAN_ID }), d.deps)) as { structuredContent: unknown }).structuredContent);
  }
});

test("plan_id: still short on a later step, the plan keeps its plan_id and records nothing new", async () => {
  const { deps, posted } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  const { plan } = planOf(await payLink(pay(SOL_PAYER, { plan_id: "Ex1st1ngP1an" }), deps));
  assert.equal(plan.plan_id, "Ex1st1ngP1an");
  assert.equal(posted.length, 0);
  assert.equal(plan.options[0]!.then.at(-1)!.args.plan_id, "Ex1st1ngP1an");
});

test("plan_id: Owed's server slow or refusing (rate limit) → the plan still goes out, without a plan_id, inside the budget", async () => {
  for (const plans of [() => "hang" as const, () => json(429, { error: { code: "rate_limited", message: "too many plans" } })]) {
    const { deps } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls, plans });
    const started = Date.now();
    const { plan, text } = planOf(await payLink(pay(SOL_PAYER), deps));
    assert.ok(Date.now() - started < 3000);
    assert.equal(plan.plan_id, null);
    assert.equal(plan.options[0]!.then.at(-1)!.args.plan_id, undefined);
    assert.match(text, /The last step is always pay_link again: it re-runs every check/);
  }
});

test("no fresh SOL price (Pyth unreachable): the SOL swap is still offered, with amount for the agent to fill in", async () => {
  const { deps } = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls });
  deps.solUsdPrice = async () => { throw new Error("rpc down"); };
  const swap = planOf(await payLink(pay(SOL_PAYER), deps)).plan.options[0]!;
  assert.equal(swap.kind, "swap_sol");
  assert.deepEqual(swap.missing, ["amount"]);
  // A stale price (an hour after Pyth published it) is treated the same way.
  const late = setup({ rpc: chain("readiness-usdc-sol-only-sender").calls, now: CAPTURED + 3600_000 });
  assert.deepEqual(planOf(await payLink(pay(SOL_PAYER), late.deps)).plan.options[0]!.missing, ["amount"]);
});

test("plan_id is a 12-character base58 id or nothing", () => {
  assert.equal(inputSchema.safeParse({ link: ID, sender: ACTIVE, plan_id: "short" }).success, false);
  assert.equal(inputSchema.safeParse({ link: ID, sender: ACTIVE, plan_id: "P1anAbCdEfG0" }).success, false, "0 isn't base58");
  assert.equal(inputSchema.parse({ link: ID, sender: ACTIVE, plan_id: PLAN_ID }).plan_id, PLAN_ID);
});
