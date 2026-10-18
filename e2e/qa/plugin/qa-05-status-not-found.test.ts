// QA-05 (Medium): one unknown id poisons check_payments. POST /api/v1/status answers an unknown id as
// {id, status: "not_found"} (web/lib/contract.ts makes amount_requested/token optional), but the
// plugin's statusResultSchema requires both, so the whole reply is "off contract" → upstream_unavailable
// → every Owed request in the batch says "Owed's server is unreachable right now".
// Live on production 2026-10-17 09:35 EDT: check_payments ["HeiQKE21Qu2f","111111111111"] → both
// "Not checked … server is unreachable", while POST /status answered 200 in 271 ms.
// The reply below is that production answer verbatim. Owner: plugin/src/contract.ts + a not_found
// result in contract/fixtures/status.res.json (LEAD: contract/**, W1-C closed). Run: command node e2e/qa/run.mjs QA-05
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayments, inputSchema } from "../../../plugin/src/tools/check_payments.ts";
import { json, makeDeps, textOf } from "../../../plugin/test/helpers.ts";

const PRODUCTION_REPLY = {
  results: [
    { id: "HeiQKE21Qu2f", status: "open", amount_requested: "0.01", token: "USDC", created_at: "2026-10-17T13:18:40Z" },
    { id: "111111111111", status: "not_found" },
  ],
};

test("QA-05 an unknown id doesn't hide the status of the known ones", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, PRODUCTION_REPLY) }, now: () => Date.parse("2026-10-17T13:35:00Z") });
  const result = await checkPayments(inputSchema.parse({ requests: ["HeiQKE21Qu2f", "111111111111"] }), deps);
  const text = textOf(result);
  assert.doesNotMatch(text, /unreachable/, `the server answered; the plugin says it didn't:\n${text}`);
  const out = result.structuredContent as { results: Array<{ input: string; status: string }> };
  assert.deepEqual(out.results.map((r) => [r.input, r.status]), [["HeiQKE21Qu2f", "open"], ["111111111111", "not_found"]]);
});

test("QA-05 a batch of one unknown id says not found, not unreachable", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, { results: [{ id: "111111111111", status: "not_found" }] }) } });
  const result = await checkPayments(inputSchema.parse({ requests: ["111111111111"] }), deps);
  assert.doesNotMatch(textOf(result), /unreachable/);
});
