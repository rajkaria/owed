#!/usr/bin/env node
// Writes the F7 fixtures (chip-in pots) in contract/fixtures/. Deterministic: the pot's nonce, every reference and
// signature come from fixed labels; the pot id hashes its recipient, token and nonce (potIdFor) and every
// contribution's id hashes its own terms (requestIdFor), exactly as web/lib/pots.ts makes them.
// No dependencies: `node contract/pot-fixtures.mjs`.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { base58Encode, potIdFor, requestIdFor, TEAM_WALLET, USDC_MINT } from "./shapes.mjs";

const dir = new URL("./fixtures/", import.meta.url);
const BASE = "https://www.getowed.xyz";
const sha = (text) => createHash("sha256").update(text, "utf8").digest();
const key = (label) => base58Encode(sha(label));
const sig = (label) => base58Encode(Buffer.concat([sha(`${label} a`), sha(`${label} b`)]));
const enc = encodeURIComponent;

const RAJ = TEAM_WALLET; // collects
const ANA = key("F7 fixture: Ana's wallet");
const BEN = key("F7 fixture: Ben's wallet");
const CAL = key("F7 fixture: Cal's wallet");
const TITLE = "Farewell gift for Ana";
const NOTE = "Card and flowers from the team";
const CREATED = "2026-10-18T09:00:00Z";
const DEADLINE = "2026-11-17T09:00:00Z"; // 30 days
const nonce = key("F7 fixture nonce: farewell gift");
const potId = potIdFor({ recipient: RAJ, token: "USDC", nonce });
const potLink = `${BASE}/pot/${potId}`;

const txRequest = (amount) => ({ amount, url: `solana:${enc(`${BASE}/api/v1/pay/${potId}?amount=${amount}`)}` });
const potBase = {
  id: potId, link: potLink, recipient: RAJ, token: "USDC", nonce, title: TITLE, note: NOTE, requester_name: "Raj", requester_handle: "rajkaria",
  target: "100", suggested: "10", any_amount: true, presets: ["5", "10", "20"], deadline: DEADLINE, status: "open", created_at: CREATED, flags: [],
};
const links = {
  board: potLink,
  transaction_request: ["10", "5", "20"].map(txRequest), // the suggested amount first, then the presets, each once
  x402: ["5", "10", "20"].map((amount) => ({ amount, url: `${BASE}/x/pot/${potId}/${amount}` })),
};

const createReq = {
  recipient: RAJ, token: "USDC", title: TITLE, note: NOTE, requester_name: "Raj", requester_handle: "rajkaria",
  target: "100", suggested: "10", any_amount: true, presets: ["5", "10", "20"], deadline_days: 30, source: "plugin",
};
const createRes = { ...potBase, totals: { raised: "0", count: 0 }, contributions: [], chain_checked: true, links };

// ---- contributions: Ana 10, Ben 25, Cal 7.5 (three wallets, three references)
function contribution({ label, amount, atomic, created, paid }) {
  const reference = key(`F7 fixture reference: ${label}`);
  const id = requestIdFor({ recipient: RAJ, token: "USDC", amountAtomic: atomic, reference });
  const url = `solana:${RAJ}?amount=${amount}&spl-token=${USDC_MINT}&reference=${reference}&label=Raj&message=${enc(TITLE)}&memo=owed%3A${id}`;
  const expires = new Date(Date.parse(created) + 86_400_000).toISOString().replace(".000Z", "Z");
  return {
    id, kind: "single", recipient: RAJ, amount, token: "USDC", payer_name: null, for: TITLE, note: NOTE, requester_name: "Raj",
    status: paid ? "paid" : "open", solana_pay_url: url, reference, x402_url: `${BASE}/x/${id}`, created_at: created,
    paid: paid ? { signature: paid.signature, payer: paid.payer, amount, at: paid.at, rail: "solana_pay" } : null,
    flags: [], from_domain: null, from_domain_verified_at: null, expires_at: expires, cancelled: null, chain: "solana", pay_url: url,
    matched: null, rest_of: null, rest_request: null, sns_name: null, sns_source: null, sns_resolved_at: null, requester_handle: "rajkaria",
    pot: { id: potId, title: TITLE, link: potLink },
  };
}
const anaPaid = { signature: sig("F7 fixture: Ana pays"), payer: ANA, at: "2026-10-18T09:06:12Z" };
const benPaid = { signature: sig("F7 fixture: Ben pays"), payer: BEN, at: "2026-10-18T09:20:40Z" };
const calPaid = { signature: sig("F7 fixture: Cal pays"), payer: CAL, at: "2026-10-18T10:02:05Z" };
const anaOpen = contribution({ label: "Ana's 10", amount: "10", atomic: 10_000_000n, created: "2026-10-18T09:05:00Z" });
const ana = contribution({ label: "Ana's 10", amount: "10", atomic: 10_000_000n, created: "2026-10-18T09:05:00Z", paid: anaPaid });
const ben = contribution({ label: "Ben's 25", amount: "25", atomic: 25_000_000n, created: "2026-10-18T09:19:58Z", paid: benPaid });
const cal = contribution({ label: "Cal's 7.5", amount: "7.5", atomic: 7_500_000n, created: "2026-10-18T10:01:30Z", paid: calPaid });

const getRes = {
  ...potBase,
  totals: { raised: "42.5", count: 3 },
  contributions: [cal, ben, ana].map((c) => ({ id: c.id, amount: c.amount, payer: c.paid.payer, signature: c.paid.signature, at: c.paid.at, rail: "solana_pay" })),
  chain_checked: true,
  links,
};

// ---- who_owes_me: paid contributions are received (never owed); the open pot is listed with what it raised
const LEDGER_CAUTION = "Anyone can create a request that pays your wallet; Owed can't tell which ones you made. Check names and amounts before chasing anyone.";
const ledgerEntry = (c) => ({
  id: c.id, kind: "single", link: `${BASE}/r/${c.id}`, amount: c.amount, token: "USDC", status: "paid", payer_name: null, for: TITLE,
  created_at: c.created_at, amount_paid: c.amount, payer: c.paid.payer, signature: c.paid.signature, paid_at: c.paid.at,
  group_id: null, group_title: null, group_link: null, invoice_number: null, due_date: null, from_domain: null, flags: [], rail: "solana_pay",
});
const ledgerRes = {
  recipient: RAJ, caution: LEDGER_CAUTION, generated_at: "2026-10-18T10:30:00Z", chain_checked: true,
  open: [], paid_recently: [cal, ben, ana].map(ledgerEntry),
  totals: [{ token: "USDC", outstanding: "0", received_30d: "42.5", open_count: 0, paid_count: 3 }],
  truncated: false,
  pots: [{ id: potId, link: potLink, title: TITLE, token: "USDC", raised: "42.5", count: 3, target: "100", deadline: DEADLINE, flags: [] }],
};

const statsRes = { paid_count: 12, paid_volume_usdc: "180.25", since: "2026-10-17T00:00:00Z", pots: { count: 2, paid_contributions: 3 } };

const files = {
  "pots.create.req.json": createReq,
  "pots.create.res.json": createRes,
  "pots.get.res.json": getRes,
  "pots.contribution.req.json": { amount: "10", source: "plugin" },
  "pots.contribution.res.json": anaOpen,
  "pots.get-request.res.json": ana,
  "ledger.pots.res.json": ledgerRes,
  "stats.pots.res.json": statsRes,
};
for (const [name, value] of Object.entries(files)) await writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} F7 fixtures (pot ${potId})`);
