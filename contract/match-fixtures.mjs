#!/usr/bin/env node
// Writes the 0012 fixtures (match_payments, ask_for_rest, /attributed) in contract/fixtures/. Deterministic: a throwaway
// ed25519 key from a fixed seed signs the match messages exactly as PayBox's request_wallet_sign does (the message's
// UTF-8 bytes, hex out); ids hash their terms; transaction signatures are synthetic (sha256-derived, valid base58 64-byte
// values that are not real mainnet transactions). No dependencies: `node contract/match-fixtures.mjs`.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { base58Encode, requestIdFor, USDC_MINT } from "./shapes.mjs";

const dir = new URL("./fixtures/", import.meta.url);
const BASE = "https://www.getowed.xyz";
const sha = (text) => createHash("sha256").update(text, "utf8").digest();

const seed = sha("owed contract fixture signer: 0012 matched payments");
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const RECIPIENT = base58Encode(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
const signHex = (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

const fakeSig = (label) => base58Encode(Buffer.concat([sha(`${label} a`), sha(`${label} b`)]));
const key = (label) => base58Encode(sha(label));
const PAYER = key("0012 fixture: an exchange hot wallet");

function request({ label, amount, atomic, forText, createdAt }) {
  const reference = key(`0012 fixture reference: ${label}`);
  const id = requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: atomic, reference });
  const message = forText ? `&message=${encodeURIComponent(forText)}` : "";
  const url = `solana:${RECIPIENT}?amount=${amount}&spl-token=${USDC_MINT}&reference=${reference}&label=Raj${message}&memo=owed%3A${id}`;
  return {
    id, kind: "single", recipient: RECIPIENT, amount, token: "USDC", payer_name: "Priya", for: forText, note: null, requester_name: "Raj",
    status: "open", solana_pay_url: url, reference, x402_url: `${BASE}/x/${id}`, created_at: createdAt, paid: null, flags: [],
    from_domain: null, from_domain_verified_at: null, expires_at: null, cancelled: null, chain: "solana", pay_url: url,
  };
}
const matchMessage = (tx, id, at) => `Owed match ${tx} to ${id} for ${RECIPIENT} at ${at}`;

// 1. Open 15 USDC request; Priya paid from an exchange, which dropped the reference. The recipient matched it.
const full = request({ label: "full", amount: "15", atomic: 15_000_000n, forText: "dinner", createdAt: "2026-10-17T13:40:00Z" });
const fullTx = fakeSig("0012 fixture: 15 USDC from an exchange, no reference");
const fullSignedAt = "2026-10-17T15:02:11Z";
const fullMessage = matchMessage(fullTx, full.id, fullSignedAt);
const fullSignature = signHex(fullMessage);
const matchReq = { recipient: RECIPIENT, transaction: fullTx, signed_message: fullMessage, signature: fullSignature };
const matchRes = {
  ...full, status: "paid",
  paid: { signature: fullTx, payer: PAYER, amount: "15", at: "2026-10-17T14:55:40Z", rail: "matched" },
  matched: {
    signature: fullTx, covers: "full", payer: PAYER, amount: "15", at: "2026-10-17T14:55:40Z", confirmed_by: RECIPIENT,
    confirmed_at: "2026-10-17T15:02:13Z", signed_message: fullMessage, message_signature: fullSignature,
  },
  rest_of: null, rest_request: null, already_matched: false,
};

// 2. 20 USDC request; 15 arrived with the reference (underpaid), the rest (5) from an exchange without it, matched.
const part = request({ label: "rest", amount: "20", atomic: 20_000_000n, forText: "rent share", createdAt: "2026-10-16T09:00:00Z" });
const firstTx = fakeSig("0012 fixture: 15 USDC with the reference");
const restTx = fakeSig("0012 fixture: the 5 USDC rest, no reference");
const restSignedAt = "2026-10-17T10:15:00Z";
const restMessage = matchMessage(restTx, part.id, restSignedAt);
const restSignature = signHex(restMessage);
const matchRestRes = {
  ...part, status: "paid",
  paid: { signature: firstTx, payer: PAYER, amount: "20", at: "2026-10-16T09:12:30Z", rail: "solana_pay" },
  matched: {
    signature: restTx, covers: "rest", payer: PAYER, amount: "5", at: "2026-10-17T10:01:07Z", confirmed_by: RECIPIENT,
    confirmed_at: "2026-10-17T10:15:02Z", signed_message: restMessage, message_signature: restSignature,
  },
  rest_of: null, rest_request: null, already_matched: false,
};

// 3. ask_for_rest on an underpaid 12 USDC request where 4.5 arrived: a new request for exactly 7.5, linked to it.
const parent = request({ label: "parent", amount: "12", atomic: 12_000_000n, forText: "concert tickets", createdAt: "2026-10-17T08:00:00Z" });
const rest = request({ label: "parent's rest", amount: "7.5", atomic: 7_500_000n, forText: "concert tickets", createdAt: "2026-10-17T16:20:00Z" });
const restRes = {
  id: rest.id, link: `${BASE}/r/${rest.id}`, solana_pay_url: rest.solana_pay_url, qr_url: `${BASE}/api/qr/${rest.id}.png`,
  reference: rest.reference, x402_url: rest.x402_url, created_at: rest.created_at, flags: [], from_domain: null, expires_at: null,
  chain: "solana", pay_url: rest.pay_url, recipient: RECIPIENT, amount: "7.5", token: "USDC", rest_of: parent.id, already_asked: false,
};

// 4. /attributed: which candidate transactions are already counted, and which keys are Owed references.
const attributedReq = { signatures: [fullTx, firstTx, restTx, fakeSig("0012 fixture: unrelated incoming transfer")], keys: [part.reference, key("0012 fixture: some token account")] };
const attributedRes = {
  attributed: [
    { signature: fullTx, request_id: full.id, how: "matched" },
    { signature: firstTx, request_id: part.id, how: "reference" },
    { signature: restTx, request_id: part.id, how: "matched" },
  ].sort((a, b) => (a.signature < b.signature ? -1 : 1)),
  references: [{ key: part.reference, request_id: part.id }],
};

// 5. POST /status after a full match and on an underpaid request whose rest was asked.
const statusRes = {
  results: [
    {
      id: full.id, status: "paid", amount_requested: "15", token: "USDC", created_at: full.created_at, amount_paid: "15", payer: PAYER,
      signature: fullTx, paid_at: "2026-10-17T14:55:40Z", rail: "matched",
      matched: { signature: fullTx, covers: "full", amount: "15", confirmed_at: "2026-10-17T15:02:13Z" },
    },
    {
      id: parent.id, status: "underpaid", amount_requested: "12", token: "USDC", created_at: parent.created_at, amount_paid: "4.5", payer: PAYER,
      signature: fakeSig("0012 fixture: 4.5 USDC with the reference"), paid_at: "2026-10-17T08:30:00Z", rail: "solana_pay", rest_request: rest.id,
    },
    { id: rest.id, status: "open", amount_requested: "7.5", token: "USDC", created_at: rest.created_at, rest_of: parent.id },
  ],
};

const files = {
  "match.req.json": matchReq,
  "match.res.json": matchRes,
  "match.rest.res.json": matchRestRes,
  "rest.req.json": { source: "plugin" },
  "rest.res.json": restRes,
  "attributed.req.json": attributedReq,
  "attributed.res.json": attributedRes,
  "status.matched.res.json": statusRes,
};
for (const [name, value] of Object.entries(files)) await writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} fixtures for recipient ${RECIPIENT}`);
