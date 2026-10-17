// W2-E, QA-06 follow-up (LEAD): a brand word is cleared only by the brand's own DNS-verified domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainBrandFlags } from "@/lib/payee";
import { brandFlags, withoutOwnBrandFlags } from "@/lib/safety";
import { modelFromRequest, pageTitle } from "@/lib/view/request-view";

const flagsFor = (texts: string[], verifiedDomain: string | null) =>
  withoutOwnBrandFlags([...new Set([...brandFlags(texts), ...domainBrandFlags(verifiedDomain)])], verifiedDomain);

test("'Owed Support' with no domain → flagged", () => {
  assert.deepEqual(flagsFor(["Owed Support"], null), ["brand_word:owed support"]);
});

test("'Owed' (or 'Owed Support') from a verified getowed.xyz → not flagged: that is Owed", () => {
  assert.deepEqual(flagsFor(["Owed"], "getowed.xyz"), []);
  assert.deepEqual(flagsFor(["Owed Support"], "getowed.xyz"), []);
  assert.deepEqual(flagsFor(["PayBox support"], "paybox.sh"), [], "the same rule for every brand");
});

test("'Owed' from a verified paybox-support.com → flagged (the domain names a brand it isn't)", () => {
  assert.deepEqual(flagsFor(["Owed"], "paybox-support.com"), ["brand_word:paybox"]);
  assert.deepEqual(flagsFor(["Owed Support"], "paybox-support.com"), ["brand_word:owed support", "brand_word:paybox"]);
  assert.deepEqual(flagsFor(["Owed Support"], "getowed.xyz.evil.example"), ["brand_word:owed support"], "embedding the name isn't owning it");
});

test("pay page: only a server-verified own domain clears the caution; a name never does", () => {
  const base = {
    id: "3sUaVYuB3nzV", kind: "single", recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", amount: "0.01", token: "USDC",
    payer_name: null, for: null, note: null, requester_name: "Owed Support", status: "open",
    solana_pay_url: "solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=0.01", reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e",
    x402_url: null, created_at: "2026-10-17T11:19:12Z", paid: null, flags: ["brand_word:owed support"],
  };
  const model = (extra: Record<string, unknown>) =>
    modelFromRequest({ ...base, ...extra } as unknown as Parameters<typeof modelFromRequest>[0], "https://www.getowed.xyz");
  const own = model({ from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T11:19:12Z" });
  assert.deepEqual(own.brandWords, []);
  assert.equal(pageTitle(own), "Owed Support is asking you for 0.01 USDC");
  assert.deepEqual(model({ from_domain: null, from_domain_verified_at: null }).brandWords, ["Owed Support"]);
  assert.deepEqual(model({ from_domain: "getowed.xyz", from_domain_verified_at: null }).brandWords, ["Owed Support"], "an unverified domain clears nothing");
  assert.deepEqual(model({ from_domain: "paybox-support.com", from_domain_verified_at: "2026-10-17T11:19:12Z", flags: ["brand_word:owed support", "brand_word:paybox"] }).brandWords,
    ["Owed Support", "PayBox"]);
});
