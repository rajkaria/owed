// QA-09 (Low): plugin/src/text.ts clean() misses links the server strips, so they reach pay_link's
// preview from raw solana: links (production run 09:20 EDT: memo "hi 45.33.12.9/claim evil.zip" came
// through verbatim). Bare IPv4 is stripped by web/lib/safety.ts; TLDs outside the plugin's list
// (.zip, .mov, .lol, .icu, .bond, .cyou, .sbs, .country, .click is in) are common in phishing.
// Owner: plugin/src/text.ts (LEAD to assign; W2-E suggested). Run: command node e2e/qa/run.mjs QA-09
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean } from "../../../plugin/src/text.ts";

for (const link of ["45.33.12.9/claim", "45.33.12.9:8080", "evil.zip", "claim.mov", "pay.lol", "wallet.icu", "refund.bond", "x.cyou", "airdrop.sbs", "verify.country"]) {
  test(`QA-09 clean() strips ${link}`, () => {
    const out = clean(`claim at ${link} now`, 140);
    assert.ok(!out.includes(link), `kept: ${out}`);
  });
}

test("QA-09 control (passes today): a plain decimal or version string is not a link", () => {
  assert.equal(clean("dinner for 2.5 people, v1.2", 140), "dinner for 2.5 people, v1.2");
});
