// QA-10 (Low): check_payments counts the same request once per input. On production,
// 20 × https://www.getowed.xyz/r/HeiQKE21Qu2f (one 0.01 USDC request) → "0 of 20 paid · 0.2 USDC
// outstanding". An agent that passes a request's id and its link (or a split's share twice) reports
// a wrong total. Owner: plugin/src/tools/check_payments.ts (W1-C closed: LEAD to assign).
// Run: command node e2e/qa/run.mjs QA-10
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayments, inputSchema } from "../../../plugin/src/tools/check_payments.ts";
import { json, makeDeps } from "../../../plugin/test/helpers.ts";

test("QA-10 the same request as id and as link counts once in the summary", async () => {
  const reply = { results: [{ id: "HeiQKE21Qu2f", status: "open", amount_requested: "0.01", token: "USDC", created_at: "2026-10-17T13:18:40Z" }] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, reply) }, env: { OWED_BASE_URL: "https://www.getowed.xyz" } });
  const result = await checkPayments(inputSchema.parse({ requests: ["HeiQKE21Qu2f", "https://www.getowed.xyz/r/HeiQKE21Qu2f"] }), deps);
  const summary = (result.structuredContent as { summary: string }).summary;
  assert.match(summary, /0 of 1 paid · 0\.01 USDC outstanding/, summary);
});
