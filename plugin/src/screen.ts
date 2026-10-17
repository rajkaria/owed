import { clean, shortAddress } from "./text.js";

// Recipient sanctions screen (SPEC §6, T2.6). Tools that create payment requests call it before
// creating; pay_link calls it before proposing a payment.
//
//   GET https://public.chainalysis.com/api/v1/address/<address>
//
// Chainalysis's free sanctions API answers {"identifications": [...]}: empty for an address on no
// sanctions list, one entry per designation otherwise. The API key is a PayBox brokered header
// (X-API-Key, exact host public.chainalysis.com): PayBox adds it to this request inside its sandbox,
// so the plugin never holds, reads or sends it itself.
//
// Listed → { ok: false } with a plain message naming the list; the caller refuses.
// Anything short of a clean answer (timeout, 401 bad key, 403 no key, 5xx, a reply off that shape)
// → { ok: true, screening: "unavailable" }; the caller continues and says the address wasn't screened.
// Fixtures: test/fixtures/chainalysis/ (real answers, recorded by capture-chainalysis.mjs).

export type Screening =
  | { ok: true; screening: "clear" | "unavailable" | "skipped" }
  | { ok: false; message: string };

export interface ScreenDeps {
  fetch: typeof fetch;
}

export const CHAINALYSIS_HOST = "public.chainalysis.com";
export const SCREEN_TIMEOUT_MS = 2500;
const MAX_BYTES = 64 * 1024;
const MAX_LABEL = 120;

export const SCREENING_UNAVAILABLE_LINE = "Recipient screening was unavailable, so this address wasn't screened.";

export function screeningUrl(address: string): string {
  return `https://${CHAINALYSIS_HOST}/api/v1/address/${encodeURIComponent(address)}`;
}

/**
 * "SANCTIONS: OFAC SDN Garantex Europe OU 2022-04-05 9f6e…" → "OFAC SDN Garantex Europe OU 2022-04-05".
 * Chainalysis's text, so it's cleaned like any outside text (no links, no control characters, capped).
 */
export function designationLabel(name: unknown): string {
  if (typeof name !== "string") return "";
  return clean(name.replace(/^\s*sanctions\s*:\s*/i, "").replace(/\s+[0-9a-f]{32,}\s*$/i, ""), MAX_LABEL).replace(/"/g, "'");
}

/** The refusal for a listed address: names the list as Chainalysis reports it, no link, no proposal. */
export function sanctionedMessage(address: string, identifications: ReadonlyArray<Record<string, unknown>>): string {
  const labels = [...new Set(identifications.map((i) => designationLabel(i.name)).filter(Boolean))];
  const named = labels.length === 0
    ? "Chainalysis reports it on a sanctions list"
    : `Chainalysis reports it as "${labels[0]}"${labels.length > 1 ? ` and ${labels.length - 1} more` : ""}`;
  return `The address ${shortAddress(address)} is on a sanctions list (${named}). Owed doesn't create or pay requests for sanctioned addresses.`;
}

/** Pure: one HTTP answer from the Chainalysis API → a screening result. */
export function parseScreening(address: string, status: number, body: string): Screening {
  const unavailable: Screening = { ok: true, screening: "unavailable" };
  if (status !== 200 || body.length > MAX_BYTES) return unavailable;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return unavailable;
  }
  const ids = (json as { identifications?: unknown } | null)?.identifications;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === "object" && i !== null && !Array.isArray(i))) return unavailable;
  if (ids.length === 0) return { ok: true, screening: "clear" };
  return { ok: false, message: sanctionedMessage(address, ids as Array<Record<string, unknown>>) };
}

async function raceTimeout<T>(promise: Promise<T>, ms: number, value: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(value), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Screens one address against Chainalysis's sanctions data in at most 2.5 s. Never throws. */
export async function screenRecipient(address: string, deps: ScreenDeps = { fetch: (i, init) => fetch(i, init) }): Promise<Screening> {
  const attempt = async (): Promise<Screening> => {
    try {
      const res = await deps.fetch(screeningUrl(address), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
        redirect: "error",
      });
      return parseScreening(address, res.status, await res.text());
    } catch {
      return { ok: true, screening: "unavailable" };
    }
  };
  // The signal covers fetch and body; the race covers a fetch that ignores it.
  return raceTimeout(attempt(), SCREEN_TIMEOUT_MS + 50, { ok: true, screening: "unavailable" });
}
