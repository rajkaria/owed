import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayments, outputSchema, type CheckOutput } from "../src/tools/check_payments.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// F8 invoices in check_payments: a paid request that was refunded says "refunded <amount>" (from GET
// /api/v1/refunds?requests=, read beside the status call); an older server without the route changes nothing.

const status = fixture("status.res.json");
const lookup = (id: string, over: Record<string, string>) => ({
  requests: [{ request_id: id, token: "USDC", paid: "15", refunded: "0", pending: "0", refundable: "15", refunds: [], ...over }], not_found: [], chain_checked: true,
});

test("a refunded payment reads refunded <amount>; in full when it all went back; pending ones say so", async () => {
  const id = "JArQ6g9JvoWr";
  const run = async (over: Record<string, string>) => {
    const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, status), [`GET /api/v1/refunds?requests=${id}`]: () => json(200, lookup(id, over)) } });
    const result = await checkPayments({ requests: [id] }, deps);
    return { o: outputSchema.parse((result as { structuredContent: CheckOutput }).structuredContent).results[0]!, text: textOf(result) };
  };
  const part = await run({ refunded: "5", refundable: "10" });
  assert.equal(part.o.refunded, "5");
  assert.equal(part.o.refunded_in_full, false);
  assert.match(part.text, /Paid, request JArQ6g9JvoWr: 15 USDC from \S+, refunded 5 USDC: https/);
  const full = await run({ refunded: "15", refundable: "0" });
  assert.match(full.text, /refunded 15 USDC \(in full\)/);
  const pending = await run({ pending: "3", refundable: "12" });
  assert.equal(pending.o.refund_pending, "3");
  assert.match(pending.text, /a refund of 3 USDC is waiting to land/);
});

test("an older server without refunds: results are exactly as before", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, status), "GET *": () => new Response("<html>404</html>", { status: 404 }) } });
  const o = outputSchema.parse((await checkPayments({ requests: ["JArQ6g9JvoWr"] }, deps) as { structuredContent: CheckOutput }).structuredContent);
  assert.equal(o.results[0]!.refunded, undefined);
  assert.equal(o.results[0]!.status, "paid");
});
