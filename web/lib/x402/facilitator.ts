import { NETWORK_V1, NETWORK_V2, type FeePayers, type SettleResponse } from "./wire";

// x402 facilitator client: GET /supported, POST /verify, POST /settle (same API for x402
// v1 and v2). Default is PayAI, keyless for ordinary `exact` payments on Solana mainnet.
// The facilitator co-signs as fee payer and submits the payer's transaction; it never holds
// the money (the transfer goes payer -> recipient in one transaction).

export const DEFAULT_FACILITATOR_URL = "https://facilitator.payai.network";
const SUPPORTED_TTL_MS = 5 * 60_000;
const SUPPORTED_TIMEOUT_MS = 4000;
const VERIFY_TIMEOUT_MS = 10_000;
/** Settlement submits and confirms a transaction; allow for a congested slot or two. */
const SETTLE_TIMEOUT_MS = 30_000;

export class FacilitatorError extends Error {}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface Supported {
  feePayers: FeePayers;
  /** Every Solana address the facilitator signs with; a payment's fee payer must be one of them. */
  signers: Set<string>;
  /** W3-B: `exact` on Base mainnet, per x402 generation (v2 eip155:8453, v1 "base"). */
  base?: { v1: boolean; v2: boolean };
}

export interface Facilitator {
  readonly url: string;
  supported(): Promise<Supported>;
  verify(version: 1 | 2, paymentPayload: unknown, paymentRequirements: unknown): Promise<VerifyResponse>;
  settle(version: 1 | 2, paymentPayload: unknown, paymentRequirements: unknown): Promise<SettleResponse>;
}

export interface FacilitatorOptions {
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface SupportedKind {
  x402Version?: unknown;
  scheme?: unknown;
  network?: unknown;
  extra?: { feePayer?: unknown };
}

const supportedCache = new Map<string, { at: number; value: Supported }>();

export function facilitatorUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new FacilitatorError("X402_FACILITATOR_URL must be https");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Reads the fee payer for Solana mainnet `exact` in both x402 generations. */
export function parseSupported(json: unknown): Supported {
  const kinds = (json as { kinds?: SupportedKind[] } | null)?.kinds;
  if (!Array.isArray(kinds)) throw new FacilitatorError("facilitator /supported has no kinds");
  const feePayerFor = (version: number, network: string) => {
    const kind = kinds.find((k) => k.x402Version === version && k.scheme === "exact" && k.network === network);
    const feePayer = kind?.extra?.feePayer;
    if (typeof feePayer !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(feePayer)) {
      throw new FacilitatorError(`facilitator does not support exact payments on ${network} (x402 v${version})`);
    }
    return feePayer;
  };
  const feePayers = { v1: feePayerFor(1, NETWORK_V1), v2: feePayerFor(2, NETWORK_V2) };
  const listed = (json as { signers?: Record<string, unknown> }).signers?.["solana:*"];
  const signers = new Set([feePayers.v1, feePayers.v2, ...(Array.isArray(listed) ? listed.filter((s) => typeof s === "string") : [])]);
  // W3-B Base requests: whether this facilitator settles `exact` USDC payments on Base mainnet.
  const base = {
    v1: kinds.some((k) => k.x402Version === 1 && k.scheme === "exact" && k.network === "base"),
    v2: kinds.some((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === "eip155:8453"),
  };
  return { feePayers, signers, base };
}

export function makeFacilitator(options: FacilitatorOptions = {}): Facilitator {
  const url = options.url ?? facilitatorUrl();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function call(path: string, timeoutMs: number, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
    let res: Response;
    try {
      res = await doFetch(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        redirect: "error",
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new FacilitatorError(`facilitator ${path} ${timedOut ? "timed out" : "unreachable"}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // An HTML error page: reported through the status code.
    }
    return { status: res.status, json, text };
  }

  return {
    url,
    async supported() {
      const hit = supportedCache.get(url);
      if (hit && now() - hit.at < SUPPORTED_TTL_MS) return hit.value;
      const { status, json } = await call("/supported", SUPPORTED_TIMEOUT_MS);
      if (status !== 200) throw new FacilitatorError(`facilitator /supported answered HTTP ${status}`);
      const value = parseSupported(json);
      supportedCache.set(url, { at: now(), value });
      return value;
    },
    async verify(version, paymentPayload, paymentRequirements) {
      const { status, json, text } = await call("/verify", VERIFY_TIMEOUT_MS, { x402Version: version, paymentPayload, paymentRequirements });
      const v = json as VerifyResponse | null;
      if (status !== 200 || !v || typeof v.isValid !== "boolean") {
        // PayAI answers 400 with {isValid:false, invalidReason} for malformed payments.
        if (v && v.isValid === false && typeof v.invalidReason === "string") return v;
        return { isValid: false, invalidReason: `facilitator_verify_http_${status}: ${text.slice(0, 160)}` };
      }
      return v;
    },
    async settle(version, paymentPayload, paymentRequirements) {
      const { status, json, text } = await call("/settle", SETTLE_TIMEOUT_MS, { x402Version: version, paymentPayload, paymentRequirements });
      const s = json as (Partial<SettleResponse> & { txHash?: string; networkId?: string; error?: string }) | null;
      const network = version === 2 ? NETWORK_V2 : NETWORK_V1;
      if (!s || typeof s.success !== "boolean") {
        return { success: false, errorReason: `facilitator_settle_http_${status}: ${text.slice(0, 160)}`, transaction: "", network };
      }
      // The oldest v1 facilitators answered {txHash, networkId, error}.
      return {
        success: s.success && status === 200,
        errorReason: s.errorReason ?? s.error ?? (status === 200 ? undefined : `facilitator_settle_http_${status}`),
        payer: s.payer,
        transaction: s.transaction ?? s.txHash ?? "",
        network: s.network ?? s.networkId ?? network,
      };
    },
  };
}

/** Tests only. */
export function clearSupportedCache(): void {
  supportedCache.clear();
}
