// Requester-written text (for, note, names) is untrusted. It is cleaned here, stored
// cleaned, and always rendered as quoted text, never as a verified identity.

export const TEXT_LIMITS = { payer_name: 40, for: 80, note: 140, requester_name: 40 } as const;

/** Case-insensitive; a hit adds a flag and a caution banner. It never blocks. */
export const BRAND_WORDS = [
  "moonpay",
  "paybox",
  "coinbase",
  "binance",
  "phantom",
  "solflare",
  "solana foundation",
  "circle",
  "usdc support",
  "refund",
  "irs",
  "tax office",
] as const;

const WEB_TLDS =
  "com|net|org|io|co|xyz|link|app|me|ly|gg|sh|so|ai|dev|info|biz|site|online|top|click|live|pro|fun|" +
  "finance|money|cash|pay|wallet|exchange|today|store|shop|vip|club|cc|tk|ml|ga|cf|gq|ru|cn|in|uk|us|" +
  "de|fr|ws|to|is|tv|fm|am|gl|bet|win|ink|lol|page|website|space|tech|cloud|digital|network|support|" +
  "help|services|global|world|news|blog|email|im|eu|ca|au|jp|br|ch|nl|be|es|it|pt|pl|tr|ua|id|ph|ng|za";

const URL_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S*/giu, // scheme://...
  /\b(?:solana|ethereum|bitcoin|mailto|tel|sms|javascript|data|vbscript|file|intent|tg|wc):\S*/giu,
  /\bwww\.\S*/giu,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?/gu, // bare IPv4
  new RegExp(
    `\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${WEB_TLDS})\\b(?:[/:?#]\\S*)?`,
    "giu",
  ),
];

/** Format characters (zero-width, bidi overrides): removed outright. */
const INVISIBLE = /\p{Cf}/gu;
/** Control characters and line/paragraph separators: become spaces. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const DOUBLE_QUOTES = /["“”„‟«»″＂]/gu;
const MARKUP = /[<>[\]{}`\\]/gu;

/**
 * Clean untrusted text: normalize, drop invisible characters and links, turn
 * double quotes into single quotes (we add our own quotes when rendering),
 * collapse whitespace and cap at `max` code points. Returns null when empty.
 */
export function sanitizeText(input: string | null | undefined, max: number): string | null {
  if (input == null) return null;
  let s = input.toWellFormed().normalize("NFKC").replace(INVISIBLE, "").replace(BREAKS, " ");
  for (const re of URL_PATTERNS) s = s.replace(re, " ");
  s = s.replace(DOUBLE_QUOTES, "'").replace(MARKUP, " ").replace(/\s+/gu, " ").trim();
  const capped = Array.from(s).slice(0, max).join("").trim();
  return capped === "" ? null : capped;
}

/** Wraps already-sanitized text in quotes for display. */
export function quoteText(s: string): string {
  return `"${s}"`;
}

// Look-alike letters and digits folded to ASCII so "M00nPay" or Cyrillic "Віnance" still match.
const CONFUSABLES: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "!": "i", "|": "l",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "ο": "o", "α": "a", "ν": "v", "ι": "i", "κ": "k",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ε": "e",
};

function fold(text: string): string {
  const lower = text.normalize("NFKC").replace(INVISIBLE, "").replace(BREAKS, " ").toLowerCase();
  let out = "";
  for (const ch of lower) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/**
 * Brand-word flags (`brand_word:<word>`) for any of the texts. Checks raw input so a
 * brand hidden inside a stripped link still counts. Whole-word match on folded text,
 * plus a squashed match ("moon-pay", "m.o.o.n.p.a.y") for words of six letters or more.
 */
export function brandFlags(texts: ReadonlyArray<string | null | undefined>): string[] {
  const folded = texts.filter((t): t is string => typeof t === "string").map(fold);
  const spaced = folded.map((t) => ` ${t.replace(/[^a-z0-9]+/g, " ").trim()} `);
  const squashed = folded.map((t) => t.replace(/[^a-z0-9]+/g, ""));
  const flags: string[] = [];
  for (const word of BRAND_WORDS) {
    const tight = word.replace(/ /g, "");
    const hit =
      spaced.some((t) => t.includes(` ${word} `)) ||
      (tight.length >= 6 && squashed.some((t) => t.includes(tight)));
    if (hit) flags.push(`brand_word:${word}`);
  }
  return flags;
}
