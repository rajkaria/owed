#!/usr/bin/env node
// Writes the F6 group-ledger fixtures (contract/fixtures/ledgers.*.json). Deterministic: throwaway ed25519 keys from
// fixed seeds are the owner and the members and sign every expense and settle-up exactly as PayBox's
// request_wallet_sign does (the message's UTF-8 bytes, hex out); request ids hash their terms. The arithmetic is the
// plugin's own src/ledger-math.ts and src/fiat.ts (the server runs a byte-identical copy), so these files are what the
// server returns for the same ledger. Run from the repo root:
//   node --import ./plugin/node_modules/tsx/dist/loader.mjs contract/ledger-fixtures.mjs
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { base58Encode, requestIdFor, USDC_MINT } from "./shapes.mjs";
import {
  decimalToUnits, expenseDigest, expensePrefix, ledgerBalances, ledgerText, planSettlement, settlePrefix, splitExpense, transferAmounts,
  unitsToDecimal, WEIGHT_DECIMALS,
} from "../plugin/src/ledger-math.ts";
import { FIAT_CURRENCIES, fromMinor, usdcAtomicFor } from "../plugin/src/fiat.ts";

const dir = new URL("./fixtures/", import.meta.url);
const BASE = "https://www.getowed.xyz";
const sha = (text) => createHash("sha256").update(text, "utf8").digest();
const key = (label) => base58Encode(sha(label));
const CAUTION = "Names, descriptions and amounts are written by whoever recorded them; Owed doesn't check them. Each expense and settle-up is signed by a wallet named in the ledger, and handles are labels Owed doesn't verify.";

function signer(label) {
  const seed = sha(`owed contract fixture signer: F6 ${label}`);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = base58Encode(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
  return { address, sign: (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex") };
}
const RAJ = signer("Raj, the owner");
const PRIYA = signer("Priya");
const SAM = signer("Sam");

const decimalsOf = (currency) => (currency === "USDC" ? 6 : FIAT_CURRENCIES[currency].decimals);
const usdc = (atomic) => unitsToDecimal(atomic, 6);

/** A ledger as the server holds it, plus the public shape GET /api/v1/ledgers/<id> returns for it. */
function makeLedger({ label, title, createdAt, members }) {
  return { id: key(`F6 fixture ledger: ${label}`).slice(-12), title, owner: members[0].wallet, createdAt, members, expenses: [], settlements: [], version: 0, requests: new Map() };
}

/** Records an expense the way POST /expenses does (body -> canonical -> split -> USDC shares), and returns the body. */
function addExpense(ledger, who, at, body, fiat = null) {
  const currency = body.currency ?? "USDC";
  const d = decimalsOf(currency);
  const u = (s) => decimalToUnits(s, d);
  const n = ledger.members.length;
  const totalUnits = u(body.amount);
  const among = body.split === "even" ? (body.among ?? Array.from({ length: n }, (_, i) => i)) : null;
  const shares = body.shares?.map((s) => ({ member: s.member, weight: decimalToUnits(s.shares, WEIGHT_DECIMALS) })) ?? null;
  const amounts = body.amounts?.map((a) => ({ member: a.member, units: u(a.amount) })) ?? null;
  const items = body.items?.map((i) => ({ description: ledgerText(i.description, 60), units: u(i.amount), members: i.members })) ?? null;
  const taxUnits = body.tax ? u(body.tax) : null;
  const tipUnits = body.tip ? u(body.tip) : null;
  const description = ledgerText(body.description, 80);
  const split = splitExpense(totalUnits, { split: body.split, among, shares, amounts, items, taxUnits, tipUnits }, n);
  const digest = expenseDigest(ledger.id, { description, paidBy: body.paid_by, currency, totalUnits, split: body.split, among, shares, amounts, items, taxUnits, tipUnits });
  const message = `${expensePrefix(ledger.id, digest, unitsToDecimal(totalUnits, d), currency, who.address)} at ${at}`;
  const usdcShares = split.units.map((units) => (currency === "USDC" || units === 0n ? units : usdcAtomicFor(fromMinor(units, currency), currency, fiat.rate)));
  const weights = new Map((shares ?? []).map((s) => [s.member, s.weight]));
  ledger.expenses.push({
    position: ledger.expenses.length, description, paid_by: body.paid_by, split: body.split, currency,
    total: unitsToDecimal(totalUnits, d), amountAtomic: usdcShares.reduce((a, b) => a + b, 0n),
    tax: taxUnits === null ? null : unitsToDecimal(taxUnits, d), tip: tipUnits === null ? null : unitsToDecimal(tipUnits, d),
    fiat: currency === "USDC" ? null : { currency, amount: unitsToDecimal(totalUnits, d), ...fiat },
    items: items?.map((i) => ({ description: i.description, amount: unitsToDecimal(i.units, d), members: [...i.members] })) ?? null,
    shares: split.participants.map((m) => ({
      member: m, weight: weights.has(m) ? unitsToDecimal(weights.get(m), WEIGHT_DECIMALS) : null, share: unitsToDecimal(split.units[m], d), amount: usdc(usdcShares[m]),
    })),
    sharesAtomic: usdcShares, recorded_by: who.address, recorded_at: at, signed_message: message, signature: who.sign(message), flags: [],
  });
  ledger.version += 1;
  return { signer: who.address, ...body, signed_message: message, signature: who.sign(message) };
}

function state(ledger) {
  const transfers = ledger.settlements.flatMap((s) => s.transfers).map((t) => {
    const r = ledger.requests.get(t.request_id);
    return { from: t.from, to: t.to, amountAtomic: t.amountAtomic, ...transferAmounts(r.status, t.amountAtomic, r.paid ? decimalToUnits(r.paid.amount, 6) : null) };
  });
  const balances = ledgerBalances(ledger.members.length, ledger.expenses.map((e) => ({ paidBy: e.paid_by, amountAtomic: e.amountAtomic, sharesAtomic: e.sharesAtomic })), transfers);
  return { balances, plan: planSettlement(balances.map((b) => b.toSettle)), transfers };
}

/** Settles up the way POST /settle does; returns the signed body and the reply's `created`. */
function settleUp(ledger, who, at, recorderName) {
  const { plan } = state(ledger);
  const payable = plan.filter((t) => ledger.members[t.to].wallet);
  const total = payable.reduce((a, t) => a + t.amountAtomic, 0n);
  const message = `${settlePrefix(ledger.id, ledger.version, payable.length, usdc(total), who.address)} at ${at}`;
  const body = { signer: who.address, version: ledger.version, signed_message: message, signature: who.sign(message) };
  const round = ledger.version;
  const forText = `${ledger.title} settle-up`;
  const note = `Settle-up from Owed ledger ${ledger.id}, recorded by ${recorderName}.`;
  const created = payable.map((t, position) => {
    const debtor = ledger.members[t.from];
    const creditor = ledger.members[t.to];
    const reference = key(`F6 fixture reference: ${ledger.id} round ${round} transfer ${position}`);
    const amount = usdc(t.amountAtomic);
    const id = requestIdFor({ recipient: creditor.wallet, token: "USDC", amountAtomic: t.amountAtomic, reference });
    const enc = encodeURIComponent;
    const solana_pay_url = `solana:${creditor.wallet}?amount=${amount}&spl-token=${USDC_MINT}&reference=${reference}&label=${enc(creditor.name)}&message=${enc(forText)}&memo=owed%3A${id}`;
    const payer = debtor.wallet ? { wallet: debtor.wallet, handle: debtor.handle, sns: debtor.sns } : null;
    ledger.requests.set(id, { status: "open", paid: null, payer });
    return {
      position, from: t.from, to: t.to, amount,
      request: {
        id, link: `${BASE}/r/${id}`, solana_pay_url, reference, recipient: creditor.wallet, payer, payer_name: debtor.name, for: forText, note,
        requester_name: creditor.name, requester_handle: creditor.handle, created_at: at,
      },
    };
  });
  ledger.settlements.push({
    round, recorded_by: who.address, recorded_at: at, signed_message: message, signature: body.signature,
    transfers: created.map((c) => ({ position: c.position, from: c.from, to: c.to, amountAtomic: decimalToUnits(c.amount, 6), request_id: c.request.id })),
  });
  ledger.version += 1;
  const unpayable = plan.filter((t) => !ledger.members[t.to].wallet).map((t) => ({ from: t.from, to: t.to, amount: usdc(t.amountAtomic), reason: "no_wallet" }));
  return { body, round, created, unpayable };
}

function publicLedger(ledger) {
  const { balances, plan } = state(ledger);
  const latestFiat = [...ledger.expenses].reverse().find((e) => e.fiat);
  let open = 0;
  return {
    id: ledger.id, link: `${BASE}/l/${ledger.id}`, title: ledger.title, owner: ledger.owner, created_at: ledger.createdAt, version: ledger.version,
    flags: [], caution: CAUTION,
    members: ledger.members.map((m, position) => ({ position, name: m.name, wallet: m.wallet, handle: m.handle, sns: m.sns })),
    expenses: ledger.expenses.map(({ amountAtomic, sharesAtomic, ...e }) => ({
      position: e.position, description: e.description, paid_by: e.paid_by, split: e.split, currency: e.currency, total: e.total, amount: usdc(amountAtomic),
      tax: e.tax, tip: e.tip, fiat: e.fiat, items: e.items, shares: e.shares, recorded_by: e.recorded_by, recorded_at: e.recorded_at,
      signed_message: e.signed_message, signature: e.signature, flags: e.flags,
    })),
    balances: balances.map((b, member) => ({
      member, paid: usdc(b.paid), share: usdc(b.share), sent: usdc(b.sent), received: usdc(b.received), net: usdc(b.net),
      pending_out: usdc(b.pendingOut), pending_in: usdc(b.pendingIn), to_settle: usdc(b.toSettle),
    })),
    plan: plan.map((t) => ({ from: t.from, to: t.to, amount: usdc(t.amountAtomic), payable: ledger.members[t.to].wallet !== null })),
    settlements: ledger.settlements.map((s) => ({
      round: s.round, recorded_by: s.recorded_by, recorded_at: s.recorded_at, signed_message: s.signed_message, signature: s.signature,
      transfers: s.transfers.map((t) => {
        const r = ledger.requests.get(t.request_id);
        if (r.status === "open") open += 1;
        return { position: t.position, from: t.from, to: t.to, amount: usdc(t.amountAtomic), request_id: t.request_id, link: `${BASE}/r/${t.request_id}`, status: r.status, paid: r.paid, addressed: r.payer !== null };
      }),
    })),
    totals: { spent: usdc(ledger.expenses.reduce((a, e) => a + e.amountAtomic, 0n)), expense_count: ledger.expenses.length, open_requests: open },
    fiat_beside: latestFiat ? { currency: latestFiat.fiat.currency, rate: latestFiat.fiat.rate, rate_source: latestFiat.fiat.rate_source, quoted_at: latestFiat.fiat.quoted_at } : null,
    settled: ledger.expenses.length > 0 && balances.every((b) => b.net === 0n && b.pendingIn === 0n && b.pendingOut === 0n),
    chain_checked: true,
  };
}

const write = (name, value) => writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);

// ---- 1. start_ledger: Raj (owner) with Priya (@priya_p, resolved by PayBox), Sam (wallet) and Alex (no wallet yet)
const createReq = {
  title: "Lisbon trip", owner: RAJ.address, owner_name: "Raj",
  members: [{ name: "Priya", payer: { handle: "priya_p", wallet: PRIYA.address } }, { name: "Sam", payer: { wallet: SAM.address } }, { name: "Alex" }],
  source: "plugin",
};
const trip = makeLedger({
  label: "Lisbon trip", title: "Lisbon trip", createdAt: "2026-10-18T09:00:00Z",
  members: [
    { name: "Raj", wallet: RAJ.address, handle: null, sns: null },
    { name: "Priya", wallet: PRIYA.address, handle: "priya_p", sns: null },
    { name: "Sam", wallet: SAM.address, handle: null, sns: null },
    { name: "Alex", wallet: null, handle: null, sns: null },
  ],
});
await write("ledgers.create.req.json", createReq);
await write("ledgers.create.res.json", publicLedger(trip));

// ---- 2. add_expense x5 (the acceptance ledger: 4 people, 5 expenses, 3 payers), the receipt one as the fixture body
const RECEIPT_ITEMS = [
  { description: "Bacalhau", amount: "18.5", members: [0] },
  { description: "Risotto", amount: "16.9", members: [1] },
  { description: "Octopus to share", amount: "21", members: [2, 3] },
  { description: "Olives and bread", amount: "9.99", members: [0, 1, 2] },
  { description: "Vinho verde", amount: "24", members: [0, 1, 2, 3] },
  { description: "Espressos", amount: "7.01", members: [1, 3] },
];
addExpense(trip, RAJ, "2026-10-18T09:05:00Z", { description: "Apartment, 3 nights", paid_by: 0, amount: "120", split: "even" });
addExpense(trip, PRIYA, "2026-10-18T09:06:00Z", { description: "Groceries", paid_by: 1, amount: "45.5", split: "even", among: [1, 2, 3] });
addExpense(trip, SAM, "2026-10-18T09:07:00Z", { description: "Car rental", paid_by: 2, amount: "60", split: "shares", shares: [{ member: 0, shares: "1" }, { member: 2, shares: "2" }, { member: 3, shares: "1" }] });
addExpense(trip, RAJ, "2026-10-18T09:08:00Z", { description: "Museum tickets", paid_by: 0, amount: "33.33", split: "exact", amounts: [{ member: 1, amount: "13.33" }, { member: 3, amount: "20" }] });
const expenseReq = addExpense(trip, RAJ, "2026-10-18T09:09:00Z", {
  description: "Dinner at Taberna", paid_by: 1, amount: "114.13", split: "items", items: RECEIPT_ITEMS, tax: "6.73", tip: "10",
});
await write("ledgers.expense.req.json", expenseReq);
await write("ledgers.expense.res.json", { added: 4, ledger: publicLedger(trip) });

// ---- 3. settle_up, signed by Sam with his own wallet: 3 requests, then Alex pays Raj
const settled = settleUp(trip, SAM, "2026-10-18T10:00:00Z", "Sam");
await write("ledgers.settle.req.json", settled.body);
await write("ledgers.settle.res.json", { round: settled.round, created: settled.created, unpayable: settled.unpayable, ledger: publicLedger(trip) });
const first = settled.created[0];
trip.requests.set(first.request.id, {
  status: "paid", payer: null,
  paid: { signature: base58Encode(createHash("sha512").update("F6 fixture: Alex pays Raj").digest()), payer: key("F6 fixture: Alex's own wallet"), amount: first.amount, at: "2026-10-18T10:30:00Z", rail: "solana_pay" },
});
await write("ledgers.get.res.json", publicLedger(trip));

// ---- 4. a local-currency receipt: the same items in euros, locked at one rate
const porto = makeLedger({
  label: "Porto weekend", title: "Porto weekend", createdAt: "2026-10-18T11:00:00Z",
  members: [
    { name: "Raj", wallet: RAJ.address, handle: null, sns: null },
    { name: "Priya", wallet: PRIYA.address, handle: null, sns: null },
    { name: "Sam", wallet: null, handle: null, sns: null },
    { name: "Alex", wallet: null, handle: null, sns: null },
  ],
});
const fiatReq = addExpense(porto, RAJ, "2026-10-18T11:05:00Z", {
  description: "Dinner", paid_by: 0, amount: "114.13", currency: "EUR", split: "items", items: RECEIPT_ITEMS, tax: "6.73", tip: "10",
}, { rate: "0.858369", rate_source: "api.coinbase.com, checked against open.er-api.com", quoted_at: "2026-10-18T11:05:01Z" });
await write("ledgers.expense.fiat.req.json", fiatReq);
await write("ledgers.expense.fiat.res.json", { added: 0, ledger: publicLedger(porto) });

console.log(`wrote 9 ledger fixtures (trip ${trip.id}, porto ${porto.id})`);
