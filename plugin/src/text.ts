// Text shown to people. Everything a requester writes (for, note, names, Solana Pay label/message/memo)
// is untrusted: it goes through clean() before display and is rendered quoted, never as a verified identity.

// Character classes are built from code points so the source stays ASCII.
const hex = (n: number) => "\\u" + n.toString(16).padStart(4, "0");
const charClass = (ranges: Array<[number, number?]>) =>
  `[${ranges.map(([a, b]) => (b === undefined ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`;
const LINE_BREAKS = new RegExp(`${charClass([[0x09, 0x0d], [0x85], [0x2028, 0x2029]])}+`, "g");
// C0/C1 controls, soft hyphen, zero-width and bidi controls, word joiners, BOM, interlinear annotations.
const INVISIBLE = new RegExp(charClass([
  [0x00, 0x1f], [0x7f, 0x9f], [0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff], [0xfff9, 0xfffb],
]), "g");
const TLDS = "com|net|org|io|xyz|app|link|co|me|info|biz|finance|money|cash|wallet|gg|so|sh|dev|ai|us|uk|ru|cn|top|site|online|club|vip|pro|live|tech|store|shop|fun|cc|tk|ml|ga|cf|gq|ly|to|in|eu|de|fr|ws|pw|support|help|claims|bet|page|click|today|world|network|exchange";
const URL_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi,
  /\b(?:solana|mailto|tel|sms|ethereum|bitcoin|javascript|data|ipfs):\S+/gi,
  /\bwww\.\S+/gi,
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

/** Cleaned text in double quotes, ready to show as someone else's words. Empty input gives "". */
export function quote(untrusted: string | null | undefined, max: number): string {
  const text = clean(untrusted, max);
  return text ? `"${text.replace(/"/g, "'")}"` : "";
}

/** SPEC §6. A hit never blocks; it adds a caution. */
export const BRAND_WORDS = [
  "moonpay", "paybox", "coinbase", "binance", "phantom", "solflare", "solana foundation",
  "circle", "usdc support", "refund", "irs", "tax office",
] as const;
export type BrandWord = (typeof BRAND_WORDS)[number];

const BRAND_DISPLAY: Record<BrandWord, string> = {
  moonpay: "MoonPay", paybox: "PayBox", coinbase: "Coinbase", binance: "Binance", phantom: "Phantom",
  solflare: "Solflare", "solana foundation": "Solana Foundation", circle: "Circle", "usdc support": "USDC support",
  refund: "refund", irs: "IRS", "tax office": "tax office",
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
}

/** The message the requester sends. Inputs must already be clean()ed. */
export function shareText(i: ShareTextInput): string {
  const greeting = i.payerName
    ? (i.requesterName ? `Hey ${i.payerName}, it's ${i.requesterName}.` : `Hey ${i.payerName}!`)
    : (i.requesterName ? `Hi, it's ${i.requesterName}.` : "Hi!");
  const ask = i.forText
    ? `Your share for "${i.forText.replace(/"/g, "'")}" is ${i.amount} ${i.token}.`
    : `This is a request for ${i.amount} ${i.token}.`;
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
