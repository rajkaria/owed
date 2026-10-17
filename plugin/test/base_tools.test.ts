import { test } from "node:test";
import assert from "node:assert/strict";
import { REFUSE_BASE_OFFLINE, REFUSE_BASE_SOLANA_RAIL, REFUSE_BASE_TAMPERED, checkBaseTerms } from "../src/base-request.ts";
import { BASE_USDC, eip681Transfer } from "../src/evm.ts";
import { x402OutputSchema } from "../src/paybox.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { checkPayments, outputSchema as checkOutput } from "../src/tools/check_payments.ts";
import { inputSchema as payInput, outputSchema as payOutput, payLink } from "../src/tools/pay_link.ts";
import { inputSchema as verifyInput, verifyPayeeTool } from "../src/tools/verify_payee.ts";
import { fixture, json, makeDeps, SENDER, textOf, type Route } from "./helpers.ts";

// W3-B Base requests through the plugin's tools, against the contract fixtures (base.*.json):
// ask_for_money chain "base", pay_link (x402 on eip155:8453 or "pay from a Base wallet", never a
// Solana transaction), check_payments (Basescan links), verify_payee (Base terms checked against the id).

const KEY = "io.paybox/transactionProposal";
const created = fixture("base.create-request.res.json");
const paid = fixture("base.get-request.res.json");
const open = { ...paid, status: "open", paid: null };
const ID = created.id as string; // BWPPcRxKPi21
const RECIPIENT = created.pay_url.match(/address=(0x[0-9a-fA-F]{40})/)[1] as string;
const OTHER_EVM = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const AMOUNT = "500000";

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
function refusalText(r: Result): string {
  assert.ok(r.isError === true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
}

// ---- ask_for_money chain "base"

const askArgs = (extra: Record<string, unknown> = {}) => askInput.parse({ recipient: RECIPIENT, amount: "0.5", chain: "base", payer_name: "Priya", for: "coffee", requester_name: "Raj", ...extra });

test("ask_for_money chain base: POSTs chain base with the checksummed recipient, checks the reply's id and EIP-681 link", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, created) } });
  const r = await askForMoney(askArgs({ recipient: RECIPIENT.toLowerCase() }), deps) as Result;
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(rec.calls[0]!.body, { recipient: RECIPIENT, amount: "0.5", token: "USDC", source: "plugin", chain: "base", payer_name: "Priya", for: "coffee", requester_name: "Raj" });
  const out = askOutput.parse(r.structuredContent);
  assert.equal(out.chain, "base");
  assert.equal(out.pay_url, eip681Transfer(RECIPIENT, 500_000n));
  assert.equal(out.solana_pay_url, null);
  assert.equal(out.link, created.link);
  assert.match(out.share_text, /0\.5 USDC on Base\. Pay from any Base wallet here: https:\/\/www\.getowed\.xyz\/r\/BWPPcRxKPi21$/);
  assert.match(textOf(r), /^Request ready: 0\.5 USDC on Base from Priya for "coffee"\./);
  assert.equal(rec.readiness.length + rec.findPayment.length, 0, "the plugin never reads a chain to ask");
});

test("ask_for_money chain base refuses a wrong checksum, SOL, and a 0x address without chain base, before any network", async () => {
  const { deps, rec } = makeDeps({ routes: {} });
  const badChecksum = RECIPIENT.slice(0, -1) + (RECIPIENT.endsWith("d") ? "D" : "d");
  assert.match(refusalText(await askForMoney(askArgs({ recipient: badChecksum }), deps) as Result), /wrong checksum/);
  assert.match(refusalText(await askForMoney(askArgs({ token: "SOL" }), deps) as Result), /USDC only/);
  assert.match(refusalText(await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "1" }), deps) as Result), /pass chain: "base"/);
  assert.match(refusalText(await askForMoney(askArgs({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs" }), deps) as Result), /Base \(0x/);
  assert.equal(rec.calls.length, 0);
});

test("ask_for_money chain base: no offline fallback, and a reply that pays anything else is refused", async () => {
  const down = makeDeps({ routes: { "POST /api/v1/requests": () => "network_error" } });
  assert.equal(refusalText(await askForMoney(askArgs(), down.deps) as Result), REFUSE_BASE_OFFLINE);
  const tampered: Array<[string, unknown]> = [
    ["another recipient in pay_url", { ...created, pay_url: eip681Transfer(OTHER_EVM, 500_000n) }],
    ["another amount", { ...created, pay_url: eip681Transfer(RECIPIENT, 500_001n) }],
    ["an id that doesn't hash the terms", { ...created, id: "JArQ6g9JvoWr" }],
    ["a Solana reply", { ...created, chain: undefined }],
    ["a Solana Pay URL", { ...created, solana_pay_url: "solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=0.5" }],
  ];
  for (const [what, body] of tampered) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, body) } });
    assert.match(refusalText(await askForMoney(askArgs(), deps) as Result), /doesn't match this request/, what);
  }
});

// ---- pay_link on a Base request

const V2 = (over: Record<string, unknown> = {}) => ({ scheme: "exact", network: "eip155:8453", amount: AMOUNT, asset: BASE_USDC, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });
const V1 = (over: Record<string, unknown> = {}) => ({ scheme: "exact", network: "base", maxAmountRequired: AMOUNT, asset: BASE_USDC, payTo: RECIPIENT, resource: `https://owed-omega.vercel.app/x/${ID}`, description: "Owed", mimeType: "application/json", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });
function challenge(v2 = [V2()], v1 = [V1()]): Response {
  const header = Buffer.from(JSON.stringify({ x402Version: 2, error: "required", resource: { url: "x" }, accepts: v2 })).toString("base64");
  return new Response(JSON.stringify({ x402Version: 1, error: "required", accepts: v1 }), { status: 402, headers: { "content-type": "application/json", "payment-required": header } });
}
const payRoutes = (x: Route = () => challenge(), request: unknown = open): Record<string, Route> => ({
  [`GET /api/v1/requests/${ID}`]: () => json(200, request),
  [`GET /x/${ID}`]: x,
});
const payArgs = (extra: Record<string, unknown> = {}) => payInput.parse({ link: `https://www.getowed.xyz/r/${ID}`, sender: SENDER, ...extra });

test("pay_link on a Base request proposes x402 on eip155:8453 at /x/<id> for exactly the amount, no Solana transaction", async () => {
  const { deps, rec } = makeDeps({ routes: payRoutes() });
  const r = await payLink(payArgs(), deps) as Result;
  assert.ok(!r.isError, textOf(r));
  const proposal = x402OutputSchema.parse(payOutput.parse(r.structuredContent))[KEY];
  assert.equal(proposal.chain, "eip155:8453");
  assert.equal(proposal.request.url, `https://owed-omega.vercel.app/x/${ID}`);
  assert.equal(proposal.payment.maxAmount, AMOUNT);
  assert.equal(proposal.payment.asset.toLowerCase(), BASE_USDC.toLowerCase());
  assert.match(textOf(r), /^Pay 0\.5 USDC on Base to 0x5a…eAed over x402\. Requester's note, unverified: "coffee"\./);
  assert.match(textOf(r), /Payee not verified: no domain on this request\./);
  assert.equal(rec.built.length + rec.readiness.length, 0, "no Solana transaction, no Solana balance read");
  // A 0x sender works too (the user's Base wallet), and so does rail x402.
  const evmSender = await payLink(payArgs({ sender: OTHER_EVM, rail: "x402" }), makeDeps({ routes: payRoutes() }).deps) as Result;
  assert.ok(!evmSender.isError, textOf(evmSender));
});

test("pay_link on a Base request: x402 unavailable or mismatched -> pay it from a Base wallet, with the link", async () => {
  const wallet = eip681Transfer(RECIPIENT, 500_000n);
  const unavailable = await payLink(payArgs(), makeDeps({ routes: payRoutes(() => json(503, { error: { code: "upstream_unavailable", message: "the x402 facilitator is unavailable" } })) }).deps) as Result;
  const text = refusalText(unavailable);
  assert.match(text, /can't offer this Base payment to PayBox right now \(Owed's x402 endpoint can't take it \(HTTP 503: the x402 facilitator is unavailable\)\)/);
  assert.ok(text.includes(wallet) && text.includes(`/r/${ID}`), text);
  assert.ok(!("structuredContent" in unavailable));
  for (const [v2, v1] of [[[V2({ payTo: OTHER_EVM })], [V1()]], [[V2()], [V1({ maxAmountRequired: "500001" })]], [[V2({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })], [V1()]], [[V2(), V2({ asset: "0x4200000000000000000000000000000000000006" })], [V1()]]]) {
    const r = await payLink(payArgs(), makeDeps({ routes: payRoutes(() => challenge(v2, v1)) }).deps) as Result;
    assert.match(refusalText(r), /asks for a different payment than the request itself/);
  }
  const down = await payLink(payArgs(), makeDeps({ routes: payRoutes(() => "network_error") }).deps) as Result;
  assert.match(refusalText(down), /couldn't be reached/);
});

test("pay_link on a Base request refuses tampered terms, rail solana_pay, paying yourself, and amounts over the limit", async () => {
  const tampered = [
    { ...open, recipient: OTHER_EVM, pay_url: eip681Transfer(OTHER_EVM, 500_000n) },
    { ...open, amount: "0.6", pay_url: eip681Transfer(RECIPIENT, 600_000n) },
    { ...open, pay_url: eip681Transfer(OTHER_EVM, 500_000n) },
    { ...open, recipient: RECIPIENT.toLowerCase() },
    { ...open, token: "SOL" },
  ];
  for (const body of tampered) {
    const { deps, rec } = makeDeps({ routes: payRoutes(undefined, body) });
    assert.equal(refusalText(await payLink(payArgs(), deps) as Result), REFUSE_BASE_TAMPERED);
    assert.ok(!rec.calls.some((c) => c.url.includes("/x/")), "refused before reading the x402 challenge");
  }
  assert.match(refusalText(await payLink(payArgs({ rail: "solana_pay" }), makeDeps({ routes: payRoutes() }).deps) as Result), new RegExp(REFUSE_BASE_SOLANA_RAIL.replace(/[.]/g, "\\.")));
  assert.match(refusalText(await payLink(payArgs({ sender: RECIPIENT.toLowerCase() }), makeDeps({ routes: payRoutes() }).deps) as Result), /your own wallet/);
  assert.match(refusalText(await payLink(payArgs({ max_amount: "0.4" }), makeDeps({ routes: payRoutes() }).deps) as Result), /above your limit of 0\.4 USDC/);
  assert.match(refusalText(await payLink(payArgs(), makeDeps({ routes: payRoutes(undefined, paid) }).deps) as Result), /already paid/);
  assert.match(refusalText(await payLink(payArgs(), makeDeps({ routes: payRoutes(() => json(200, { paid: true })) }).deps) as Result), /already paid/);
  // A Solana request still needs a Solana sender.
  const solana = fixture("get-request.res.json");
  const sol = await payLink(payInput.parse({ link: "https://www.getowed.xyz/r/JArQ6g9JvoWr", sender: OTHER_EVM }),
    makeDeps({ routes: { "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, { ...solana, status: "open", paid: null }) } }).deps) as Result;
  assert.match(refusalText(sol), /request is on Solana: sender must be/);
});

test("checkBaseTerms: the id, recipient, amount and EIP-681 link must agree", () => {
  const deps = makeDeps().deps;
  assert.deepEqual(checkBaseTerms(open, ID, deps), { recipient: RECIPIENT, amountAtomic: 500_000n });
  assert.equal(checkBaseTerms(open, "JArQ6g9JvoWr", deps), REFUSE_BASE_TAMPERED);
  assert.equal(checkBaseTerms({ ...open, reference: "AZLsgyxKZQ9fiqCig4G8drfgCtB96ZfcLQsEQNKmPQ5z" }, ID, deps), REFUSE_BASE_TAMPERED);
});

// ---- check_payments and verify_payee

test("check_payments: a paid Base request links to Basescan and says Base; a bare ethereum: link is explained", async () => {
  const status = fixture("base.status.res.json");
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, status) } });
  const r = await checkPayments({ requests: [ID, "JArQ6g9JvoWr", eip681Transfer(RECIPIENT, 500_000n)] }, deps) as Result;
  const out = checkOutput.parse(r.structuredContent);
  const base = out.results[0]!;
  assert.equal(base.status, "paid");
  assert.equal(base.chain, "base");
  assert.equal(base.explorer_url, `https://basescan.org/tx/${status.results[0].signature}`);
  assert.equal(out.results[1]!.chain, undefined);
  assert.equal(out.results[2]!.status, "invalid");
  assert.match(out.results[2]!.error!, /Base payment link/);
  assert.match(textOf(r), /Paid, request BWPPcRxKPi21 \(Base\): 0\.5 USDC from 0xBe…64Fb: https:\/\/basescan\.org\/tx\/0xe35f/);
  assert.match(out.summary, /^1 of 3 paid · 0\.5 USDC received · 15 USDC outstanding · 1 invalid$/);
});

test("verify_payee on a Base link checks the terms against the id and reports no domain; a bad 0x checksum is refused", async () => {
  const { deps } = makeDeps({ routes: payRoutes() });
  const r = await verifyPayeeTool(verifyInput.parse({ link: `https://www.getowed.xyz/r/${ID}` }), deps) as Result;
  assert.ok(!r.isError, textOf(r));
  const out = r.structuredContent as { status: string; address: string; amount: string; token: string };
  assert.deepEqual([out.status, out.address, out.amount, out.token], ["no_domain", RECIPIENT, "0.5", "USDC"]);
  const tampered = makeDeps({ routes: payRoutes(undefined, { ...open, recipient: OTHER_EVM, pay_url: eip681Transfer(OTHER_EVM, 500_000n) }) });
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ link: ID }), tampered.deps) as Result), /don't match its id/);
  const bad = await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT.replace("a", "A"), domain: "getowed.xyz" }), makeDeps().deps) as Result;
  assert.match(refusalText(bad), /wrong checksum/);
});
