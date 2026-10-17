import "server-only";
import { domainToASCII, domainToUnicode } from "node:url";
import { ApiError } from "./http";

// Verified payee (SPEC §5.2 T2.8), the server's copy. A request may name a domain that publishes
// its recipient in DNS: TXT `owed-pay=<address>` at `_owed.<domain>`. The server re-checks it at
// creation (cloudflare-dns.com, then dns.google, 2.5 s each) and stores it for display only; the
// plugin re-reads DNS itself before paying. Same rules as plugin/src/payee.ts: both test suites run
// plugin/test/fixtures/doh/ (real resolver answers) and plugin/test/fixtures/payee-vectors.json.

export type PayeeStatus = "verified" | "unverified" | "dns_unavailable" | "invalid_domain";

export interface PayeeResult {
  status: PayeeStatus;
  /** Lower-case ASCII, punycode for IDN; "" when invalid_domain. */
  domain: string;
  /** Unicode form for people. */
  display_domain: string;
  /** The resolver's AD flag. */
  dnssec: boolean;
  /** owed-pay= records at _owed.<domain>, for any wallet. */
  records: number;
}

export const RECORD_LABEL = "_owed";
export const RECORD_PREFIX = "owed-pay=";
export const DOH_RESOLVERS = [
  { host: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { host: "dns.google", url: "https://dns.google/resolve" },
] as const;
export const DOH_TIMEOUT_MS = 2500;
export const PAYEE_BUDGET_MS = 2 * DOH_TIMEOUT_MS;
const MAX_DOH_BYTES = 64 * 1024;
const TXT = 16;

// ---------------------------------------------------------------- domains

export interface NormalizedDomain {
  ascii: string;
  unicode: string;
  nonAsciiInput: boolean;
}

const NOT_A_HOST = /[\s/\\:@?#%[\]<>"'`,;!$&()*+=|^{}~\p{Cc}\p{Cf}]/u;
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NON_ASCII = /[^\x00-\x7f]/;

/** UTS #46 to ASCII, then strict LDH rules: 2+ labels, ≤63 each, ≤253 total, a non-numeric TLD. */
export function normalizeDomain(input: string): NormalizedDomain | null {
  let s = input.trim().normalize("NFC");
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.toLowerCase().startsWith(`${RECORD_LABEL}.`)) s = s.slice(RECORD_LABEL.length + 1);
  if (!s || s.length > 253 || NOT_A_HOST.test(s)) return null;
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => LDH_LABEL.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  const unicode = domainToUnicode(ascii);
  if (!unicode) return null;
  const unicodeLabels = unicode.split(".");
  if (unicodeLabels.length !== labels.length) return null;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l.startsWith("xn--") && (!NON_ASCII.test(unicodeLabels[i]) || domainToASCII(unicodeLabels[i]) !== l)) return null;
  }
  return { ascii, unicode, nonAsciiInput: NON_ASCII.test(s) };
}

const SCRIPTS = [
  "Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Tamil",
  "Thai", "Han", "Hiragana", "Katakana", "Hangul", "Bopomofo", "Cherokee", "Ethiopic",
] as const;
const SCRIPT_RES = SCRIPTS.map((name) => ({ name, re: new RegExp(`\\p{Script=${name}}`, "u") }));
const ALLOWED_MIXES = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];

function scriptsOf(label: string): string[] {
  const found = new Set<string>();
  for (const ch of label) {
    if (!/\p{L}/u.test(ch)) continue;
    found.add(SCRIPT_RES.find(({ re }) => re.test(ch))?.name ?? "other");
  }
  return [...found];
}

const CONFUSABLE: Record<string, string> = {
  "а": "a", "ь": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "к": "k", "ӏ": "l", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "ѵ": "v", "ԝ": "w",
  "х": "x", "у": "y", "ү": "y",
  "α": "a", "ϲ": "c", "ε": "e", "ι": "i", "ϳ": "j", "κ": "k", "ν": "v", "ο": "o",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y", "ω": "w",
  "ց": "g", "հ": "h", "ո": "n", "օ": "o", "զ": "q", "ս": "u",
  "ɡ": "g", "ı": "i", "ɑ": "a", "ɩ": "i", "ʟ": "l", "ɴ": "n", "ʀ": "r", "ł": "l",
  "ø": "o", "đ": "d", "ħ": "h", "ŧ": "t", "ƅ": "b", "ɵ": "o",
};

function skeleton(label: string): string {
  let out = "";
  for (const ch of label.normalize("NFD").replace(/\p{M}/gu, "")) out += CONFUSABLE[ch] ?? ch;
  return out;
}

const DIGIT_LOOKALIKES: Array<{ re: RegExp; text: string }> = [
  { re: /[a-z]0|0[a-z]/, text: "\"0\" (zero) for \"o\"" },
  { re: /[a-z]1|1[a-z]/, text: "\"1\" (one) for \"l\"" },
  { re: /rn/, text: "\"rn\" for \"m\"" },
  { re: /vv/, text: "\"vv\" for \"w\"" },
];

const listFormat = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** IDN and lookalike warnings, word for word the plugin's; the last line says to check the spelling. */
export function domainWarnings(d: NormalizedDomain): string[] {
  const out: string[] = [];
  const asciiLabels = d.ascii.split(".");
  const unicodeLabels = d.unicode.split(".");
  const idn = asciiLabels.some((l) => l.startsWith("xn--"));
  if (idn) out.push(`${d.unicode} is an internationalized domain name; in DNS it is ${d.ascii}.`);
  else if (d.nonAsciiInput) out.push(`The domain was given with non-ASCII characters and was checked as ${d.ascii}.`);
  if (idn) {
    const read = unicodeLabels.map(skeleton).join(".");
    if (/^[a-z0-9.-]+$/.test(read) && read !== d.unicode) {
      out.push(`It can pass for ${read}: letters from other alphabets, or with accents, can look like plain ones.`);
    }
    for (const label of unicodeLabels) {
      const scripts = scriptsOf(label);
      if (scripts.length > 1 && !ALLOWED_MIXES.some((ok) => scripts.every((s) => ok.has(s)))) {
        out.push(`"${label}" mixes ${listFormat(scripts)} letters, a common trick in lookalike domains.`);
      }
    }
  }
  const plain = asciiLabels.filter((l) => !l.startsWith("xn--")).join(".");
  const digits = DIGIT_LOOKALIKES.filter(({ re }) => re.test(plain)).map(({ text }) => text);
  if (digits.length > 0) out.push(`${d.ascii} has characters that can pass for others: ${listFormat(digits)}.`);
  if (out.length > 0) out.push("Check the spelling letter by letter.");
  return out;
}

export interface PayeeDisplay {
  /** As stored and checked: lower-case ASCII. */
  domain: string;
  /** Unicode form. */
  displayDomain: string;
  /** "münchen.de (xn--mnchen-3ya.de)" for IDN, else the domain. */
  label: string;
  warnings: string[];
}

/** For the pay page badge: how to show a stored domain, with its lookalike warnings. Null if it isn't one. */
export function payeeDisplay(stored: string): PayeeDisplay | null {
  const d = normalizeDomain(stored);
  if (!d) return null;
  return { domain: d.ascii, displayDomain: d.unicode, label: d.unicode !== d.ascii ? `${d.unicode} (${d.ascii})` : d.ascii, warnings: domainWarnings(d) };
}

/** "just now", "12 min ago", "3 h ago", "2 days ago" from `iso` to `now`; null for a bad or future time. */
export function verifiedAgo(iso: string, now: number = Date.now()): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at > now + 60_000) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

// ---------------------------------------------------------------- DNS-over-HTTPS

export interface TxtAnswer {
  rcode: "noerror" | "nxdomain";
  txt: string[];
  ad: boolean;
}

/** Cloudflare: RFC 1035 presentation (`"a" "b"`, `\"`, `\DDD`); dns.google: the joined text bare. */
export function txtValue(data: string): string {
  if (!data.startsWith('"')) return data;
  let out = "";
  let i = 0;
  while (i < data.length) {
    while (data[i] === " ") i++;
    if (i >= data.length) break;
    if (data[i] !== '"') return data;
    i++;
    let closed = false;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      if (ch === "\\") {
        const digits = /^[0-9]{3}/.exec(data.slice(i + 1, i + 4));
        if (digits) {
          out += String.fromCharCode(Number(digits[0]));
          i += 4;
          continue;
        }
        if (i + 1 >= data.length) return data;
        out += data[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    if (!closed) return data;
  }
  return out;
}

const bareName = (name: unknown) => (typeof name === "string" ? name.toLowerCase().replace(/\.$/, "") : null);

/** A DoH JSON answer for `qname`, or null on failure (SERVFAIL, REFUSED, truncated, off-shape, other name). */
export function parseTxtAnswer(body: unknown, qname: string): TxtAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.TC === true) return null;
  const rcode = b.Status === 0 ? "noerror" : b.Status === 3 ? "nxdomain" : null;
  if (!rcode) return null;
  const question = Array.isArray(b.Question) ? (b.Question[0] as Record<string, unknown> | undefined) : undefined;
  if (!question || bareName(question.name) !== qname.toLowerCase()) return null;
  const answers: unknown[] = Array.isArray(b.Answer) ? b.Answer : [];
  const txt = answers
    .filter((a): a is { type: number; data: string } => {
      const r = a as { type?: unknown; data?: unknown } | null;
      return typeof r === "object" && r !== null && r.type === TXT && typeof r.data === "string";
    })
    .map((a) => txtValue(a.data));
  return { rcode, txt, ad: b.AD === true };
}

// W3-B Base requests: a record may name a 0x (Base) address; EVM addresses compare case-insensitively
// (EIP-55 case is only a checksum), Solana addresses exactly.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function sameWallet(published: string, address: string): boolean {
  if (EVM_ADDRESS.test(published) && EVM_ADDRESS.test(address)) return published.toLowerCase() === address.toLowerCase();
  return published === address;
}

export function owedPayValues(txt: string[]): string[] {
  return txt
    .map((t) => t.trim())
    .filter((t) => t.toLowerCase().startsWith(RECORD_PREFIX))
    .map((t) => t.slice(RECORD_PREFIX.length).trim());
}

export function dohUrl(resolverUrl: string, qname: string): string {
  return `${resolverUrl}?name=${encodeURIComponent(qname)}&type=TXT`;
}

export interface PayeeOptions {
  fetch?: typeof fetch;
  budgetMs?: number;
}

async function queryTxt(resolverUrl: string, qname: string, timeoutMs: number, doFetch: typeof fetch): Promise<TxtAnswer | null> {
  const attempt = async (): Promise<TxtAnswer | null> => {
    try {
      const res = await doFetch(dohUrl(resolverUrl, qname), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_DOH_BYTES) return null;
      return parseTxtAnswer(JSON.parse(text), qname);
    } catch {
      return null;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + 50);
  });
  try {
    return await Promise.race([attempt(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Checks `_owed.<domain>` for `owed-pay=<address>`. Never throws. */
export async function verifyDomain(domain: string, address: string, options: PayeeOptions = {}): Promise<PayeeResult> {
  const d = normalizeDomain(domain);
  if (!d) return { status: "invalid_domain", domain: "", display_domain: "", dnssec: false, records: 0 };
  const doFetch = options.fetch ?? fetch;
  const deadline = Date.now() + (options.budgetMs ?? PAYEE_BUDGET_MS);
  const qname = `${RECORD_LABEL}.${d.ascii}`;
  for (const resolver of DOH_RESOLVERS) {
    const remaining = deadline - Date.now();
    if (remaining < 100) break;
    const answer = await queryTxt(resolver.url, qname, Math.min(DOH_TIMEOUT_MS, remaining), doFetch);
    if (!answer) continue;
    const wallets = owedPayValues(answer.txt);
    return {
      status: wallets.some((w) => sameWallet(w, address)) ? "verified" : "unverified",
      domain: d.ascii,
      display_domain: d.unicode,
      dnssec: answer.ad,
      records: wallets.length,
    };
  }
  return { status: "dns_unavailable", domain: d.ascii, display_domain: d.unicode, dnssec: false, records: 0 };
}

/**
 * For create routes: the normalized domain to store, or an ApiError that says how to fix it
 * (invalid_input for an unverified or malformed domain, upstream_unavailable when DNS can't be read).
 */
export async function requireVerifiedDomain(fromDomain: string, recipient: string, options: PayeeOptions = {}): Promise<string> {
  const r = await verifyDomain(fromDomain, recipient, options);
  switch (r.status) {
    case "verified":
      return r.domain;
    case "invalid_domain":
      throw new ApiError("invalid_input", "from_domain must be a domain name like example.com");
    case "unverified":
      throw new ApiError(
        "invalid_input",
        `from_domain: ${r.domain} does not publish this recipient. To verify it, add a DNS TXT record named ` +
          `${RECORD_LABEL}.${r.domain} with the value ${RECORD_PREFIX}${recipient}, then try again`,
      );
    case "dns_unavailable":
      throw new ApiError("upstream_unavailable", `DNS for ${r.domain} couldn't be read right now, try again shortly`);
  }
}
