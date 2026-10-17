import { domainToASCII, domainToUnicode } from "node:url";
import * as z from "zod/v4";
import { clean } from "./text.js";

// Verified payee (SPEC §5.2 T2.8). A requester proves a domain by publishing a DNS TXT record
// `owed-pay=<Solana address>` at `_owed.<domain>`. The plugin reads it itself over DNS-over-HTTPS,
// never through Owed's server, so the server can't vouch for anyone. "Verified" means exactly
// "<domain> publishes this wallet": it proves control of the domain, not that the request is honest.
// web/lib/payee.ts re-implements the same rules for the server's display-only copy; both test
// suites run plugin/test/fixtures/doh/ (real resolver answers) and its vectors.json.

export type PayeeStatus = "verified" | "unverified" | "dns_unavailable" | "invalid_domain";

export interface PayeeResult {
  status: PayeeStatus;
  /** The DNS name checked: lower-case ASCII, punycode for IDN. "" when invalid_domain. */
  domain: string;
  /** Unicode form for people; equals `domain` when it is plain ASCII. */
  display_domain: string;
  /** The resolver's AD flag on the answer used. */
  dnssec: boolean;
  /** owed-pay= TXT records found at _owed.<domain>, whatever wallet they name. */
  records: number;
  /** Sentences for people: IDN/punycode, mixed scripts, lookalike characters, then "check the spelling". */
  warnings: string[];
}

/** The tools' Deps satisfies this. */
export interface PayeeDeps {
  fetch: typeof fetch;
  now?: () => number;
}

export const RECORD_LABEL = "_owed";
export const RECORD_PREFIX = "owed-pay=";
/** Tried in order; the next one only when the previous fails or times out. */
export const DOH_RESOLVERS = [
  { host: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { host: "dns.google", url: "https://dns.google/resolve" },
] as const;
export const DOH_HOSTS: string[] = DOH_RESOLVERS.map((r) => r.host);
export const DOH_TIMEOUT_MS = 2500;
export const PAYEE_BUDGET_MS = 2 * DOH_TIMEOUT_MS;
const MAX_DOH_BYTES = 64 * 1024;
const TXT = 16;

export const fromDomainSchema = z.string().min(1).max(253).describe(
  "Optional domain the user controls, e.g. \"example.com\". Owed checks that the domain publishes the recipient wallet "
  + "in DNS (TXT record at _owed.<domain> with the value owed-pay=<wallet>) and refuses if it doesn't. Payers then see "
  + "\"From <domain> · verified\". Only pass it when the user names their domain.",
);

// ---------------------------------------------------------------- domains

export interface NormalizedDomain {
  /** Lower-case ASCII, punycode labels for IDN, no trailing dot. */
  ascii: string;
  unicode: string;
  /** The input had non-ASCII characters (an IDN, or full-width letters folded to ASCII). */
  nonAsciiInput: boolean;
}

// Characters that are never part of a host name but that URL parsing would quietly reinterpret
// ("ex/ample.com" → "ex", "%41" → "a"). Refused before IDNA processing.
const NOT_A_HOST = /[\s/\\:@?#%[\]<>"'`,;!$&()*+=|^{}~\p{Cc}\p{Cf}]/u;
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** UTS #46 to ASCII, then strict LDH rules: 2+ labels, ≤63 each, ≤253 total, a non-numeric TLD. Null if not a domain. */
export function normalizeDomain(input: string): NormalizedDomain | null {
  let s = input.trim().normalize("NFC");
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.toLowerCase().startsWith(`${RECORD_LABEL}.`)) s = s.slice(RECORD_LABEL.length + 1); // the record name pasted as the domain
  if (!s || s.length > 253 || NOT_A_HOST.test(s)) return null;
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => LDH_LABEL.test(l))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null; // an IPv4 address, not a domain
  const unicode = domainToUnicode(ascii);
  if (!unicode) return null;
  // Every punycode label must decode to non-ASCII text that encodes back to the same label.
  const unicodeLabels = unicode.split(".");
  if (unicodeLabels.length !== labels.length) return null;
  for (const [i, l] of labels.entries()) {
    if (l.startsWith("xn--") && (!/[^\x00-\x7f]/.test(unicodeLabels[i]!) || domainToASCII(unicodeLabels[i]!) !== l)) return null;
  }
  return { ascii, unicode, nonAsciiInput: /[^\x00-\x7f]/.test(s) };
}

const SCRIPTS = [
  "Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Tamil",
  "Thai", "Han", "Hiragana", "Katakana", "Hangul", "Bopomofo", "Cherokee", "Ethiopic",
] as const;
const SCRIPT_RES = SCRIPTS.map((name) => ({ name, re: new RegExp(`\\p{Script=${name}}`, "u") }));
// UTS #39 "highly restrictive": one script, or Latin with the scripts CJK writing mixes in.
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

// Letters people read as plain Latin ones (lower case, as IDNA leaves them). From Unicode's
// confusables.txt, limited to pairs that look alike in common fonts.
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  "а": "a", "ь": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "к": "k", "ӏ": "l", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "ѵ": "v", "ԝ": "w",
  "х": "x", "у": "y", "ү": "y",
  // Greek
  "α": "a", "ϲ": "c", "ε": "e", "ι": "i", "ϳ": "j", "κ": "k", "ν": "v", "ο": "o",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y", "ω": "w",
  // Armenian
  "ց": "g", "հ": "h", "ո": "n", "օ": "o", "զ": "q", "ս": "u",
  // Latin letters that are not plain a–z
  "ɡ": "g", "ı": "i", "ɑ": "a", "ɩ": "i", "ʟ": "l", "ɴ": "n", "ʀ": "r", "ł": "l",
  "ø": "o", "đ": "d", "ħ": "h", "ŧ": "t", "ƅ": "b", "ɵ": "o",
};

/** What a label reads as: accents dropped, lookalike letters replaced. */
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

const listFormat = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The lookalike and IDN warnings for a normalized domain; the last line says to check the spelling. */
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

/** "münchen.de (xn--mnchen-3ya.de)" for IDN, else the domain. Always the full name, never shortened. */
export function domainLabel(r: Pick<PayeeResult, "domain" | "display_domain">): string {
  return r.display_domain && r.display_domain !== r.domain ? `${r.display_domain} (${r.domain})` : r.domain;
}

// ---------------------------------------------------------------- DNS-over-HTTPS answers

export interface TxtAnswer {
  /** NOERROR (records may be empty) or NXDOMAIN. */
  rcode: "noerror" | "nxdomain";
  /** Every TXT record's value, its character-strings joined. */
  txt: string[];
  /** The resolver's AD (authenticated data) flag. */
  ad: boolean;
}

/**
 * One TXT record from a DoH JSON answer. Cloudflare sends RFC 1035 presentation format
 * (`"part one" "part two"`, with `\"` and `\DDD` escapes); dns.google sends the joined text bare.
 */
export function txtValue(data: string): string {
  if (!data.startsWith("\"")) return data;
  let out = "";
  let i = 0;
  while (i < data.length) {
    while (data[i] === " ") i++;
    if (i >= data.length) break;
    if (data[i] !== "\"") return data;
    i++;
    let closed = false;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\"") { closed = true; i++; break; }
      if (ch === "\\") {
        const digits = /^[0-9]{3}/.exec(data.slice(i + 1, i + 4));
        if (digits) { out += String.fromCharCode(Number(digits[0])); i += 4; continue; }
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

/** A DoH JSON answer for `qname`, or null when it is a failure (SERVFAIL, REFUSED, truncated, off-shape, other name). */
export function parseTxtAnswer(body: unknown, qname: string): TxtAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.TC === true) return null;
  const rcode = b.Status === 0 ? "noerror" : b.Status === 3 ? "nxdomain" : null;
  if (!rcode) return null;
  const question = Array.isArray(b.Question) ? (b.Question[0] as Record<string, unknown> | undefined) : undefined;
  if (!question || bareName(question.name) !== qname.toLowerCase()) return null;
  const answers = Array.isArray(b.Answer) ? b.Answer : [];
  const txt = answers
    .filter((a): a is { type: number; data: string } => typeof a === "object" && a !== null && a.type === TXT && typeof a.data === "string")
    .map((a) => txtValue(a.data));
  return { rcode, txt, ad: b.AD === true };
}

/** The wallet named by each owed-pay= record (prefix case-insensitive, value exact). */
export function owedPayValues(txt: string[]): string[] {
  return txt.map((t) => t.trim()).filter((t) => t.toLowerCase().startsWith(RECORD_PREFIX)).map((t) => t.slice(RECORD_PREFIX.length).trim());
}

export function dohUrl(resolverUrl: string, qname: string): string {
  return `${resolverUrl}?name=${encodeURIComponent(qname)}&type=TXT`;
}

async function raceTimeout<T>(promise: Promise<T>, ms: number, value: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(value), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function queryTxt(resolverUrl: string, qname: string, timeoutMs: number, doFetch: typeof fetch): Promise<TxtAnswer | null> {
  const attempt = async (): Promise<TxtAnswer | null> => {
    try {
      const res = await doFetch(dohUrl(resolverUrl, qname), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_DOH_BYTES) return null;
      return parseTxtAnswer(JSON.parse(text), qname);
    } catch {
      return null;
    }
  };
  // The signal covers fetch and body; the race covers a fetch that ignores it.
  return raceTimeout(attempt(), timeoutMs + 50, null);
}

// ---------------------------------------------------------------- verification

/** Checks `_owed.<domain>` for `owed-pay=<address>` over DoH. Never throws. */
export async function verifyPayee(
  domain: string, address: string, budgetMs: number = PAYEE_BUDGET_MS, deps: PayeeDeps = { fetch: (i, init) => fetch(i, init) },
): Promise<PayeeResult> {
  const d = normalizeDomain(domain);
  if (!d) return { status: "invalid_domain", domain: "", display_domain: "", dnssec: false, records: 0, warnings: [] };
  const base = { domain: d.ascii, display_domain: d.unicode, warnings: domainWarnings(d) };
  const now = deps.now ?? Date.now;
  const deadline = now() + budgetMs;
  const qname = `${RECORD_LABEL}.${d.ascii}`;
  for (const resolver of DOH_RESOLVERS) {
    const remaining = deadline - now();
    if (remaining < 100) break;
    const answer = await queryTxt(resolver.url, qname, Math.min(DOH_TIMEOUT_MS, remaining), deps.fetch);
    if (!answer) continue;
    const wallets = owedPayValues(answer.txt);
    return { ...base, status: wallets.includes(address) ? "verified" : "unverified", dnssec: answer.ad, records: wallets.length };
  }
  return { ...base, status: "dns_unavailable", dnssec: false, records: 0 };
}

const RESOLVER_NAMES = DOH_HOSTS.join(" and ");

/** The exact DNS record that verifies `address` for `domain`. */
export function recordHowTo(domain: string, address: string): string {
  return `add a DNS TXT record named ${RECORD_LABEL}.${domain} with the value ${RECORD_PREFIX}${address}`;
}

export type FromDomainCheck =
  | { ok: true; from_domain: string; payee: PayeeResult; lines: string[] }
  | { ok: false; message: string; payee: PayeeResult };

/**
 * For tools that create requests with `from_domain`: verified → the ASCII domain to send to the API
 * and lines for the tool's text; anything else → a refusal that says how to fix it. Never throws.
 */
export async function checkFromDomain(fromDomain: string, recipient: string, deps: PayeeDeps, budgetMs: number = PAYEE_BUDGET_MS): Promise<FromDomainCheck> {
  const payee = await verifyPayee(fromDomain, recipient, budgetMs, deps);
  const label = domainLabel(payee);
  switch (payee.status) {
    case "verified":
      return {
        ok: true, from_domain: payee.domain, payee,
        lines: [`From ${label}: verified, ${payee.domain} publishes this wallet in its DNS${payee.dnssec ? " (DNSSEC-signed)" : ""}.`, ...payee.warnings],
      };
    case "invalid_domain":
      return { ok: false, payee, message: `"${clean(fromDomain, 60)}" isn't a domain name Owed can check. Give just the domain, like example.com. Nothing was created.` };
    case "dns_unavailable":
      return { ok: false, payee, message: `DNS couldn't be checked right now (${RESOLVER_NAMES} didn't answer), so the request wasn't created. Try again in a moment, or ask without from_domain.` };
    case "unverified": {
      const others = payee.records > 0 ? ` It publishes ${payee.records === 1 ? "another Owed wallet" : `${payee.records} other Owed wallets`}, not this one.` : "";
      return {
        ok: false, payee,
        message: `${label} doesn't publish this wallet, so the request wasn't created.${others} To verify it, ${recordHowTo(payee.domain, recipient)}, wait a few minutes for DNS, then ask again. Or ask without from_domain.`,
      };
    }
  }
}

export type PaymentPayee =
  | { ok: true; lead: string | null; lines: string[] }
  | { ok: false; refuse: string };

/**
 * For pay_link: a request that names a domain is paid only if that domain publishes the recipient.
 * `lead` replaces the short address in "Pay 15 USDC to <lead>"; `lines` go into the preview text.
 */
export async function payeeForPayment(
  fromDomain: string | null | undefined, recipient: string, allowUnverified: boolean, deps: PayeeDeps, budgetMs: number = PAYEE_BUDGET_MS,
): Promise<PaymentPayee> {
  if (fromDomain === null || fromDomain === undefined || fromDomain === "") {
    return { ok: true, lead: null, lines: ["Payee not verified: no domain on this request."] };
  }
  const payee = await verifyPayee(fromDomain, recipient, budgetMs, deps);
  const label = domainLabel(payee);
  switch (payee.status) {
    case "verified":
      return {
        ok: true,
        lead: `${label} (verified by DNS${payee.dnssec ? ", DNSSEC" : ""})`,
        lines: [`Verified: ${payee.domain} publishes this wallet in its DNS. That proves who controls the domain, not what the request is for.`, ...payee.warnings],
      };
    case "unverified":
      return { ok: false, refuse: `This request claims to be from ${label}, but ${label} does not publish this wallet. Not paying.` };
    case "invalid_domain":
      return { ok: false, refuse: `This request claims to be from "${clean(fromDomain, 60)}", which isn't a domain name Owed can check. Not paying.` };
    case "dns_unavailable":
      if (allowUnverified) {
        return { ok: true, lead: null, lines: [`Payee not verified: the request claims ${label}, but DNS couldn't be checked; paying anyway because allow_unverified is set.`, ...payee.warnings] };
      }
      return {
        ok: false,
        refuse: `This request claims to be from ${label}, but DNS couldn't be checked right now (${RESOLVER_NAMES} didn't answer), so Owed can't confirm ${label} publishes this wallet. Nothing was sent. Try again shortly, or pass allow_unverified: true only if the user accepts paying without the check.`,
      };
  }
}
