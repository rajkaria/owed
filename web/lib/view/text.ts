// Requester-written text (`for`, `note`, names, Solana Pay label/message) is
// untrusted. The API cleans it on write; pages clean it again on render so a
// raw Solana Pay link on /p, or an older row, gets the same treatment.

export const LIMITS = { name: 40, for: 80, note: 140, ogFor: 40 } as const;

// Control characters, zero-width characters and bidi overrides (used to make
// "dinner" display as something else), plus (W2-E, QA-01) every format character, tag characters,
// variation selectors, fillers that render as blanks and the Braille blank: the same set as
// lib/safety.ts and the plugin's text.ts.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** Text without the invisible characters above (for matching, not display). */
export function withoutInvisible(input: string): string {
  return input.normalize("NFKC").replace(INVISIBLE, "");
}

const SCHEME_URL = /\b(?:https?|ftp|solana|ethereum|bitcoin|data|javascript|mailto|tg|wc):\/{0,2}\S+/gi;
const WWW_URL = /\bwww\.\S+/gi;
const BARE_DOMAIN =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|net|org|io|xyz|app|link|co|me|info|biz|ru|cn|top|site|online|live|gg|ly|to|sh|dev|ai|fi|finance|money|cash|pay|wallet|click|vip|shop|store|claims?|support|help|us|uk|in)\b(?:\/\S*)?/gi;

/** Code-point aware truncation with a single-character ellipsis. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/**
 * Strip URLs and invisible characters, collapse whitespace, cap length.
 * Returns null when nothing readable is left.
 */
export function cleanText(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input
    .slice(0, 2000)
    .normalize("NFKC")
    .replace(INVISIBLE, " ")
    .replace(SCHEME_URL, " ")
    .replace(WWW_URL, " ")
    .replace(BARE_DOMAIN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return truncate(cleaned, max);
}
