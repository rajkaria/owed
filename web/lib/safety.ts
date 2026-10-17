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
  // W2-E (QA-06): Owed's own name, as phrases the ordinary word "owed" never forms, and the model maker.
  "owed support",
  "owed team",
  "owed security",
  "owed admin",
  "owed billing",
  "getowed",
  "anthropic",
] as const;

// One list with plugin/src/text.ts and lib/view/text.ts (W2-E, QA-09); test/safety-links.test.ts keeps them equal.
export const WEB_TLDS =
  "com|net|org|io|xyz|app|link|co|me|info|biz|finance|money|cash|pay|wallet|exchange|gg|so|sh|dev|ai|us|uk|ru|cn|top|site|online|website|club|vip|pro|live|tech|store|shop|fun|cc|tk|ml|ga|cf|gq|ly|to|in|eu|de|fr|ws|pw|is|tv|fm|am|gl|im|ca|au|jp|br|ch|nl|be|es|it|pt|pl|tr|ua|id|ph|ng|za|asia|mobi|name|support|help|claims|claim|fi|services|global|world|network|today|click|page|bet|win|ink|lol|space|cloud|digital|news|blog|email|zip|mov|icu|bond|cyou|sbs|country|xin|work|rest|cam|quest|buzz|monster|cfd|uno|best|fit|ltd|art|one|run|life|guru|host|press|fyi|wiki|zone|center|company|group|loan|date|review|download|stream|party|science|trade|bid|racing|men|kim|red|ooo|now|chat|social|game|games|bot";

const URL_PATTERNS: RegExp[] = [
  // scheme://... ; one glued to the end of a word ("INV-42https://…") takes only the URL (QA-13).
  /(?:https?|ftp|wss?|ipfs|ipns|file):\/\/\S*|(?<![a-z0-9+.-])[a-z][a-z+.]*:\/\/\S*/giu,
  /\b(?:solana|ethereum|bitcoin|mailto|tel|sms|javascript|data|vbscript|file|intent|tg|wc):\S*/giu,
  /\bwww\.\S*/giu,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?/gu, // bare IPv4
  new RegExp(
    `\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${WEB_TLDS})\\b(?:[/:?#]\\S*)?`,
    "giu",
  ),
];

const OWED_DOMAINS = ["getowed.xyz", "owed-omega.vercel.app"] as const;

/**
 * Each brand's own domains (W2-E, QA-06 follow-up; the same as W2-H's lib/payee.ts list). A brand word
 * in a request's text is not a caution when the request's DNS-verified from_domain is that brand's
 * own domain or under it: "Owed Support" from a verified getowed.xyz is Owed. A name alone never clears it.
 */
export const BRAND_OWN_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  paybox: ["paybox.sh"],
  moonpay: ["moonpay.com"],
  coinbase: ["coinbase.com"],
  binance: ["binance.com", "binance.us"],
  phantom: ["phantom.app", "phantom.com"],
  solflare: ["solflare.com"],
  "solana foundation": ["solana.org", "solana.com"],
  circle: ["circle.com"],
  irs: ["irs.gov"],
  "owed support": OWED_DOMAINS,
  "owed team": OWED_DOMAINS,
  "owed security": OWED_DOMAINS,
  "owed admin": OWED_DOMAINS,
  "owed billing": OWED_DOMAINS,
  getowed: OWED_DOMAINS,
  anthropic: ["anthropic.com"],
};

/** True when `domain` (already DNS-verified) is `word`'s own domain or a subdomain of one. */
export function isBrandOwnDomain(word: string, domain: string | null | undefined): boolean {
  const d = domain?.trim().toLowerCase().replace(/\.$/, "");
  return !!d && (BRAND_OWN_DOMAINS[word] ?? []).some((own) => d === own || d.endsWith(`.${own}`));
}

/** Drops `brand_word:<w>` flags that a DNS-verified from_domain owns. Pass only a verified domain. */
export function withoutOwnBrandFlags(flags: readonly string[], verifiedDomain: string | null | undefined): string[] {
  return flags.filter((f) => !(f.startsWith("brand_word:") && isBrandOwnDomain(f.slice("brand_word:".length), verifiedDomain)));
}

/**
 * Removed outright: format characters (zero-width, bidi overrides, tag characters), and (W2-E, QA-01)
 * everything else that renders as nothing but a model still reads: Unicode tag characters
 * (U+E0000–E007F), variation selectors (U+FE00–FE0F, U+E0100–E01EF), the combining grapheme joiner,
 * Mongolian free variation selectors, Khmer inherent vowels, Hangul fillers and the Braille blank.
 * plugin/src/text.ts and lib/view/text.ts drop the same set.
 */
export const INVISIBLE =
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Control characters and line/paragraph separators: become spaces. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const DOUBLE_QUOTES = /["“”„‟«»″＂]/gu;
const MARKUP = /[<>[\]{}`\\]/gu;
const PLUGIN_LINK_MARKER = /\[link removed\]/giu;

/**
 * Clean untrusted text: normalize, drop invisible characters and links, turn
 * double quotes into single quotes (we add our own quotes when rendering),
 * collapse whitespace and cap at `max` code points. Returns null when empty.
 */
export function sanitizeText(input: string | null | undefined, max: number): string | null {
  if (input == null) return null;
  let s = input.toWellFormed().normalize("NFKC").replace(INVISIBLE, "").replace(BREAKS, " ");
  for (const re of URL_PATTERNS) s = s.replace(re, " ");
  // The plugin marks the links it removed as "[link removed]"; keep that readable once brackets go (QA-13).
  s = s.replace(PLUGIN_LINK_MARKER, "(link removed)");
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
