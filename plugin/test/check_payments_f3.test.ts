import { test } from "node:test";
import assert from "node:assert/strict";
import { BANK_TRANSFER_LABEL, CARD_LABEL, checkPayments, outputSchema, type CheckOutput } from "../src/tools/check_payments.ts";
import { fixture, json, makeDeps } from "./helpers.ts";

// F3 bank rail in check_payments: a request paid by bank transfer to the recipient's MoonPay account (rail
// "bank_transfer", a new value that only ever appears on bank-paid requests) says so in paid_via; card payments
// through MoonPay say so too; every other rail reads exactly as before.

const status = fixture("status.res.json");
const ID = "JArQ6g9JvoWr";

async function run(rail: string | undefined) {
  const results = status.results.map((r: Record<string, unknown>) => (r.id === ID && rail ? { ...r, rail } : r));
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, { results }), "GET *": () => new Response("<html>404</html>", { status: 404 }) } });
  const o = outputSchema.parse((await checkPayments({ requests: [ID] }, deps) as { structuredContent: CheckOutput }).structuredContent);
  return o.results[0]!;
}

test("rail bank_transfer: paid_via names the bank transfer through MoonPay", async () => {
  const r = await run("bank_transfer");
  assert.equal(r.status, "paid");
  assert.equal(r.paid_via, BANK_TRANSFER_LABEL);
  assert.match(r.paid_via!, /bank transfer/);
});

test("rail moonpay_card: paid_via names the card; solana_pay and no rail: no paid_via", async () => {
  assert.equal((await run("moonpay_card")).paid_via, CARD_LABEL);
  assert.equal((await run("solana_pay")).paid_via, undefined);
  assert.equal((await run(undefined)).paid_via, undefined);
});
