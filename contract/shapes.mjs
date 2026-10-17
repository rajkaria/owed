// Dependency-free shapes of the Owed HTTP API (SPEC §5.3), shared by contract/check.mjs and web/scripts/smoke.mjs.
// Every shape must accept its file in contract/fixtures/ (check.mjs enforces this), so the smoke test and the
// fixtures can't drift apart silently. Amount checks are string/bigint only: no floats anywhere.

import { createHash, createPublicKey, verify } from "node:crypto";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_DECIMALS = { USDC: 6, SOL: 9 };
export const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
export const ERROR_CODES = ["invalid_input", "rate_limited", "not_found", "upstream_unavailable", "blocked"];

// ---------------------------------------------------------------------------------------------- base58

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGITS = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));

/** Decodes base58 to bytes, or returns null for any character outside the Bitcoin alphabet. */
export function base58Decode(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  let value = 0n;
  for (const char of text) {
    const digit = DIGITS.get(char);
    if (digit === undefined) return null;
    value = value * 58n + digit;
  }
  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  return "1".repeat(zeros) + text;
}

export const isPubkey = (text) => typeof text === "string" && text.length >= 32 && text.length <= 44 && base58Decode(text)?.length === 32;
export const isSignature = (text) => typeof text === "string" && text.length >= 64 && text.length <= 88 && base58Decode(text)?.length === 64;

// ---------------------------------------------------------------------------------------------- amounts

export const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** "15.5" with 6 decimals → 15500000n. Throws on anything that isn't a plain decimal string. */
export function toAtomic(amount, decimals) {
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) throw new Error(`not a decimal amount: ${JSON.stringify(amount)}`);
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new Error(`${amount} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 15500000n with 6 decimals → "15.5". */
export function fromAtomic(atomic, decimals) {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// ---------------------------------------------------------------------------------------------- Solana Pay

/**
 * Parses a Solana Pay URL (https://docs.solanapay.com/spec). Transfer requests return their fields;
 * transaction requests (`solana:https://…`) return `{ kind: "transaction" }`. Never throws.
 */
export function parseSolanaPayUrl(text) {
  if (typeof text !== "string" || !text.startsWith("solana:")) return { ok: false, error: "does not start with solana:" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  const target = decodeURIComponent(url.pathname);
  if (/^https?:/i.test(target)) return { ok: true, kind: "transaction", link: target };
  if (!isPubkey(target)) return { ok: false, error: `recipient ${JSON.stringify(target)} is not a base58 32-byte key` };
  const params = url.searchParams;
  const amount = params.get("amount");
  if (amount !== null && !AMOUNT_RE.test(amount)) return { ok: false, error: `amount ${JSON.stringify(amount)} is not a decimal` };
  const splToken = params.get("spl-token");
  if (splToken !== null && !isPubkey(splToken)) return { ok: false, error: "spl-token is not a base58 32-byte key" };
  const references = params.getAll("reference");
  if (references.some((reference) => !isPubkey(reference))) return { ok: false, error: "a reference is not a base58 32-byte key" };
  return {
    ok: true, kind: "transfer", recipient: target, amount, splToken, references,
    token: splToken === null ? "SOL" : splToken === USDC_MINT ? "USDC" : null,
    label: params.get("label"), message: params.get("message"), memo: params.get("memo"),
  };
}

// ---------------------------------------------------------------------------------------------- shape DSL
// A shape is (value, path, ctx) => void that pushes to ctx.errors / ctx.warnings.

const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};
const kind = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

export function check(shape, value) {
  const ctx = { errors: [], warnings: [] };
  shape(value, "$", ctx);
  return ctx;
}

const optional = (shape) => Object.assign((value, path, ctx) => shape(value, path, ctx), { optional: true });
const nullable = (shape) => (value, path, ctx) => (value === null ? undefined : shape(value, path, ctx));

const string = ({ min = 0, max = 10_000, pattern, test, label } = {}) => (value, path, ctx) => {
  if (typeof value !== "string") return void ctx.errors.push(`${path}: expected string, got ${kind(value)}`);
  if (value.length < min || value.length > max) return void ctx.errors.push(`${path}: length ${value.length} outside ${min}..${max}`);
  if ((pattern && !pattern.test(value)) || (test && !test(value))) ctx.errors.push(`${path}: ${show(value)} is not ${label ?? pattern}`);
};
const oneOf = (...values) => (value, path, ctx) => {
  if (!values.includes(value)) ctx.errors.push(`${path}: ${show(value)} is not one of ${values.join("|")}`);
};
const integer = ({ min = 0 } = {}) => (value, path, ctx) => {
  if (!Number.isSafeInteger(value) || value < min) ctx.errors.push(`${path}: expected integer ≥ ${min}, got ${show(value)}`);
};
const array = (item, { min = 0, max = 10_000 } = {}) => (value, path, ctx) => {
  if (!Array.isArray(value)) return void ctx.errors.push(`${path}: expected array, got ${kind(value)}`);
  if (value.length < min || value.length > max) ctx.errors.push(`${path}: ${value.length} items, expected ${min}..${max}`);
  value.forEach((entry, index) => item(entry, `${path}[${index}]`, ctx));
};
const object = (fields, refine) => (value, path, ctx) => {
  if (kind(value) !== "object") return void ctx.errors.push(`${path}: expected object, got ${kind(value)}`);
  const before = ctx.errors.length;
  for (const [key, shape] of Object.entries(fields)) {
    if (!(key in value)) {
      if (!shape.optional) ctx.errors.push(`${path}.${key}: missing`);
      continue;
    }
    if (value[key] === undefined && shape.optional) continue;
    shape(value[key], `${path}.${key}`, ctx);
  }
  for (const key of Object.keys(value)) if (!(key in fields)) ctx.warnings.push(`${path}.${key}: not in the contract`);
  if (refine && before === ctx.errors.length) refine(value, path, ctx);
};

const id = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?$/, label: "a 12-char base58 id (10 for requests made before ids were derived)" });
const pubkey = string({ test: isPubkey, label: "a base58 32-byte key" });
const signature = string({ test: isSignature, label: "a base58 64-byte signature" });
const amount = string({ max: 40, pattern: AMOUNT_RE, label: "a decimal amount" });
const positiveAmount = string({ max: 40, test: (text) => AMOUNT_RE.test(text) && /[1-9]/.test(text), label: "a positive decimal amount" });
const token = oneOf("USDC", "SOL");
// W2-H verified payee: the server stores the domain lower-case ASCII (punycode for IDN), as migration 0009 checks.
const domain = string({ max: 253, pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, label: "a lower-case ASCII domain" });
const iso = string({
  max: 40, label: "an ISO-8601 timestamp",
  test: (text) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)),
});
const httpsUrl = string({
  max: 2048, label: "an https URL",
  test: (text) => { try { return new URL(text).protocol === "https:"; } catch { return false; } },
});
const solanaPayTransfer = string({
  max: 2048, label: "a Solana Pay transfer URL",
  test: (text) => { const parsed = parseSolanaPayUrl(text); return parsed.ok && parsed.kind === "transfer"; },
});
const flag = string({ max: 80, pattern: /^[a-z_]+:[^\s]+/, label: "a flag like brand_word:<w>" });
// Requester-written text after the API sanitized it (SPEC §6): capped, no URLs, no control characters.
const untrusted = (max) => nullable(string({
  max, label: "sanitized text (no URLs or control characters)",
  test: (text) => !/[\u0000-\u001f\u007f-\u009f]/.test(text) && !/(https?:\/\/|www\.)/i.test(text),
}));

/** Amount fits the token's decimals (USDC 6, SOL 9). */
function decimalsFit(amountKey) {
  return (value, path, ctx) => {
    const decimals = TOKEN_DECIMALS[value.token];
    if (decimals === undefined || typeof value[amountKey] !== "string") return;
    try { toAtomic(value[amountKey], decimals); } catch (error) { ctx.errors.push(`${path}.${amountKey}: ${error.message}`); }
  };
}

/** Request id = last 12 base58 chars of sha256 over the payment terms (plugin/src/request-id.ts, web/lib/ids.ts). */
export function requestIdFor({ recipient, token, amountAtomic, reference }) {
  const asset = token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-request:v1\n${recipient}\n${asset}\n${amountAtomic}\n${reference}`, "utf8").digest();
  return base58Encode(digest).slice(-12);
}

/** W3-B: on a Solana request, pay_url (when present) is the solana_pay_url itself. */
function payUrlIsSolanaPayUrl(value, path, ctx) {
  if ("pay_url" in value && value.pay_url !== value.solana_pay_url) ctx.errors.push(`${path}.pay_url: differs from .solana_pay_url`);
}

/** solana_pay_url must carry the same recipient/amount/token/reference as the JSON next to it. */
function urlMatchesFields(value, path, ctx) {
  const parsed = parseSolanaPayUrl(value.solana_pay_url);
  if (!parsed.ok || parsed.kind !== "transfer") return;
  if ("recipient" in value && parsed.recipient !== value.recipient) ctx.errors.push(`${path}.solana_pay_url: recipient differs from .recipient`);
  if ("amount" in value && parsed.amount !== value.amount) ctx.errors.push(`${path}.solana_pay_url: amount=${parsed.amount} differs from .amount=${value.amount}`);
  if ("token" in value && parsed.token !== value.token) ctx.errors.push(`${path}.solana_pay_url: spl-token is ${parsed.token ?? "unknown"}, .token is ${value.token}`);
  if ("reference" in value && !parsed.references.includes(value.reference)) ctx.errors.push(`${path}.solana_pay_url: does not carry .reference`);
  if ("id" in value && parsed.memo !== null && parsed.memo !== `owed:${value.id}`) ctx.errors.push(`${path}.solana_pay_url: memo ${show(parsed.memo)} is not owed:${value.id}`);
  // 12-char ids commit to the terms; 10-char ids are random ids from before that change.
  if (typeof value.id === "string" && value.id.length === 12 && typeof value.reference === "string" && parsed.amount !== null
    && TOKEN_DECIMALS[parsed.token] !== undefined) {
    let expected = null;
    try { expected = requestIdFor({ recipient: parsed.recipient, token: parsed.token, amountAtomic: toAtomic(parsed.amount, TOKEN_DECIMALS[parsed.token]), reference: value.reference }); } catch { /* amount errors are reported elsewhere */ }
    if (expected !== null && expected !== value.id) ctx.errors.push(`${path}.id: ${value.id} is not the hash of its payment terms (expected ${expected})`);
  }
}

// W3-B Base requests: 0x addresses and transaction hashes (EIP-55 case is checked by the zod contracts).
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

const statusFields = {
  status: oneOf("open", "paid", "underpaid", "cancelled", "expired", "not_found", "invalid"), // W3-C: + expired
  amount_requested: optional(positiveAmount),
  token: optional(token),
  amount_paid: optional(amount),
  payer: optional(string({ test: (t) => isPubkey(t) || EVM_ADDRESS_RE.test(t), label: "a base58 32-byte key or a 0x address (Base)" })), // W3-B
  signature: optional(string({ test: (t) => isSignature(t) || TX_HASH_RE.test(t), label: "a base58 64-byte signature or a 0x transaction hash (Base)" })), // W3-B
  paid_at: optional(iso),
  created_at: optional(iso), // W1-C asked for it; the plugin turns it into "waited"
  expires_at: optional(iso), // W3-C: when an expiring request ends
  cancelled_at: optional(iso), // W3-C
  chain: optional(oneOf("base")), // W3-B: set on Base requests
};
function statusConsistent(value, path, ctx) {
  if (["open", "paid", "underpaid", "cancelled", "expired"].includes(value.status)) {
    for (const key of ["amount_requested", "token"]) if (!(key in value)) ctx.errors.push(`${path}.${key}: missing for status ${value.status}`);
  }
  if (value.status === "paid" || value.status === "underpaid") {
    for (const key of ["amount_paid", "payer", "signature", "paid_at"]) if (!(key in value)) ctx.errors.push(`${path}.${key}: missing for status ${value.status}`);
  }
  if (value.status === "underpaid" && value.token && value.amount_paid && value.amount_requested) {
    const decimals = TOKEN_DECIMALS[value.token];
    if (toAtomic(value.amount_paid, decimals) >= toAtomic(value.amount_requested, decimals)) ctx.errors.push(`${path}: underpaid but amount_paid ≥ amount_requested`);
  }
}

// ---------------------------------------------------------------------------------------------- split bills

/** Group id = last 12 base58 chars of sha256 over its share ids in board order (web/lib/groups.ts, plugin split_bill). */
export function groupIdFor({ recipient, token, totalAtomic, shareIds }) {
  const asset = token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-group:v1\n${recipient}\n${asset}\n${totalAtomic}\n${shareIds.join("\n")}`, "utf8").digest();
  return base58Encode(digest).slice(-12);
}

const groupId = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 group id" });
const paidInfo = object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402") });

/** People's amounts fit the token, and explicit amounts never exceed (or, when all are given, equal) the total. */
function peopleFitTotal(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (decimals === undefined) return;
  let total;
  try { total = toAtomic(value.total, decimals); } catch (error) { return void ctx.errors.push(`${path}.total: ${error.message}`); }
  let fixed = 0n;
  let open = 0;
  value.people.forEach((person, index) => {
    if (person.amount === undefined) return void (open += 1);
    try { fixed += toAtomic(person.amount, decimals); } catch (error) { ctx.errors.push(`${path}.people[${index}].amount: ${error.message}`); }
  });
  if (open === 0 && fixed !== total) ctx.errors.push(`${path}.people: amounts add up to ${fromAtomic(fixed, decimals)}, total is ${value.total}`);
  if (open > 0 && total - fixed < BigInt(open)) ctx.errors.push(`${path}.people: nothing left to split between the people without an amount`);
}

/** Every share pays the group's recipient its own amount, its id hashes its terms, and the group id hashes the share ids. */
function groupConsistent(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (value.share_count !== value.shares.length) ctx.errors.push(`${path}.share_count: ${value.share_count} but ${value.shares.length} shares`);
  const paidCount = value.shares.filter((share) => share.status === "paid").length;
  if (value.paid_count !== paidCount) ctx.errors.push(`${path}.paid_count: ${value.paid_count} but ${paidCount} shares are paid`);
  if (!new URL(value.link).pathname.endsWith(`/g/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /g/${value.id}`);
  if (decimals === undefined) return;
  let total = 0n;
  let received = 0n;
  value.shares.forEach((share, index) => {
    const at = `${path}.shares[${index}]`;
    try { total += toAtomic(share.amount, decimals); } catch (error) { ctx.errors.push(`${at}.amount: ${error.message}`); }
    urlMatchesFields({ ...share, recipient: value.recipient, token: value.token }, at, ctx);
    if (!new URL(share.link).pathname.endsWith(`/r/${share.id}`)) ctx.errors.push(`${at}.link: does not end in /r/${share.id}`);
    if ((share.status === "paid" || share.status === "underpaid") && !share.paid) ctx.errors.push(`${at}.paid: status is ${share.status} but paid is ${show(share.paid)}`);
    if (share.status === "open" && share.paid) ctx.errors.push(`${at}.paid: status is open but paid is set`);
    if (share.paid) try { received += toAtomic(share.paid.amount, decimals); } catch { /* reported by the amount shape */ }
    // pay_link checks a share on its own, so each share must carry the same verified domain as its board.
    if ("from_domain" in share && (share.from_domain ?? null) !== (value.from_domain ?? null)) {
      ctx.errors.push(`${at}.from_domain: ${show(share.from_domain)} but the group's is ${show(value.from_domain ?? null)}`);
    }
  });
  try {
    if (toAtomic(value.total, decimals) !== total) ctx.errors.push(`${path}.total: ${value.total} but the shares add up to ${fromAtomic(total, decimals)}`);
    if (toAtomic(value.amount_received, decimals) !== received) ctx.errors.push(`${path}.amount_received: ${value.amount_received} but the shares received ${fromAtomic(received, decimals)}`);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
  const expected = groupIdFor({ recipient: value.recipient, token: value.token, totalAtomic: total, shareIds: value.shares.map((share) => share.id) });
  if (expected !== value.id) ctx.errors.push(`${path}.id: ${value.id} is not the hash of its share ids (expected ${expected})`);
}
// W2-D ledger. The request's signature is ed25519 over the message's UTF-8 bytes (what PayBox's
// request_wallet_sign {op:"solanaMessage"} returns, as hex); the fixture's is checked for real.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
function ed25519Verifies(message, signatureHex, address) {
  const pub = base58Decode(address);
  if (!pub || pub.length !== 32 || !/^(0x)?[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pub)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex.replace(/^0x/i, ""), "hex"));
  } catch {
    return false;
  }
}
const LEDGER_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function ledgerSigned(value, path, ctx) {
  const lead = `Owed ledger access for ${value.recipient} at `;
  if (!value.signed_message.startsWith(lead) || !LEDGER_ISO.test(value.signed_message.slice(lead.length))) {
    return void ctx.errors.push(`${path}.signed_message: must read "${lead}<UTC time>"`);
  }
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(value.signature) && !ed25519Verifies(value.signed_message, value.signature, value.recipient)) {
    ctx.errors.push(`${path}.signature: does not verify for ${value.recipient} over signed_message`);
  }
}
const ledgerEntry = object({
  id, kind: oneOf("single", "split_share", "invoice"), link: httpsUrl, amount: positiveAmount, token,
  status: oneOf("open", "underpaid", "paid"), payer_name: untrusted(40), for: untrusted(80), created_at: iso,
  amount_due: optional(amount), amount_paid: optional(amount), payer: optional(pubkey), signature: optional(signature), paid_at: optional(iso),
  group_id: nullable(string({ max: 40 })), group_title: untrusted(60), group_link: nullable(httpsUrl),
  invoice_number: untrusted(20), due_date: nullable(string({ pattern: /^\d{4}-\d{2}-\d{2}$/, label: "a YYYY-MM-DD date" })),
  from_domain: nullable(string({ max: 253, pattern: /^[a-z0-9.-]+$/, label: "a lower-case ASCII domain" })),
  flags: array(flag, { max: 32 }),
}, (value, path, ctx) => {
  decimalsFit("amount")(value, path, ctx);
  // Invoices are paid on their invoice page; requests and split shares on their own pay page.
  const page = value.kind === "invoice" ? "i" : "r";
  if (!new URL(value.link).pathname.endsWith(`/${page}/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /${page}/${value.id}`);
  const share = value.kind === "split_share";
  if (share !== (value.group_id !== null)) ctx.errors.push(`${path}.group_id: ${share ? "missing" : "set"} for kind ${value.kind}`);
  if (share !== (value.group_link !== null)) ctx.errors.push(`${path}.group_link: ${share ? "missing" : "set"} for kind ${value.kind}`);
  if (!share && value.group_title !== null) ctx.errors.push(`${path}.group_title: set for kind ${value.kind}`);
  if (value.group_link !== null && value.group_id !== null && !new URL(value.group_link).pathname.endsWith(`/g/${value.group_id}`)) {
    ctx.errors.push(`${path}.group_link: does not end in /g/${value.group_id}`);
  }
  if ((value.kind === "invoice") !== (value.due_date !== null)) ctx.errors.push(`${path}.due_date: ${value.kind === "invoice" ? "missing" : "set"} for kind ${value.kind}`);
  if (value.kind !== "invoice" && value.invoice_number !== null) ctx.errors.push(`${path}.invoice_number: set for kind ${value.kind}`);
  const settled = value.status !== "open";
  for (const key of ["amount_paid", "payer", "signature", "paid_at"]) {
    if (settled !== (key in value)) ctx.errors.push(`${path}.${key}: ${settled ? "missing" : "set"} for status ${value.status}`);
  }
  if ((value.status === "paid") === ("amount_due" in value)) ctx.errors.push(`${path}.amount_due: ${value.status === "paid" ? "set" : "missing"} for status ${value.status}`);
  const decimals = TOKEN_DECIMALS[value.token];
  if (decimals === undefined) return;
  const atomic = (key) => (value[key] === undefined ? 0n : toAtomic(value[key], decimals));
  try {
    if (value.status === "open" && atomic("amount_due") !== atomic("amount")) ctx.errors.push(`${path}.amount_due: open but differs from amount`);
    if (value.status === "underpaid" && atomic("amount_due") + atomic("amount_paid") !== atomic("amount")) ctx.errors.push(`${path}: amount_paid + amount_due differs from amount`);
    if (value.status === "underpaid" && atomic("amount_paid") >= atomic("amount")) ctx.errors.push(`${path}: underpaid but amount_paid ≥ amount`);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
});
/** Untruncated ledgers: the totals are exactly the sums and counts of the entries listed. */
function ledgerTotals(value, path, ctx) {
  const seen = new Set();
  for (const t of value.totals) {
    if (seen.has(t.token)) ctx.errors.push(`${path}.totals: ${t.token} listed twice`);
    seen.add(t.token);
  }
  if (value.truncated) return;
  for (const t of value.totals) {
    const decimals = TOKEN_DECIMALS[t.token];
    const open = value.open.filter((e) => e.token === t.token);
    const paid = value.paid_recently.filter((e) => e.token === t.token);
    const sum = (entries, key) => entries.reduce((n, e) => n + (e[key] === undefined ? 0n : toAtomic(e[key], decimals)), 0n);
    if (t.open_count !== open.length) ctx.errors.push(`${path}.totals.${t.token}.open_count: ${t.open_count}, ${open.length} open entries listed`);
    if (t.paid_count !== paid.length) ctx.errors.push(`${path}.totals.${t.token}.paid_count: ${t.paid_count}, ${paid.length} paid entries listed`);
    if (toAtomic(t.outstanding, decimals) !== sum(open, "amount_due")) ctx.errors.push(`${path}.totals.${t.token}.outstanding: not the sum of amount_due`);
    if (toAtomic(t.received_30d, decimals) < sum(paid, "amount_paid")) ctx.errors.push(`${path}.totals.${t.token}.received_30d: less than the paid entries`);
  }
  for (const e of [...value.open, ...value.paid_recently]) {
    if (!seen.has(e.token)) ctx.errors.push(`${path}.totals: no total for ${e.token}`);
  }
}
const totalsEntry = object({ token, outstanding: amount, received_30d: amount, open_count: integer(), paid_count: integer() });

// W3-C: expiry and cancel. A cancellation's proof is ed25519 over "Owed cancel <id> for <recipient> at <ISO>"
// by the recipient's wallet, checked for real wherever it appears.
const expiresInDays = (value, path, ctx) => {
  if (!Number.isInteger(value) || value < 1 || value > 90) ctx.errors.push(`${path}: expected a whole number of days from 1 to 90, got ${show(value)}`);
};
const CANCEL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function cancelSigned(message, signature, id, recipient, path, ctx) {
  const lead = `Owed cancel ${id ?? ""}`;
  const match = /^Owed cancel ([1-9A-HJ-NP-Za-km-z]{10,12}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at (.+)$/.exec(message);
  if (!match || (id && match[1] !== id) || match[2] !== recipient || !CANCEL_ISO.test(match[3])) {
    return void ctx.errors.push(`${path}.signed_message: must read "${lead}${id ? "" : "<id>"} for ${recipient} at <UTC time>"`);
  }
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(signature) && !ed25519Verifies(message, signature, recipient)) {
    ctx.errors.push(`${path}.signature: does not verify for ${recipient} over signed_message`);
  }
}
const cancelProof = object({ at: iso, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) });

const getRequestFields = {
  id, kind: oneOf("single", "split_share", "invoice"), recipient: pubkey, amount: positiveAmount, token,
  payer_name: untrusted(40), for: untrusted(80), note: untrusted(140), requester_name: untrusted(40),
  status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), // W3-C: + expired
  solana_pay_url: solanaPayTransfer, reference: pubkey, x402_url: optional(nullable(httpsUrl)), created_at: iso,
  paid: optional(nullable(object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402") }))),
  flags: array(flag), from_domain: optional(nullable(domain)), from_domain_verified_at: optional(nullable(iso)),
  expires_at: optional(nullable(iso)), cancelled: optional(nullable(cancelProof)), // W3-C
  chain: optional(oneOf("solana")), pay_url: optional(solanaPayTransfer), // W3-B
};
function getRequestConsistent(value, path, ctx) {
  payUrlIsSolanaPayUrl(value, path, ctx); // W3-B
  decimalsFit("amount")(value, path, ctx);
  if (value.from_domain && !value.from_domain_verified_at) ctx.errors.push(`${path}.from_domain_verified_at: from_domain is set but its verified time is ${show(value.from_domain_verified_at)}`);
  urlMatchesFields(value, path, ctx);
  if (value.status === "paid" && !value.paid) ctx.errors.push(`${path}.paid: status is paid but paid is ${show(value.paid)}`);
  if (value.status === "open" && value.paid) ctx.errors.push(`${path}.paid: status is open but paid is set`);
  // W3-C: expired needs an expiry in the past of something; a cancelled request carries the signed proof.
  if (value.status === "expired" && !value.expires_at) ctx.errors.push(`${path}.expires_at: status is expired but expires_at is ${show(value.expires_at)}`);
  if (value.expires_at && Date.parse(value.expires_at) <= Date.parse(value.created_at)) ctx.errors.push(`${path}.expires_at: not after created_at`);
  if (value.cancelled) cancelSigned(value.cancelled.signed_message, value.cancelled.signature, value.id, value.recipient, `${path}.cancelled`, ctx);
}

export const shapes = {
  createGroupReq: object({
    recipient: pubkey, total: positiveAmount, token, title: string({ min: 1, max: 60 }),
    people: array(object({ name: string({ min: 1, max: 40 }), amount: optional(positiveAmount) }), { min: 2, max: 20 }),
    requester_name: optional(string({ max: 40 })), source: oneOf("plugin", "web"),
    from_domain: optional(string({ min: 1, max: 253 })), expires_in_days: optional(expiresInDays),
  }, peopleFitTotal),
  groupRes: object({
    id: groupId, link: httpsUrl, title: untrusted(60), recipient: pubkey, token, total: positiveAmount,
    requester_name: untrusted(40), created_at: iso, flags: array(flag),
    from_domain: optional(nullable(string({ max: 253, pattern: /^[a-z0-9.-]+$/, label: "a lower-case ASCII domain" }))),
    from_domain_verified_at: optional(nullable(iso)),
    share_count: integer({ min: 2 }), paid_count: integer(), amount_received: amount,
    shares: array(object({
      id, name: untrusted(40), amount: positiveAmount, status: oneOf("open", "paid", "underpaid", "cancelled", "expired"),
      link: httpsUrl, solana_pay_url: solanaPayTransfer, reference: pubkey, paid: nullable(paidInfo),
      from_domain: optional(nullable(domain)),
    }), { min: 2, max: 20 }),
    expires_at: optional(iso), // W3-C
  }, groupConsistent),
  createRequestReq: object({
    recipient: pubkey, amount: positiveAmount, token,
    payer_name: optional(string({ max: 40 })), for: optional(string({ max: 80 })), note: optional(string({ max: 140 })),
    requester_name: optional(string({ max: 40 })), kind: optional(oneOf("single")), group_id: optional(string({ max: 40 })),
    source: oneOf("plugin", "web"), from_domain: optional(string({ min: 1, max: 253 })),
    expires_in_days: optional(expiresInDays), // W3-C
  }, decimalsFit("amount")),
  createRequestRes: object({
    id, link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
    x402_url: optional(nullable(httpsUrl)), created_at: iso, flags: array(flag), from_domain: optional(nullable(domain)),
    expires_at: optional(nullable(iso)), // W3-C
    chain: optional(oneOf("solana")), pay_url: optional(solanaPayTransfer), // W3-B
  }, (value, path, ctx) => {
    payUrlIsSolanaPayUrl(value, path, ctx); // W3-B
    urlMatchesFields(value, path, ctx);
    if (!new URL(value.link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /r/${value.id}`);
  }),
  getRequestRes: object(getRequestFields, getRequestConsistent), // W3-C: fields and checks moved above, + expiry and cancel
  statusReq: object({ ids: array(id, { min: 1, max: 20 }) }),
  statusRes: object({ results: array(object({ id, ...statusFields }, statusConsistent), { max: 20 }) }),
  statusRawReq: object({ solana_pay_url: string({ max: 2048, pattern: /^solana:/, label: "a solana: URL" }) }),
  statusRawRes: object(statusFields, statusConsistent),
  statsRes: object({ paid_count: integer(), paid_volume_usdc: amount, since: iso }),
  errorRes: object({ error: object({ code: oneOf(...ERROR_CODES), message: string({ min: 1, max: 500 }) }) }),
  ledgerReq: object({ recipient: pubkey, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) }, ledgerSigned),
  ledgerRes: object({
    // QA-20: the ledger always says its rows may come from anyone (web/lib/ledger.ts LEDGER_CAUTION).
    recipient: pubkey, caution: string({ max: 400, pattern: /^Anyone can create a request that pays your wallet/, label: "the ledger caution" }),
    generated_at: iso, chain_checked: oneOf(true, false),
    open: array(ledgerEntry, { max: 100 }), paid_recently: array(ledgerEntry, { max: 100 }),
    totals: array(totalsEntry, { max: 2 }), truncated: oneOf(true, false),
  }, (value, path, ctx) => {
    value.open.forEach((e, i) => { if (e.status === "paid") ctx.errors.push(`${path}.open[${i}]: paid entry in open`); });
    value.paid_recently.forEach((e, i) => { if (e.status !== "paid") ctx.errors.push(`${path}.paid_recently[${i}]: ${e.status} entry in paid_recently`); });
    ledgerTotals(value, path, ctx);
  }),
};

/** Which shape each file in contract/fixtures/ must satisfy. A new fixture without an entry fails check.mjs. */
export const fixtureShapes = {
  "create-request.req.json": "createRequestReq",
  "create-request.res.json": "createRequestRes",
  "get-request.res.json": "getRequestRes",
  "status.req.json": "statusReq",
  "status.res.json": "statusRes",
  "status-raw.req.json": "statusRawReq",
  "status-raw.res.json": "statusRawRes",
  "stats.res.json": "statsRes",
  "error.res.json": "errorRes",
  "groups.create.req.json": "createGroupReq",
  "groups.create.res.json": "groupRes",
  "groups.get.res.json": "groupRes",
  "ledger.req.json": "ledgerReq",
  "ledger.res.json": "ledgerRes",
};

// ---------------------------------------------------------------------------------------------- invoices
// Appended with Object.assign so this block merges cleanly next to other wave-2 shapes.
// An invoice is one request (same id) for its total: the id hashes (recipient, token, total, reference).

/** "2026-10-31" that is a real calendar date. */
const isRealDate = (text) => {
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text;
};
const invoiceDate = string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, test: isRealDate, label: "a real date written YYYY-MM-DD" });
const QUANTITY_DECIMALS = 4;
const invoiceQuantity = string({
  max: 20, label: "a positive quantity with at most 4 decimal places",
  test: (text) => AMOUNT_RE.test(text) && /[1-9]/.test(text) && (text.split(".")[1]?.length ?? 0) <= QUANTITY_DECIMALS,
});
const invoicePaid = object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402") });

/** quantity × unit price in atomic units, or null when it isn't a whole number of atomic units. */
export function invoiceLineAtomic(quantity, unitPrice, decimals) {
  const scale = 10n ** BigInt(QUANTITY_DECIMALS);
  const scaled = toAtomic(unitPrice, decimals) * toAtomic(quantity, QUANTITY_DECIMALS);
  return scaled % scale === 0n ? scaled / scale : null;
}

/** Every line's quantity × unit price is a whole number of the token's atomic units. */
function invoiceItemsFit(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (decimals === undefined) return;
  value.items.forEach((item, index) => {
    try {
      if (invoiceLineAtomic(item.quantity ?? "1", item.unit_price, decimals) === null) {
        ctx.errors.push(`${path}.items[${index}]: ${item.quantity ?? "1"} × ${item.unit_price} is not a whole number of ${value.token} units`);
      }
    } catch (error) {
      ctx.errors.push(`${path}.items[${index}].unit_price: ${error.message}`);
    }
  });
}

/** Lines multiply out and add up to the total, the payment link pays exactly the total, and the id hashes those terms. */
function invoiceConsistent(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (!new URL(value.link).pathname.endsWith(`/i/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /i/${value.id}`);
  if (!new URL(value.request_link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.request_link: does not end in /r/${value.id}`);
  if (value.created_at.slice(0, 10) !== value.issue_date) ctx.errors.push(`${path}.issue_date: ${value.issue_date} is not the UTC date of created_at`);
  if ((value.from_domain === null) !== (value.from_domain_verified_at === null)) ctx.errors.push(`${path}.from_domain: set without from_domain_verified_at, or the reverse`);
  if ((value.status === "paid" || value.status === "underpaid") && !value.paid) ctx.errors.push(`${path}.paid: status is ${value.status} but paid is ${show(value.paid)}`);
  if (value.status === "open" && value.paid) ctx.errors.push(`${path}.paid: status is open but paid is set`);
  urlMatchesFields({ id: value.id, recipient: value.recipient, amount: value.total, token: value.token, reference: value.reference, solana_pay_url: value.solana_pay_url }, path, ctx);
  if (decimals === undefined) return;
  let total = 0n;
  value.items.forEach((item, index) => {
    const at = `${path}.items[${index}]`;
    try {
      const line = invoiceLineAtomic(item.quantity, item.unit_price, decimals);
      if (line === null) return void ctx.errors.push(`${at}: ${item.quantity} × ${item.unit_price} is not a whole number of ${value.token} units`);
      if (line !== toAtomic(item.amount, decimals)) ctx.errors.push(`${at}.amount: ${item.amount}, but ${item.quantity} × ${item.unit_price} = ${fromAtomic(line, decimals)}`);
      total += line;
    } catch (error) {
      ctx.errors.push(`${at}: ${error.message}`);
    }
  });
  try {
    if (toAtomic(value.total, decimals) !== total) ctx.errors.push(`${path}.total: ${value.total} but the items add up to ${fromAtomic(total, decimals)}`);
  } catch (error) {
    ctx.errors.push(`${path}.total: ${error.message}`);
  }
}

Object.assign(shapes, {
  createInvoiceReq: object({
    recipient: pubkey, token, business_name: string({ min: 1, max: 60 }), client_name: string({ min: 1, max: 60 }),
    items: array(object({ description: string({ min: 1, max: 80 }), quantity: optional(invoiceQuantity), unit_price: positiveAmount }), { min: 1, max: 20 }),
    due_date: invoiceDate, invoice_number: optional(string({ min: 1, max: 20 })), notes: optional(string({ min: 1, max: 280 })),
    from_domain: optional(string({ min: 1, max: 253 })), source: oneOf("plugin", "web"),
    expires_in_days: optional(expiresInDays), // W3-C
  }, invoiceItemsFit),
  invoiceRes: object({
    id, link: httpsUrl, request_link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
    x402_url: optional(nullable(httpsUrl)), recipient: pubkey, token,
    business_name: untrusted(60), client_name: untrusted(60), invoice_number: untrusted(20), notes: untrusted(280),
    issue_date: invoiceDate, due_date: invoiceDate,
    items: array(object({ description: untrusted(80), quantity: invoiceQuantity, unit_price: positiveAmount, amount: positiveAmount }), { min: 1, max: 20 }),
    total: positiveAmount, status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), paid: nullable(invoicePaid),
    created_at: iso, flags: array(flag),
    from_domain: nullable(string({ max: 253, pattern: /^[a-z0-9.-]+$/, label: "a lower-case ASCII domain" })),
    from_domain_verified_at: nullable(iso),
    expires_at: optional(iso), cancelled_at: optional(iso), // W3-C
  }, invoiceConsistent),
});

Object.assign(fixtureShapes, {
  "invoices.create.req.json": "createInvoiceReq",
  "invoices.create.res.json": "invoiceRes",
  "invoices.get.res.json": "invoiceRes",
});

// ---------------------------------------------------------------------------------------------- W3-C cancel
// POST /api/v1/requests/:id/cancel. Appended with Object.assign, like the invoice shapes.

Object.assign(shapes, {
  cancelReq: object({ recipient: pubkey, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) },
    (value, path, ctx) => cancelSigned(value.signed_message, value.signature, null, value.recipient, path, ctx)),
  cancelRes: object({ ...getRequestFields, already_cancelled: oneOf(true, false) }, (value, path, ctx) => {
    getRequestConsistent(value, path, ctx);
    if (value.status !== "cancelled" && value.status !== "paid") ctx.errors.push(`${path}.status: ${value.status} after a cancel`);
    if (!value.cancelled) ctx.errors.push(`${path}.cancelled: missing after a cancel`);
  }),
});

Object.assign(fixtureShapes, {
  "cancel.req.json": "cancelReq",
  "cancel.res.json": "cancelRes",
  "status.ended.res.json": "statusRes",
});

// ---------------------------------------------------------------------------------------------- Base requests (W3-B)
// A request on Base: USDC at 0x8335…2913 on chain 8453, recipient a 0x address, no Solana Pay URL. pay_url is the
// EIP-681 transfer link, and the id hashes the terms with the chain (owed-request:v1, eip155:8453, recipient,
// Base USDC, atomic amount, reference). Appended with Object.assign like the invoices block.

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function baseRequestIdFor({ recipient, amountAtomic, reference }) {
  const digest = createHash("sha256").update(`owed-request:v1\neip155:8453\n${recipient}\n${BASE_USDC}\n${amountAtomic}\n${reference}`, "utf8").digest();
  return base58Encode(digest).slice(-12);
}

export function eip681Transfer(recipient, amountAtomic) {
  return `ethereum:${BASE_USDC}@8453/transfer?address=${recipient}&uint256=${amountAtomic}`;
}

const evmAddress = string({ pattern: EVM_ADDRESS_RE, label: "a 0x address" });
const txHash = string({ pattern: TX_HASH_RE, label: "a lower-case 0x transaction hash" });
const eip681 = string({ max: 2048, pattern: /^ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453\/transfer\?address=0x[0-9a-fA-F]{40}&uint256=[1-9][0-9]*$/, label: "an EIP-681 Base USDC transfer link" });

/** pay_url pays exactly .recipient .amount, and the 12-char id hashes those terms on Base. */
function baseTermsMatch(value, path, ctx) {
  if (value.token !== "USDC") return void ctx.errors.push(`${path}.token: Base requests are USDC only`);
  let atomic = null;
  try { atomic = toAtomic(value.amount, 6); } catch (error) { return void ctx.errors.push(`${path}.amount: ${error.message}`); }
  if ("recipient" in value && value.pay_url !== eip681Transfer(value.recipient, atomic)) ctx.errors.push(`${path}.pay_url: does not pay .recipient .amount`);
  if (typeof value.id === "string" && "recipient" in value) {
    const expected = baseRequestIdFor({ recipient: value.recipient, amountAtomic: atomic, reference: value.reference });
    if (expected !== value.id) ctx.errors.push(`${path}.id: ${value.id} is not the hash of its Base payment terms (expected ${expected})`);
  }
}

Object.assign(shapes, {
  baseCreateRequestReq: object({
    recipient: evmAddress, amount: positiveAmount, token: oneOf("USDC"), chain: oneOf("base"),
    payer_name: optional(string({ max: 40 })), for: optional(string({ max: 80 })), note: optional(string({ max: 140 })),
    requester_name: optional(string({ max: 40 })), source: oneOf("plugin", "web"), from_domain: optional(string({ min: 1, max: 253 })),
    expires_in_days: optional(integer({ min: 1 })), // W3-C
  }, decimalsFit("amount")),
  baseCreateRequestRes: object({
    id, link: httpsUrl, solana_pay_url: (value, path, ctx) => { if (value !== null) ctx.errors.push(`${path}: must be null on a Base request`); },
    qr_url: httpsUrl, reference: pubkey, x402_url: optional(nullable(httpsUrl)), created_at: iso, flags: array(flag),
    from_domain: optional(nullable(domain)), chain: oneOf("base"), pay_url: eip681,
    expires_at: optional(nullable(iso)), // W3-C
  }, (value, path, ctx) => {
    if (!new URL(value.link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /r/${value.id}`);
    const m = /address=(0x[0-9a-fA-F]{40})&uint256=([0-9]+)$/.exec(value.pay_url);
    if (m && typeof value.id === "string") {
      const expected = baseRequestIdFor({ recipient: m[1], amountAtomic: BigInt(m[2]), reference: value.reference });
      if (expected !== value.id) ctx.errors.push(`${path}.id: ${value.id} is not the hash of the terms in pay_url (expected ${expected})`);
    }
  }),
  baseGetRequestRes: object({
    id, kind: oneOf("single"), recipient: evmAddress, amount: positiveAmount, token: oneOf("USDC"),
    payer_name: untrusted(40), for: untrusted(80), note: untrusted(140), requester_name: untrusted(40),
    status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), // W3-C: + expired
    solana_pay_url: (value, path, ctx) => { if (value !== null) ctx.errors.push(`${path}: must be null on a Base request`); },
    reference: pubkey, x402_url: optional(nullable(httpsUrl)), created_at: iso,
    paid: optional(nullable(object({ signature: txHash, payer: evmAddress, amount, at: iso, rail: oneOf("base_transfer", "x402") }))),
    flags: array(flag), from_domain: optional(nullable(domain)), from_domain_verified_at: optional(nullable(iso)),
    chain: oneOf("base"), pay_url: eip681,
    expires_at: optional(nullable(iso)), cancelled: optional(nullable(cancelProof)), // W3-C
  }, (value, path, ctx) => {
    baseTermsMatch(value, path, ctx);
    if (value.status === "paid" && !value.paid) ctx.errors.push(`${path}.paid: status is paid but paid is ${show(value.paid)}`);
    if (value.status === "open" && value.paid) ctx.errors.push(`${path}.paid: status is open but paid is set`);
  }),
});

Object.assign(fixtureShapes, {
  "base.create-request.req.json": "baseCreateRequestReq",
  "base.create-request.res.json": "baseCreateRequestRes",
  "base.get-request.res.json": "baseGetRequestRes",
  "base.status.res.json": "statusRes",
});
