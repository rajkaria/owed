import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  moonpayConfig,
  moonpaySellConfig,
  moonpayWebhookKey,
  SELL_WIDGET_LIVE,
  SELL_WIDGET_SANDBOX,
  WIDGET_SANDBOX,
} from "@/lib/moonpay/config";
import {
  cashOutStatusOf,
  depositProblem,
  isSellWebhook,
  parseSellList,
  parseSellTx,
  parseSellWebhook,
  pickSale,
  saleProblem,
  sellWidgetParams,
  signedSellUrl,
  usdcNumberToAtomic,
  type SellTx,
} from "@/lib/moonpay/sell";
import { signQuery } from "@/lib/moonpay/widget";
import { parseWebhookBody, verifyWebhookSignature } from "@/lib/moonpay/transaction";

// F4 cash out, pure parts: the sell widget URL (MoonPay's documented signing scheme, checked against its published test
// vector in test/moonpay.test.ts and recomputed here over the exact query), configuration (cash-out has its own flag
// and needs the webhook key; the card's configuration is unchanged), Sell transaction parsing (a deposit address is
// only ever read from a webhook body, never from the REST answer), and every check a sale must pass before Owed
// releases a deposit address.

const WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const DEPOSIT = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const ID = "Ab3dEfGh2jKm";
const SELL = { publishableKey: "pk_test_DocsVector00", secretKey: "sk_test_DocsVector00", widgetBase: SELL_WIDGET_SANDBOX };

// --- the sell widget URL ---------------------------------------------------------------------------

test("the documented URL-signing vector holds for the off-ramp too (same scheme as the buy widget)", () => {
  // https://dev.moonpay.com/widget/off-ramp/customization/url-signing.md "Verify your implementation"
  const query = "?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
  assert.equal(signQuery(query, "sk_test_DocsVector00"), "oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=");
});

test("signedSellUrl: usdc_sol, the exact amount locked, refunds to this wallet, the cash-out id; signed over the exact query", () => {
  const url = signedSellUrl(SELL, {
    wallet: WALLET, amount: "12.5", cashOutId: ID, fiatCurrency: "eur",
    redirectUrl: `https://www.getowed.xyz/cash-out/${ID}`, unsupportedRegionUrl: `https://www.getowed.xyz/cash-out/${ID}?region=1`,
  });
  assert.ok(url.startsWith(`${SELL_WIDGET_SANDBOX}/?apiKey=pk_test_DocsVector00&baseCurrencyCode=usdc_sol&baseCurrencyAmount=12.5&lockAmount=true&`));
  const parsed = new URL(url);
  const p = parsed.searchParams;
  assert.equal(p.get("baseCurrencyCode"), "usdc_sol");
  assert.equal(p.get("baseCurrencyAmount"), "12.5");
  assert.equal(p.get("lockAmount"), "true");
  assert.equal(p.get("quoteCurrencyCode"), "eur");
  assert.equal(p.get("refundWalletAddress"), WALLET);
  assert.equal(p.get("showWalletAddressForm"), "true");
  assert.equal(p.get("externalTransactionId"), ID);
  assert.equal(p.get("redirectURL"), `https://www.getowed.xyz/cash-out/${ID}`);
  assert.equal(p.get("unsupportedRegionRedirectUrl"), `https://www.getowed.xyz/cash-out/${ID}?region=1`);
  assert.equal([...p.keys()].at(-1), "signature", "signature comes last");
  assert.ok(!url.includes("sk_test"), "the secret key never appears in the URL");
  const [signed, encodedSig] = parsed.search.split("&signature=");
  assert.equal(decodeURIComponent(encodedSig), createHmac("sha256", SELL.secretKey).update(signed).digest("base64"));
  assert.ok(!/[+/=]/.test(encodedSig), "the signature is URL-encoded");
  // No fiat chosen: MoonPay lets the user pick.
  assert.deepEqual(sellWidgetParams(SELL, { wallet: WALLET, amount: "5", cashOutId: ID, fiatCurrency: null, redirectUrl: "https://x.test/a", unsupportedRegionUrl: "https://x.test/b" }).map(([k]) => k),
    ["apiKey", "baseCurrencyCode", "baseCurrencyAmount", "lockAmount", "refundWalletAddress", "showWalletAddressForm", "externalTransactionId", "redirectURL", "unsupportedRegionRedirectUrl"]);
});

// --- configuration ---------------------------------------------------------------------------------

const KEYS = { MOONPAY_PUBLISHABLE_KEY: "pk_live_a1", MOONPAY_SECRET_KEY: "sk_live_b2", MOONPAY_WEBHOOK_KEY: "wk_live_c3" };

test("moonpaySellConfig: its own flag, the standard keys from one environment, and the webhook key", () => {
  assert.equal(moonpaySellConfig({ ...KEYS }), null, "flag off");
  assert.equal(moonpaySellConfig({ ...KEYS, OWED_MOONPAY_SELL: "true" }), null, "only 1 switches it on");
  assert.equal(moonpaySellConfig({ OWED_MOONPAY_SELL: "1", MOONPAY_PUBLISHABLE_KEY: "pk_live_a1", MOONPAY_SECRET_KEY: "sk_live_b2" }), null, "no webhook key: no deposit address could ever arrive");
  assert.equal(moonpaySellConfig({ ...KEYS, OWED_MOONPAY_SELL: "1", MOONPAY_SECRET_KEY: "sk_test_b2" }), null, "test and live keys mixed");
  assert.deepEqual(moonpaySellConfig({ ...KEYS, OWED_MOONPAY_SELL: "1" }), { publishableKey: "pk_live_a1", secretKey: "sk_live_b2", webhookKey: "wk_live_c3", sandbox: false, widgetBase: SELL_WIDGET_LIVE });
  assert.equal(moonpaySellConfig({ OWED_MOONPAY_SELL: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_a", MOONPAY_SECRET_KEY: "sk_test_b", MOONPAY_WEBHOOK_KEY: "w" })?.widgetBase, SELL_WIDGET_SANDBOX);
});

test("cash-out and the card switch on independently; the card's configuration is unchanged", () => {
  const sellOnly = { ...KEYS, OWED_MOONPAY_SELL: "1" };
  assert.equal(moonpayConfig(sellOnly), null, "selling doesn't turn the card on");
  assert.equal(moonpayWebhookKey(sellOnly), "wk_live_c3", "the webhook route verifies sell events with the shared key");
  const cardOnly = { ...KEYS, NEXT_PUBLIC_OWED_MOONPAY: "1" };
  assert.equal(moonpaySellConfig(cardOnly), null, "the card doesn't turn selling on");
  assert.equal(moonpayWebhookKey(cardOnly), "wk_live_c3");
  assert.equal(moonpayWebhookKey({ ...KEYS }), null, "both off: the webhook route refuses");
  assert.deepEqual(moonpayConfig({ NEXT_PUBLIC_OWED_MOONPAY: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test_def" }),
    { publishableKey: "pk_test_abc", secretKey: "sk_test_def", webhookKey: null, sandbox: true, widgetBase: WIDGET_SANDBOX, ipMatch: true });
});

// --- Sell transactions -----------------------------------------------------------------------------

function sale(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9020fd02-42ac-497f-8b5f-41fdf4dd0b1d", status: "waitingForDeposit", externalTransactionId: ID, refundWalletAddress: WALLET,
    baseCurrency: { code: "usdc_sol" }, baseCurrencyAmount: 12.5, depositHash: null, failureReason: null, updatedAt: "2026-10-18T10:00:00.000Z",
    depositWallet: { walletAddress: DEPOSIT, walletAddressTag: null }, ...over,
  };
}
const tx = (over: Record<string, unknown> = {}, source: "api" | "webhook" = "webhook") => parseSellTx(sale(over), source) as SellTx;
const TERMS = { cashOutId: ID, wallet: WALLET, amountAtomic: 12_500_000n };

test("parseSellTx: the deposit address is read from a webhook only, never from MoonPay's REST answer", () => {
  assert.equal(tx({}, "webhook").depositAddress, DEPOSIT);
  assert.equal(tx({}, "api").depositAddress, null, "the REST schema documents no deposit address, so none is taken from it");
  assert.equal(parseSellList([sale(), { junk: true }])[0].depositAddress, null);
  assert.equal(tx().baseAmountAtomic, 12_500_000n);
  assert.equal(tx().baseCurrencyCode, "usdc_sol");
  assert.equal(parseSellTx(sale({ status: "refunded" }), "api"), null, "an undocumented status isn't a sale");
  assert.equal(parseSellTx(sale({ id: 7 }), "api"), null);
  assert.equal(tx({ status: "requoteRequired" }).status, "requoteRequired");
});

test("parseSellWebhook / isSellWebhook: sell events only; a sell body never reaches the card parser", () => {
  const body = { type: "sell_transaction_updated", data: sale() };
  assert.equal(isSellWebhook(body), true);
  assert.equal(parseSellWebhook(body)?.depositAddress, DEPOSIT);
  assert.equal(parseWebhookBody(body), null, "the card path ignores it");
  for (const type of ["sell_transaction_created", "sell_transaction_failed", "sell_transaction_requote_required"]) assert.ok(parseSellWebhook({ type, data: sale() }));
  assert.equal(isSellWebhook({ type: "transaction_updated", data: {} }), false);
  assert.equal(parseSellWebhook({ type: "sell_transaction_updated", data: { id: "x" } }), null);
});

test("Sell webhooks are signed exactly like the card's (Moonpay-Signature-V2 over `${t}.${body}`)", () => {
  const body = JSON.stringify({ type: "sell_transaction_updated", data: sale() });
  const t = 1_792_300_000;
  const header = `t=${t},s=${createHmac("sha256", "wk").update(`${t}.${body}`).digest("hex")}`;
  assert.equal(verifyWebhookSignature(header, body, "wk", t * 1000), true);
  assert.equal(verifyWebhookSignature(header, body.replace(DEPOSIT, OTHER), "wk", t * 1000), false, "a swapped deposit address breaks the signature");
});

test("usdcNumberToAtomic: MoonPay's JSON numbers as USDC atomic units, or null", () => {
  assert.equal(usdcNumberToAtomic(12.5), 12_500_000n);
  assert.equal(usdcNumberToAtomic(10), 10_000_000n);
  assert.equal(usdcNumberToAtomic(0.000001), 1n);
  assert.equal(usdcNumberToAtomic(0.0000001), null, "more than 6 decimals");
  assert.equal(usdcNumberToAtomic(0), null);
  assert.equal(usdcNumberToAtomic(-1), null);
  assert.equal(usdcNumberToAtomic("12.5"), null, "a string isn't the documented number");
  assert.equal(usdcNumberToAtomic(Number.NaN), null);
});

test("saleProblem refuses each mismatch: another cash-out, another currency, another amount, another refund wallet", () => {
  assert.equal(saleProblem(tx(), TERMS), null);
  assert.match(saleProblem(tx({ externalTransactionId: "Zz3dEfGh2jKm" }), TERMS)!, /different cash-out/);
  assert.match(saleProblem(tx({ baseCurrency: { code: "usdc" } }), TERMS)!, /not USDC on Solana/);
  assert.match(saleProblem(tx({ baseCurrency: null }), TERMS)!, /not USDC on Solana/);
  assert.match(saleProblem(tx({ baseCurrencyAmount: 12.49 }), TERMS)!, /different amount/);
  assert.match(saleProblem(tx({ baseCurrencyAmount: 125 }), TERMS)!, /different amount/);
  assert.match(saleProblem(tx({ refundWalletAddress: OTHER }), TERMS)!, /refunds a different wallet/);
  assert.match(saleProblem(tx({ refundWalletAddress: "" }), TERMS)!, /refunds a different wallet/);
});

test("depositProblem: a Solana address, no memo tag, never the wallet itself", () => {
  assert.equal(depositProblem(tx(), WALLET), null);
  assert.match(depositProblem(tx({ depositWallet: null }), WALLET)!, /no deposit address/);
  assert.match(depositProblem(tx({ depositWallet: { walletAddress: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" } }), WALLET)!, /isn't a Solana address/);
  assert.match(depositProblem(tx({ depositWallet: { walletAddress: DEPOSIT, walletAddressTag: "1234" } }), WALLET)!, /memo tag/);
  assert.match(depositProblem(tx({ depositWallet: { walletAddress: WALLET } }), WALLET)!, /this wallet itself/);
});

test("pickSale: the only live sale, else the newest failed one; two live sales are refused", () => {
  const live = tx({ id: "a" });
  const failedOld = tx({ id: "b", status: "failed", updatedAt: "2026-10-18T09:00:00.000Z" });
  const failedNew = tx({ id: "c", status: "failed", updatedAt: "2026-10-18T09:30:00.000Z" });
  assert.equal(pickSale([failedOld, live], ID).sale?.id, "a");
  assert.equal(pickSale([failedOld, failedNew], ID).sale?.id, "c");
  assert.equal(pickSale([], ID).sale, null);
  assert.equal(pickSale([tx({ externalTransactionId: "Zz3dEfGh2jKm" })], ID).sale, null, "a sale for another cash-out is never picked");
  const two = pickSale([live, tx({ id: "d", status: "pending" })], ID);
  assert.equal(two.sale, null);
  assert.match(two.problem!, /more than one open sale/);
});

test("cashOutStatusOf maps every MoonPay sale status", () => {
  assert.equal(cashOutStatusOf("waitingForDeposit"), "waiting_for_deposit");
  assert.equal(cashOutStatusOf("pending"), "pending");
  assert.equal(cashOutStatusOf("completed"), "completed");
  assert.equal(cashOutStatusOf("failed"), "failed");
  assert.equal(cashOutStatusOf("requoteRequired"), "requote_required");
});
