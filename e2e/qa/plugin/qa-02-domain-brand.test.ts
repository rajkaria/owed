// QA-02 (High): a verified from_domain that carries a brand word, or embeds another domain, must
// still raise a caution. Fails on main 13f0507: brand words are checked in requester text only, and
// domainWarnings() covers IDN, mixed scripts and digit lookalikes, so "paybox-support.com" leads the
// preview as "(verified by DNS)" with no caution line. DNS answers: the real nodata-signed capture
// renamed to the attacker's domain, carrying its owed-pay= record (an attacker controls their own DNS).
// Owner: W2-H. Run: command node e2e/qa/run.mjs QA-02
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainWarnings, normalizeDomain, verifyPayee } from "../../../plugin/src/payee.ts";
import { inputSchema as payInput, payLink } from "../../../plugin/src/tools/pay_link.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf } from "../../../plugin/test/helpers.ts";
import { dohFor } from "./qa-helpers.ts";

const openRequest = { ...fixture("get-request.res.json"), status: "open", paid: null };
const ID = openRequest.id as string;

async function preview(fromDomain: string): Promise<string> {
  const { deps } = makeDeps({
    routes: {
      [`GET /api/v1/requests/${ID}`]: () => json(200, { ...openRequest, from_domain: fromDomain, from_domain_verified_at: "2026-10-17T13:00:00Z" }),
      ...dohFor(fromDomain, [`owed-pay=${RECIPIENT}`]),
    },
  });
  const result = await payLink(payInput.parse({ link: `https://owed.link/r/${ID}`, sender: SENDER }), deps);
  assert.ok(!result.isError, `unexpected refusal: ${textOf(result)}`);
  return textOf(result);
}

for (const [domain, brand] of [
  ["paybox-support.com", "PayBox"],
  ["phantom-wallet.xyz", "Phantom"],
  ["usdc-support.app", "USDC support"],
  ["coinbase.refunds-desk.com", "Coinbase"],
] as const) {
  test(`QA-02 pay_link: verified ${domain} still carries a "${brand}" caution`, async () => {
    const text = await preview(domain);
    assert.match(text, /\(verified by DNS/, "precondition: the attacker's own DNS verifies");
    assert.match(text, new RegExp(`^Caution: .*${brand}`, "m"), `no caution for a verified brand domain:\n${text}`);
  });
}

for (const [domain, embedded] of [
  ["getowed.xyz.example-attacker.com", "getowed.xyz"],
  ["paybox.sh.example-attacker.com", "paybox.sh"],
] as const) {
  test(`QA-02 pay_link: verified ${domain} warns that it only starts with ${embedded}`, async () => {
    const text = await preview(domain);
    assert.match(text, /\(verified by DNS/, "precondition: the attacker's own DNS verifies");
    // Any warning line naming the embedded domain will do; the wording is the owner's.
    const warnings = text.split("\n").filter((l) => !/^(Pay |Recipient: |Verified: )/.test(l));
    assert.ok(warnings.some((l) => l.includes(embedded)), `no warning that ${domain} is not ${embedded}:\n${text}`);
  });
}

test("QA-02 domainWarnings: a brand word in the domain is a warning even when the domain is plain ASCII", () => {
  const d = normalizeDomain("paybox-support.com");
  assert.ok(d);
  const warnings = domainWarnings(d);
  assert.ok(warnings.some((w) => /PayBox/i.test(w)), `no brand warning: ${JSON.stringify(warnings)}`);
});

test("QA-02 verify_payee (verifyPayee): verified phantom-wallet.xyz returns a warning", async () => {
  const { deps } = makeDeps({ routes: dohFor("phantom-wallet.xyz", [`owed-pay=${RECIPIENT}`]) });
  const r = await verifyPayee("phantom-wallet.xyz", RECIPIENT, 5000, deps);
  assert.equal(r.status, "verified");
  assert.ok(r.warnings.some((w) => /Phantom/i.test(w)), `no brand warning: ${JSON.stringify(r.warnings)}`);
});
