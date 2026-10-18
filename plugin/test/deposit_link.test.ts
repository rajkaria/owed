import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { checkDepositUrl, DEPOSIT_HINT, isDepositHost } from "../src/deposit-link.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { createInvoice, inputSchema as invoiceInput, outputSchema as invoiceOutput } from "../src/tools/create_invoice.ts";
import { checkPayments, outputSchema as checkOutput } from "../src/tools/check_payments.ts";
import { ledgerMessage, outputSchema as whoOutput, whoOwesMe } from "../src/tools/who_owes_me.ts";
import { fixture, json, makeDeps, RECIPIENT, textOf } from "./helpers.ts";

// F3 PayBox Open Deposit link in the plugin: what deposit_url accepts (the same rule as web/lib/deposit-link.ts),
// ask_for_money and create_invoice sending it and checking the server stored it, and the match_payments hint in
// check_payments and who_owes_me. Replies are the contract fixtures (contract/autopay-fixtures.mjs).

const LINK = "https://deposit.paybox.sh/d/7f3a9c2e";
type Out = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
const refused = (r: Out) => {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
};

test("checkDepositUrl: https on paybox.sh, no credentials or port, 512 characters, USDC on Solana asked in USDC", () => {
  assert.deepEqual(checkDepositUrl(LINK, { token: "USDC" }), { ok: true, url: LINK });
  assert.deepEqual(checkDepositUrl("https://PayBox.sh/deposit/x", { token: "USDC" }), { ok: true, url: "https://paybox.sh/deposit/x" });
  const no = (input: string, ctx: Parameters<typeof checkDepositUrl>[1] = { token: "USDC" }) => {
    const r = checkDepositUrl(input, ctx);
    assert.equal(r.ok, false, input);
    return (r as { message: string }).message;
  };
  assert.match(no("https://evil.example/d/1"), /PayBox Deposit link on paybox\.sh.*Nothing was created\./);
  assert.match(no("https://paybox.sh.evil.example/d/1"), /on paybox\.sh/);
  assert.match(no("http://deposit.paybox.sh/d/1"), /must be an https link/);
  assert.match(no("https://a:b@deposit.paybox.sh/d/1"), /user name or password/);
  assert.match(no("https://deposit.paybox.sh:444/d/1"), /port/);
  assert.match(no(`https://deposit.paybox.sh/${"x".repeat(510)}`), /longer than 512 characters/);
  assert.match(no("nonsense"), /https link PayBox get_deposit_link returned/);
  assert.match(no(LINK, { token: "SOL" }), /USDC requests on Solana only/);
  assert.match(no(LINK, { token: "USDC", chain: "base" }), /USDC requests on Solana only/);
  assert.match(no(LINK, { token: "USDC", currency: "INR" }), /Ask in USDC \(not a local currency\)/);
  assert.equal(isDepositHost("xpaybox.sh"), false);
});

test("ask_for_money: sends deposit_url beside the request (never in its id) and says how a payment through it counts", async () => {
  const created = fixture("deposit.create-request.res.json");
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, created) } });
  const r = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "12", for: "team lunch", requester_name: "Raj", deposit_url: LINK }), deps);
  assert.notEqual(r.isError, true, textOf(r));
  assert.deepEqual(rec.calls[0]!.body, fixture("deposit.create-request.req.json"));
  const out = askOutput.parse(r.structuredContent);
  assert.equal(out.deposit_url, LINK);
  assert.equal(out.id, created.id);
  const text = textOf(r);
  assert.match(text, /PayBox Deposit link stored with the request: Owed shows it on the pay page for 24 hours where Owed has PayBox Deposit switched on \(it's off until tested\)\./);
  assert.match(text, /Owed can't check, so a payment through it isn't counted on its own: once they pay, run match_payments to match it\./);
  // A server that dropped the link (an older one) means the link isn't used.
  const { deps: old } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, { ...created, deposit_url: undefined }) } });
  assert.match(refused(await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "12", for: "team lunch", requester_name: "Raj", deposit_url: LINK }), old)), /didn't store the PayBox Deposit link/);
});

test("ask_for_money: a bad deposit_url, a SOL, Base or local-currency ask is refused before anything is sent", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ deposit_url: "https://evil.example/x" }, /on paybox\.sh/],
    [{ deposit_url: LINK, token: "SOL" }, /USDC requests on Solana only/],
    [{ deposit_url: LINK, chain: "base", recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, /USDC requests on Solana only/],
    [{ deposit_url: LINK, currency: "INR", amount: "1200" }, /Ask in USDC/],
  ];
  for (const [extra, why] of cases) {
    const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, fixture("deposit.create-request.res.json")) } });
    assert.match(refused(await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "12", ...extra }), deps)), why);
    assert.equal(rec.calls.length, 0);
  }
});

const invoiceArgs = (extra: Record<string, unknown> = {}) => invoiceInput.parse({
  recipient: RECIPIENT, business_name: "Northwind Translation", client_name: "Lena",
  items: [
    { description: "Translation, English to Hindi (pages)", quantity: 3, unit_price: "0.2" },
    { description: "Proofreading", unit_price: "0.25" },
    { description: "Call to review terms (hours)", quantity: "1.5", unit_price: "0.1" },
  ],
  due_date: "2026-10-31", invoice_number: "NT-2026-017", notes: "Thanks, Lena. Payment within 14 days, please.", ...extra,
});

test("create_invoice: a plain USDC invoice carries the link; installments, an early price and SOL are refused", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, fixture("deposit.invoices.create.res.json")) } });
  const r = await createInvoice(invoiceArgs({ deposit_url: LINK }), deps);
  assert.notEqual(r.isError, true, textOf(r));
  assert.deepEqual(rec.calls[0]!.body, fixture("deposit.invoices.create.req.json"));
  assert.equal(invoiceOutput.parse(r.structuredContent).deposit_url, LINK);
  assert.match(textOf(r), /PayBox Deposit link stored with the invoice/);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ deposit_url: LINK, installments: { count: 2 } }, /can't carry a PayBox Deposit link/],
    [{ deposit_url: LINK, early_discount: { percent: "5", until: "2026-10-24" } }, /can't carry a PayBox Deposit link/],
    [{ deposit_url: LINK, token: "SOL" }, /USDC invoices on Solana only/],
    [{ deposit_url: "http://deposit.paybox.sh/x" }, /https link/],
  ];
  for (const [extra, why] of cases) {
    const { deps: d, rec: r2 } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, fixture("deposit.invoices.create.res.json")) } });
    assert.match(refused(await createInvoice(invoiceArgs(extra), d)), why);
    assert.equal(r2.calls.length, 0);
  }
  const { deps: old } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, fixture("invoices.create.res.json")) } });
  assert.match(refused(await createInvoice(invoiceArgs({ deposit_url: LINK }), old)), /didn't store the PayBox Deposit link with the invoice/);
});

test("check_payments: an open request with a deposit link says to run match_payments if they paid through it", async () => {
  const status = fixture("deposit.status.res.json");
  const { deps } = makeDeps({ now: () => Date.parse("2026-10-18T12:00:00Z"), routes: { "POST /api/v1/status": () => json(200, status) } });
  const r = await checkPayments({ requests: [status.results[0].id] }, deps);
  const out = checkOutput.parse(r.structuredContent);
  assert.equal(out.results[0]!.deposit_link, true);
  assert.ok(textOf(r).includes(DEPOSIT_HINT));
  // Once paid, no hint.
  const paid = { results: [{ ...status.results[0], status: "paid", amount_paid: "12", payer: RECIPIENT, signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", paid_at: "2026-10-18T11:30:00Z" }] };
  const { deps: d2 } = makeDeps({ now: () => Date.parse("2026-10-18T12:00:00Z"), routes: { "POST /api/v1/status": () => json(200, paid) } });
  assert.ok(!textOf(await checkPayments({ requests: [status.results[0].id] }, d2)).includes(DEPOSIT_HINT));
});

test("who_owes_me: the same hint on an open request that carries a deposit link", async () => {
  const seed = createHash("sha256").update("owed test signer: deposit_link.test.ts").digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const me = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  const now = Date.parse("2026-10-17T10:30:00Z");
  const message = ledgerMessage(me, now);
  const signature = sign(null, Buffer.from(message, "utf8"), priv).toString("hex");
  const ledger = fixture("ledger.res.json");
  const answer = { ...ledger, recipient: me, open: ledger.open.map((e: Record<string, unknown>, i: number) => (i === 0 ? { ...e, deposit_link: true } : e)) };
  const { deps } = makeDeps({ now: () => now + 60_000, routes: { "POST /api/v1/ledger": () => json(200, answer) } });
  const r = await whoOwesMe({ recipient: me, signed_message: message, signature }, deps);
  assert.notEqual((r as { isError?: boolean }).isError, true, textOf(r));
  const out = whoOutput.parse(r.structuredContent);
  assert.equal(out.open![0]!.deposit_link, true);
  assert.equal(ledger.open[0].status, "open");
  assert.equal(textOf(r).split(DEPOSIT_HINT).length - 1, 1, "once, on that line only");
});
