#!/usr/bin/env node
// Writes the F5 autopay and F3 deposit-link fixtures in contract/fixtures/. Deterministic: a throwaway ed25519 key from a
// fixed seed is the payer and signs the rule, revoke and inbox messages exactly as PayBox's request_wallet_sign does
// (the message's UTF-8 bytes, hex out); request ids hash their terms. Neither an autopay rule nor a deposit_url ever
// enters a request id. No dependencies: `node contract/autopay-fixtures.mjs`.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { base58Encode, requestIdFor, TEAM_WALLET, USDC_MINT } from "./shapes.mjs";

const dir = new URL("./fixtures/", import.meta.url);
const BASE = "https://www.getowed.xyz";
const sha = (text) => createHash("sha256").update(text, "utf8").digest();
const key = (label) => base58Encode(sha(label));

const seed = sha("owed contract fixture signer: F5 autopay payer");
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const PAYER = base58Encode(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
const signHex = (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

const LANDLORD = TEAM_WALLET; // the requester the rule pays
const STRANGER = key("F5 fixture: a requester without a rule");
const DEPOSIT_URL = "https://deposit.paybox.sh/d/7f3a9c2e";
const RULE_ID = "Rk7mPq2xLw9a";
const OLD_RULE_ID = "Hn4cVb8tYs3e";

const enc = encodeURIComponent;
function terms({ label, recipient = LANDLORD, amount, atomic, requester, message }) {
  const reference = key(`F5 fixture reference: ${label}`);
  const id = requestIdFor({ recipient, token: "USDC", amountAtomic: atomic, reference });
  const url = `solana:${recipient}?amount=${amount}&spl-token=${USDC_MINT}&reference=${reference}${requester ? `&label=${enc(requester)}` : ""}${message ? `&message=${enc(message)}` : ""}&memo=owed%3A${id}`;
  return { id, reference, url };
}

// ---- 1. set_autopay: the signed rule, as POST /api/v1/autopay takes and returns it
const ruleText = `Owed autopay for ${PAYER}: pay ${LANDLORD} up to 1500 USDC per request and 1500 USDC per month until 2027-10-18 (at 2026-10-18T10:15:00Z)`;
const createReq = {
  payer: PAYER, requester: { wallet: LANDLORD, handle: "landlord_bob" }, token: "USDC", max_per_request: "1500", max_per_month: "1500", ends: "2027-10-18",
  signed_message: ruleText, signature: signHex(ruleText),
};
const rule = {
  id: RULE_ID, payer: PAYER, requester: { wallet: LANDLORD, handle: "landlord_bob", sns: null }, token: "USDC",
  max_per_request: "1500", max_per_month: "1500", ends: "2027-10-18", ends_at: "2027-10-19T00:00:00Z", created_at: "2026-10-18T10:15:02Z",
  status: "active", revoked_at: null, replaced_by: null, month: "2026-10", used_this_month: "0",
  signed_message: ruleText, signature: createReq.signature,
};
const createRes = { rule, replaced: OLD_RULE_ID };

// ---- 2. revoking it
const revokeText = `Owed autopay revoke ${RULE_ID} for ${PAYER} at 2026-10-18T10:20:00Z`;
const revokeReq = { payer: PAYER, rule_id: RULE_ID, signed_message: revokeText, signature: signHex(revokeText) };
const revokeRes = { rule: { ...rule, status: "revoked", revoked_at: "2026-10-18T10:20:01Z" }, already_revoked: false };

// ---- 3. the payer's inbox with the rule live: two 1,000 USDC rent requests under a 1,500 USDC monthly cap, one stranger
const inboxText = `Owed inbox access for ${PAYER} at 2026-10-18T10:30:00Z`;
const inboxReq = { payer: PAYER, signed_message: inboxText, signature: signHex(inboxText) };
const october = terms({ label: "October rent", amount: "1000", atomic: 1_000_000_000n, requester: "Bob", message: "October rent" });
const november = terms({ label: "November rent", amount: "1000", atomic: 1_000_000_000n, requester: "Bob", message: "November rent" });
const snacks = terms({ label: "snacks", recipient: STRANGER, amount: "5", atomic: 5_000_000n, message: "snacks" });
const line = (t, { recipient = LANDLORD, amount, name = "Bob", forText, createdAt, autopay }) => ({
  id: t.id, kind: "single", link: `${BASE}/r/${t.id}`, status: "open", amount, amount_due: amount, token: "USDC", chain: "solana", recipient,
  requester_name: name, requester_handle: null, for: forText, from_domain: null, sns_name: null, created_at: createdAt, expires_at: null,
  due_date: null, invoice_number: null, group_title: null, addressed_as: { handle: null, sns: null }, first_time: false, flags: [], autopay,
});
const inboxRes = {
  payer: PAYER,
  caution: "Anyone can address a request to your wallet; Owed doesn't check who sent it. Names, handles and reasons are the requester's own words, and Owed hasn't verified any handle.",
  generated_at: "2026-10-18T10:30:00Z",
  chain_checked: true,
  owed: [
    line(october, { amount: "1000", forText: "October rent", createdAt: "2026-10-18T09:00:00Z", autopay: { status: "eligible", rule_id: RULE_ID, reason: "Within the rule: 1000 USDC of 1500 USDC per request, 1000 USDC of 1500 USDC this month (UTC)." } }),
    line(november, { amount: "1000", forText: "November rent", createdAt: "2026-10-18T09:05:00Z", autopay: { status: "over_limit", rule_id: RULE_ID, reason: "Paying it would make 2000 USDC this month (UTC), above the rule's 1500 USDC per month (1000 USDC already counted)." } }),
    line(snacks, { recipient: STRANGER, amount: "5", name: null, forText: "snacks", createdAt: "2026-10-18T09:10:00Z", autopay: { status: "not_covered", reason: "No autopay rule covers this requester's wallet." } }),
  ],
  base: [],
  totals: [{ token: "USDC", chain: "solana", amount_due: "2005", count: 3 }],
  blocked_hidden: 0,
  blocked_requesters: [],
  truncated: false,
  autopay_rules: [rule],
};
// GET /api/v1/requests?ids=<october> as what_do_i_owe reads it before attaching the pay_x402 call.
const getOf = (t, { recipient = LANDLORD, amount, forText, createdAt }) => ({
  id: t.id, kind: "single", recipient, amount, token: "USDC", payer_name: null, for: forText, note: null, requester_name: "Bob", status: "open",
  solana_pay_url: t.url, reference: t.reference, x402_url: `${BASE}/x/${t.id}`, created_at: createdAt, paid: null, flags: [], from_domain: null,
  from_domain_verified_at: null, expires_at: null, cancelled: null, chain: "solana", pay_url: t.url, matched: null, rest_of: null, rest_request: null,
  sns_name: null, sns_source: null, sns_resolved_at: null, payer: { wallet: PAYER, handle: null, sns: null },
});
const bulkRes = { requests: [getOf(october, { amount: "1000", forText: "October rent", createdAt: "2026-10-18T09:00:00Z" })], not_found: [] };

// ---- 4. F3: a request with a PayBox Open Deposit link (not part of its id)
const lunch = terms({ label: "deposit lunch", amount: "12", atomic: 12_000_000n, requester: "Raj", message: "team lunch" });
const depositCreateReq = { recipient: LANDLORD, amount: "12", token: "USDC", for: "team lunch", requester_name: "Raj", source: "plugin", deposit_url: DEPOSIT_URL };
const depositCreated = "2026-10-18T11:00:00Z";
const depositCreateRes = {
  id: lunch.id, link: `${BASE}/r/${lunch.id}`, solana_pay_url: lunch.url, qr_url: `${BASE}/api/qr/${lunch.id}.png`, reference: lunch.reference,
  x402_url: `${BASE}/x/${lunch.id}`, created_at: depositCreated, flags: [], from_domain: null, expires_at: null, chain: "solana", pay_url: lunch.url,
  sns_name: null, sns_source: null, deposit_url: DEPOSIT_URL,
};
const depositGetRes = {
  id: lunch.id, kind: "single", recipient: LANDLORD, amount: "12", token: "USDC", payer_name: null, for: "team lunch", note: null, requester_name: "Raj",
  status: "open", solana_pay_url: lunch.url, reference: lunch.reference, x402_url: `${BASE}/x/${lunch.id}`, created_at: depositCreated, paid: null, flags: [],
  from_domain: null, from_domain_verified_at: null, expires_at: null, cancelled: null, chain: "solana", pay_url: lunch.url, matched: null, rest_of: null,
  rest_request: null, sns_name: null, sns_source: null, sns_resolved_at: null, deposit_url: DEPOSIT_URL, deposit_url_added_at: depositCreated,
};
const depositStatusRes = { results: [{ id: lunch.id, status: "open", amount_requested: "12", token: "USDC", created_at: depositCreated, deposit_link: true }] };
// The plain invoice fixture with a deposit link: same terms, same id.
const invoiceReq = JSON.parse(await readFile(new URL("invoices.create.req.json", dir), "utf8"));
const invoiceRes = JSON.parse(await readFile(new URL("invoices.create.res.json", dir), "utf8"));

const files = {
  "autopay.create.req.json": createReq,
  "autopay.create.res.json": createRes,
  "autopay.revoke.req.json": revokeReq,
  "autopay.revoke.res.json": revokeRes,
  "autopay.inbox.req.json": inboxReq,
  "autopay.inbox.res.json": inboxRes,
  "autopay.requests.bulk.res.json": bulkRes,
  "deposit.create-request.req.json": depositCreateReq,
  "deposit.create-request.res.json": depositCreateRes,
  "deposit.get-request.res.json": depositGetRes,
  "deposit.status.res.json": depositStatusRes,
  "deposit.invoices.create.req.json": { ...invoiceReq, deposit_url: DEPOSIT_URL },
  "deposit.invoices.create.res.json": { ...invoiceRes, deposit_url: DEPOSIT_URL },
};
for (const [name, value] of Object.entries(files)) await writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} F5/F3 fixtures (payer ${PAYER})`);
