// Pay by card with MoonPay: the payer buys USDC on Solana with a card in MoonPay's widget, delivered
// straight to the request's recipient. Off unless NEXT_PUBLIC_OWED_MOONPAY=1 and both API keys are set,
// so a deployment without them behaves exactly as before (no button, no extra queries, no MoonPay calls).
//
// Facts below are from dev.moonpay.com and api.moonpay.com/v3/currencies, read 2026-10-18:
// - USDC on Solana is currency code `usdc_sol` (metadata.contractAddress = the USDC mint, networkCode solana).
// - Its buy limits are 4.99 to 30,000 USDC; buying it is refused in Canada (CA) and the US Virgin Islands
//   (VI), on top of the countries MoonPay serves no purchases in at all (GET /v3/countries isBuyAllowed=false).
// - A pk_test_/sk_test_ key pair runs the sandbox widget at buy-sandbox.moonpay.com; pk_live_/sk_live_ the
//   live one at buy.moonpay.com. Both API environments share https://api.moonpay.com.

export const MOONPAY_CURRENCY = "usdc_sol";
export const MOONPAY_API = "https://api.moonpay.com";
export const WIDGET_LIVE = "https://buy.moonpay.com";
export const WIDGET_SANDBOX = "https://buy-sandbox.moonpay.com";

/** usdc_sol minBuyAmount / maxBuyAmount in USDC atomic units (6 decimals), used until the limits API answers. */
export const DEFAULT_MIN_ATOMIC = 4_990_000n;
export const DEFAULT_MAX_ATOMIC = 30_000_000_000n;

export interface MoonpayConfig {
  publishableKey: string;
  secretKey: string;
  /** Verifies Moonpay-Signature-V2 on webhooks; without it the webhook route refuses and polling alone attributes. */
  webhookKey: string | null;
  sandbox: boolean;
  widgetBase: string;
  /** Bind each widget URL to a hash of the payer's IP (MoonPay requires it to go live). On unless MOONPAY_IP_MATCH=0. */
  ipMatch: boolean;
}

type Env = Record<string, string | undefined>;

/** The public flag alone: what client code may read. The server still needs the keys (moonpayConfig). */
export function moonpayFlagOn(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_OWED_MOONPAY === "1";
}

/** The server-side configuration, or null when the feature is off or the keys are missing or mismatched. */
export function moonpayConfig(env: Env = process.env): MoonpayConfig | null {
  if (!moonpayFlagOn(env)) return null;
  const publishableKey = env.MOONPAY_PUBLISHABLE_KEY?.trim() ?? "";
  const secretKey = env.MOONPAY_SECRET_KEY?.trim() ?? "";
  const pk = /^pk_(test|live)_[A-Za-z0-9]+$/.exec(publishableKey);
  const sk = /^sk_(test|live)_[A-Za-z0-9]+$/.exec(secretKey);
  // A test key signing a live URL (or the reverse) makes the widget refuse to load: treat it as unconfigured.
  if (!pk || !sk || pk[1] !== sk[1]) return null;
  const sandbox = pk[1] === "test";
  return {
    publishableKey,
    secretKey,
    webhookKey: env.MOONPAY_WEBHOOK_KEY?.trim() || null,
    sandbox,
    widgetBase: sandbox ? WIDGET_SANDBOX : WIDGET_LIVE,
    ipMatch: env.MOONPAY_IP_MATCH !== "0",
  };
}
