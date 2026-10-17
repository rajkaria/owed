import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { MOONPAY_CURRENCY, type MoonpayConfig } from "./config";

// The MoonPay buy widget URL, signed on the server (dev.moonpay.com, "URL signing" and "IP matching"):
// - walletAddress pre-fills the recipient, so MoonPay requires `signature`: base64 HMAC-SHA256 of the
//   query string *including its leading "?"*, keyed with the secret key, appended last and URL-encoded.
//   Every parameter value is URL-encoded before signing, so MoonPay sees exactly the bytes we signed.
// - allowedIpAddress: base64 HMAC-SHA256 of the payer's canonical public IP, inside the signed query,
//   so a leaked URL won't load on another device. Required by MoonPay to go live.
// Pure: no I/O, the secret never leaves this module's return value except as a signature.

export interface WidgetInput {
  /** The request's recipient: where MoonPay delivers the USDC. */
  recipient: string;
  /** Exact USDC owed, as a decimal string ("12.5"). */
  amount: string;
  /** The Owed request id, sent as externalTransactionId so the purchase can be found again. */
  requestId: string;
  /** Where MoonPay sends the payer afterwards (it appends transactionId and transactionStatus). */
  redirectUrl: string;
  /** Where MoonPay sends a payer from a region it doesn't serve. */
  unsupportedRegionUrl: string;
  /** The payer's IP as the server saw it, or null. */
  ip: string | null;
}

export function hmacBase64(key: string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("base64");
}

/** The `signature` for a query string that starts with "?" (MoonPay signs the "?" too). */
export function signQuery(query: string, secretKey: string): string {
  if (!query.startsWith("?")) throw new Error("sign the query string with its leading ?");
  return hmacBase64(secretKey, query);
}

/**
 * An IP as MoonPay compares it: IPv4 dotted quad without leading zeros, IPv6 in RFC 5952 form (lowercase,
 * longest zero run as ::), IPv4-mapped IPv6 unmapped, ports and brackets stripped. Null if not an IP.
 */
export function canonicalIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  s = s.replace(/%.*$/, ""); // zone id
  if (isIP(s) === 4) return s.split(".").map((p) => String(Number(p))).join(".");
  if (isIP(s) !== 6) return null;
  const mappedDotted = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mappedDotted && isIP(mappedDotted[1]) === 4) return canonicalIp(mappedDotted[1]);
  // WHATWG URL serialises IPv6 hosts exactly as RFC 5952 asks.
  const host = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return host;
}

/** Loopback, private, link-local and similar: MoonPay can never observe these, so hashing one would only block the widget. */
export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  if (isIP(ip) === 6) return !(ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip));
  return false;
}

/** The allowedIpAddress value for this IP, or null when it can't help (no IP, or not a public one). */
export function allowedIpHash(ip: string | null, secretKey: string): string | null {
  const canonical = canonicalIp(ip);
  return canonical && isPublicIp(canonical) ? hmacBase64(secretKey, canonical) : null;
}

/** The parameters in the order they are signed and sent. */
export function widgetParams(config: MoonpayConfig, input: WidgetInput): [string, string][] {
  const params: [string, string][] = [
    ["apiKey", config.publishableKey],
    ["currencyCode", MOONPAY_CURRENCY],
    ["walletAddress", input.recipient],
    ["showWalletAddressForm", "true"], // the payer sees, but can't change, where the money goes
    ["quoteCurrencyAmount", input.amount],
    ["paymentMethod", "credit_debit_card"],
    ["externalTransactionId", input.requestId],
    ["redirectURL", input.redirectUrl],
    ["unsupportedRegionRedirectUrl", input.unsupportedRegionUrl],
  ];
  const ipHash = config.ipMatch ? allowedIpHash(input.ip, config.secretKey) : null;
  if (ipHash) params.push(["allowedIpAddress", ipHash]);
  return params;
}

export function encodeQuery(params: readonly (readonly [string, string])[]): string {
  return `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}

/** The complete signed widget URL. */
export function signedWidgetUrl(config: MoonpayConfig, input: WidgetInput): string {
  const query = encodeQuery(widgetParams(config, input));
  return `${config.widgetBase}/${query}&signature=${encodeURIComponent(signQuery(query, config.secretKey))}`;
}
