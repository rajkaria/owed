import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { addExpense, inputSchema as expenseInput, outputSchema as expenseOutput } from "../src/tools/add_expense.ts";
import { ledgerBalances, inputSchema as balancesInput, outputSchema as balancesOutput } from "../src/tools/ledger_balances.ts";
import { settleUp, inputSchema as settleInput, outputSchema as settleOutput } from "../src/tools/settle_up.ts";
import { startLedger, inputSchema as startInput, outputSchema as startOutput } from "../src/tools/start_ledger.ts";
import { buildExpense, checkLedger, expenseLead, LEDGER_CAUTION } from "../src/ledger.ts";
import { decimalToUnits } from "../src/ledger-math.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// F6 tools against the contract fixtures (contract/ledger-fixtures.mjs: fixed-seed wallets sign every expense and
// settle-up as PayBox's request_wallet_sign does). The plugin builds exactly the bodies the server takes, re-derives
// every split, balance and plan the server sends, and refuses anything that doesn't add up or wasn't signed.

const createReq = fixture("ledgers.create.req.json");
const createRes = fixture("ledgers.create.res.json");
const expenseReq = fixture("ledgers.expense.req.json");
const expenseRes = fixture("ledgers.expense.res.json");
const fiatReq = fixture("ledgers.expense.fiat.req.json");
const fiatRes = fixture("ledgers.expense.fiat.res.json");
const getRes = fixture("ledgers.get.res.json");
const settleReq = fixture("ledgers.settle.req.json");
const settleRes = fixture("ledgers.settle.res.json");
const ID = createRes.id as string;
const RAJ = createRes.owner as string;
const SAM = createRes.members[2].wallet as string;
const at = (iso: string) => () => Date.parse(iso);
type Out = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
const refused = (r: Out) => {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
};
const ok = (r: Out) => {
  assert.notEqual(r.isError, true, textOf(r));
  return r;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** A wallet the fixtures don't know. */
function stranger() {
  const seed = createHash("sha256").update("ledger tools test: a stranger").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  return { address: bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12)), sign: (m: string) => sign(null, Buffer.from(m, "utf8"), key).toString("hex") };
}

// ---------------------------------------------------------------- start_ledger

const startArgs = (patch: Record<string, unknown> = {}) => startInput.parse({
  owner: RAJ, owner_name: "Raj", title: "Lisbon trip",
  members: [{ name: "Priya", payer: { handle: "@Priya_P", wallet: createRes.members[1].wallet } }, { name: "Sam", payer: { wallet: SAM } }, { name: "Alex" }],
  ...patch,
});

test("start_ledger: sends exactly the contract body (handle normalized, owner first) and shows the ledger", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/ledgers": () => json(201, createRes) } });
  const r = ok(await startLedger(startArgs(), deps));
  assert.deepEqual(rec.calls[0]!.body, createReq);
  const out = startOutput.parse(r.structuredContent);
  assert.deepEqual([out.ledger_id, out.link, out.owner, out.caution], [ID, createRes.link, RAJ, LEDGER_CAUTION]);
  assert.deepEqual(out.members.map((m) => [m.name, m.wallet, m.handle]), [["Raj", RAJ, null], ["Priya", createRes.members[1].wallet, "priya_p"], ["Sam", SAM, null], ["Alex", null, null]]);
  const text = textOf(r);
  assert.match(text, /^Ledger ready: "Lisbon trip" with 4 people\. Page: https:\/\/www\.getowed\.xyz\/l\//);
  assert.match(text, /"Priya": @priya_p/);
  assert.match(text, /No wallet in this ledger: "Alex"\. They can owe .* but nothing can pay them through Owed\./);
  assert.match(text, /Handles are labels/);
});

test("start_ledger refuses duplicate names, the owner's wallet as a member, a shared wallet, a handle without its wallet, and a ledger the server changed", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ members: [{ name: "raj" }] }, /Two members are called "raj"/],
    [{ members: [{ name: "Priya", payer: { wallet: RAJ } }] }, /is the user's own wallet/],
    [{ members: [{ name: "Priya", payer: { wallet: SAM } }, { name: "Sam", payer: { wallet: SAM } }] }, /same wallet as another member/],
    [{ members: [{ name: "Priya", payer: { handle: "@priya" } }] }, /first call PayBox resolve_username with "@priya"/],
  ];
  for (const [patch, why] of cases) {
    const { deps, rec } = makeDeps({ routes: { "POST /api/v1/ledgers": () => json(201, createRes) } });
    assert.match(refused(await startLedger(startArgs(patch), deps)), why);
    assert.equal(rec.calls.length, 0, JSON.stringify(patch));
  }
  const swapped = clone(createRes);
  swapped.members[2].wallet = stranger().address;
  const { deps } = makeDeps({ routes: { "POST /api/v1/ledgers": () => json(201, swapped) } });
  assert.match(refused(await startLedger(startArgs(), deps)), /doesn't match what was asked/);
  const old = makeDeps({ routes: { "POST /api/v1/ledgers": () => new Response("<html>404</html>", { status: 404 }) } });
  assert.match(refused(await startLedger(startArgs(), old.deps)), /doesn't have group ledgers yet/);
  const sanctioned = makeDeps({ routes: {}, screenRecipient: async () => ({ ok: false, message: "That wallet is on the OFAC list." }) as never });
  assert.match(refused(await startLedger(startArgs(), sanctioned.deps)), /OFAC/);
});

// ---------------------------------------------------------------- add_expense

const RECEIPT = [
  { description: "Bacalhau", amount: "18.50", members: ["Raj"] },
  { description: "Risotto", amount: "16.90", members: ["Priya"] },
  { description: "Octopus to share", amount: "21.00", members: ["Alex", "Sam"] }, // any order: sent in ledger order
  { description: "Olives and bread", amount: "9.99", members: ["Raj", "Priya", "Sam"] },
  { description: "Vinho verde", amount: "24", members: ["Raj", "Priya", "Sam", "Alex"] },
  { description: "Espressos", amount: "7.01", members: ["Priya", "Alex"] },
];
const dinner = (patch: Record<string, unknown> = {}) => expenseInput.parse({
  ledger_id: ID, signer: RAJ, paid_by: "priya", amount: "114.13", description: "Dinner at Taberna", split: "items", items: RECEIPT, tax: "6.73", tip: "10.00", ...patch,
});
const ledgerRoutes = (writes: Record<string, unknown> = {}) => ({
  [`GET /api/v1/ledgers/${ID}?chain=0`]: () => json(200, createRes),
  ...writes,
});

test("add_expense, first call: the split worked out here, to the cent, and the exact message to sign; nothing sent", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T09:09:00Z"), routes: ledgerRoutes() });
  const r = ok(await addExpense(dinner(), deps));
  const out = expenseOutput.parse(r.structuredContent);
  assert.equal(out.step, "sign");
  assert.equal(out.message_to_sign, expenseReq.signed_message, "the digest covers exactly the body the server takes");
  assert.equal(out.expires_at, "2026-10-18T09:14:00Z");
  assert.deepEqual(out.shares.map((s) => [s.member, s.share]), [["Raj", "32.610246"], ["Priya", "34.84246"], ["Sam", "23.236118"], ["Alex", "23.441176"]]);
  assert.match(textOf(r), /request_wallet_sign with this wallet's credential_id and intent \{"op":"solanaMessage"/);
  assert.equal(out.shares.reduce((a, s) => a + decimalToUnits(s.share, 6), 0n), 114_130_000n, "the shares add up to the receipt exactly");
  assert.deepEqual(rec.calls.map((c) => c.method), ["GET"], "only the ledger was read");
});

test("add_expense, second call: posts the contract body once and checks what the server stored", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T09:10:00Z"), routes: ledgerRoutes({ [`POST /api/v1/ledgers/${ID}/expenses`]: () => json(201, expenseRes) }) });
  const r = ok(await addExpense(dinner({ signed_message: expenseReq.signed_message, signature: expenseReq.signature }), deps));
  assert.deepEqual(rec.calls[1]!.body, expenseReq);
  const out = expenseOutput.parse(r.structuredContent);
  assert.deepEqual([out.step, out.position, out.usdc_total, out.total, out.currency], ["added", 4, "114.13", "114.13", "USDC"]);
  assert.deepEqual(out.balances, [
    '"Raj" is owed 75.719754 USDC.', '"Priya" is owed 66.290873 USDC.', '"Sam" owes 38.402785 USDC.', '"Alex" owes 103.607842 USDC.',
  ]);
  assert.match(textOf(r), /settle_up turns the balances into payment requests/);
});

test("add_expense refuses before signing: a wallet not in the ledger, a name not in it, splits that don't add up, USD", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ signer: stranger().address }, /isn't one of them/],
    [{ paid_by: "Bob" }, /paid_by: "Bob" isn't in this ledger\. Its members are "Raj", "Priya", "Sam", "Alex"/],
    [{ tip: "9.99" }, /add up to 114120000 units, not the expense's 114130000/],
    [{ split: "exact", items: undefined, tax: undefined, tip: undefined, amounts: [{ member: "Raj", amount: "100" }] }, /exact amounts add up to/],
    [{ split: "even", items: undefined, tax: undefined, tip: undefined, among: ["Sam", "sam"] }, /among names someone twice/],
    [{ split: "even", items: undefined }, /tax and tip go with split "items"/],
    [{ currency: "USD" }, /USD needs no conversion/],
    [{ currency: "XYZ" }, /can't quote XYZ/],
  ];
  for (const [patch, why] of cases) {
    const { deps, rec } = makeDeps({ now: at("2026-10-18T09:09:00Z"), routes: ledgerRoutes() });
    assert.match(refused(await addExpense(dinner(patch), deps)), why, JSON.stringify(patch));
    assert.ok(rec.calls.every((c) => c.method === "GET"), "nothing was posted");
  }
});

test("add_expense, second call: stale, changed or forged signatures are refused without a write", async () => {
  const signed = { signed_message: expenseReq.signed_message, signature: expenseReq.signature };
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["2026-10-18T09:15:00Z", signed, /more than 5 minutes old/],
    ["2026-10-18T09:07:00Z", signed, /dated in the future/],
    ["2026-10-18T09:10:00Z", { ...signed, amount: "114.14", tip: "10.01" }, /must be exactly the message_to_sign/],
    ["2026-10-18T09:10:00Z", { ...signed, signature: stranger().sign(expenseReq.signed_message) }, /isn't from wallet/],
    ["2026-10-18T09:10:00Z", { signed_message: expenseReq.signed_message }, /Pass both signed_message and signature/],
  ];
  for (const [now, patch, why] of cases) {
    const { deps, rec } = makeDeps({ now: at(now), routes: ledgerRoutes({ [`POST /api/v1/ledgers/${ID}/expenses`]: () => json(201, expenseRes) }) });
    assert.match(refused(await addExpense(dinner(patch), deps)), why, now);
    assert.ok(rec.calls.every((c) => c.method === "GET"));
  }
});

test("add_expense refuses a server that stored something else, or whose ledger doesn't add up", async () => {
  const signed = { signed_message: expenseReq.signed_message, signature: expenseReq.signature };
  const tamper: Array<(x: typeof expenseRes) => void> = [
    (x) => { x.ledger.expenses[4].shares[0].share = "32.623798"; x.ledger.expenses[4].shares[1].share = "34.842473"; },
    (x) => { x.ledger.expenses[4].paid_by = 0; },
    (x) => { x.ledger.balances[0].net = "80"; },
    (x) => { x.ledger.expenses[0].signature = x.ledger.expenses[1].signature; },
  ];
  for (const [i, t] of tamper.entries()) {
    const bad = clone(expenseRes);
    t(bad);
    const { deps } = makeDeps({ now: at("2026-10-18T09:10:00Z"), routes: ledgerRoutes({ [`POST /api/v1/ledgers/${ID}/expenses`]: () => json(201, bad) }) });
    assert.match(refused(await addExpense(dinner(signed), deps)), /stored something other than what was signed/, String(i));
  }
  const { deps } = makeDeps({
    now: at("2026-10-18T09:10:00Z"),
    routes: ledgerRoutes({ [`POST /api/v1/ledgers/${ID}/expenses`]: () => json(400, { error: { code: "invalid_input", message: "this signature was already used; sign a fresh message to try again" } }) }),
  });
  assert.match(refused(await addExpense(dinner(signed), deps)), /Owed refused the expense: this signature was already used/);
});

test("add_expense in euros: shares to the cent, the server's rate checked share by share", async () => {
  const before = { ...clone(fiatRes.ledger), expenses: [], version: 0, fiat_beside: null };
  const id = before.id as string;
  const args = expenseInput.parse({
    ledger_id: id, signer: RAJ, paid_by: "Raj", amount: "114.13", currency: "eur", description: "Dinner", split: "items",
    items: RECEIPT, tax: "6.73", tip: "10", signed_message: fiatReq.signed_message, signature: fiatReq.signature,
  });
  const { deps, rec } = makeDeps({
    now: at("2026-10-18T11:06:00Z"),
    routes: { [`GET /api/v1/ledgers/${id}?chain=0`]: () => json(200, before), [`POST /api/v1/ledgers/${id}/expenses`]: () => json(201, fiatRes) },
  });
  const r = ok(await addExpense(args, deps));
  assert.deepEqual(rec.calls[1]!.body, fiatReq);
  const out = expenseOutput.parse(r.structuredContent);
  assert.deepEqual(out.shares.map((s) => [s.member, s.share]), [["Raj", "32.62"], ["Priya", "34.85"], ["Sam", "23.23"], ["Alex", "23.43"]]);
  assert.equal(out.rate, "0.858369");
  assert.match(textOf(r), /€114\.13 for "Dinner", paid by "Raj" = 132\.96\d* USDC/);
  // A quote that doesn't round up to the stored USDC is caught.
  const bad = clone(fiatRes);
  bad.ledger.expenses[0].shares[0].amount = "38.0";
  const tampered = makeDeps({
    now: at("2026-10-18T11:06:00Z"),
    routes: { [`GET /api/v1/ledgers/${id}?chain=0`]: () => json(200, before), [`POST /api/v1/ledgers/${id}/expenses`]: () => json(201, bad) },
  });
  assert.match(refused(await addExpense(args, tampered.deps)), /stored something other than what was signed/);
});

// ---------------------------------------------------------------- ledger_balances

test("ledger_balances: verified balances, the plan, settle-up requests with their status, and no signature", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/ledgers/${ID}`]: () => json(200, getRes) } });
  const r = ok(await ledgerBalances(balancesInput.parse({ ledger_id: ID }), deps));
  const out = balancesOutput.parse(r.structuredContent);
  assert.equal(out.verified, true);
  assert.equal(out.problems, undefined);
  assert.deepEqual(out.balances.map((b) => [b.member, b.net, b.to_settle]), [["Raj", "0", "0"], ["Priya", "66.290873", "0"], ["Sam", "-38.402785", "0"], ["Alex", "-27.888088", "0"]]);
  assert.deepEqual(out.plan, []);
  assert.deepEqual(out.requests.map((q) => [q.from, q.to, q.amount, q.status]), [["Alex", "Raj", "75.719754", "paid"], ["Sam", "Priya", "38.402785", "open"], ["Alex", "Priya", "27.888088", "open"]]);
  assert.deepEqual([out.spent, out.settled, out.chain_checked], ["372.96", false, true]);
  const text = textOf(r);
  assert.match(text, /- "Raj" is square\./);
  assert.match(text, /- "Priya" is owed 66\.290873 USDC \(66\.290873 USDC on its way to them\)\./);
  assert.match(text, /Settle-up requests: 1 of 3 settled\./);
  assert.match(text, /"Dinner at Taberna": 114\.13 USDC, paid by "Priya"/);
});

test("ledger_balances: in a local-currency ledger, the local amount beside each balance", async () => {
  const l = fiatRes.ledger;
  const { deps } = makeDeps({ routes: { [`GET /api/v1/ledgers/${l.id}`]: () => json(200, l) } });
  const r = ok(await ledgerBalances(balancesInput.parse({ ledger_id: l.id }), deps));
  const out = balancesOutput.parse(r.structuredContent);
  assert.equal(out.verified, true);
  assert.match(out.balances[0]!.net_local!, /^≈ €\d+\.\d{2}$/);
  assert.match(out.balances[1]!.net_local!, /^≈ -€\d+\.\d{2}$/);
  assert.match(textOf(r), /Amounts in EUR are approximate, at the rate locked for the latest EUR expense/);
  assert.match(textOf(r), /\(≈ €/);
});

test("ledger_balances: a server whose numbers don't add up is shown as unverified, with the plugin's own arithmetic", async () => {
  const bad = clone(getRes);
  bad.balances[1].net = "70";
  bad.expenses[2].shares[1].amount = "31";
  const { deps } = makeDeps({ routes: { [`GET /api/v1/ledgers/${ID}`]: () => json(200, bad) } });
  const out = balancesOutput.parse(ok(await ledgerBalances(balancesInput.parse({ ledger_id: ID }), deps)).structuredContent);
  assert.equal(out.verified, false);
  assert.ok(out.problems!.some((p) => /expense 3: "?Sam/.test(p) || /expense 3/.test(p)), JSON.stringify(out.problems));
  assert.ok(out.problems!.some((p) => /balances Owed's server sent don't match/.test(p)));
  assert.equal(checkLedger(getRes).problems.length, 0, "the fixture itself checks out");
});

// ---------------------------------------------------------------- settle_up

const ledgerBefore = expenseRes.ledger;
const settleRoutes = (post: unknown = settleRes, get: unknown = ledgerBefore) => ({
  [`GET /api/v1/ledgers/${ID}?chain=0`]: () => json(200, get),
  [`POST /api/v1/ledgers/${ID}/settle`]: () => json(201, post),
});

test("settle_up, first call: at most n - 1 payments and the message naming the version, count and total", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:00:00Z"), routes: settleRoutes() });
  const r = ok(await settleUp(settleInput.parse({ ledger_id: ID, signer: SAM }), deps));
  const out = settleOutput.parse(r.structuredContent);
  assert.equal(out.step, "sign");
  assert.equal(out.message_to_sign, settleReq.signed_message);
  assert.match(out.message_to_sign!, /v5: 3 requests, 142\.010627 USDC by /);
  assert.deepEqual(out.plan, [
    { from: "Alex", to: "Raj", amount: "75.719754", payable: true },
    { from: "Sam", to: "Priya", amount: "38.402785", payable: true },
    { from: "Alex", to: "Priya", amount: "27.888088", payable: true },
  ]);
  assert.equal(rec.calls.length, 1);
});

test("settle_up, second call: three requests, each checked against the plan, the creditor's wallet and its own id", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:01:00Z"), routes: settleRoutes() });
  const r = ok(await settleUp(settleInput.parse({ ledger_id: ID, signer: SAM, signed_message: settleReq.signed_message, signature: settleReq.signature }), deps));
  assert.deepEqual(rec.calls.map((c) => c.method), ["POST"], "the signed message names the version: no read needed");
  assert.deepEqual(rec.calls[0]!.body, settleReq);
  const out = settleOutput.parse(r.structuredContent);
  assert.equal(out.step, "settled");
  assert.deepEqual(out.requests!.map((q) => [q.from, q.to, q.amount, q.addressed_to?.wallet ?? null]), [
    ["Alex", "Raj", "75.719754", null], ["Sam", "Priya", "38.402785", SAM], ["Alex", "Priya", "27.888088", null],
  ]);
  assert.match(out.requests![0]!.share_text, /^Hi Alex! Settling up 'Lisbon trip': you owe Raj 75\.719754 USDC\. Pay with any Solana wallet, or your own agent in PayBox, here: https:\/\/www\.getowed\.xyz\/r\//);
  assert.equal(out.unpayable, undefined);
  const text = textOf(r);
  assert.match(text, /3 requests, 142\.010627 USDC/);
  assert.match(text, /"Sam" pays "Priya" 38\.402785 USDC: \S+ \(in their own agent's inbox, what_do_i_owe\)/);
  assert.match(text, /"Alex" pays "Raj" 75\.719754 USDC: \S+ \(no wallet in the ledger: send them this link\)/);
});

test("settle_up refuses requests that don't pay what was planned, to whom, or that don't hash their terms", async () => {
  const signed = settleInput.parse({ ledger_id: ID, signer: SAM, signed_message: settleReq.signed_message, signature: settleReq.signature });
  const tamper: Array<[(x: typeof settleRes) => void, RegExp]> = [
    [(x) => { x.created[0].request.recipient = SAM; }, /payment 1 isn't the planned one/],
    [(x) => { x.created[1].request.payer = null; }, /isn't addressed to Sam/],
    [(x) => { x.created[2].request.reference = x.created[1].request.reference; }, /doesn't hash its terms/],
    [(x) => { x.created[0].request.solana_pay_url = x.created[0].request.solana_pay_url.replace("amount=75.719754", "amount=75.719755"); }, /Solana Pay link pays something else/],
    [(x) => { x.created[0].request.note = "Totally legit"; }, /doesn't name the ledger/],
    [(x) => { x.round = 4; }, /a different ledger or version/],
    [(x) => { x.created.pop(); }, /not the requests that were signed for/],
  ];
  for (const [t, why] of tamper) {
    const bad = clone(settleRes);
    t(bad);
    const { deps } = makeDeps({ now: at("2026-10-18T10:01:00Z"), routes: settleRoutes(bad) });
    assert.match(refused(await settleUp(signed, deps)), why);
  }
});

test("settle_up: nothing to settle, nobody payable, a wallet not in the ledger, a ledger that doesn't add up, a wrong message", async () => {
  const nothing = makeDeps({ now: at("2026-10-18T10:05:00Z"), routes: settleRoutes(settleRes, settleRes.ledger) });
  const r = ok(await settleUp(settleInput.parse({ ledger_id: ID, signer: SAM }), nothing.deps));
  assert.equal(settleOutput.parse(r.structuredContent).step, "nothing");
  assert.match(textOf(r), /Nothing new to settle in "Lisbon trip": 3 settle-up requests are still open/);

  const outsider = makeDeps({ now: at("2026-10-18T10:00:00Z"), routes: settleRoutes(settleRes, ledgerBefore) });
  assert.match(refused(await settleUp(settleInput.parse({ ledger_id: ID, signer: stranger().address }), outsider.deps)), /isn't one of them/);

  const broken = clone(ledgerBefore);
  broken.expenses[1].amount = "46";
  const bad = makeDeps({ now: at("2026-10-18T10:00:00Z"), routes: settleRoutes(settleRes, broken) });
  assert.match(refused(await settleUp(settleInput.parse({ ledger_id: ID, signer: SAM }), bad.deps)), /doesn't add up .* nothing was created/);

  const wrong = makeDeps({ now: at("2026-10-18T10:01:00Z"), routes: settleRoutes() });
  const otherLedger = settleReq.signed_message.replace(ID, "1111111111ab");
  assert.match(refused(await settleUp(settleInput.parse({ ledger_id: ID, signer: SAM, signed_message: otherLedger, signature: settleReq.signature }), wrong.deps)), /must be exactly the message_to_sign settle_up gave/);
  assert.equal(wrong.rec.calls.length, 0);
});

test("settle_up: when everyone owed has no wallet, nothing can be created", async () => {
  // A real, signed two-person ledger: Bob paid 10 for both of them, and Bob has no wallet in it.
  const owner = stranger();
  const l = {
    id: "Fab1caTedLdg", link: "https://www.getowed.xyz/l/Fab1caTedLdg", title: "Flat", owner: owner.address, created_at: "2026-10-18T09:00:00Z", version: 1,
    flags: [], caution: LEDGER_CAUTION, settlements: [], fiat_beside: null, settled: false, chain_checked: true,
    members: [{ position: 0, name: "Raj", wallet: owner.address, handle: null, sns: null }, { position: 1, name: "Bob", wallet: null, handle: null, sns: null }],
    expenses: [] as unknown[],
    balances: [
      { member: 0, paid: "0", share: "5", sent: "0", received: "0", net: "-5", pending_out: "0", pending_in: "0", to_settle: "-5" },
      { member: 1, paid: "10", share: "5", sent: "0", received: "0", net: "5", pending_out: "0", pending_in: "0", to_settle: "5" },
    ],
    plan: [{ from: 0, to: 1, amount: "5", payable: false }],
    totals: { spent: "10", expense_count: 1, open_requests: 0 },
  };
  const built = buildExpense(l as never, { paid_by: "Bob", amount: "10", split: "even" });
  const message = `${expenseLead(l.id, built, owner.address)}2026-10-18T09:00:00Z`;
  l.expenses = [{
    position: 0, description: null, paid_by: 1, split: "even", currency: "USDC", total: "10", amount: "10", tax: null, tip: null, fiat: null, items: null,
    shares: [{ member: 0, weight: null, share: "5", amount: "5" }, { member: 1, weight: null, share: "5", amount: "5" }],
    recorded_by: owner.address, recorded_at: "2026-10-18T09:00:00Z", signed_message: message, signature: owner.sign(message), flags: [],
  }];
  assert.deepEqual(checkLedger(l as never).problems, [], "a ledger that checks out");
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:00:00Z"), routes: { [`GET /api/v1/ledgers/${l.id}?chain=0`]: () => json(200, l) } });
  assert.match(refused(await settleUp(settleInput.parse({ ledger_id: l.id, signer: owner.address }), deps)), /has no wallet in the ledger, so no request can pay them: "Raj" pays "Bob" 5 USDC \("Bob" has no wallet/);
  assert.equal(rec.calls.length, 1);
});
