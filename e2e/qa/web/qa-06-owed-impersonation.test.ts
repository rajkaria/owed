// QA-06 (High): a requester can impersonate Owed itself on Owed's own domain. "Owed" is in none of the
// three brand lists (plugin/src/text.ts, web/lib/safety.ts, web/lib/view/request-view.ts), so on
// production request Yq9MaUsCopbJ (requester_name "Owed Support", for "account verification fee")
// the page <title>, og:title and twitter:title read "Owed Support is asking you for 5 USDC", the
// headline names "Owed Support" as the asker, flags are [] and no caution shows. The unfurl in
// WhatsApp/iMessage is that title under www.getowed.xyz. Same gap for "Anthropic".
// Owner: W2-E (the brand lists, both sides) + W1-E's view list (LEAD to assign). Run: command node e2e/qa/run.mjs QA-06
import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFlags } from "@/lib/safety";
import { detectBrandWords, modelFromRequest, pageTitle } from "@/lib/view/request-view";

const IMPERSONATIONS = ["Owed Support", "Owed team", "Owed Security", "getowed billing", "Anthropic"];

for (const name of IMPERSONATIONS) {
  test(`QA-06 server brandFlags flags "${name}"`, () => {
    assert.ok(brandFlags([name]).length > 0, `no flag for ${name}`);
  });
  test(`QA-06 page brand detection flags "${name}"`, () => {
    assert.ok(detectBrandWords([name]).length > 0, `no brand word for ${name}`);
  });
}

test("QA-06 the production row Yq9MaUsCopbJ doesn't get an 'Owed Support is asking you' title", () => {
  // GET /api/v1/requests/Yq9MaUsCopbJ on production, 2026-10-17 09:38 EDT (flags: []).
  const req = {
    id: "Yq9MaUsCopbJ", kind: "single", recipient: "B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp", amount: "5", token: "USDC",
    payer_name: null, for: "account verification fee", note: "Solana Pay security check required by Claude", requester_name: "Owed Support",
    status: "open", solana_pay_url: "solana:B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp?amount=5", reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e",
    x402_url: null, created_at: "2026-10-17T13:38:00Z", paid: null, flags: [], from_domain: null, from_domain_verified_at: null,
  };
  const model = modelFromRequest(req as Parameters<typeof modelFromRequest>[0], "https://www.getowed.xyz");
  assert.doesNotMatch(pageTitle(model), /Owed Support/, `title: ${pageTitle(model)}`);
  assert.ok(model.brandWords.length > 0, "no caution banner");
});
