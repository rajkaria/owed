#!/usr/bin/env node
// Writes the F1 fixtures (payer inbox, X handles, pay_all) in contract/fixtures/. Deterministic: a throwaway ed25519
// key from a fixed seed is the payer and signs the inbox and block messages exactly as PayBox's request_wallet_sign
// does (the message's UTF-8 bytes, hex out); request ids hash their terms and group ids their shares. Payer fields
// never enter an id. No dependencies: `node contract/inbox-fixtures.mjs`.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { base58Encode, groupIdFor, requestIdFor, TEAM_WALLET, USDC_MINT } from "./shapes.mjs";

const dir = new URL("./fixtures/", import.meta.url);
const BASE = "https://www.getowed.xyz";
const sha = (text) => createHash("sha256").update(text, "utf8").digest();
const key = (label) => base58Encode(sha(label));

const seed = sha("owed contract fixture signer: F1 payer inbox");
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const SAM = base58Encode(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
const signHex = (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

const RAJ = TEAM_WALLET; // the requester: every request below pays this wallet unless it says otherwise
const LENA = key("F1 fixture: Lena's studio wallet");
const LEE = key("F1 fixture: Lee's wallet");
const SPAMMER = key("F1 fixture: a wallet Sam blocked");
const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v"; // bonfida.sns's owner (mainnet)
const BASE_RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const enc = encodeURIComponent;
function terms({ label, recipient = RAJ, amount, atomic, requester, message }) {
  const reference = key(`F1 fixture reference: ${label}`);
  const id = requestIdFor({ recipient, token: "USDC", amountAtomic: atomic, reference });
  const url = `solana:${recipient}?amount=${amount}&spl-token=${USDC_MINT}&reference=${reference}${requester ? `&label=${enc(requester)}` : ""}${message ? `&message=${enc(message)}` : ""}&memo=owed%3A${id}`;
  return { id, reference, url };
}

// ---- 1. ask_for_money addressed to @sam_ok (the agent resolved it with PayBox resolve_username first)
const SAM_PAYER = { wallet: SAM, handle: "sam_ok", sns: null };
const ticket = terms({ label: "concert tickets", amount: "12", atomic: 12_000_000n, requester: "Raj", message: "concert tickets" });
const createReq = {
  recipient: RAJ, amount: "12", token: "USDC", payer_name: "Sam", for: "concert tickets", requester_name: "Raj", source: "plugin",
  payer: { handle: "sam_ok", wallet: SAM }, requester_handle: "rajkaria",
};
const createdAt = "2026-10-18T08:00:00Z";
const createRes = {
  id: ticket.id, link: `${BASE}/r/${ticket.id}`, solana_pay_url: ticket.url, qr_url: `${BASE}/api/qr/${ticket.id}.png`, reference: ticket.reference,
  x402_url: `${BASE}/x/${ticket.id}`, created_at: createdAt, flags: [], from_domain: null, expires_at: null, chain: "solana", pay_url: ticket.url,
  sns_name: null, sns_source: null, payer: SAM_PAYER, requester_handle: "rajkaria",
};
const getRes = {
  id: ticket.id, kind: "single", recipient: RAJ, amount: "12", token: "USDC", payer_name: "Sam", for: "concert tickets", note: null,
  requester_name: "Raj", status: "open", solana_pay_url: ticket.url, reference: ticket.reference, x402_url: `${BASE}/x/${ticket.id}`,
  created_at: createdAt, paid: null, flags: [], from_domain: null, from_domain_verified_at: null, expires_at: null, cancelled: null,
  chain: "solana", pay_url: ticket.url, matched: null, rest_of: null, rest_request: null, sns_name: null, sns_source: null, sns_resolved_at: null,
  payer: SAM_PAYER, requester_handle: "rajkaria",
};

// ---- 2. split_bill with a payer on two of the three people
const groupCreated = "2026-10-18T08:30:00Z";
const people = [
  { name: "Sam", amount: "0.1", payer: SAM_PAYER },
  { name: "Ana", amount: "0.1", payer: null },
  { name: "Lee", amount: "0.1", payer: { wallet: LEE, handle: null, sns: null } },
];
const shares = people.map((p) => {
  const t = terms({ label: `climbing ${p.name}`, amount: p.amount, atomic: 100_000n, requester: "Raj", message: "Climbing gym" });
  return {
    id: t.id, name: p.name, amount: p.amount, status: "open", link: `${BASE}/r/${t.id}`, solana_pay_url: t.url, reference: t.reference,
    paid: null, from_domain: null, ...(p.payer && { payer: p.payer }),
  };
});
const groupId = groupIdFor({ recipient: RAJ, token: "USDC", totalAtomic: 300_000n, shareIds: shares.map((s) => s.id) });
const groupReq = {
  recipient: RAJ, total: "0.3", token: "USDC", title: "Climbing gym",
  people: [
    { name: "Sam", amount: "0.1", payer: { handle: "sam_ok", wallet: SAM } },
    { name: "Ana", amount: "0.1" },
    { name: "Lee", amount: "0.1", payer: { wallet: LEE } },
  ],
  requester_name: "Raj", source: "plugin", requester_handle: "rajkaria",
};
const groupRes = {
  id: groupId, link: `${BASE}/g/${groupId}`, title: "Climbing gym", recipient: RAJ, token: "USDC", total: "0.3", requester_name: "Raj",
  created_at: groupCreated, flags: [], from_domain: null, from_domain_verified_at: null, share_count: 3, paid_count: 0, amount_received: "0",
  shares, requester_handle: "rajkaria",
};

// ---- 3. create_invoice to a client found by an .sns name (resolved on Solana by the plugin, again by the server)
const invoiceTerms = terms({ label: "invoice LS-31", recipient: LENA, amount: "1.25", atomic: 1_250_000n, requester: "Lena Studio", message: "Invoice LS-31" });
const invoiceItems = [{ description: "Poster design", quantity: "1", unit_price: "1", amount: "1" }, { description: "Print files", quantity: "1", unit_price: "0.25", amount: "0.25" }];
const invoiceReq = {
  recipient: LENA, token: "USDC", business_name: "Lena Studio", client_name: "Bonfida", items: invoiceItems.map(({ description, quantity, unit_price }) => ({ description, quantity, unit_price })),
  due_date: "2026-10-31", invoice_number: "LS-31", source: "plugin", payer: { sns: "bonfida.sns", wallet: BONFIDA }, requester_handle: "lenastudio",
};
const invoiceRes = {
  id: invoiceTerms.id, link: `${BASE}/i/${invoiceTerms.id}`, request_link: `${BASE}/r/${invoiceTerms.id}`, solana_pay_url: invoiceTerms.url,
  qr_url: `${BASE}/api/qr/${invoiceTerms.id}.png`, reference: invoiceTerms.reference, x402_url: `${BASE}/x/${invoiceTerms.id}`, recipient: LENA, token: "USDC",
  business_name: "Lena Studio", client_name: "Bonfida", invoice_number: "LS-31", notes: null, issue_date: "2026-10-18", due_date: "2026-10-31",
  items: invoiceItems, total: "1.25", status: "open", paid: null, created_at: "2026-10-18T09:00:00Z", flags: [], from_domain: null, from_domain_verified_at: null,
  payer: { wallet: BONFIDA, handle: null, sns: "bonfida.sns" }, requester_handle: "lenastudio",
};

// ---- 4. ask_every_month addressed to @sam_ok: the first month's request opens on the 1st
const scheduleReq = {
  recipient: RAJ, amount: "450", token: "USDC", payer_name: "Sam", for: "rent", requester_name: "Raj", day_of_month: 1, source: "plugin",
  payer: { handle: "sam_ok", wallet: SAM }, requester_handle: "rajkaria",
};
const scheduleRes = {
  id: "Xr4HPa9WmT2q", recipient: RAJ, amount: "450", token: "USDC", payer_name: "Sam", for: "rent", requester_name: "Raj", day_of_month: 1,
  months: null, first_period: "2026-11", status: "active", next_request_on: "2026-11-01", created_at: "2026-10-18T09:30:00Z", flags: [],
  from_domain: null, from_domain_verified_at: null, first_request: null, payer: SAM_PAYER, requester_handle: "rajkaria",
};

// ---- 5. what_do_i_owe: Sam's inbox after one signature (one requester blocked), and a block
const inboxAt = "2026-10-18T10:15:00Z";
const inboxMessage = `Owed inbox access for ${SAM} at ${inboxAt}`;
const inboxReq = { payer: SAM, signed_message: inboxMessage, signature: signHex(inboxMessage) };
const baseId = "Gq8NvZx3TkWp";
const entry = (e) => ({
  id: e.id, kind: e.kind, link: e.link, status: "open", amount: e.amount, amount_due: e.amount, token: "USDC", chain: e.chain ?? "solana", recipient: e.recipient,
  requester_name: e.requester_name, requester_handle: e.requester_handle ?? null, for: e.for, from_domain: null, sns_name: null, created_at: e.created_at,
  expires_at: null, due_date: e.due_date ?? null, invoice_number: e.invoice_number ?? null, group_title: e.group_title ?? null,
  addressed_as: e.addressed_as, first_time: e.first_time, flags: [],
});
const inboxRes = {
  payer: SAM,
  caution: "Anyone can address a request to your wallet; Owed doesn't check who sent it. Names, handles and reasons are the requester's own words, and Owed hasn't verified any handle.",
  generated_at: inboxAt, chain_checked: true,
  owed: [
    entry({ id: ticket.id, kind: "single", link: `${BASE}/r/${ticket.id}`, amount: "12", recipient: RAJ, requester_name: "Raj", requester_handle: "rajkaria", for: "concert tickets", created_at: createdAt, addressed_as: { handle: "sam_ok", sns: null }, first_time: false }),
    entry({ id: shares[0].id, kind: "split_share", link: `${BASE}/r/${shares[0].id}`, amount: "0.1", recipient: RAJ, requester_name: "Raj", requester_handle: "rajkaria", for: "Climbing gym", group_title: "Climbing gym", created_at: groupCreated, addressed_as: { handle: "sam_ok", sns: null }, first_time: false }),
    entry({ id: invoiceTerms.id, kind: "invoice", link: `${BASE}/i/${invoiceTerms.id}`, amount: "1.25", recipient: LENA, requester_name: "Lena Studio", requester_handle: "lenastudio", for: "Invoice LS-31", invoice_number: "LS-31", due_date: "2026-10-31", created_at: "2026-10-18T09:00:00Z", addressed_as: { handle: null, sns: null }, first_time: true }),
  ],
  base: [
    entry({ id: baseId, kind: "single", link: `${BASE}/r/${baseId}`, amount: "5", chain: "base", recipient: BASE_RECIPIENT, requester_name: "Priya", for: "coffee", created_at: "2026-10-18T09:45:00Z", addressed_as: { handle: "sam_ok", sns: null }, first_time: true }),
  ],
  totals: [
    { token: "USDC", chain: "solana", amount_due: "13.35", count: 3 },
    { token: "USDC", chain: "base", amount_due: "5", count: 1 },
  ],
  blocked_hidden: 1, blocked_requesters: [SPAMMER], truncated: false,
};
const blockAt = "2026-10-18T10:16:30Z";
const blockMessage = `Owed block ${SPAMMER} for ${SAM} at ${blockAt}`;
const blockReq = { payer: SAM, requester: SPAMMER, action: "block", signed_message: blockMessage, signature: signHex(blockMessage) };
const blockRes = { payer: SAM, requester: SPAMMER, action: "block", blocked: true, changed: true, inbox: { ...inboxRes, generated_at: blockAt } };

// ---- 6. pay_all's bulk terms: GET /api/v1/requests?ids=<ticket>,<Sam's share>,<unknown>
const shareGet = {
  ...getRes, id: shares[0].id, kind: "split_share", amount: "0.1", payer_name: "Sam", for: "Climbing gym", solana_pay_url: shares[0].solana_pay_url,
  reference: shares[0].reference, x402_url: `${BASE}/x/${shares[0].id}`, created_at: groupCreated, pay_url: shares[0].solana_pay_url,
};
const bulkRes = { requests: [getRes, shareGet], not_found: ["Unknwn7Abcde"] };

const files = {
  "payer.create-request.req.json": createReq,
  "payer.create-request.res.json": createRes,
  "payer.get-request.res.json": getRes,
  "payer.groups.create.req.json": groupReq,
  "payer.groups.create.res.json": groupRes,
  "payer.invoices.create.req.json": invoiceReq,
  "payer.invoices.create.res.json": invoiceRes,
  "payer.schedules.create.req.json": scheduleReq,
  "payer.schedules.create.res.json": scheduleRes,
  "inbox.req.json": inboxReq,
  "inbox.res.json": inboxRes,
  "inbox.block.req.json": blockReq,
  "inbox.block.res.json": blockRes,
  "requests.bulk.res.json": bulkRes,
};
for (const [name, value] of Object.entries(files)) await writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} fixtures; payer ${SAM}`);
