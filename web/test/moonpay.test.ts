import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { assess, judgeTransaction, shouldApply, type CardRequest } from "@/lib/moonpay/attribution";
import { parseLimits } from "@/lib/moonpay/client";
import { moonpayConfig, WIDGET_LIVE, WIDGET_SANDBOX, type MoonpayConfig } from "@/lib/moonpay/config";
import { cardEligibility, ineligibleNote } from "@/lib/moonpay/eligibility";
import { parseMoonpayList, parseWebhookBody, verifyWebhookSignature, type MoonpayTx } from "@/lib/moonpay/transaction";
import { allowedIpHash, canonicalIp, hmacBase64, isPublicIp, signedWidgetUrl, signQuery } from "@/lib/moonpay/widget";
import type { ParsedTransaction } from "@/lib/validate";

// Pay by card with MoonPay: URL signing (against MoonPay's published test vector), IP binding, webhook
// signatures, eligibility, and the attribution state machine, including refusing a transaction that
// doesn't pay the request. Pure: no network, no database (test/moonpay-db.test.ts covers the SQL).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MOONPAY_WALLET = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const RECIPIENT_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const SOURCE_ATA = "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9";
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2s111";
const ID = "Ab3dEfGh2jKm";

const CONFIG: MoonpayConfig = {
  publishableKey: "pk_test_DocsVector00",
  secretKey: "sk_test_DocsVector00",
  webhookKey: "wk_test_key",
  sandbox: true,
  widgetBase: WIDGET_SANDBOX,
  ipMatch: true,
};

// --- URL signing -----------------------------------------------------------------------------------

test("signQuery matches MoonPay's published test vector (the message includes the leading ?)", () => {
  const query = "?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
  assert.equal(signQuery(query, "sk_test_DocsVector00"), "oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=");
  assert.equal(encodeURIComponent(signQuery(query, "sk_test_DocsVector00")), "oIJxSghyzll%2FBLhUFdQZhkxf7DAS8REFaWr%2FibO%2BK8Q%3D");
  // The documented wrong answer for signing without the "?", which signQuery refuses to do.
  assert.equal(hmacBase64("sk_test_DocsVector00", query.slice(1)), "z2PF5gVnemAZat6jSnLdgG7MB9SNX1TCrRc2bkHq8DQ=");
  assert.throws(() => signQuery(query.slice(1), "sk_test_DocsVector00"), /leading \?/);
});

test("signedWidgetUrl: usdc_sol, recipient, exact amount, request id, return links; signature over the exact query", () => {
  const url = signedWidgetUrl(CONFIG, {
    recipient: RECIPIENT,
    amount: "12.5",
    requestId: ID,
    redirectUrl: `https://www.getowed.xyz/r/${ID}?card=return`,
    unsupportedRegionUrl: `https://www.getowed.xyz/r/${ID}?card=region`,
    ip: "203.0.113.42",
  });
  assert.ok(url.startsWith(`${WIDGET_SANDBOX}/?apiKey=pk_test_DocsVector00&currencyCode=usdc_sol&`));
  const parsed = new URL(url);
  const p = parsed.searchParams;
  assert.equal(p.get("currencyCode"), "usdc_sol");
  assert.equal(p.get("walletAddress"), RECIPIENT);
  assert.equal(p.get("quoteCurrencyAmount"), "12.5");
  assert.equal(p.get("externalTransactionId"), ID);
  assert.equal(p.get("showWalletAddressForm"), "true");
  assert.equal(p.get("paymentMethod"), "credit_debit_card");
  assert.equal(p.get("redirectURL"), `https://www.getowed.xyz/r/${ID}?card=return`);
  assert.equal(p.get("unsupportedRegionRedirectUrl"), `https://www.getowed.xyz/r/${ID}?card=region`);
  assert.equal(p.get("allowedIpAddress"), hmacBase64(CONFIG.secretKey, "203.0.113.42"));
  assert.equal(p.get("apiKey"), "pk_test_DocsVector00");
  assert.ok(!url.includes("sk_test"), "the secret key never appears in the URL");
  // MoonPay recomputes the HMAC over the query it received, minus the trailing signature.
  const [signed, encodedSig] = parsed.search.split("&signature=");
  assert.equal(decodeURIComponent(encodedSig), createHmac("sha256", CONFIG.secretKey).update(signed).digest("base64"));
  assert.ok(!/[+/=]/.test(encodedSig), "the signature is URL-encoded");
  assert.equal([...p.keys()].at(-1), "signature", "signature comes last");
});

test("signedWidgetUrl: no allowedIpAddress for a private IP, no IP, or MOONPAY_IP_MATCH=0; still signed", () => {
  const base = { recipient: RECIPIENT, amount: "5", requestId: ID, redirectUrl: "https://x.test/r", unsupportedRegionUrl: "https://x.test/r" };
  for (const [config, ip] of [[CONFIG, "10.0.0.7"], [CONFIG, null], [CONFIG, "::1"], [{ ...CONFIG, ipMatch: false }, "203.0.113.42"]] as const) {
    const url = new URL(signedWidgetUrl(config, { ...base, ip }));
    assert.equal(url.searchParams.get("allowedIpAddress"), null);
    assert.ok(url.searchParams.get("signature"));
  }
});

test("canonicalIp follows MoonPay's canonicalisation rules", () => {
  assert.equal(canonicalIp("203.0.113.42"), "203.0.113.42");
  assert.equal(canonicalIp(" 203.0.113.42:8443 "), "203.0.113.42");
  assert.equal(canonicalIp("::ffff:203.0.113.42"), "203.0.113.42");
  assert.equal(canonicalIp("::FFFF:CB00:712A"), "203.0.113.42");
  assert.equal(canonicalIp("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
  assert.equal(canonicalIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(canonicalIp("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
  assert.equal(canonicalIp("unknown"), null);
  assert.equal(canonicalIp(""), null);
  assert.equal(canonicalIp(null), null);
  assert.equal(isPublicIp("203.0.113.42"), true);
  assert.equal(isPublicIp("192.168.1.2"), false);
  assert.equal(isPublicIp("100.64.0.1"), false);
  assert.equal(isPublicIp("fd00::1"), false);
  assert.equal(isPublicIp("2001:db8::1"), true);
  assert.equal(allowedIpHash("::ffff:203.0.113.42", "k"), allowedIpHash("203.0.113.42", "k"));
});

// --- configuration ---------------------------------------------------------------------------------

test("moonpayConfig: off without the flag or keys, and with test/live keys mixed", () => {
  const keys = { MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test_def" };
  assert.equal(moonpayConfig({ ...keys }), null);
  assert.equal(moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "1" }), null);
  assert.equal(moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_live_def" }), null);
  assert.equal(moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "true", ...keys }), null);
  const on = moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "1", ...keys });
  assert.deepEqual(on, { publishableKey: "pk_test_abc", secretKey: "sk_test_def", webhookKey: null, sandbox: true, widgetBase: WIDGET_SANDBOX, ipMatch: true });
  const live = moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "1", MOONPAY_PUBLISHABLE_KEY: "pk_live_a", MOONPAY_SECRET_KEY: "sk_live_b", MOONPAY_WEBHOOK_KEY: "wk", MOONPAY_IP_MATCH: "0" });
  assert.equal(live?.widgetBase, WIDGET_LIVE);
  assert.equal(live?.webhookKey, "wk");
  assert.equal(live?.ipMatch, false);
});

// --- webhook signature -----------------------------------------------------------------------------

const KEY = "wk_test_key";
function sign(body: string, t: number, key = KEY) {
  return `t=${t},s=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

test("verifyWebhookSignature: Moonpay-Signature-V2 over `${t}.${body}`, constant-time, fresh", () => {
  const body = JSON.stringify({ type: "transaction_updated", data: { id: "x" } });
  const now = 1_792_300_000_000;
  const t = now / 1000;
  assert.equal(verifyWebhookSignature(sign(body, t), body, KEY, now), true);
  assert.equal(verifyWebhookSignature(sign(body, t).toUpperCase().replace("T=", "t=").replace("S=", "s="), body, KEY, now), true);
  assert.equal(verifyWebhookSignature(sign(body, t), `${body} `, KEY, now), false, "tampered body");
  assert.equal(verifyWebhookSignature(sign(body, t, "other"), body, KEY, now), false, "wrong key");
  assert.equal(verifyWebhookSignature(sign(body, t - 7200), body, KEY, now), false, "two hours old");
  assert.equal(verifyWebhookSignature(sign(body, t + 7200), body, KEY, now), false, "two hours ahead");
  assert.equal(verifyWebhookSignature(null, body, KEY, now), false);
  assert.equal(verifyWebhookSignature("t=abc,s=def", body, KEY, now), false);
  assert.equal(verifyWebhookSignature(`s=${"0".repeat(64)}`, body, KEY, now), false);
  assert.equal(verifyWebhookSignature(sign(body, t), body, "", now), false);
});

// --- MoonPay payloads ------------------------------------------------------------------------------

function moonpayTx(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "defb7c52-7bd3-422b-9052-374df50cc51a",
    status: "completed",
    externalTransactionId: ID,
    walletAddress: RECIPIENT,
    currency: { code: "usdc_sol" },
    cryptoTransactionId: SIG,
    quoteCurrencyAmount: 12.5,
    updatedAt: "2026-10-18T10:00:00.000Z",
    failureReason: null,
    ...over,
  };
}

test("parseWebhookBody keeps Buy transaction events only; parseMoonpayList takes an array or one object", () => {
  const tx = parseWebhookBody({ type: "transaction_updated", data: moonpayTx() });
  assert.equal(tx?.id, "defb7c52-7bd3-422b-9052-374df50cc51a");
  assert.equal(tx?.currencyCode, "usdc_sol");
  assert.equal(tx?.cryptoTransactionId, SIG);
  assert.equal(parseWebhookBody({ type: "sell_transaction_updated", data: moonpayTx() }), null);
  assert.equal(parseWebhookBody({ type: "transaction_updated", data: moonpayTx({ status: "refunded" }) }), null);
  assert.equal(parseWebhookBody({ type: "transaction_updated", data: moonpayTx({ walletAddress: 7 }) }), null);
  assert.equal(parseMoonpayList([moonpayTx(), { junk: true }]).length, 1);
  assert.equal(parseMoonpayList(moonpayTx()).length, 1);
});

// --- attribution state machine ---------------------------------------------------------------------

const REQ: CardRequest = { id: ID, recipient: RECIPIENT, token: "USDC", chain: "solana", amountAtomic: 12_500_000n };
const tx = (over: Partial<Record<string, unknown>> = {}) => parseMoonpayList(moonpayTx(over))[0] as MoonpayTx;

test("assess: only this request, its recipient and usdc_sol count; a named transaction is always checked", () => {
  assert.deepEqual(assess(tx(), REQ), { state: "sent", signature: SIG });
  assert.equal(assess(tx({ externalTransactionId: "Zz3dEfGh2jKm" }), REQ).state, "ignore");
  assert.equal(assess(tx({ walletAddress: OTHER }), REQ).state, "ignore");
  assert.equal(assess(tx({ currency: { code: "usdc" } }), REQ).state, "ignore");
  assert.equal(assess(tx(), { ...REQ, token: "SOL" }).state, "ignore");
  assert.equal(assess(tx(), { ...REQ, chain: "base" }).state, "ignore");
  assert.deepEqual(assess(tx({ status: "pending", cryptoTransactionId: null }), REQ), { state: "pending" });
  assert.deepEqual(assess(tx({ status: "waitingAuthorization", cryptoTransactionId: null }), REQ), { state: "pending" });
  assert.deepEqual(assess(tx({ status: "failed", cryptoTransactionId: null, failureReason: "card declined" }), REQ), { state: "failed", reason: "card declined" });
  assert.deepEqual(assess(tx({ status: "pending" }), REQ), { state: "sent", signature: SIG }, "MoonPay naming a transaction early still gets it checked");
  assert.deepEqual(assess(tx({ cryptoTransactionId: "not-a-signature" }), REQ), { state: "pending" });
});

test("shouldApply: out-of-order and repeated reports never move a purchase backwards", () => {
  const at = (s: string) => `2026-10-18T10:00:${s}.000Z`;
  assert.equal(shouldApply(null, { state: "pending" }, at("00")), true);
  assert.equal(shouldApply({ state: "pending", signature: null, moonpayUpdatedAt: at("10") }, { state: "sent", signature: SIG }, at("20")), true);
  assert.equal(shouldApply({ state: "pending", signature: null, moonpayUpdatedAt: at("10") }, { state: "failed", reason: "x" }, at("05")), false, "older report");
  assert.equal(shouldApply({ state: "sent", signature: SIG, moonpayUpdatedAt: at("10") }, { state: "pending" }, at("20")), false, "a named transaction stays named");
  assert.equal(shouldApply({ state: "sent", signature: SIG, moonpayUpdatedAt: at("10") }, { state: "sent", signature: SIG }, at("20")), false, "duplicate");
  assert.equal(shouldApply({ state: "failed", signature: null, moonpayUpdatedAt: at("10") }, { state: "sent", signature: SIG }, at("20")), true, "failed, then a transaction: check it");
  for (const final of ["verified", "underpaid", "mismatch"] as const) {
    assert.equal(shouldApply({ state: final, signature: SIG, moonpayUpdatedAt: at("10") }, { state: "sent", signature: SIG }, at("30")), false);
  }
});

function chainTx({ credit = 12_500_000n, owner = RECIPIENT, err = null as unknown, signature = SIG, blockTime = 1_792_300_100 } = {}): ParsedTransaction {
  const keys = [MOONPAY_WALLET, SOURCE_ATA, RECIPIENT_ATA, USDC];
  return {
    slot: 400_000_000,
    blockTime,
    meta: {
      err,
      preBalances: keys.map(() => 1),
      postBalances: keys.map(() => 1),
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: String(1_000_000n + credit) } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [{
          program: "spl-token",
          parsed: { type: "transferChecked", info: { source: SOURCE_ATA, mint: USDC, destination: RECIPIENT_ATA, authority: MOONPAY_WALLET, tokenAmount: { amount: String(credit) } } },
        }],
      },
    },
  };
}
const TERMS = { recipient: RECIPIENT, amountAtomic: 12_500_000n, notBeforeUnix: 1_792_300_000 };

test("judgeTransaction: verified only when the chain shows the recipient credited in full", () => {
  const v = judgeTransaction(chainTx(), SIG, TERMS);
  assert.equal(v.state, "verified");
  if (v.state === "verified") {
    assert.equal(v.credit.amountAtomic, 12_500_000n);
    assert.equal(v.credit.payer, MOONPAY_WALLET);
    assert.equal(v.credit.signature, SIG);
  }
  assert.equal(judgeTransaction(chainTx({ credit: 20_000_000n }), SIG, TERMS).state, "verified", "more than owed still pays it");
  assert.equal(judgeTransaction(null, SIG, TERMS).state, "sent", "not on chain yet: keep waiting");
});

test("judgeTransaction: refuses a transaction that doesn't pay this request", () => {
  const reason = (t: ParsedTransaction) => {
    const v = judgeTransaction(t, SIG, TERMS);
    assert.equal(v.state, "mismatch");
    return v.state === "mismatch" ? v.reason : "";
  };
  assert.match(reason(chainTx({ owner: OTHER })), /did not credit the recipient/);
  assert.match(reason(chainTx({ err: { InstructionError: [0, "Custom"] } })), /failed on chain/);
  assert.match(reason(chainTx({ signature: `${SIG.slice(0, -1)}2` })), /different transaction/);
  assert.match(reason(chainTx({ blockTime: 1_792_299_000 })), /older than the card checkout/);
  assert.match(reason(chainTx({ credit: 0n })), /did not credit/);
});

test("judgeTransaction: a smaller credit is real money, so it is underpaid, never paid", () => {
  const v = judgeTransaction(chainTx({ credit: 12_000_000n }), SIG, TERMS);
  assert.equal(v.state, "underpaid");
  if (v.state === "underpaid") assert.equal(v.credit.amountAtomic, 12_000_000n);
});

// --- eligibility -----------------------------------------------------------------------------------

test("cardEligibility: open USDC-on-Solana requests within MoonPay's limits, in whole cents", () => {
  const open = { token: "USDC", chain: "solana", status: "open" };
  assert.deepEqual(cardEligibility({ ...open, amountAtomic: 12_500_000n }), { ok: true });
  assert.deepEqual(cardEligibility({ ...open, amountAtomic: 4_990_000n }), { ok: true });
  const small = cardEligibility({ ...open, amountAtomic: 4_980_000n });
  assert.deepEqual(small, { ok: false, reason: "below_minimum", limit: "4.99" });
  assert.equal(ineligibleNote(small), "Paying by card isn't offered for this request: MoonPay's smallest USDC purchase is 4.99 USDC.");
  assert.equal(cardEligibility({ ...open, amountAtomic: 30_000_000_001n }).ok, false);
  assert.deepEqual(cardEligibility({ ...open, amountAtomic: 12_345_678n }), { ok: false, reason: "sub_cent" });
  assert.match(ineligibleNote(cardEligibility({ ...open, amountAtomic: 12_345_678n })) ?? "", /whole cents/);
  assert.deepEqual(cardEligibility({ ...open, token: "SOL", amountAtomic: 12_500_000n }), { ok: false, reason: "not_usdc_on_solana" });
  assert.deepEqual(cardEligibility({ ...open, chain: "base", amountAtomic: 12_500_000n }), { ok: false, reason: "not_usdc_on_solana" });
  assert.deepEqual(cardEligibility({ ...open, status: "paid", amountAtomic: 12_500_000n }), { ok: false, reason: "not_open" });
  assert.equal(ineligibleNote({ ok: false, reason: "not_open" }), null, "a paid page says nothing about cards");
  assert.equal(cardEligibility({ ...open, amountAtomic: 12_500_000n }, { minAtomic: 20_000_000n, maxAtomic: 30_000_000_000n }).ok, false, "live limits win");
});

test("parseLimits reads quoteCurrency min/max for usdc_sol only", () => {
  assert.deepEqual(parseLimits({ quoteCurrency: { code: "usdc_sol", minBuyAmount: 4.99, maxBuyAmount: 30000 } }), { minAtomic: 4_990_000n, maxAtomic: 30_000_000_000n });
  assert.deepEqual(parseLimits({ quoteCurrency: { code: "usdc_sol", minBuyAmount: 20, maxBuyAmount: null } }), { minAtomic: 20_000_000n, maxAtomic: 30_000_000_000n });
  assert.equal(parseLimits({ quoteCurrency: { code: "eth", minBuyAmount: 0.01 } }), null);
  assert.equal(parseLimits({}), null);
  assert.equal(parseLimits(null), null);
});
