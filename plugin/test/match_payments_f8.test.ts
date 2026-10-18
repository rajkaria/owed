import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPayments, outputSchema, overpaidOf, type MatchOutput } from "../src/tools/match_payments.ts";
import { fixture, json, makeDeps, RECIPIENT, textOf } from "./helpers.ts";
import * as money from "../src/money.ts";

// F8 invoices in match_payments: a request that received more than it asked is listed as overpaid, with the
// refund_payment call that sends the difference back to the payer.

const paid = { ...fixture("get-request.res.json"), status: "paid" };

test("overpaidOf: only a paid amount above the request's, and the exact difference", () => {
  const x = { id: "JArQ6g9JvoWr", link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", token: "USDC" as const, amount: "15" };
  assert.deepEqual(overpaidOf({ ...x, amountPaid: "15.5" }, RECIPIENT, money), {
    request_id: "JArQ6g9JvoWr", request_link: x.link, token: "USDC", amount: "15", amount_paid: "15.5", difference: "0.5",
    refund: { tool: "refund_payment", args: { link: x.link, recipient: RECIPIENT, amount: "0.5" } },
  });
  assert.equal(overpaidOf({ ...x, amountPaid: "15" }, RECIPIENT, money), null);
  assert.equal(overpaidOf({ ...x, amountPaid: "14" }, RECIPIENT, money), null);
  assert.equal(overpaidOf({ ...x, amountPaid: undefined }, RECIPIENT, money), null);
});

test("find on an overpaid request offers a refund of the difference, text and call", async () => {
  const rq = { ...paid, recipient: RECIPIENT, paid: { ...paid.paid, amount: String(Number(paid.amount) + 2) } };
  const { deps } = makeDeps({ routes: { [`GET /api/v1/requests/${rq.id}`]: () => json(200, rq) } });
  const result = await matchPayments({ recipient: RECIPIENT, requests: [rq.id] }, deps);
  const o = outputSchema.parse((result as { structuredContent: MatchOutput }).structuredContent);
  assert.equal(o.overpaid?.length, 1);
  assert.equal(o.overpaid![0]!.difference, "2");
  assert.deepEqual(o.overpaid![0]!.refund.args.amount, "2");
  assert.match(textOf(result), new RegExp(`Overpaid: request ${rq.id} asked ${rq.amount} USDC and received ${rq.paid.amount} USDC\\. To send the 2 USDC difference back to the payer, call refund_payment`));
});
