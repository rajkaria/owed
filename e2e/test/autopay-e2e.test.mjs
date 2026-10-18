// F5 set_autopay on the real bundle, run the way PayBox runs it (fresh process, no network unless a host is listed):
// the first call returns the exact rule message and the request_wallet_sign call with no network at all, revoke does the
// same, and a correctly signed second call reaches Owed's server (simulated down here, so nothing is stored anywhere).
// Plus F5/F3 shapes: contract/shapes.mjs checks the rule signature, its canonical amounts and deposit links for real.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { base58Encode, check, shapes, TEAM_WALLET } from "../../contract/shapes.mjs";
import { runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));
const skip = !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built";
const seed = createHash("sha256").update("owed e2e signer: autopay-e2e.test.mjs", "utf8").digest();
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const PAYER = base58Encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
const signHex = (message) => sign(null, Buffer.from(message, "utf8"), key).toString("hex");
const RULE = { payer: PAYER, requester: { wallet: TEAM_WALLET, handle: "@landlord_bob" }, max_per_request: "1500", months: 12 };

test("set_autopay, first call: the rule message and the request_wallet_sign call, with no network", { skip }, async () => {
  const report = await runE2E({ artifact: BUNDLE, tool: "set_autopay", arguments: RULE, hosts: "none", expects: ["step=sign", "mode=create"], expectTexts: ["request_wallet_sign", "one tap a month", "never paid automatically"] });
  assert.deepEqual(report.failures, []);
  const out = report.call.structuredContent;
  assert.match(out.message_to_sign, new RegExp(`^Owed autopay for ${PAYER}: pay ${TEAM_WALLET} up to 1500 USDC per request and 1500 USDC per month until \\d{4}-\\d{2}-\\d{2} \\(at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z\\)$`));
  assert.deepEqual(out.sign_call.args.intent, { op: "solanaMessage", address: PAYER, message: out.message_to_sign });
  assert.deepEqual(report.call.network, []);
});

test("set_autopay, second call: a correctly signed rule goes to Owed's server (simulated down: nothing stored)", { skip }, async () => {
  const first = await runE2E({ artifact: BUNDLE, tool: "set_autopay", arguments: RULE, hosts: "none" });
  const message = first.call.structuredContent.message_to_sign;
  const report = await runE2E({
    artifact: BUNDLE, tool: "set_autopay", arguments: { ...RULE, signed_message: message, signature: signHex(message) },
    down: ["owed-omega.vercel.app"], expectError: true, expectTexts: ["couldn't be reached, so nothing was saved"],
  });
  assert.deepEqual(report.failures, []);
  assert.ok(report.call.network.some((n) => n.host === "owed-omega.vercel.app" && n.simulated), JSON.stringify(report.call.network));
  // Signed by another wallet: refused before any network.
  const forged = await runE2E({ artifact: BUNDLE, tool: "set_autopay", arguments: { ...RULE, signed_message: message, signature: `${"0".repeat(127)}1` }, hosts: "none", expectError: true, expectTexts: ["isn't from wallet"] });
  assert.deepEqual(forged.failures, []);
});

test("set_autopay, revoke: the revoke message, with no network", { skip }, async () => {
  const report = await runE2E({ artifact: BUNDLE, tool: "set_autopay", arguments: { payer: PAYER, revoke: "Rk7mPq2xLw9a" }, hosts: "none", expects: ["step=sign", "mode=revoke"] });
  assert.deepEqual(report.failures, []);
  assert.match(report.call.structuredContent.message_to_sign, new RegExp(`^Owed autopay revoke Rk7mPq2xLw9a for ${PAYER} at \\d{4}-\\d{2}-\\d{2}T`));
});

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errorsOf = (shape, value) => check(shapes[shape], value).errors.join("\n");

test("shapes: the rule's signature and fields are checked for real; amounts are canonical", async () => {
  const req = await fixture("autopay.create.req.json");
  assert.equal(errorsOf("autopayCreateReq", req), "");
  assert.match(errorsOf("autopayCreateReq", { ...req, max_per_request: "1600", max_per_month: "1600" }), /says 1500 USDC per request, not 1600/);
  assert.match(errorsOf("autopayCreateReq", { ...req, signed_message: req.signed_message.replace("10:15:00", "10:15:01") }), /does not verify/);
  assert.match(errorsOf("autopayCreateReq", { ...req, requester: { wallet: req.payer } }), /names requester|payer's own wallet/);
  const res = await fixture("autopay.create.res.json");
  assert.equal(errorsOf("autopayCreateRes", res), "");
  assert.match(errorsOf("autopayCreateRes", { ...res, rule: { ...res.rule, ends_at: "2027-10-18T00:00:00Z" } }), /start of the day after ends/);
  const revoke = await fixture("autopay.revoke.req.json");
  assert.match(errorsOf("autopayRevokeReq", { ...revoke, rule_id: "Hn4cVb8tYs3e" }), /must read "Owed autopay revoke Hn4cVb8tYs3e/);
});

test("shapes: inbox verdicts name a listed rule; deposit links are paybox.sh on USDC Solana requests only", async () => {
  const inbox = await fixture("autopay.inbox.res.json");
  assert.equal(errorsOf("autopayInboxRes", inbox), "");
  const unlisted = { ...inbox, autopay_rules: [] };
  assert.match(errorsOf("autopayInboxRes", unlisted), /names a rule the inbox doesn't list/);
  const badStatus = structuredClone(inbox);
  badStatus.owed[0].autopay.status = "auto";
  assert.match(errorsOf("autopayInboxRes", badStatus), /is not one of eligible\|over_limit\|not_covered/);
  const req = await fixture("deposit.create-request.req.json");
  assert.equal(errorsOf("depositCreateRequestReq", req), "");
  assert.match(errorsOf("depositCreateRequestReq", { ...req, deposit_url: "https://evil.example/x" }), /PayBox Deposit link on paybox\.sh/);
  assert.match(errorsOf("depositCreateRequestReq", { ...req, token: "SOL", amount: "1" }), /only on a USDC request on Solana/);
  const got = await fixture("deposit.get-request.res.json");
  assert.equal(errorsOf("depositGetRequestRes", got), "");
  assert.match(errorsOf("depositGetRequestRes", { ...got, deposit_url_added_at: "2026-10-18T10:00:00Z" }), /before created_at/);
});
