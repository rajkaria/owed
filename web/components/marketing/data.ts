import "server-only";
import { dohUrl, DOH_RESOLVERS, DOH_TIMEOUT_MS, owedPayValues, parseTxtAnswer, RECORD_LABEL } from "@/lib/payee";
import { siteOrigin } from "@/lib/site";

// Live data for the landing page, read at render time (the page revalidates every minute).
// Both reads fail soft: a section that can't load real data says so or hides, never shows made-up values.

export interface PaidStats {
  count: number;
  /** Decimal string, whole USDC. */
  usdc: string;
  since: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** GET /api/v1/stats: real paid requests on mainnet. Null when it can't be read. */
export async function getPaidStats(origin = siteOrigin()): Promise<PaidStats | null> {
  try {
    const res = await fetch(new URL("/api/v1/stats", origin), {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { paid_count?: unknown; paid_volume_usdc?: unknown; since?: unknown };
    const count = json.paid_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    const usdc = typeof json.paid_volume_usdc === "string" && DECIMAL.test(json.paid_volume_usdc) ? json.paid_volume_usdc : "0";
    const since = typeof json.since === "string" && !Number.isNaN(Date.parse(json.since)) ? json.since : "";
    return { count, usdc, since };
  } catch {
    return null;
  }
}

export interface OwedRecord {
  /** `_owed.<domain>` */
  name: string;
  /** Wallets listed in `owed-pay=` values, in DNS order. */
  wallets: string[];
  /** The resolver's AD flag. */
  dnssec: boolean;
  resolver: string;
  /** When this page read it (ISO, UTC). */
  readAt: string;
}

/** Reads `_owed.<domain>` TXT the way the plugin does (Cloudflare, then Google). Null when DNS can't be read. */
export async function readOwedRecord(domain: string): Promise<OwedRecord | null> {
  const name = `${RECORD_LABEL}.${domain}`;
  for (const resolver of DOH_RESOLVERS) {
    try {
      const res = await fetch(dohUrl(resolver.url, name), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
        next: { revalidate: 60 },
      });
      if (!res.ok) continue;
      const answer = parseTxtAnswer(await res.json(), name);
      if (!answer) continue;
      return { name, wallets: owedPayValues(answer.txt), dnssec: answer.ad, resolver: resolver.host, readAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    } catch {
      // try the next resolver
    }
  }
  return null;
}
