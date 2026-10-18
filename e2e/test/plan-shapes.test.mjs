// F2: contract/shapes.mjs holds funding plans to what makes them safe to follow: every option ends with the same pay
// call for the same sender carrying the plan_id, swaps go where they say, a bridge lands in the sender's own Solana
// wallet after a get_portfolio check, buy links ask for whole cents of at least MoonPay's 4.99, x402 only fixes a fee
// on pay_link, and every amount's display says exactly its atomic value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check, shapes } from "../../contract/shapes.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errors = (doc) => check(shapes.fundingPlanDoc, doc).errors;
const SWAP = fixture("funding-plan.swap.json");
const FEE = fixture("funding-plan.fee.json");
const ALL = fixture("funding-plan.pay-all.json");
function edit(doc, fn) {
  const copy = structuredClone(doc);
  fn(copy.funding_plan);
  return copy;
}

test("the recorded plans pass", () => {
  for (const name of ["funding-plan.swap.json", "funding-plan.buy.json", "funding-plan.fee.json", "funding-plan.pay-all.json"]) {
    assert.deepEqual(check(shapes.fundingPlanDoc, fixture(name)), { errors: [], warnings: [] }, name);
  }
});

test("every option must end with the same pay call, for the plan's sender, carrying its plan_id", () => {
  assert.match(errors(edit(SWAP, (p) => { p.options[0].then.at(-1).args.sender = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; })).join(), /pays from another wallet/);
  assert.match(errors(edit(SWAP, (p) => { delete p.options[1].then.at(-1).args.plan_id; })).join(), /doesn't carry the plan_id/);
  assert.match(errors(edit(SWAP, (p) => { p.options[2].then.pop(); })).join(), /doesn't end with pay_link/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].then.at(-1).tool = "ask_for_money"; })).join(), /doesn't end with pay_link|calls Owed's ask_for_money/);
  assert.match(errors(edit(ALL, (p) => { p.options[0].then.at(-1).args.rail = "x402"; })).join(), /pay_all has no rail/);
  assert.deepEqual(errors(edit(SWAP, (p) => { p.plan_id = null; for (const o of p.options) delete o.then.at(-1).args.plan_id; })), [], "a plan the server didn't record has no id anywhere");
});

test("swaps, bridges and buy links say exactly what the plan says they do", () => {
  assert.match(errors(edit(SWAP, (p) => { p.options[0].args.dst_token = "So11111111111111111111111111111111111111112"; })).join(), /dst_token/);
  assert.match(errors(edit(SWAP, (p) => { delete p.options[0].args.amount; })).join(), /amount: a positive atomic amount, or listed in missing/);
  assert.deepEqual(errors(edit(SWAP, (p) => { delete p.options[0].args.amount; p.options[0].missing = ["amount"]; })), []);
  assert.match(errors(edit(SWAP, (p) => { p.options[1].args.recipient = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; })).join(), /recipient/);
  assert.match(errors(edit(SWAP, (p) => { delete p.options[1].check; })).join(), /get_portfolio checks first/);
  assert.match(errors(edit(SWAP, (p) => { p.options[1].credential_of = p.sender; })).join(), /Base wallet/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].args.amount_usd = 1; })).join(), /at least 4\.99/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].args.amount_usd = 15.005; })).join(), /whole cents/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].args.amount_usd = "15"; })).join(), /whole cents/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].args.currency_code = "usdc_base"; })).join(), /usdc_sol/);
  assert.match(errors(edit(FEE, (p) => { p.options[2].args.currency_code = "sol"; })).join(), /native SOL takes no currency_code/);
  assert.match(errors(edit(SWAP, (p) => { p.options[3].tool = "request_swap"; })).join(), /expected get_buy_link/);
});

test("x402 only fixes a fee, only on pay_link; kinds and request ids don't repeat; displays match atomics", () => {
  assert.match(errors(edit(FEE, (p) => { p.options[0].args.rail = "solana_pay"; })).join(), /pays with rail x402/);
  assert.match(errors(edit(FEE, (p) => { p.shortfall = { token: "USDC", atomic: "1", display: "0.000001 USDC" }; })).join(), /only fixes a SOL \(fee\) shortfall/);
  assert.match(errors(edit(FEE, (p) => { p.options.push(structuredClone(p.options[1])); })).join(), /lists a kind twice/);
  assert.match(errors(edit(ALL, (p) => { p.request_ids.push(p.request_ids[0]); })).join(), /lists an id twice/);
  assert.match(errors(edit(ALL, (p) => { p.request_ids = []; })).join(), /names its requests/);
  assert.match(errors(edit(SWAP, (p) => { p.have[1].display = "5.2 SOL"; })).join(), /is not "5\.211577354 SOL"/);
  assert.match(errors(edit(SWAP, (p) => { p.shortfall.atomic = "0"; p.shortfall.display = "0 USDC"; })).join(), /something short/);
  assert.match(errors(edit(SWAP, (p) => { p.need = []; })).join(), /doesn't cover the USDC shortfall/);
});

test("plan API bodies: unknown kinds, repeats and non-positive shortfalls are refused; stats can't count more used or paid than offered", () => {
  const req = fixture("plans.create.req.json");
  assert.deepEqual(check(shapes.createPlanReq, req).errors, []);
  assert.ok(check(shapes.createPlanReq, { ...req, options: ["teleport"] }).errors.length);
  assert.ok(check(shapes.createPlanReq, { ...req, options: ["buy_usdc", "buy_usdc"] }).errors.length);
  assert.ok(check(shapes.createPlanReq, { ...req, shortfall: { token: "USDC", atomic: "0" } }).errors.length);
  assert.ok(check(shapes.createPlanReq, { ...req, tool: "pay_all", request_ids: [] }).errors.length);
  assert.deepEqual(check(shapes.createPlanReq, { ...req, request_ids: [] }).errors, [], "a link that isn't an Owed request");
  assert.ok(check(shapes.planStatsRes, { offered: 1, used: 2, paid: 0, since: "2026-10-18T00:00:00Z" }).errors.length);
  assert.ok(check(shapes.planStatsRes, { offered: 1, used: 1, paid: 2, since: "2026-10-18T00:00:00Z" }).errors.length);
});
