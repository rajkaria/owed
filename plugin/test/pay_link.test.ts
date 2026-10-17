import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaOutputSchema } from "../src/paybox.ts";
import { inputSchema, payLink, REFUSE_ALREADY_PAID, REFUSE_TAMPERED, REFUSE_TRANSACTION_REQUEST, REFUSE_UNVERIFIABLE } from "../src/tools/pay_link.ts";
import { requestIdFor } from "../src/request-id.ts";
import { fixture, html, json, makeDeps, RECIPIENT, REFERENCE, SENDER, textOf, USDC_MINT, usingReal } from "./helpers.ts";

const KEY = "io.paybox/transactionProposal";
const paidRequest = fixture("get-request.res.json");
const openRequest = { ...paidRequest, status: "open", paid: null };
const owedRoutes = (body: unknown, status = 200) => ({ "GET /api/v1/requests/JArQ6g9JvoWr": () => json(status, body) });
const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({ link: "https://owed.link/r/JArQ6g9JvoWr", sender: SENDER, ...extra });

type Result = Awaited<ReturnType<typeof payLink>>;
function isRefusal(r: Result): boolean {
  return "isError" in r && r.isError === true;
}
function refusalText(r: Result): string {
  assert.ok(isRefusal(r), `expected a refusal, got: ${textOf(r)}`);
  assert.equal("structuredContent" in r, false);
  return textOf(r);
}
function proposal(r: Result) {
  assert.ok(!isRefusal(r), `unexpected refusal: ${textOf(r)}`);
  const sc = (r as { structuredContent: unknown }).structuredContent;
  return solanaOutputSchema.parse(sc)[KEY];
}

test("pays an open Owed request: checks readiness, builds the tx, proposes it with a quoted preview", async () => {
  const { deps, rec } = makeDeps({ routes: owedRoutes(openRequest) });
  const result = await payLink(input(), deps);
  const p = proposal(result);
  assert.equal(p.kind, "solana");
  assert.equal(p.chain, "solana:mainnet");
  const expires = Date.parse(p.expiresAt);
  assert.ok(expires > Date.now() && expires <= Date.now() + 300_000);
  assert.deepEqual(rec.readiness, [{ sender: SENDER, recipient: RECIPIENT, token: "USDC", amountAtomic: 15_000_000n }]);
  assert.equal(rec.built.length, 1);
  const built = rec.built[0]!;
  assert.equal(built.sender, SENDER);
  assert.equal(built.token, "USDC");
  assert.equal(built.amountAtomic, 15_000_000n);
  assert.equal(built.createRecipientAta, false);
  assert.equal(built.request.recipient, RECIPIENT);
  assert.equal(built.request.splToken, USDC_MINT);
  assert.deepEqual(built.request.references, [REFERENCE]);
  assert.equal(built.request.memo, "owed:JArQ6g9JvoWr");
  assert.equal(p.transaction.transactionBase64, deps.buildTransferTx(built).transactionBase64);
  assert.equal(textOf(result).split("\n")[0],
    'Pay 15 USDC to FN6G…cbvs. Requester\'s note, unverified: "dinner", "Thanks for coming!". Requester\'s name, unverified: "Raj". Approve in PayBox to send.');
  assert.equal(textOf(result).split("\n")[1], `Recipient: ${RECIPIENT}`);
});

test("preview text matches the SPEC sentence when only a for-text is present", async () => {
  const { deps } = makeDeps({ routes: owedRoutes({ ...openRequest, note: null, requester_name: null, payer_name: null }) });
  const text = textOf(await payLink(input({ link: "JArQ6g9JvoWr" }), deps));
  assert.equal(text.split("\n")[0], 'Pay 15 USDC to FN6G…cbvs. Requester\'s note, unverified: "dinner". Approve in PayBox to send.');
});

test(`refuses a paid request: "${REFUSE_ALREADY_PAID}"`, async () => {
  const { deps, rec } = makeDeps({ routes: owedRoutes(paidRequest) });
  assert.equal(refusalText(await payLink(input(), deps)), "This request is already paid.");
  assert.equal(rec.readiness.length + rec.built.length, 0);
});

test("refuses Solana Pay transaction requests with the SPEC text", async () => {
  assert.equal(REFUSE_TRANSACTION_REQUEST, "This is a Solana Pay checkout link (transaction request). Owed pays transfer links only; open it in a wallet app instead.");
  for (const link of ["solana:https%3A%2F%2Fcheckout.example.com%2Fapi%2Fpay%3Forder%3D1", "solana:https://checkout.example.com/api/pay"]) {
    const { deps, rec } = makeDeps();
    assert.equal(refusalText(await payLink(input({ link }), deps)), REFUSE_TRANSACTION_REQUEST);
    assert.equal(rec.calls.length + rec.readiness.length, 0);
  }
});

test("refuses amounts above max_amount, allows equal", async () => {
  const { deps, rec } = makeDeps({ routes: owedRoutes(openRequest) });
  assert.equal(refusalText(await payLink(input({ max_amount: "10" }), deps)),
    "This request is for 15 USDC, above your limit of 10 USDC. Nothing was sent.");
  assert.equal(rec.readiness.length, 0);
  proposal(await payLink(input({ max_amount: "15.00" }), deps));
  assert.match(refusalText(await payLink(input({ max_amount: "0" }), deps)), /^max_amount isn't valid/);
});

test("brand words in requester text add the SPEC caution line first", async () => {
  const link = `solana:${RECIPIENT}?amount=2&spl-token=${USDC_MINT}&reference=${REFERENCE}&label=MoonPay&message=${encodeURIComponent("Your payout, see https://moonpay-claims.example")}`;
  const { deps } = makeDeps();
  const lines = textOf(await payLink(input({ link }), deps)).split("\n");
  assert.equal(lines[0], 'Caution: this request mentions "MoonPay". Owed can\'t confirm who sent it.');
  assert.equal(lines[1], 'Pay 2 USDC to FN6G…cbvs. Requester\'s note, unverified: "Your payout, see [link removed]". Requester\'s name, unverified: "MoonPay". Approve in PayBox to send.');
});

test("server-side brand flags and local matches are merged", async () => {
  const { deps } = makeDeps({ routes: owedRoutes({ ...openRequest, for: "IRS refund", flags: ["brand_word:paybox"] }) });
  const first = textOf(await payLink(input(), deps)).split("\n")[0];
  assert.equal(first, 'Caution: this request mentions "PayBox", "refund" and "IRS". Owed can\'t confirm who sent it.');
});

test("Owed's own owed:<id> memo isn't shown as requester text", async () => {
  const { deps, rec } = makeDeps();
  const text = textOf(await payLink(input({ link: openRequest.solana_pay_url }), deps));
  assert.doesNotMatch(text, /owed:JArQ6g9JvoWr/);
  assert.equal(rec.built[0]!.request.memo, "owed:JArQ6g9JvoWr"); // still on-chain, so the server can match it
});

test("opens the recipient's USDC account only when it doesn't exist, and says so", async () => {
  const { deps, rec } = makeDeps({ routes: owedRoutes(openRequest), payerReadiness: async () => ({ ok: true, recipientAtaExists: false }) });
  const text = textOf(await payLink(input(), deps));
  assert.equal(rec.built[0]!.createRecipientAta, true);
  assert.match(text, /This also opens the recipient's USDC account \(about 0\.002 SOL, paid by you\)\./);

  const sol = `solana:${RECIPIENT}?amount=0.1&reference=${REFERENCE}`;
  const { deps: d2, rec: r2 } = makeDeps({ payerReadiness: async () => ({ ok: true, recipientAtaExists: false }) });
  proposal(await payLink(input({ link: sol }), d2));
  assert.equal(r2.built[0]!.token, "SOL");
  assert.equal(r2.built[0]!.amountAtomic, 100_000_000n);
  assert.equal(r2.built[0]!.createRecipientAta, false);
});

test("passes the wallet's shortfall through in plain words", async () => {
  const reason = "Your wallet has 3.2 USDC; this request is 15 USDC.";
  const { deps, rec } = makeDeps({ routes: owedRoutes(openRequest), payerReadiness: async () => ({ ok: false, reason, recipientAtaExists: true }) });
  assert.equal(refusalText(await payLink(input(), deps)), reason);
  assert.equal(rec.built.length, 0);
  const { deps: noReason } = makeDeps({ routes: owedRoutes(openRequest), payerReadiness: async () => ({ ok: false, recipientAtaExists: true }) });
  assert.match(refusalText(await payLink(input(), noReason)), /can't cover this payment/);
});

test("RPC and builder failures refuse without proposing", async () => {
  const { deps } = makeDeps({ routes: owedRoutes(openRequest), payerReadiness: async () => { throw new Error("fetch failed"); } });
  assert.equal(refusalText(await payLink(input(), deps)), "Solana couldn't be reached to check your balance. Nothing was sent; try again in a moment.");
  const { deps: broken } = makeDeps({ routes: owedRoutes(openRequest), buildTransferTx: () => { throw new Error("transaction is 1300 bytes"); } });
  assert.equal(refusalText(await payLink(input(), broken)), "Couldn't build the payment: transaction is 1300 bytes");
});

test("a slow RPC can't push the call past PayBox's 10 s limit", async () => {
  let t = 0;
  const { deps, rec } = makeDeps({
    routes: owedRoutes(openRequest),
    now: () => (t += 9000), // every reading is past the 8.5 s budget
    payerReadiness: () => new Promise(() => {}),
  });
  const started = Date.now();
  assert.match(refusalText(await payLink(input(), deps)), /^Solana couldn't be reached/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(rec.built.length, 0);
});

test("links without an amount need one; links with an amount can't be changed", async () => {
  const noAmount = `solana:${RECIPIENT}?spl-token=${USDC_MINT}&reference=${REFERENCE}`;
  const { deps, rec } = makeDeps();
  assert.equal(refusalText(await payLink(input({ link: noAmount }), deps)),
    "This link doesn't set an amount. Ask the user how much USDC to send and pass it as amount.");
  proposal(await payLink(input({ link: noAmount, amount: "7.25" }), deps));
  assert.equal(rec.built.at(-1)!.amountAtomic, 7_250_000n);

  const { deps: d2 } = makeDeps({ routes: owedRoutes(openRequest) });
  assert.equal(refusalText(await payLink(input({ amount: "20" }), d2)), "This link already sets the amount to 15 USDC; it can't be changed.");
  proposal(await payLink(input({ amount: "15.0" }), d2));
});

test("other request states and API failures refuse with plain sentences", async () => {
  const cases: Array<[unknown, number, RegExp]> = [
    [{ ...openRequest, status: "cancelled" }, 200, /^This request was cancelled by the requester\.$/],
    [{ ...openRequest, status: "underpaid", paid: { ...paidRequest.paid, amount: "10" } }, 200, /partial payment \(10 of 15 USDC\)\. Ask the requester for a new link/],
    [{ error: { code: "not_found", message: "nope" } }, 404, /^No Owed request has the id JArQ6g9JvoWr\./],
    [{ error: { code: "upstream_unavailable", message: "db" } }, 503, /server is unreachable.*ask the requester for the Solana Pay link/],
    [{ ...openRequest, solana_pay_url: openRequest.solana_pay_url.replace("amount=15", "amount=1500") }, 200, /doesn't match the request\. Nothing was sent\./],
    [{ ...openRequest, solana_pay_url: openRequest.solana_pay_url.replace(RECIPIENT, SENDER) }, 200, /doesn't match the request/],
  ];
  for (const [body, status, expected] of cases) {
    const { deps, rec } = makeDeps({ routes: owedRoutes(body, status) });
    assert.match(refusalText(await payLink(input(), deps)), expected);
    assert.equal(rec.built.length, 0);
  }
  const { deps } = makeDeps({ routes: { "GET *": () => html(404) } });
  assert.match(refusalText(await payLink(input(), deps)), /server is unreachable/);
});

test("a server that swaps the recipient or amount behind a shared id is refused, even when its own link agrees", async () => {
  // A compromised server returns internally consistent terms: the solana_pay_url matches the
  // swapped fields. Only the id, which hashes the original terms, gives it away.
  const swapped = [
    { recipient: SENDER, amount: "15" },
    { recipient: RECIPIENT, amount: "1500" },
  ];
  for (const terms of swapped) {
    const url = openRequest.solana_pay_url.replace(RECIPIENT, terms.recipient).replace("amount=15&", `amount=${terms.amount}&`);
    const body = { ...openRequest, recipient: terms.recipient, amount: terms.amount, solana_pay_url: url };
    const { deps, rec } = makeDeps({ routes: owedRoutes(body) });
    const sender = terms.recipient === SENDER ? RECIPIENT : SENDER;
    assert.equal(refusalText(await payLink(input({ sender }), deps)), REFUSE_TAMPERED);
    assert.equal(rec.built.length, 0);
  }
  // A swapped reference is caught too: the payment couldn't be found under the shared id.
  const otherRef = "AZLsgyxKZQ9fiqCig4G8drfgCtB96ZfcLQsEQNKmPQ5z";
  const refSwap = { ...openRequest, reference: otherRef, solana_pay_url: openRequest.solana_pay_url.replace(REFERENCE, otherRef) };
  const { deps } = makeDeps({ routes: owedRoutes(refSwap) });
  assert.equal(refusalText(await payLink(input(), deps)), REFUSE_TAMPERED);
});

test("the fixture id is the hash of its terms, so the happy path above is a verified id", () => {
  assert.equal(requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 15_000_000n, reference: REFERENCE }), "JArQ6g9JvoWr");
});

test("older 10-character ids can't be verified and are refused before any network call", async () => {
  const { deps, rec } = makeDeps({ routes: owedRoutes(openRequest) });
  for (const link of ["https://owed-omega.vercel.app/r/1RRer81ufk", "ux9oshckE4"]) {
    assert.equal(refusalText(await payLink(input({ link }), deps)), REFUSE_UNVERIFIABLE);
  }
  assert.equal(rec.calls.length, 0);
  assert.equal(rec.built.length, 0);
});

test("rejects unreadable links, self-payment and bad senders", async () => {
  const { deps } = makeDeps();
  const unreadable = refusalText(await payLink(input({ link: "https://example.com/pay" }), deps));
  assert.ok(unreadable.length > 0);
  const usdt = `solana:${RECIPIENT}?amount=1&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`;
  assert.match(refusalText(await payLink(input({ link: usdt }), deps)), /USDC or SOL/);
  const self = `solana:${SENDER}?amount=1&reference=${REFERENCE}`;
  assert.equal(refusalText(await payLink(input({ link: self }), deps)), "This request pays your own wallet, so there is nothing to send.");
  assert.match(refusalText(await payLink(input({ sender: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }), deps)), /^sender must be a Solana wallet address/);
});

test("input schema is strict and bounded", () => {
  const base = { link: "JArQ6g9JvoWr", sender: SENDER };
  const ok = (v: object) => inputSchema.safeParse(v).success;
  assert.equal(ok(base), true);
  assert.equal(ok({ ...base, max_amount: "10", amount: "1.5" }), true);
  assert.equal(ok({ ...base, extra: 1 }), false);
  assert.equal(ok({ ...base, link: "" }), false);
  assert.equal(ok({ ...base, link: "x".repeat(2049) }), false);
  assert.equal(ok({ ...base, max_amount: "1e3" }), false);
  assert.equal(ok({ ...base, amount: "-2" }), false);
  assert.equal(ok({ link: "JArQ6g9JvoWr" }), false);
  assert.equal(ok({ ...base, sender: "0x3806c85df527e5336f05277ab8cc3932b9abe42a" }), false);
});

test("uses the real transaction builder when it has merged", { skip: !usingReal.buildTransferTx && "tx.ts is still a stub" }, async () => {
  const { deps } = makeDeps({ routes: owedRoutes(openRequest) });
  const p = proposal(await payLink(input(), deps));
  const bytes = Buffer.from(p.transaction.transactionBase64, "base64");
  assert.ok(bytes.length > 0 && bytes.length <= 1232);
});
