// Text shown to people. Everything a requester writes (for, note, names, Solana Pay label/message/memo)
// is untrusted: it goes through clean() before display and is rendered quoted, never as a verified identity.

// Character classes are built from code points so the source stays ASCII (u flag: astral planes too).
const hex = (n: number) => `\\u{${n.toString(16)}}`;
const charClass = (ranges: Array<[number, number?]>, extra = "") =>
  `[${ranges.map(([a, b]) => (b === undefined ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}${extra}]`;
const LINE_BREAKS = new RegExp(`${charClass([[0x09, 0x0d], [0x85], [0x2028, 0x2029]])}+`, "gu");
// C0/C1 controls, soft hyphen, zero-width and bidi controls, word joiners, BOM, interlinear annotations,
// and (W2-E, QA-01) everything else that renders as nothing but a model still reads: every format
// character (\p{Cf}), Unicode tag characters ("ASCII smuggling", U+E0000–E007F), variation selectors
// (U+FE00–FE0F, U+E0100–E01EF, one per byte in "emoji smuggling"), the combining grapheme joiner,
// Mongolian free variation selectors, Khmer inherent vowels, Hangul fillers and the Braille blank.
// web/lib/safety.ts and web/lib/view/text.ts drop the same set.
const INVISIBLE = new RegExp(charClass([
  [0x00, 0x1f], [0x7f, 0x9f], [0xad], [0x34f], [0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x2800], [0x3164], [0xfe00, 0xfe0f], [0xfeff], [0xffa0], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
], "\\p{Cf}"), "gu");
// One list with web/lib/safety.ts and web/lib/view/text.ts (W2-E, QA-09: newer TLDs common in phishing,
// .zip and .mov included); web/test/safety-links.test.ts checks the three stay equal.
export const TLDS = "com|net|org|io|xyz|app|link|co|me|info|biz|finance|money|cash|pay|wallet|exchange|gg|so|sh|dev|ai|us|uk|ru|cn|top|site|online|website|club|vip|pro|live|tech|store|shop|fun|cc|tk|ml|ga|cf|gq|ly|to|in|eu|de|fr|ws|pw|is|tv|fm|am|gl|im|ca|au|jp|br|ch|nl|be|es|it|pt|pl|tr|ua|id|ph|ng|za|asia|mobi|name|support|help|claims|claim|fi|services|global|world|network|today|click|page|bet|win|ink|lol|space|cloud|digital|news|blog|email|zip|mov|icu|bond|cyou|sbs|country|xin|work|rest|cam|quest|buzz|monster|cfd|uno|best|fit|ltd|art|one|run|life|guru|host|press|fyi|wiki|zone|center|company|group|loan|date|review|download|stream|party|science|trade|bid|racing|men|kim|red|ooo|now|chat|social|game|games|bot";
const URL_PATTERNS = [
  // A scheme glued to the end of a word ("INV-42https://…") takes only the URL, not the word (QA-13).
  /(?:https?|ftp|wss?|ipfs|ipns|file):\/\/\S*|(?<![a-z0-9+.-])[a-z][a-z+.]*:\/\/\S*/gi,
  /\b(?:solana|mailto|tel|sms|ethereum|bitcoin|javascript|data|ipfs):\S+/gi,
  /\bwww\.\S+/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?/g, // a bare IPv4 address (QA-09)
  new RegExp(`\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.(?:${TLDS})\\b(?:[/?#:]\\S*)?`, "gi"),
];
export const LINK_REMOVED = "[link removed]";

/** Strips links, control and invisible characters, collapses whitespace, caps at `max` characters. */
export function clean(untrusted: string | null | undefined, max: number): string {
  if (!untrusted) return "";
  let text = untrusted.normalize("NFKC").replace(LINE_BREAKS, " ").replace(INVISIBLE, "");
  for (const pattern of URL_PATTERNS) text = text.replace(pattern, LINK_REMOVED);
  text = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * A create refused with rate_limited: the server says which limit (this recipient, this client, or
 * everyone), so say that instead of guessing (W2-E, QA-07).
 */
export function rateLimitedText(serverMessage: string, extra = ""): string {
  const reason = clean(serverMessage, 160).replace(/[.\s]+$/, "");
  return `Owed is limiting new requests${reason ? `: ${reason}` : " right now"}.${extra ? ` ${extra}` : ""} Nothing was created.`;
}

/** Cleaned text in double quotes, ready to show as someone else's words. Empty input gives "". */
export function quote(untrusted: string | null | undefined, max: number): string {
  const text = clean(untrusted, max);
  return text ? `"${text.replace(/"/g, "'")}"` : "";
}

/** SPEC §6. A hit never blocks; it adds a caution. */
export const BRAND_WORDS = [
  "moonpay", "paybox", "coinbase", "binance", "phantom", "solflare", "solana foundation",
  "circle", "usdc support", "refund", "irs", "tax office",
  // W2-E (QA-06): Owed's own name, as phrases the ordinary word "owed" never forms, and the model maker.
  "owed support", "owed team", "owed security", "owed admin", "owed billing", "getowed", "anthropic",
] as const;
export type BrandWord = (typeof BRAND_WORDS)[number];

const BRAND_DISPLAY: Record<BrandWord, string> = {
  moonpay: "MoonPay", paybox: "PayBox", coinbase: "Coinbase", binance: "Binance", phantom: "Phantom",
  solflare: "Solflare", "solana foundation": "Solana Foundation", circle: "Circle", "usdc support": "USDC support",
  refund: "refund", irs: "IRS", "tax office": "tax office",
  "owed support": "Owed Support", "owed team": "Owed team", "owed security": "Owed Security", "owed admin": "Owed admin",
  "owed billing": "Owed billing", getowed: "getowed", anthropic: "Anthropic",
};

// Letters may be split by one space, dot, dash or underscore ("Moon Pay", "I.R.S"); the word must stand alone.
const BRAND_PATTERNS = BRAND_WORDS.map((word) => {
  const letters = Array.from(word.replace(/ /g, "")).join("[\\s._-]?");
  return { word, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${letters}s?(?![\\p{L}\\p{N}])`, "iu") };
});

/** `brand_word:<word>` for each brand word found in any of the texts, in list order. */
export function brandFlags(...texts: Array<string | null | undefined>): string[] {
  const haystack = texts.filter(Boolean).join(" | ").normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ");
  return BRAND_PATTERNS.filter(({ pattern }) => pattern.test(haystack)).map(({ word }) => `brand_word:${word}`);
}

const OWED_DOMAINS = ["getowed.xyz", "owed-omega.vercel.app"] as const;

/**
 * Each brand's own domains (W2-E, QA-06 follow-up; the same as W2-H's list in payee.ts). A brand word is
 * not a caution when the request's from_domain, verified over DNS by this plugin, is that brand's own
 * domain or under it: "Owed Support" from a verified getowed.xyz is Owed. A name alone never clears it.
 */
export const BRAND_OWN_DOMAINS: Readonly<Partial<Record<BrandWord, readonly string[]>>> = {
  paybox: ["paybox.sh"], moonpay: ["moonpay.com"], coinbase: ["coinbase.com"], binance: ["binance.com", "binance.us"],
  phantom: ["phantom.app", "phantom.com"], solflare: ["solflare.com"], "solana foundation": ["solana.org", "solana.com"],
  circle: ["circle.com"], irs: ["irs.gov"], "owed support": OWED_DOMAINS, "owed team": OWED_DOMAINS, "owed security": OWED_DOMAINS,
  "owed admin": OWED_DOMAINS, "owed billing": OWED_DOMAINS, getowed: OWED_DOMAINS, anthropic: ["anthropic.com"],
};

/** Drops `brand_word:<w>` flags that a DNS-verified domain owns. Pass only a domain this plugin verified. */
export function withoutOwnBrandFlags(flags: readonly string[], verifiedDomain: string | null | undefined): string[] {
  const d = verifiedDomain?.trim().toLowerCase().replace(/\.$/, "");
  if (!d) return [...flags];
  return flags.filter((f) => {
    const own = f.startsWith("brand_word:") ? BRAND_OWN_DOMAINS[f.slice("brand_word:".length) as BrandWord] : undefined;
    return !own?.some((o) => d === o || d.endsWith(`.${o}`));
  });
}

/** Display names for the brand words in flags like `brand_word:moonpay`; unknown flags are ignored. */
export function brandWordsFromFlags(flags: string[]): string[] {
  const words = new Set<string>();
  for (const flag of flags) {
    const word = flag.startsWith("brand_word:") ? flag.slice("brand_word:".length) : "";
    if (word in BRAND_DISPLAY) words.add(BRAND_DISPLAY[word as BrandWord]);
  }
  return [...words];
}

export function cautionLine(flags: string[]): string | null {
  const words = brandWordsFromFlags(flags);
  if (words.length === 0) return null;
  const quoted = words.map((w) => `"${w}"`);
  const list = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
  return `Caution: this request mentions ${list}. Owed can't confirm who sent it.`;
}

export interface ShareTextInput {
  payerName?: string;
  requesterName?: string;
  forText?: string;
  amount: string;
  token: string;
  link: string;
  /** Local-currency ask: the amount asked, formatted ("₹1,200"); `amount` is then the USDC locked. */
  fiat?: string;
}

/** The message the requester sends. Inputs must already be clean()ed. */
export function shareText(i: ShareTextInput): string {
  const greeting = i.payerName
    ? (i.requesterName ? `Hey ${i.payerName}, it's ${i.requesterName}.` : `Hey ${i.payerName}!`)
    : (i.requesterName ? `Hi, it's ${i.requesterName}.` : "Hi!");
  // Local-currency asks lead with the amount asked, then the USDC actually paid.
  const what = i.fiat ? `${i.fiat} (${i.amount} ${i.token})` : `${i.amount} ${i.token}`;
  const ask = i.forText
    ? `Your share for "${i.forText.replace(/"/g, "'")}" is ${what}.`
    : `This is a request for ${what}.`;
  return `${greeting} ${ask} Pay with any Solana wallet here: ${i.link}`;
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Time from `iso` to `now` as "2h 14m", "3d 4h", "12m" or "<1m". Undefined for bad or future times. */
export function ago(iso: string, now: number = Date.now()): string | undefined {
  const start = Date.parse(iso);
  if (!Number.isFinite(start) || start > now + 60_000) return undefined;
  const minutes = Math.floor(Math.max(0, now - start) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return minutes > 0 ? `${mins}m` : "<1m";
}

export function explorerUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
