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
  // 0012: the paid rail, the recipient's match (no reference on the payment) and the ask_for_rest links.
  rail: optional(oneOf("solana_pay", "x402", "base_transfer", "matched", "moonpay_card")),
  matched: optional((value, path, ctx) => matchedLite(value, path, ctx)),
  rest_of: optional(id), rest_request: optional(id),
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
  if (value.rail === "matched" && !value.matched) ctx.errors.push(`${path}.matched: rail is matched but matched is missing`); // 0012
  if (value.matched && value.status !== "paid") ctx.errors.push(`${path}.matched: set for status ${value.status}`);
}

// ---------------------------------------------------------------------------------------------- split bills

/** Group id = last 12 base58 chars of sha256 over its share ids in board order (web/lib/groups.ts, plugin split_bill). */
export function groupIdFor({ recipient, token, totalAtomic, shareIds }) {
  const asset = token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-group:v1\n${recipient}\n${asset}\n${totalAtomic}\n${shareIds.join("\n")}`, "utf8").digest();
  return base58Encode(digest).slice(-12);
}

const groupId = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 group id" });
const paidInfo = object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402", "matched", "moonpay_card") }); // 0012: + matched, moonpay_card

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
  // W3-D: the monthly schedule and month that opened this request; null for one-off requests.
  schedule_id: optional(nullable(string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 schedule id" }))),
  period: optional(nullable(string({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/, label: "a month written YYYY-MM" }))),
  // 0012: paid rail, the recipient's match (no reference on the payment), and the ask_for_rest links.
  rail: optional(oneOf("solana_pay", "x402", "base_transfer", "matched")),
  matched: optional((value, path, ctx) => matchedLite(value, path, ctx)),
  rest_of: optional(id), rest_request: optional(id),
}, (value, path, ctx) => {
  decimalsFit("amount")(value, path, ctx);
  if (value.matched && value.status !== "paid") ctx.errors.push(`${path}.matched: set for status ${value.status}`); // 0012
  if ((value.schedule_id ?? null) === null !== ((value.period ?? null) === null)) ctx.errors.push(`${path}.period: set without schedule_id, or the reverse`); // W3-D
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

// W3-S SNS names: "name.sns" or "sub.name.sns", lower case, as the server stores it after resolving it.
const snsName = string({ max: 140, pattern: /^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$/u, test: (t) => t === t.toLowerCase(), label: "a lower-case SNS name ending in .sns" });
const snsSource = oneOf("sol_record_v2", "sol_record_v1", "owner");

// F1 payer inbox: who a request is addressed to. X handles are stored lower case without "@" (labels: Owed never
// verifies them); the payer is a Solana wallet, found by a handle (PayBox resolve_username), an .sns name or itself.
// Never part of a request id.
const handle = string({ max: 15, pattern: /^[a-z0-9_]{1,15}$/, label: "an X handle, lower case without @" });
const handleIn = string({ max: 16, pattern: /^@?[A-Za-z0-9_]{1,15}$/, label: "an X handle like @sam_ok" });
const payerReq = object({ wallet: optional(pubkey), handle: optional(handleIn), sns: optional(string({ min: 1, max: 140 })) }, (value, path, ctx) => {
  if (!value.wallet && !value.sns) ctx.errors.push(`${path}: needs wallet or sns`);
  if (value.handle && !value.wallet) ctx.errors.push(`${path}.wallet: a handle comes with the wallet resolve_username returned`);
});
const payerInfo = object({ wallet: pubkey, handle: nullable(handle), sns: nullable(snsName) });
/** The payer can never be the wallet the request pays. */
function payerNotRecipient(value, path, ctx) {
  if (value.payer && value.recipient && value.payer.wallet === value.recipient) ctx.errors.push(`${path}.payer.wallet: the request's own recipient`);
}

const getRequestFields = {
  id, kind: oneOf("single", "split_share", "invoice"), recipient: pubkey, amount: positiveAmount, token,
  payer_name: untrusted(40), for: untrusted(80), note: untrusted(140), requester_name: untrusted(40),
  status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), // W3-C: + expired
  solana_pay_url: solanaPayTransfer, reference: pubkey, x402_url: optional(nullable(httpsUrl)), created_at: iso,
  paid: optional(nullable(object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402", "matched", "moonpay_card") }))), // 0012: + matched, moonpay_card
  flags: array(flag), from_domain: optional(nullable(domain)), from_domain_verified_at: optional(nullable(iso)),
  expires_at: optional(nullable(iso)), cancelled: optional(nullable(cancelProof)), // W3-C
  chain: optional(oneOf("solana")), pay_url: optional(solanaPayTransfer), // W3-B
  // 0012: a payment without the reference matched by the recipient (signed), and the ask_for_rest links.
  matched: optional(nullable((value, path, ctx) => matchedProof(value, path, ctx))), rest_of: optional(nullable(id)),
  rest_request: optional(nullable((value, path, ctx) => restLink(value, path, ctx))),
  sns_name: optional(nullable(snsName)), sns_source: optional(nullable(snsSource)), sns_resolved_at: optional(nullable(iso)), // W3-S
  payer: optional(nullable(payerInfo)), requester_handle: optional(nullable(handle)), // F1
};
function getRequestConsistent(value, path, ctx) {
  payerNotRecipient(value, path, ctx); // F1
  // W3-S: a stored name always says which rule picked the wallet, and when.
  if (value.sns_name && (!value.sns_source || !value.sns_resolved_at)) ctx.errors.push(`${path}.sns_name: set without sns_source and sns_resolved_at`);
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
  if (value.matched) matchedConsistent(value, path, ctx); // 0012
  if (value.rest_of && value.rest_of === value.id) ctx.errors.push(`${path}.rest_of: a request can't ask for its own rest`);
}

export const shapes = {
  createGroupReq: object({
    recipient: pubkey, total: positiveAmount, token, title: string({ min: 1, max: 60 }),
    people: array(object({ name: string({ min: 1, max: 40 }), amount: optional(positiveAmount), payer: optional(payerReq) }), { min: 2, max: 20 }), // F1: + payer
    requester_name: optional(string({ max: 40 })), source: oneOf("plugin", "web"),
    from_domain: optional(string({ min: 1, max: 253 })), expires_in_days: optional(expiresInDays),
    requester_handle: optional(handleIn), // F1
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
      payer: optional(payerInfo), // F1
    }), { min: 2, max: 20 }),
    expires_at: optional(iso), // W3-C
    requester_handle: optional(handle), // F1
  }, (value, path, ctx) => {
    groupConsistent(value, path, ctx);
    value.shares.forEach((share, index) => { if (share.payer?.wallet === value.recipient) ctx.errors.push(`${path}.shares[${index}].payer.wallet: the group's own recipient`); });
  }),
  createRequestReq: object({
    recipient: pubkey, amount: positiveAmount, token,
    payer_name: optional(string({ max: 40 })), for: optional(string({ max: 80 })), note: optional(string({ max: 140 })),
    requester_name: optional(string({ max: 40 })), kind: optional(oneOf("single")), group_id: optional(string({ max: 40 })),
    source: oneOf("plugin", "web"), from_domain: optional(string({ min: 1, max: 253 })),
    expires_in_days: optional(expiresInDays), // W3-C
    sns_name: optional(string({ min: 1, max: 140 })), // W3-S
    payer: optional(payerReq), requester_handle: optional(handleIn), // F1
  }, (value, path, ctx) => { decimalsFit("amount")(value, path, ctx); payerNotRecipient(value, path, ctx); }),
  createRequestRes: object({
    id, link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
    x402_url: optional(nullable(httpsUrl)), created_at: iso, flags: array(flag), from_domain: optional(nullable(domain)),
    expires_at: optional(nullable(iso)), // W3-C
    chain: optional(oneOf("solana")), pay_url: optional(solanaPayTransfer), // W3-B
    sns_name: optional(nullable(snsName)), sns_source: optional(nullable(snsSource)), // W3-S
    payer: optional(nullable(payerInfo)), requester_handle: optional(nullable(handle)), // F1
  }, (value, path, ctx) => {
    payUrlIsSolanaPayUrl(value, path, ctx); // W3-B
    if (value.sns_name && !value.sns_source) ctx.errors.push(`${path}.sns_source: sns_name is set but sns_source is ${show(value.sns_source)}`); // W3-S
    urlMatchesFields(value, path, ctx);
    if (!new URL(value.link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /r/${value.id}`);
  }),
  getRequestRes: object(getRequestFields, getRequestConsistent), // W3-C: fields and checks moved above, + expiry and cancel
  statusReq: object({ ids: array(id, { min: 1, max: 20 }) }),
  statusRes: object({ results: array(object({ id, ...statusFields }, statusConsistent), { max: 20 }) }),
  statusRawReq: object({ solana_pay_url: string({ max: 2048, pattern: /^solana:/, label: "a solana: URL" }) }),
  statusRawRes: object(statusFields, statusConsistent),
  statsRes: object({ paid_count: integer(), paid_volume_usdc: amount, since: iso, cta: optional(object({ paybox_clicks: integer(), prompt_copies: integer() })) }), // SP1 (0016)
  errorRes: object({ error: object({ code: oneOf(...ERROR_CODES), message: string({ min: 1, max: 500 }) }) }),
  ledgerReq: object({
    recipient: pubkey, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }),
    csv: optional(oneOf(true)), // W3-D
  }, ledgerSigned),
  ledgerRes: object({
    // QA-20: the ledger always says its rows may come from anyone (web/lib/ledger.ts LEDGER_CAUTION).
    recipient: pubkey, caution: string({ max: 400, pattern: /^Anyone can create a request that pays your wallet/, label: "the ledger caution" }),
    generated_at: iso, chain_checked: oneOf(true, false),
    open: array(ledgerEntry, { max: 100 }), paid_recently: array(ledgerEntry, { max: 100 }),
    totals: array(totalsEntry, { max: 2 }), truncated: oneOf(true, false),
    schedules: optional((value, path, ctx) => array(scheduleSummary, { max: 20 })(value, path, ctx)), // W3-D, shapes below
    csv: optional(nullable(object({ url: httpsUrl, expires_at: iso }, csvLinkConsistent))), // W3-D
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
const invoicePaid = object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402", "matched", "moonpay_card") }); // 0012: + matched, moonpay_card

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
    payer: optional(payerReq), requester_handle: optional(handleIn), // F1: the client as a payer
  }, (value, path, ctx) => { invoiceItemsFit(value, path, ctx); payerNotRecipient(value, path, ctx); }),
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
    payer: optional(payerInfo), requester_handle: optional(handle), // F1
  }, (value, path, ctx) => { invoiceConsistent(value, path, ctx); payerNotRecipient(value, path, ctx); }),
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

// ---------------------------------------------------------------------------------------------- W3-D: schedules
// ask_every_month: POST /api/v1/schedules stores a monthly schedule; on its day it opens that month's request at
// once (first_request), an ordinary request whose id hashes its terms. The ledger lists schedules and a CSV link.

const dayOfMonth = (value, path, ctx) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 28) ctx.errors.push(`${path}: expected a day of the month 1..28, got ${show(value)}`);
};
const monthCount = (value, path, ctx) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120) ctx.errors.push(`${path}: expected 1..120 months, got ${show(value)}`);
};
const month = string({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/, label: "a month written YYYY-MM" });
const scheduleId = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 schedule id" });
const scheduleStatus = oneOf("active", "ended", "stopped");

function csvLinkConsistent(value, path, ctx) {
  const url = new URL(value.url);
  if (!url.pathname.endsWith("/api/v1/ledger/csv")) ctx.errors.push(`${path}.url: not a /api/v1/ledger/csv link`);
  const expires = Number(url.searchParams.get("expires"));
  if (!Number.isSafeInteger(expires) || expires * 1000 !== Date.parse(value.expires_at)) ctx.errors.push(`${path}.expires_at: differs from the link's expires`);
  if (!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("sig") ?? "")) ctx.errors.push(`${path}.url: sig is not a base64url HMAC-SHA256`);
  if (!isPubkey(url.searchParams.get("recipient") ?? "")) ctx.errors.push(`${path}.url: recipient is not a base58 key`);
}

const scheduleSummary = object({
  id: scheduleId, status: scheduleStatus, amount: positiveAmount, token, payer_name: untrusted(40), for: untrusted(80),
  day_of_month: dayOfMonth, months: nullable(monthCount), requests_opened: integer(),
  next_request_on: nullable(invoiceDate), created_at: iso,
  from_domain: nullable(domain), last_error: nullable(string({ max: 400 })),
  requests: array(object({ period: month, id, link: httpsUrl, status: oneOf("open", "paid", "underpaid", "cancelled") }), { max: 24 }),
}, (value, path, ctx) => {
  decimalsFit("amount")(value, path, ctx);
  value.requests.forEach((r, i) => { if (!new URL(r.link).pathname.endsWith(`/r/${r.id}`)) ctx.errors.push(`${path}.requests[${i}].link: does not end in /r/${r.id}`); });
  for (let i = 1; i < value.requests.length; i++) {
    if (value.requests[i - 1].period <= value.requests[i].period) ctx.errors.push(`${path}.requests: not newest first`);
  }
  if (value.requests.length > value.requests_opened) ctx.errors.push(`${path}.requests: more listed than requests_opened`);
  if (value.months !== null && value.requests_opened > value.months) ctx.errors.push(`${path}.requests_opened: more than months`);
  if ((value.status === "active") !== (value.next_request_on !== null)) ctx.errors.push(`${path}.next_request_on: ${value.status === "active" ? "missing" : "set"} for status ${value.status}`);
});

Object.assign(shapes, {
  createScheduleReq: object({
    recipient: pubkey, amount: positiveAmount, token,
    payer_name: optional(string({ min: 1, max: 40 })), for: optional(string({ min: 1, max: 80 })), requester_name: optional(string({ min: 1, max: 40 })),
    day_of_month: dayOfMonth, months: optional(monthCount), from_domain: optional(string({ min: 1, max: 253 })), source: oneOf("plugin", "web"),
    payer: optional(payerReq), requester_handle: optional(handleIn), // F1
  }, (value, path, ctx) => { decimalsFit("amount")(value, path, ctx); payerNotRecipient(value, path, ctx); }),
  scheduleRes: object({
    id: scheduleId, recipient: pubkey, amount: positiveAmount, token,
    payer_name: untrusted(40), for: untrusted(80), requester_name: untrusted(40),
    day_of_month: dayOfMonth, months: nullable(monthCount), first_period: month, status: scheduleStatus,
    next_request_on: nullable(invoiceDate), created_at: iso, flags: array(flag),
    from_domain: nullable(domain), from_domain_verified_at: nullable(iso),
    first_request: nullable(object({
      period: month, id, link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
      x402_url: nullable(httpsUrl), created_at: iso, flags: array(flag), from_domain: nullable(domain),
    })),
    payer: optional(payerInfo), requester_handle: optional(handle), // F1
  }, (value, path, ctx) => {
    payerNotRecipient(value, path, ctx); // F1
    decimalsFit("amount")(value, path, ctx);
    if ((value.from_domain === null) !== (value.from_domain_verified_at === null)) ctx.errors.push(`${path}.from_domain: set without from_domain_verified_at, or the reverse`);
    if (value.first_period.length === 7 && value.created_at.slice(0, 7) > value.first_period) ctx.errors.push(`${path}.first_period: before the month it was created in`);
    if (value.next_request_on !== null && value.next_request_on.slice(0, 7) < value.first_period) ctx.errors.push(`${path}.next_request_on: before first_period`);
    if (value.next_request_on !== null && Number(value.next_request_on.slice(8)) !== value.day_of_month) ctx.errors.push(`${path}.next_request_on: not on day_of_month`);
    const f = value.first_request;
    if (!f) return;
    // This month's request: the same terms as the schedule, opened on its day, in its first month.
    urlMatchesFields({ id: f.id, recipient: value.recipient, amount: value.amount, token: value.token, reference: f.reference, solana_pay_url: f.solana_pay_url }, `${path}.first_request`, ctx);
    if (!new URL(f.link).pathname.endsWith(`/r/${f.id}`)) ctx.errors.push(`${path}.first_request.link: does not end in /r/${f.id}`);
    if (f.period !== value.first_period) ctx.errors.push(`${path}.first_request.period: not first_period`);
    if (Number(f.created_at.slice(8, 10)) !== value.day_of_month || f.created_at.slice(0, 7) !== f.period) ctx.errors.push(`${path}.first_request.created_at: not on the schedule's day in its month`);
    if ((f.from_domain ?? null) !== (value.from_domain ?? null)) ctx.errors.push(`${path}.first_request.from_domain: differs from the schedule's`);
  }),
  scheduleSummary,
});

Object.assign(fixtureShapes, {
  "schedules.create.req.json": "createScheduleReq",
  "schedules.create.res.json": "scheduleRes",
  "ledger.schedules.req.json": "ledgerReq",
  "ledger.schedules.res.json": "ledgerRes",
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

// ---------------------------------------------------------------------------------------------- 0012: matched payments
// match_payments: a payment that carried no Solana Pay reference (exchanges and some wallets drop it) counts only after
// the recipient's wallet signs "Owed match <transaction> to <id> for <recipient> at <ISO>" and the server re-reads the
// transaction. ask_for_rest: a new request for exactly what an underpaid request still owes. POST /api/v1/attributed
// tells match_payments which transactions are already counted. Appended with Object.assign like the blocks above.

const MATCH_RE = /^Owed match ([1-9A-HJ-NP-Za-km-z]{64,88}) to ([1-9A-HJ-NP-Za-km-z]{10,12}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at (.+)$/;
function matchSigned(message, signature, transaction, id, recipient, path, ctx) {
  const m = MATCH_RE.exec(message);
  if (!m || m[1] !== transaction || (id && m[2] !== id) || m[3] !== recipient || !CANCEL_ISO.test(m[4])) {
    return void ctx.errors.push(`${path}.signed_message: must read "Owed match ${transaction} to ${id ?? "<id>"} for ${recipient} at <UTC time>"`);
  }
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(signature) && !ed25519Verifies(message, signature, recipient)) {
    ctx.errors.push(`${path}.signature: does not verify for ${recipient} over signed_message`);
  }
}
function matchedProof(value, path, ctx) {
  object({
    signature, covers: oneOf("full", "rest"), payer: pubkey, amount: positiveAmount, at: iso, confirmed_by: pubkey, confirmed_at: iso,
    signed_message: string({ min: 1, max: 200 }), message_signature: string({ min: 64, max: 200 }),
  })(value, path, ctx);
}
function matchedLite(value, path, ctx) {
  object({ signature, covers: oneOf("full", "rest"), amount: positiveAmount, confirmed_at: iso })(value, path, ctx);
}
function restLink(value, path, ctx) {
  object({ id, status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), link: optional(httpsUrl) }, (v, p, c) => {
    if (v.link && !new URL(v.link).pathname.endsWith(`/r/${v.id}`)) c.errors.push(`${p}.link: does not end in /r/${v.id}`);
  })(value, path, ctx);
}
/** A matched request is paid; the match is signed by the recipient over this transaction and id; "full" names it in paid. */
function matchedConsistent(value, path, ctx) {
  const m = value.matched;
  if (value.status !== "paid") ctx.errors.push(`${path}.matched: set for status ${value.status}`);
  if (m.confirmed_by !== value.recipient) ctx.errors.push(`${path}.matched.confirmed_by: not the recipient`);
  matchSigned(m.signed_message, m.message_signature, m.signature, value.id, value.recipient, `${path}.matched`, ctx);
  if (Date.parse(m.at) < Date.parse(value.created_at) - 60_000) ctx.errors.push(`${path}.matched.at: before the request was made`);
  if (!value.paid) return;
  const decimals = TOKEN_DECIMALS[value.token];
  if (m.covers === "full") {
    if (value.paid.rail !== "matched") ctx.errors.push(`${path}.paid.rail: a full match must say matched, not ${show(value.paid.rail)}`);
    if (value.paid.signature !== m.signature) ctx.errors.push(`${path}.paid.signature: differs from matched.signature`);
    if (toAtomic(m.amount, decimals) !== toAtomic(value.amount, decimals)) ctx.errors.push(`${path}.matched.amount: a full match must be exactly the amount`);
  } else {
    if (value.paid.rail === "matched") ctx.errors.push(`${path}.paid.rail: a rest match keeps the referenced payment's rail`);
    if (value.paid.signature === m.signature) ctx.errors.push(`${path}.paid.signature: the rest's transaction can't also be the first payment`);
    if (toAtomic(value.paid.amount, decimals) !== toAtomic(value.amount, decimals)) ctx.errors.push(`${path}.paid.amount: after a rest match the total paid must be the amount`);
  }
  if (value.paid.rail === "matched" && m.covers !== "full") ctx.errors.push(`${path}.paid.rail: matched without a full match`);
}

Object.assign(shapes, {
  matchReq: object({ recipient: pubkey, transaction: signature, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) },
    (value, path, ctx) => matchSigned(value.signed_message, value.signature, value.transaction, null, value.recipient, path, ctx)),
  matchRes: object({ ...getRequestFields, already_matched: oneOf(true, false) }, (value, path, ctx) => {
    getRequestConsistent(value, path, ctx);
    if (value.status !== "paid") ctx.errors.push(`${path}.status: ${value.status} after a match`);
    if (!value.matched) ctx.errors.push(`${path}.matched: missing after a match`);
  }),
  restReq: object({ source: optional(oneOf("plugin", "web")) }),
  restRes: object({
    id, link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
    x402_url: optional(nullable(httpsUrl)), created_at: iso, flags: array(flag), from_domain: optional(nullable(domain)),
    expires_at: optional(nullable(iso)), chain: optional(oneOf("solana")), pay_url: optional(solanaPayTransfer),
    recipient: pubkey, amount: positiveAmount, token, rest_of: id, already_asked: oneOf(true, false),
  }, (value, path, ctx) => {
    payUrlIsSolanaPayUrl(value, path, ctx);
    decimalsFit("amount")(value, path, ctx);
    urlMatchesFields(value, path, ctx);
    if (!new URL(value.link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /r/${value.id}`);
    if (value.rest_of === value.id) ctx.errors.push(`${path}.rest_of: a request can't ask for its own rest`);
  }),
  attributedReq: object({ signatures: array(signature, { max: 100 }), keys: optional(array(pubkey, { max: 256 })) }),
  attributedRes: object({
    attributed: array(object({ signature, request_id: id, how: oneOf("reference", "matched", "x402") })),
    references: array(object({ key: pubkey, request_id: id })),
  }),
});

Object.assign(fixtureShapes, {
  "match.req.json": "matchReq",
  "match.res.json": "matchRes",
  "match.rest.res.json": "matchRes",
  "rest.req.json": "restReq",
  "rest.res.json": "restRes",
  "attributed.req.json": "attributedReq",
  "attributed.res.json": "attributedRes",
  "status.matched.res.json": "statusRes",
});

// ---------------------------------------------------------------------------------------------- local-currency asks
// "ask Priya for ₹1,200": `currency` (ISO 4217, never USD) makes a create body's amounts that currency; the server locks
// a USDC amount at a live rate and replies with the quote as `fiat` {currency, amount, rate, rate_source, quoted_at}.
// The quote is display only (ids hash the USDC terms, unchanged), but it must produce the USDC exactly:
// usdc = ceil(amount / rate) to 6 decimals (plugin/src/fiat.ts, web/lib/fiat.ts). These shapes wrap the ones above:
// they check the fiat fields, then hand the rest to the original shape.

const fiatCode = string({ pattern: /^[A-Z]{3}$/, test: (t) => t !== "USD", label: "an ISO 4217 code other than USD" });
const fiatQuote = object({ currency: fiatCode, amount: positiveAmount, rate: positiveAmount, rate_source: string({ min: 1, max: 120 }), quoted_at: iso });

/** USDC atomic units for `amount` at `rate` (units per 1 USDC), rounded up: exact decimals, no floats. */
export function usdcAtomicForQuote(quote) {
  const [aw, af = ""] = quote.amount.split(".");
  const [rw, rf = ""] = quote.rate.split(".");
  const num = BigInt(aw + af) * 10n ** BigInt(rf.length + 6);
  const den = BigInt(rw + rf) * 10n ** BigInt(af.length);
  return (num + den - 1n) / den;
}

function quoteGives(quote, usdc, path, ctx) {
  try {
    if (usdcAtomicForQuote(quote) !== toAtomic(usdc, 6)) {
      ctx.errors.push(`${path}: ${quote.amount} ${quote.currency} at ${quote.rate} per USDC is ${fromAtomic(usdcAtomicForQuote(quote), 6)} USDC rounded up, not ${usdc}`);
    }
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
}

/** `base` without the keys in `extra` (checked first), then `refine` on the whole value. */
const withFiat = (base, extra, refine) => (value, path, ctx) => {
  if (kind(value) !== "object") return base(value, path, ctx);
  const before = ctx.errors.length;
  const rest = { ...value };
  for (const [key, shape] of Object.entries(extra)) {
    if (!(key in rest)) {
      if (!shape.optional) ctx.errors.push(`${path}.${key}: missing`);
      continue;
    }
    shape(rest[key], `${path}.${key}`, ctx);
    delete rest[key];
  }
  base(rest, path, ctx);
  if (refine && before === ctx.errors.length) refine(value, path, ctx, rest);
};
const usdcOnly = (value, path, ctx) => { if (value.token !== "USDC") ctx.errors.push(`${path}.token: a local-currency ask is USDC, not ${value.token}`); };

/** An array's entries may carry `fiat`; each is checked against the entry's USDC `amountKey`, then stripped for `base`. */
const entriesWithFiat = (value, key, amountKey, path, ctx) => (value[key] ?? []).map((entry, index) => {
  if (!entry || !("fiat" in entry)) return entry;
  const { fiat, ...rest } = entry;
  const at = `${path}.${key}[${index}]`;
  const errors = ctx.errors.length;
  fiatQuote(fiat, `${at}.fiat`, ctx);
  if (errors === ctx.errors.length) quoteGives(fiat, entry[amountKey], `${at}.fiat`, ctx);
  return rest;
});

/** Decimal string scaled to 12 places, for checking invoice lines priced in any currency. */
const scaled12 = (text) => toAtomic(text, 12);

Object.assign(shapes, {
  fiatCreateRequestReq: withFiat(shapes.createRequestReq, { currency: fiatCode }, usdcOnly),
  fiatCreateRequestRes: withFiat(shapes.createRequestRes, { amount: positiveAmount, fiat: fiatQuote }, (value, path, ctx) => {
    quoteGives(value.fiat, value.amount, `${path}.fiat`, ctx);
    const parsed = parseSolanaPayUrl(value.solana_pay_url);
    if (parsed.ok && parsed.amount !== value.amount) ctx.errors.push(`${path}.amount: ${value.amount} but the solana: URL asks ${parsed.amount}`);
  }),
  fiatGetRequestRes: withFiat(shapes.getRequestRes, { fiat: fiatQuote }, (value, path, ctx) => {
    usdcOnly(value, path, ctx);
    quoteGives(value.fiat, value.amount, `${path}.fiat`, ctx);
  }),
  fiatStatusRes: (value, path, ctx) => {
    if (kind(value) !== "object" || !Array.isArray(value.results)) return shapes.statusRes(value, path, ctx);
    const results = entriesWithFiat(value, "results", "amount_requested", path, ctx);
    shapes.statusRes({ ...value, results }, path, ctx);
  },
  fiatLedgerRes: (value, path, ctx) => {
    if (kind(value) !== "object") return shapes.ledgerRes(value, path, ctx);
    const open = entriesWithFiat(value, "open", "amount", path, ctx);
    const paid = entriesWithFiat(value, "paid_recently", "amount", path, ctx);
    shapes.ledgerRes({ ...value, open, paid_recently: paid }, path, ctx);
  },
  fiatCreateGroupReq: withFiat(shapes.createGroupReq, { currency: fiatCode }, usdcOnly),
  /** Each share's quote is its part of the bill at the board's one rate; `total` is the shares' USDC sum. */
  fiatGroupRes: (value, path, ctx) => {
    if (kind(value) !== "object" || !Array.isArray(value.shares)) return shapes.groupRes(value, path, ctx);
    const before = ctx.errors.length;
    const shares = entriesWithFiat(value, "shares", "amount", path, ctx);
    withFiat(shapes.groupRes, { fiat: fiatQuote }, () => {})({ ...value, shares }, path, ctx);
    if (before !== ctx.errors.length) return;
    usdcOnly(value, path, ctx);
    let fiatSum = 0n;
    value.shares.forEach((share, index) => {
      const q = share.fiat;
      if (!q) return void ctx.errors.push(`${path}.shares[${index}].fiat: missing on a local-currency split`);
      for (const key of ["currency", "rate", "rate_source", "quoted_at"]) {
        if (q[key] !== value.fiat[key]) ctx.errors.push(`${path}.shares[${index}].fiat.${key}: differs from the board's`);
      }
      fiatSum += scaled12(q.amount);
    });
    if (fiatSum !== scaled12(value.fiat.amount)) ctx.errors.push(`${path}.fiat.amount: ${value.fiat.amount} but the shares' amounts add up to ${fromAtomic(fiatSum, 12)}`);
  },
  fiatCreateInvoiceReq: withFiat(shapes.createInvoiceReq, { currency: fiatCode }, usdcOnly),
  /** Items are priced in fiat.currency and add up to fiat.amount; `total` is the USDC that quote locks. */
  fiatInvoiceRes: (value, path, ctx) => {
    if (kind(value) !== "object" || !Array.isArray(value.items)) return shapes.invoiceRes(value, path, ctx);
    const before = ctx.errors.length;
    // The original shape checks links, ids and the solana: URL against `total`; one synthetic line keeps its sum check true.
    const asUsdc = { ...value, items: [{ description: "total", quantity: "1", unit_price: value.total, amount: value.total }] };
    withFiat(shapes.invoiceRes, { fiat: fiatQuote }, () => {})(asUsdc, path, ctx);
    if (before !== ctx.errors.length || !value.fiat) return;
    usdcOnly(value, path, ctx);
    quoteGives(value.fiat, value.total, `${path}.fiat`, ctx);
    let sum = 0n;
    value.items.forEach((item, index) => {
      const at = `${path}.items[${index}]`;
      try {
        const line = scaled12(item.unit_price) * toAtomic(item.quantity, QUANTITY_DECIMALS);
        if (line % 10n ** BigInt(QUANTITY_DECIMALS) !== 0n || line / 10n ** BigInt(QUANTITY_DECIMALS) !== scaled12(item.amount)) {
          ctx.errors.push(`${at}.amount: ${item.amount}, but ${item.quantity} × ${item.unit_price} differs`);
        }
        sum += scaled12(item.amount);
      } catch (error) {
        ctx.errors.push(`${at}: ${error.message}`);
      }
    });
    if (sum !== scaled12(value.fiat.amount)) ctx.errors.push(`${path}.fiat.amount: ${value.fiat.amount} but the items add up to ${fromAtomic(sum, 12)}`);
  },
});

Object.assign(fixtureShapes, {
  "fiat.create-request.req.json": "fiatCreateRequestReq",
  "fiat.create-request.res.json": "fiatCreateRequestRes",
  "fiat.get-request.res.json": "fiatGetRequestRes",
  "fiat.status.res.json": "fiatStatusRes",
  "fiat.ledger.res.json": "fiatLedgerRes",
  "fiat.groups.create.req.json": "fiatCreateGroupReq",
  "fiat.groups.create.res.json": "fiatGroupRes",
  "fiat.invoices.create.req.json": "fiatCreateInvoiceReq",
  "fiat.invoices.create.res.json": "fiatInvoiceRes",
});

// ---------------------------------------------------------------------------------------------- W3-S SNS names
// A request created for an SNS name (bonfida.sns): same shapes, sns_* fields set. Captured from a local server.
Object.assign(fixtureShapes, {
  "sns.create-request.req.json": "createRequestReq",
  "sns.create-request.res.json": "createRequestRes",
  "sns.get-request.res.json": "getRequestRes",
});

// ---------------------------------------------------------------------------------------------- F1: payer inbox
// what_do_i_owe: POST /api/v1/inbox lists the open requests addressed to the wallet that signed
// "Owed inbox access for <payer> at <ISO>" (checked for real here); POST /api/v1/inbox/block hides one requester
// wallet ("Owed block <requester> for <payer> at <ISO>", or unblock). pay_all reads every request's terms at once
// with GET /api/v1/requests?ids=, each in the getRequestRes shape. Fixtures: contract/inbox-fixtures.mjs.

const INBOX_CAUTION_RE = /^Anyone can address a request to your wallet/;
const anyWallet = string({ test: (t) => isPubkey(t) || EVM_ADDRESS_RE.test(t), label: "a base58 32-byte key or a 0x address (Base)" });

function signedAs(lead, signer, value, path, ctx) {
  if (!value.signed_message.startsWith(lead) || !LEDGER_ISO.test(value.signed_message.slice(lead.length))) {
    return void ctx.errors.push(`${path}.signed_message: must read "${lead}<UTC time>"`);
  }
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(value.signature) && !ed25519Verifies(value.signed_message, value.signature, signer)) {
    ctx.errors.push(`${path}.signature: does not verify for ${signer} over signed_message`);
  }
}

const inboxEntry = object({
  id, kind: oneOf("single", "split_share", "invoice"), link: httpsUrl, status: oneOf("open", "underpaid"),
  amount: positiveAmount, amount_due: positiveAmount, token, chain: oneOf("solana", "base"), recipient: anyWallet,
  requester_name: untrusted(40), requester_handle: nullable(handle), for: untrusted(80),
  from_domain: nullable(domain), sns_name: nullable(snsName), created_at: iso, expires_at: nullable(iso),
  due_date: nullable(invoiceDate), invoice_number: untrusted(20), group_title: untrusted(60),
  addressed_as: object({ handle: nullable(handle), sns: nullable(snsName) }), first_time: oneOf(true, false), flags: array(flag, { max: 32 }),
  fiat: optional(fiatQuote),
}, (value, path, ctx) => {
  decimalsFit("amount")(value, path, ctx);
  const page = value.kind === "invoice" ? "i" : "r";
  if (!new URL(value.link).pathname.endsWith(`/${page}/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /${page}/${value.id}`);
  if ((value.kind === "invoice") !== (value.due_date !== null)) ctx.errors.push(`${path}.due_date: ${value.kind === "invoice" ? "missing" : "set"} for kind ${value.kind}`);
  if (value.kind !== "invoice" && value.invoice_number !== null) ctx.errors.push(`${path}.invoice_number: set for kind ${value.kind}`);
  if (value.kind !== "split_share" && value.group_title !== null) ctx.errors.push(`${path}.group_title: set for kind ${value.kind}`);
  if (value.chain === "base" && (value.token !== "USDC" || !EVM_ADDRESS_RE.test(value.recipient))) ctx.errors.push(`${path}: a Base entry pays USDC to a 0x address`);
  if (value.chain === "solana" && !isPubkey(value.recipient)) ctx.errors.push(`${path}.recipient: a Solana entry pays a base58 wallet`);
  const decimals = TOKEN_DECIMALS[value.token];
  try {
    const amount = toAtomic(value.amount, decimals);
    const due = toAtomic(value.amount_due, decimals);
    if (value.status === "open" && due !== amount) ctx.errors.push(`${path}.amount_due: open but differs from amount`);
    if (value.status === "underpaid" && due >= amount) ctx.errors.push(`${path}.amount_due: underpaid but not less than amount`);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
});

function inboxConsistent(value, path, ctx) {
  value.owed.forEach((e, i) => { if (e.chain !== "solana") ctx.errors.push(`${path}.owed[${i}]: a ${e.chain} entry belongs in base`); });
  value.base.forEach((e, i) => { if (e.chain !== "base") ctx.errors.push(`${path}.base[${i}]: a ${e.chain} entry belongs in owed`); });
  const seen = new Set();
  for (const t of value.totals) {
    const k = `${t.chain}:${t.token}`;
    if (seen.has(k)) ctx.errors.push(`${path}.totals: ${k} listed twice`);
    seen.add(k);
  }
  const all = [...value.owed, ...value.base];
  for (const e of all) if (!seen.has(`${e.chain}:${e.token}`)) ctx.errors.push(`${path}.totals: no total for ${e.chain} ${e.token}`);
  if (value.truncated) return;
  for (const t of value.totals) {
    const mine = all.filter((e) => e.chain === t.chain && e.token === t.token);
    const decimals = TOKEN_DECIMALS[t.token];
    const sum = mine.reduce((n, e) => n + toAtomic(e.amount_due, decimals), 0n);
    if (t.count !== mine.length) ctx.errors.push(`${path}.totals.${t.chain}:${t.token}.count: ${t.count}, ${mine.length} entries listed`);
    if (toAtomic(t.amount_due, decimals) !== sum) ctx.errors.push(`${path}.totals.${t.chain}:${t.token}.amount_due: not the sum of amount_due`);
  }
  const ids = all.map((e) => e.id);
  if (new Set(ids).size !== ids.length) ctx.errors.push(`${path}: an entry is listed twice`);
}

const inboxRes = object({
  payer: pubkey, caution: string({ max: 400, pattern: INBOX_CAUTION_RE, label: "the inbox caution" }), generated_at: iso,
  chain_checked: oneOf(true, false), owed: array(inboxEntry, { max: 100 }), base: array(inboxEntry, { max: 100 }),
  totals: array(object({ token, chain: oneOf("solana", "base"), amount_due: amount, count: integer() }), { max: 3 }),
  blocked_hidden: integer(), blocked_requesters: array(anyWallet, { max: 50 }), truncated: oneOf(true, false),
}, inboxConsistent);

Object.assign(shapes, {
  inboxReq: object({ payer: pubkey, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) },
    (value, path, ctx) => signedAs(`Owed inbox access for ${value.payer} at `, value.payer, value, path, ctx)),
  inboxRes,
  inboxBlockReq: object({
    payer: pubkey, requester: anyWallet, action: oneOf("block", "unblock"),
    signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }),
  }, (value, path, ctx) => {
    signedAs(`Owed ${value.action} ${value.requester} for ${value.payer} at `, value.payer, value, path, ctx);
    if (value.requester === value.payer) ctx.errors.push(`${path}.requester: the payer's own wallet`);
  }),
  inboxBlockRes: object({
    payer: pubkey, requester: anyWallet, action: oneOf("block", "unblock"), blocked: oneOf(true, false), changed: oneOf(true, false), inbox: inboxRes,
  }, (value, path, ctx) => {
    if (value.blocked !== (value.action === "block")) ctx.errors.push(`${path}.blocked: ${value.blocked} after ${value.action}`);
    if (value.inbox.payer !== value.payer) ctx.errors.push(`${path}.inbox.payer: differs from payer`);
    const listed = value.inbox.blocked_requesters.includes(value.requester);
    if (listed !== value.blocked) ctx.errors.push(`${path}.inbox.blocked_requesters: ${listed ? "lists" : "misses"} the requester after ${value.action}`);
    for (const e of [...value.inbox.owed, ...value.inbox.base]) if (value.blocked && e.recipient === value.requester) ctx.errors.push(`${path}.inbox: still lists ${e.id} from the blocked requester`);
  }),
  bulkRequestsRes: object({
    requests: array(object(getRequestFields, getRequestConsistent), { max: 20 }), not_found: array(id, { max: 20 }),
  }, (value, path, ctx) => {
    const ids = [...value.requests.map((r) => r.id), ...value.not_found];
    if (new Set(ids).size !== ids.length) ctx.errors.push(`${path}: an id is listed twice`);
    if (ids.length > 20) ctx.errors.push(`${path}: more than 20 ids`);
  }),
});

Object.assign(fixtureShapes, {
  "payer.create-request.req.json": "createRequestReq",
  "payer.create-request.res.json": "createRequestRes",
  "payer.get-request.res.json": "getRequestRes",
  "payer.groups.create.req.json": "createGroupReq",
  "payer.groups.create.res.json": "groupRes",
  "payer.invoices.create.req.json": "createInvoiceReq",
  "payer.invoices.create.res.json": "invoiceRes",
  "payer.schedules.create.req.json": "createScheduleReq",
  "payer.schedules.create.res.json": "scheduleRes",
  "inbox.req.json": "inboxReq",
  "inbox.res.json": "inboxRes",
  "inbox.block.req.json": "inboxBlockReq",
  "inbox.block.res.json": "inboxBlockRes",
  "requests.bulk.res.json": "bulkRequestsRes",
});

// ---------------------------------------------------------------------------------------------- F2: funding plans
// When a sender's wallet can't cover a payment, pay_link / pay_all return a funding plan: the exact PayBox calls that
// fix it, in the tool's text as a ```json block ({"funding_plan": …}, shape fundingPlanDoc). POST /api/v1/plans
// records that a plan was offered (no balances), POST /api/v1/plans/<id>/used that its final call proposed the payment,
// GET /api/v1/plans/stats counts offered / used / paid. Fixtures: plugin/test (pay_link_f2, pay_all_f2) write the
// funding-plan.* files from the real planner (OWED_WRITE_PLAN_FIXTURES=1) and fail when they drift.

export const PLAN_OPTION_KINDS = ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc", "x402", "swap_usdc_for_sol", "buy_sol"];
export const MOONPAY_MIN_USD = 4.99;
const planId = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 plan id" });
const planKind = oneOf(...PLAN_OPTION_KINDS);
const positiveAtomic = string({ max: 31, pattern: /^[1-9][0-9]*$/, label: "a positive whole number of atomic units" });
const anyAtomicText = string({ max: 31, pattern: /^(0|[1-9][0-9]*)$/, label: "a whole number of atomic units" });
const PLAN_TOOL = oneOf("pay_link", "pay_all");
const unique = (key) => (value, path, ctx) => {
  if (new Set(value[key]).size !== value[key].length) ctx.errors.push(`${path}.${key}: lists an entry twice`);
};

const planAmount = object({ token, atomic: anyAtomicText, display: string({ max: 60 }) }, (value, path, ctx) => {
  const want = `${fromAtomic(BigInt(value.atomic), TOKEN_DECIMALS[value.token])} ${value.token}`;
  if (value.display !== want) ctx.errors.push(`${path}.display: ${show(value.display)} is not ${show(want)}`);
});
const planStepFields = {
  via: oneOf("paybox", "owed"), tool: string({ min: 1, max: 40 }),
  args: (value, path, ctx) => { if (kind(value) !== "object") ctx.errors.push(`${path}: expected object, got ${kind(value)}`); },
  credential_of: nullable(string({ max: 64 })), missing: optional(array(string({ max: 40 }), { max: 8 })), why: string({ min: 1, max: 800 }),
};
const planStep = object(planStepFields);
const planOption = object({ ...planStepFields, kind: planKind, check: optional(planStep), then: array(planStep, { max: 4 }) });

/** Which PayBox (or Owed) tool each kind of option starts with. */
const KIND_TOOL = { swap_sol: "request_swap", bridge_base_usdc: "request_swap", swap_other: "get_portfolio", buy_usdc: "get_buy_link", swap_usdc_for_sol: "request_swap", buy_sol: "get_buy_link" };

function planConsistent(plan, path, ctx) {
  const err = (where, message) => ctx.errors.push(`${path}${where}: ${message}`);
  const kinds = plan.options.map((o) => o.kind);
  if (new Set(kinds).size !== kinds.length) err(".options", "lists a kind twice");
  if (plan.pay_tool === "pay_all" && plan.request_ids.length === 0) err(".request_ids", "a pay_all plan names its requests");
  if (new Set(plan.request_ids).size !== plan.request_ids.length) err(".request_ids", "lists an id twice");
  if (BigInt(plan.shortfall.atomic) === 0n) err(".shortfall.atomic", "a plan is for something short");
  const need = plan.need.find((n) => n.token === plan.shortfall.token);
  if (!need || BigInt(need.atomic) < BigInt(plan.shortfall.atomic)) err(".need", `doesn't cover the ${plan.shortfall.token} shortfall`);
  plan.options.forEach((o, i) => {
    const at = `.options[${i}]`;
    const expectTool = o.kind === "x402" ? plan.pay_tool : KIND_TOOL[o.kind];
    if (o.tool !== expectTool) err(`${at}.tool`, `${show(o.tool)} for kind ${o.kind}, expected ${expectTool}`);
    if ((o.via === "owed") !== (o.kind === "x402")) err(`${at}.via`, `${o.via} for kind ${o.kind}`);
    // Every option ends with the pay call again, for this sender, carrying the plan's id.
    const last = o.then.length ? o.then[o.then.length - 1] : o;
    if (last.via !== "owed" || last.tool !== plan.pay_tool) err(at, `doesn't end with ${plan.pay_tool}`);
    else {
      if (last.args.sender !== plan.sender) err(at, "its pay step pays from another wallet");
      if (plan.plan_id !== null && last.args.plan_id !== plan.plan_id) err(at, "its pay step doesn't carry the plan_id");
      if (plan.pay_tool === "pay_all" && last.args.rail !== undefined) err(at, "pay_all has no rail");
    }
    for (const s of [o, ...o.then]) if (s.via === "owed" && s.tool !== plan.pay_tool) err(at, `calls Owed's ${s.tool}`);
    const a = o.args;
    const swapArgs = (want) => {
      for (const [k, v] of Object.entries(want)) if (a[k] !== v) err(`${at}.args.${k}`, `${show(a[k])}, expected ${show(v)}`);
      if (a.amount === undefined ? !(o.missing ?? []).includes("amount") : !/^[1-9][0-9]*$/.test(a.amount)) err(`${at}.args.amount`, "a positive atomic amount, or listed in missing");
    };
    if (o.kind === "swap_sol") swapArgs({ src_chain: "solana:mainnet", src_token: "native", dst_token: USDC_MINT });
    if (o.kind === "swap_usdc_for_sol") swapArgs({ src_chain: "solana:mainnet", src_token: USDC_MINT, dst_token: "native" });
    if (o.kind === "bridge_base_usdc") {
      swapArgs({ src_chain: "eip155:8453", src_token: BASE_USDC, dst_chain: "solana:mainnet", dst_token: USDC_MINT, recipient: plan.sender });
      if (o.credential_of !== "base_wallet") err(`${at}.credential_of`, "a bridge spends from the user's Base wallet");
      if (o.check?.tool !== "get_portfolio") err(`${at}.check`, "Owed can't read Base: get_portfolio checks first");
    }
    if (o.kind === "buy_usdc" || o.kind === "buy_sol") {
      if (o.kind === "buy_usdc" && a.currency_code !== "usdc_sol") err(`${at}.args.currency_code`, `${show(a.currency_code)}, expected "usdc_sol"`);
      if (o.kind === "buy_sol" && a.currency_code !== undefined) err(`${at}.args.currency_code`, "native SOL takes no currency_code");
      if (a.amount_usd === undefined) {
        if (!(o.missing ?? []).includes("amount_usd")) err(`${at}.args.amount_usd`, "missing and not listed in missing");
      } else if (typeof a.amount_usd !== "number" || !/^\d+(\.\d{1,2})?$/.test(String(a.amount_usd)) || a.amount_usd < MOONPAY_MIN_USD) {
        err(`${at}.args.amount_usd`, `${show(a.amount_usd)} is not whole cents of at least ${MOONPAY_MIN_USD} (MoonPay's minimum)`);
      }
    }
    if (o.kind === "x402") {
      if (plan.pay_tool !== "pay_link") err(at, "only pay_link pays over x402");
      if (a.rail !== "x402") err(`${at}.args.rail`, "the x402 option pays with rail x402");
      if (plan.shortfall.token !== "SOL") err(at, "x402 only fixes a SOL (fee) shortfall");
    }
  });
}

const fundingPlan = object({
  plan_id: nullable(planId), pay_tool: PLAN_TOOL, request_ids: array(id, { max: 20 }), sender: anyWallet,
  shortfall: planAmount, have: array(planAmount, { max: 2 }), need: array(planAmount, { max: 2 }), options: array(planOption, { min: 1, max: 8 }),
}, planConsistent);

Object.assign(shapes, {
  createPlanReq: object({
    tool: PLAN_TOOL, sender: anyWallet, request_ids: array(id, { max: 20 }),
    shortfall: object({ token, atomic: positiveAtomic }), options: array(planKind, { min: 1, max: 8 }),
  }, (value, path, ctx) => {
    unique("request_ids")(value, path, ctx);
    unique("options")(value, path, ctx);
    if (value.tool === "pay_all" && value.request_ids.length === 0) ctx.errors.push(`${path}.request_ids: a pay_all plan names its requests`);
  }),
  createPlanRes: object({ plan_id: planId, created_at: iso }),
  planUsedReq: object({ sender: anyWallet }),
  planUsedRes: object({ plan_id: planId, used_at: iso, already_used: oneOf(true, false) }),
  planStatsRes: object({ offered: integer(), used: integer(), paid: integer(), since: iso }, (value, path, ctx) => {
    if (value.used > value.offered) ctx.errors.push(`${path}.used: more than offered`);
    if (value.paid > value.offered) ctx.errors.push(`${path}.paid: more than offered`);
  }),
  fundingPlanDoc: object({ funding_plan: fundingPlan }),
});

Object.assign(fixtureShapes, {
  "plans.create.req.json": "createPlanReq",
  "plans.create.res.json": "createPlanRes",
  "plans.used.req.json": "planUsedReq",
  "plans.used.res.json": "planUsedRes",
  "plans.stats.res.json": "planStatsRes",
  "funding-plan.swap.json": "fundingPlanDoc",
  "funding-plan.buy.json": "fundingPlanDoc",
  "funding-plan.fee.json": "fundingPlanDoc",
  "funding-plan.pay-all.json": "fundingPlanDoc",
});

// ---------------------------------------------------------------------------------------------- F6 ledger
// Group ledgers: POST /api/v1/ledgers, GET /api/v1/ledgers/<id>, POST .../expenses, POST .../settle. Every write is
// signed by a wallet named in the ledger, over "Owed add expense <digest> (<total> <currency>) to ledger <id> by
// <signer> at <ISO>" or "Owed settle up ledger <id> v<version>: <n> requests, <total> USDC by <signer> at <ISO>".
// These shapes re-derive everything a ledger reply claims, with their own code: each expense's digest (a third copy
// of plugin/src/ledger-math.ts expenseDigest) and signature, its split adding up (USDC shares rounded up from a
// local currency at the one rate), every balance from the expenses and the live statuses of the settle-up requests,
// and the greedy plan. Fixtures: contract/ledger-fixtures.mjs.

const glId = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char base58 ledger id" });
const glMember = (value, path, ctx) => {
  if (!Number.isInteger(value) || value < 0 || value > 19) ctx.errors.push(`${path}: expected a member position 0..19, got ${show(value)}`);
};
const glSigned = string({ max: 41, pattern: /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, test: (t) => t !== "-0", label: "a signed decimal amount" });
const glCurrency = string({ pattern: /^(USDC|[A-Z]{3})$/, test: (t) => t !== "USD", label: "USDC or an ISO 4217 code other than USD" });
const glSplit = oneOf("even", "shares", "exact", "items");
const GL_ZERO_DECIMAL = new Set(["CLP", "JPY", "KRW", "VND", "XOF"]);
const glDecimals = (currency) => (currency === "USDC" ? 6 : GL_ZERO_DECIMAL.has(currency) ? 0 : 2);
const glUnits = (amount, decimals) => toAtomic(amount, decimals);
const glText = (max) => nullable(string({ min: 1, max, test: (t) => !/[\u0000-\u001f\u007f-\u009f"<>[\]{}`\\@]/.test(t) && !/(:\/\/|www\.)/i.test(t), label: "cleaned text" }));
const GL_SIGNED_ISO = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z)";

/** 16 hex characters of sha256 over an expense in the fixed order plugin/src/ledger-math.ts expenseDigest uses. */
export function groupLedgerExpenseDigest(ledgerId, e) {
  const canonical = JSON.stringify([
    "owed-ledger-expense:v1", ledgerId, e.description, e.paidBy, e.currency, String(e.totalUnits), e.split,
    e.among ?? null,
    e.shares ? e.shares.map((s) => [s.member, String(s.weight)]) : null,
    e.amounts ? e.amounts.map((a) => [a.member, String(a.units)]) : null,
    e.items ? e.items.map((i) => [i.description, String(i.units), i.members]) : null,
    e.taxUnits == null ? null : String(e.taxUnits), e.tipUnits == null ? null : String(e.tipUnits),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** Greedy settle-up: largest debtor pays largest creditor, ties to the earlier member (lib/ledgers-math.ts planSettlement). */
export function groupLedgerPlan(toSettle) {
  const left = [...toSettle];
  const out = [];
  const pick = (sign) => {
    let best = -1;
    for (let i = 0; i < left.length; i++) if (left[i] * sign > 0n && (best === -1 || left[i] * sign > left[best] * sign)) best = i;
    return best;
  };
  for (;;) {
    const d = pick(-1n);
    const c = pick(1n);
    if (d === -1 || c === -1) return out;
    const amount = -left[d] < left[c] ? -left[d] : left[c];
    out.push({ from: d, to: c, amountAtomic: amount });
    left[d] += amount;
    left[c] -= amount;
  }
}

const glSignedStr = (atomic) => (atomic < 0n ? `-${fromAtomic(-atomic, 6)}` : fromAtomic(atomic, 6));
const glPlain = (atomic) => fromAtomic(atomic, 6);

function glExpenseConsistent(ledger, e, path, ctx) {
  const n = ledger.members.length;
  const d = glDecimals(e.currency);
  if (e.paid_by >= n) ctx.errors.push(`${path}.paid_by: no member ${e.paid_by}`);
  const members = e.shares.map((s) => s.member);
  if (members.some((m, i) => m >= n || (i > 0 && m <= members[i - 1]))) ctx.errors.push(`${path}.shares: members must be ascending ledger positions`);
  if ((e.currency === "USDC") !== (e.fiat === null)) ctx.errors.push(`${path}.fiat: ${e.currency === "USDC" ? "set on a USDC expense" : "missing on a local-currency expense"}`);
  if (e.fiat && (e.fiat.currency !== e.currency || e.fiat.amount !== e.total)) ctx.errors.push(`${path}.fiat: not this expense's currency and total`);
  if ((e.split === "items") !== (e.items !== null)) ctx.errors.push(`${path}.items: ${e.split === "items" ? "missing" : "set"} for split ${e.split}`);
  if (e.split !== "items" && (e.tax !== null || e.tip !== null)) ctx.errors.push(`${path}: tax and tip go with split items only`);
  if ((e.split === "shares") !== e.shares.every((s) => s.weight !== null)) ctx.errors.push(`${path}.shares: weights are ${e.split === "shares" ? "missing" : "set"} for split ${e.split}`);
  try {
    const total = glUnits(e.total, d);
    let shareSum = 0n;
    let usdcSum = 0n;
    for (const [i, s] of e.shares.entries()) {
      const units = glUnits(s.share, d);
      const atomic = toAtomic(s.amount, 6);
      shareSum += units;
      usdcSum += atomic;
      const expected = e.currency === "USDC" ? units : units === 0n ? 0n : usdcAtomicForQuote({ amount: s.share, rate: e.fiat?.rate ?? "1" });
      if (atomic !== expected) ctx.errors.push(`${path}.shares[${i}].amount: ${s.amount} USDC, but ${s.share} ${e.currency} gives ${glPlain(expected)}`);
    }
    if (shareSum !== total) ctx.errors.push(`${path}.shares: add up to ${fromAtomic(shareSum, d)} ${e.currency}, not the total ${e.total}`);
    if (usdcSum !== toAtomic(e.amount, 6)) ctx.errors.push(`${path}.amount: ${e.amount} USDC, but the shares add up to ${glPlain(usdcSum)}`);
    if (e.split === "items") {
      const items = e.items.reduce((a, i) => a + glUnits(i.amount, d), 0n);
      const extras = (e.tax === null ? 0n : glUnits(e.tax, d)) + (e.tip === null ? 0n : glUnits(e.tip, d));
      if (items + extras !== total) ctx.errors.push(`${path}.items: plus tax and tip add up to ${fromAtomic(items + extras, d)}, not ${e.total}`);
    }
    const digest = groupLedgerExpenseDigest(ledger.id, {
      description: e.description, paidBy: e.paid_by, currency: e.currency, totalUnits: total, split: e.split,
      among: e.split === "even" ? members : null,
      shares: e.split === "shares" ? e.shares.map((s) => ({ member: s.member, weight: toAtomic(s.weight, 4) })) : null,
      amounts: e.split === "exact" ? e.shares.map((s) => ({ member: s.member, units: glUnits(s.share, d) })) : null,
      items: e.items ? e.items.map((i) => ({ description: i.description, units: glUnits(i.amount, d), members: i.members })) : null,
      taxUnits: e.tax === null ? null : glUnits(e.tax, d), tipUnits: e.tip === null ? null : glUnits(e.tip, d),
    });
    if (!ledger.members.some((m) => m.wallet === e.recorded_by)) ctx.errors.push(`${path}.recorded_by: not a wallet in this ledger`);
    signedAs(`Owed add expense ${digest} (${e.total} ${e.currency}) to ledger ${ledger.id} by ${e.recorded_by} at `, e.recorded_by, e, path, ctx);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
}

function glConsistent(value, path, ctx) {
  const n = value.members.length;
  if (!new URL(value.link).pathname.endsWith(`/l/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /l/${value.id}`);
  value.members.forEach((m, i) => {
    if (m.position !== i) ctx.errors.push(`${path}.members[${i}].position: ${m.position}`);
    if (m.wallet === null && (m.handle !== null || m.sns !== null)) ctx.errors.push(`${path}.members[${i}]: a handle or SNS name without its wallet`);
  });
  if (value.members[0]?.wallet !== value.owner) ctx.errors.push(`${path}.members[0].wallet: is not the owner`);
  const wallets = value.members.map((m) => m.wallet).filter(Boolean);
  if (new Set(wallets).size !== wallets.length) ctx.errors.push(`${path}.members: a wallet is listed twice`);
  value.expenses.forEach((e, i) => {
    if (e.position !== i) ctx.errors.push(`${path}.expenses[${i}].position: ${e.position}`);
    glExpenseConsistent(value, e, `${path}.expenses[${i}]`, ctx);
  });
  if (ctx.errors.length) return;
  // Balances, from the expenses and the settle-up requests' statuses.
  const b = value.members.map(() => ({ paid: 0n, share: 0n, sent: 0n, received: 0n, pendingOut: 0n, pendingIn: 0n }));
  let spent = 0n;
  for (const e of value.expenses) {
    const amount = toAtomic(e.amount, 6);
    spent += amount;
    b[e.paid_by].paid += amount;
    for (const s of e.shares) b[s.member].share += toAtomic(s.amount, 6);
  }
  let open = 0;
  const seen = new Set();
  for (const [r, s] of value.settlements.entries()) {
    const at = `${path}.settlements[${r}]`;
    let total = 0n;
    for (const [i, t] of s.transfers.entries()) {
      const amount = toAtomic(t.amount, 6);
      total += amount;
      if (t.from === t.to || t.from >= n || t.to >= n) ctx.errors.push(`${at}.transfers[${i}]: from ${t.from} to ${t.to}`);
      if (seen.has(t.request_id)) ctx.errors.push(`${at}.transfers[${i}].request_id: listed twice`);
      seen.add(t.request_id);
      if (!new URL(t.link).pathname.endsWith(`/r/${t.request_id}`)) ctx.errors.push(`${at}.transfers[${i}].link: does not end in /r/${t.request_id}`);
      if (t.addressed && value.members[t.from]?.wallet === null) ctx.errors.push(`${at}.transfers[${i}].addressed: the debtor has no wallet`);
      if ((t.paid !== null) !== (t.status === "paid" || t.status === "underpaid")) ctx.errors.push(`${at}.transfers[${i}].paid: ${t.paid ? "set" : "missing"} for status ${t.status}`);
      const moved = t.status === "paid" ? amount : t.status === "underpaid" ? toAtomic(t.paid.amount, 6) : 0n;
      const pending = t.status === "open" ? amount : 0n;
      if (pending > 0n) open += 1;
      b[t.from].sent += moved;
      b[t.to].received += moved;
      b[t.from].pendingOut += pending;
      b[t.to].pendingIn += pending;
    }
    if (!value.members.some((m) => m.wallet === s.recorded_by)) ctx.errors.push(`${at}.recorded_by: not a wallet in this ledger`);
    const k = s.transfers.length;
    signedAs(`Owed settle up ledger ${value.id} v${s.round}: ${k} ${k === 1 ? "request" : "requests"}, ${glPlain(total)} USDC by ${s.recorded_by} at `, s.recorded_by, s, at, ctx);
    if (r > 0 && s.round <= value.settlements[r - 1].round) ctx.errors.push(`${at}.round: not after the previous settle-up`);
  }
  const toSettle = [];
  let netSum = 0n;
  value.balances.forEach((x, i) => {
    const at = `${path}.balances[${i}]`;
    if (x.member !== i) return void ctx.errors.push(`${at}.member: ${x.member}`);
    const want = b[i];
    const net = want.paid - want.share + want.sent - want.received;
    const settle = net + want.pendingOut - want.pendingIn;
    netSum += net;
    toSettle.push(settle);
    const got = { paid: x.paid, share: x.share, sent: x.sent, received: x.received, pending_out: x.pending_out, pending_in: x.pending_in, net: x.net, to_settle: x.to_settle };
    const expected = {
      paid: glPlain(want.paid), share: glPlain(want.share), sent: glPlain(want.sent), received: glPlain(want.received),
      pending_out: glPlain(want.pendingOut), pending_in: glPlain(want.pendingIn), net: glSignedStr(net), to_settle: glSignedStr(settle),
    };
    for (const k of Object.keys(expected)) if (got[k] !== expected[k]) ctx.errors.push(`${at}.${k}: ${got[k]}, the expenses and requests give ${expected[k]}`);
  });
  if (value.balances.length !== n) ctx.errors.push(`${path}.balances: ${value.balances.length} for ${n} members`);
  if (netSum !== 0n) ctx.errors.push(`${path}.balances: nets add up to ${glSignedStr(netSum)}, not 0`);
  const plan = groupLedgerPlan(toSettle).map((t) => ({ from: t.from, to: t.to, amount: glPlain(t.amountAtomic), payable: value.members[t.to].wallet !== null }));
  if (JSON.stringify(plan) !== JSON.stringify(value.plan)) ctx.errors.push(`${path}.plan: ${JSON.stringify(value.plan)}, the balances give ${JSON.stringify(plan)}`);
  if (plan.length > Math.max(0, n - 1)) ctx.errors.push(`${path}.plan: more than n - 1 transfers`);
  if (value.totals.spent !== glPlain(spent)) ctx.errors.push(`${path}.totals.spent: ${value.totals.spent}, the expenses add up to ${glPlain(spent)}`);
  if (value.totals.expense_count !== value.expenses.length) ctx.errors.push(`${path}.totals.expense_count: ${value.totals.expense_count}`);
  if (value.totals.open_requests !== open) ctx.errors.push(`${path}.totals.open_requests: ${value.totals.open_requests}, ${open} are open`);
  const latest = [...value.expenses].reverse().find((e) => e.fiat);
  const beside = latest ? { currency: latest.fiat.currency, rate: latest.fiat.rate, rate_source: latest.fiat.rate_source, quoted_at: latest.fiat.quoted_at } : null;
  if (JSON.stringify(beside) !== JSON.stringify(value.fiat_beside)) ctx.errors.push(`${path}.fiat_beside: not the latest local-currency expense's quote`);
  const square = value.expenses.length > 0 && b.every((x, i) => x.pendingIn === 0n && x.pendingOut === 0n && toSettle[i] === 0n);
  if (value.settled !== square) ctx.errors.push(`${path}.settled: ${value.settled}`);
}

const glPaid = object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402", "matched", "moonpay_card") });
const glRes = object({
  id: glId, link: httpsUrl, title: string({ min: 1, max: 240 }), owner: pubkey, created_at: iso, version: integer(), flags: array(flag, { max: 32 }),
  caution: string({ max: 400, pattern: /^Names, descriptions and amounts are written by whoever recorded them/, label: "the ledger caution" }),
  members: array(object({ position: glMember, name: string({ min: 1, max: 160 }), wallet: nullable(pubkey), handle: nullable(handle), sns: nullable(snsName) }), { min: 2, max: 20 }),
  expenses: array(object({
    position: integer(), description: glText(320), paid_by: glMember, split: glSplit, currency: glCurrency, total: positiveAmount, amount: positiveAmount,
    tax: nullable(positiveAmount), tip: nullable(positiveAmount), fiat: nullable(fiatQuote),
    items: nullable(array(object({ description: glText(240), amount: positiveAmount, members: array(glMember, { min: 1, max: 20 }) }), { min: 1, max: 30 })),
    shares: array(object({ member: glMember, weight: nullable(positiveAmount), share: amount, amount }), { min: 1, max: 20 }),
    recorded_by: pubkey, recorded_at: iso, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }), flags: array(flag, { max: 32 }),
  }), { max: 100 }),
  balances: array(object({
    member: glMember, paid: amount, share: amount, sent: amount, received: amount, net: glSigned, pending_out: amount, pending_in: amount, to_settle: glSigned,
  }), { min: 2, max: 20 }),
  plan: array(object({ from: glMember, to: glMember, amount: positiveAmount, payable: oneOf(true, false) }), { max: 19 }),
  settlements: array(object({
    round: integer(), recorded_by: pubkey, recorded_at: iso, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }),
    transfers: array(object({
      position: integer(), from: glMember, to: glMember, amount: positiveAmount, request_id: id, link: httpsUrl,
      status: oneOf("open", "paid", "underpaid", "cancelled", "expired"), paid: nullable(glPaid), addressed: oneOf(true, false),
    }), { min: 1, max: 19 }),
  }), { max: 50 }),
  totals: object({ spent: amount, expense_count: integer(), open_requests: integer() }),
  fiat_beside: nullable(object({ currency: fiatCode, rate: positiveAmount, rate_source: string({ min: 1, max: 120 }), quoted_at: iso })),
  settled: oneOf(true, false), chain_checked: oneOf(true, false),
}, glConsistent);

/** An expense body's digest, recomputed from the body (its text must already be clean) and the ledger id it signs for. */
function glExpenseSigned(value, path, ctx) {
  const m = new RegExp(`^Owed add expense ([0-9a-f]{16}) \\((\\S+) (\\S+)\\) to ledger ([1-9A-HJ-NP-Za-km-z]{12}) by (\\S+) at ${GL_SIGNED_ISO}$`).exec(value.signed_message);
  if (!m) return void ctx.errors.push(`${path}.signed_message: must read "Owed add expense <digest> (<total> <currency>) to ledger <id> by <signer> at <UTC time>"`);
  const [, digest, total, currency, ledgerId, by] = m;
  const code = value.currency ?? "USDC";
  const d = glDecimals(code);
  try {
    if (by !== value.signer) ctx.errors.push(`${path}.signed_message: signed for ${by}, not the signer`);
    if (currency !== code || toAtomic(total, d) !== glUnits(value.amount, d)) ctx.errors.push(`${path}.signed_message: names ${total} ${currency}, not the body's ${value.amount} ${code}`);
    const n = 1 + Math.max(value.paid_by, ...(value.among ?? []), ...(value.shares ?? []).map((s) => s.member), ...(value.amounts ?? []).map((a) => a.member), ...(value.items ?? []).flatMap((i) => i.members));
    const want = groupLedgerExpenseDigest(ledgerId, {
      description: value.description ?? null, paidBy: value.paid_by, currency: code, totalUnits: glUnits(value.amount, d), split: value.split,
      among: value.split === "even" ? (value.among ?? Array.from({ length: n }, (_, i) => i)) : null,
      shares: value.shares ? value.shares.map((s) => ({ member: s.member, weight: toAtomic(s.shares, 4) })) : null,
      amounts: value.amounts ? value.amounts.map((a) => ({ member: a.member, units: glUnits(a.amount, d) })) : null,
      items: value.items ? value.items.map((i) => ({ description: i.description ?? null, units: glUnits(i.amount, d), members: i.members })) : null,
      taxUnits: value.tax ? glUnits(value.tax, d) : null, tipUnits: value.tip ? glUnits(value.tip, d) : null,
    });
    // An even split over everyone names no `among`; the digest then lists every member, which a body alone can't
    // count when the highest position isn't named. Only a body that names its members is checked here.
    if ((value.split !== "even" || value.among) && want !== digest) ctx.errors.push(`${path}.signed_message: digest ${digest}, the body gives ${want}`);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
  signedAs(value.signed_message.slice(0, value.signed_message.lastIndexOf(" at ") + 4), value.signer, value, path, ctx);
}

Object.assign(shapes, {
  groupLedgerCreateReq: object({
    title: string({ min: 1, max: 240 }), owner: pubkey, owner_name: string({ min: 1, max: 160 }),
    members: array(object({ name: string({ min: 1, max: 160 }), payer: optional(payerReq) }), { min: 1, max: 19 }), source: oneOf("plugin", "web"),
  }),
  groupLedgerRes: glRes,
  groupLedgerExpenseReq: object({
    signer: pubkey, description: optional(string({ min: 1, max: 320 })), paid_by: glMember, amount: positiveAmount, currency: optional(glCurrency), split: glSplit,
    among: optional(array(glMember, { min: 1, max: 20 })),
    shares: optional(array(object({ member: glMember, shares: positiveAmount }), { min: 1, max: 20 })),
    amounts: optional(array(object({ member: glMember, amount: positiveAmount }), { min: 1, max: 20 })),
    items: optional(array(object({ description: optional(string({ min: 1, max: 240 })), amount: positiveAmount, members: array(glMember, { min: 1, max: 20 }) }), { min: 1, max: 30 })),
    tax: optional(positiveAmount), tip: optional(positiveAmount), signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }),
  }, glExpenseSigned),
  groupLedgerExpenseRes: object({ added: integer(), ledger: glRes }, (value, path, ctx) => {
    if (value.added !== value.ledger.expenses.length - 1) ctx.errors.push(`${path}.added: ${value.added}, but the ledger's last expense is ${value.ledger.expenses.length - 1}`);
  }),
  groupLedgerSettleReq: object({ signer: pubkey, version: integer(), signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) }, (value, path, ctx) => {
    const m = new RegExp(`^Owed settle up ledger [1-9A-HJ-NP-Za-km-z]{12} v(\\d+): (\\d+) requests?, (\\S+) USDC by (\\S+) at ${GL_SIGNED_ISO}$`).exec(value.signed_message);
    if (!m) return void ctx.errors.push(`${path}.signed_message: must read "Owed settle up ledger <id> v<version>: <n> requests, <total> USDC by <signer> at <UTC time>"`);
    if (Number(m[1]) !== value.version) ctx.errors.push(`${path}.version: ${value.version}, but the message settles v${m[1]}`);
    if (m[4] !== value.signer) ctx.errors.push(`${path}.signed_message: signed for ${m[4]}, not the signer`);
    signedAs(value.signed_message.slice(0, value.signed_message.lastIndexOf(" at ") + 4), value.signer, value, path, ctx);
  }),
  groupLedgerSettleRes: object({
    round: integer(),
    created: array(object({
      position: integer(), from: glMember, to: glMember, amount: positiveAmount,
      request: object({
        id, link: httpsUrl, solana_pay_url: solanaPayTransfer, reference: pubkey, recipient: pubkey, payer: nullable(payerInfo),
        payer_name: untrusted(40), for: untrusted(80), note: untrusted(140), requester_name: untrusted(40), requester_handle: nullable(handle), created_at: iso,
      }),
    }), { min: 1, max: 19 }),
    unpayable: array(object({ from: glMember, to: glMember, amount: positiveAmount, reason: oneOf("no_wallet") }), { max: 19 }),
    ledger: glRes,
  }, (value, path, ctx) => {
    const l = value.ledger;
    const round = l.settlements.find((s) => s.round === value.round);
    if (!round) return void ctx.errors.push(`${path}.round: the ledger has no settle-up ${value.round}`);
    if (round.transfers.length !== value.created.length) ctx.errors.push(`${path}.created: ${value.created.length}, the settle-up lists ${round.transfers.length}`);
    for (const [i, c] of value.created.entries()) {
      const at = `${path}.created[${i}]`;
      const r = c.request;
      const t = round.transfers[i];
      if (!t || t.request_id !== r.id || t.amount !== c.amount || t.from !== c.from || t.to !== c.to) ctx.errors.push(`${at}: not the settle-up's transfer ${i}`);
      if (r.recipient !== l.members[c.to]?.wallet) ctx.errors.push(`${at}.request.recipient: not the creditor's wallet`);
      if ((r.payer?.wallet ?? null) !== (l.members[c.from]?.wallet ?? null)) ctx.errors.push(`${at}.request.payer: not the debtor's wallet`);
      if (requestIdFor({ recipient: r.recipient, token: "USDC", amountAtomic: toAtomic(c.amount, 6), reference: r.reference }) !== r.id) ctx.errors.push(`${at}.request.id: does not hash its terms`);
      const parsed = parseSolanaPayUrl(r.solana_pay_url);
      if (!parsed.ok || parsed.recipient !== r.recipient || parsed.amount !== c.amount || parsed.token !== "USDC" || !parsed.references.includes(r.reference) || parsed.memo !== `owed:${r.id}`) {
        ctx.errors.push(`${at}.request.solana_pay_url: does not pay exactly this transfer`);
      }
      if (r.for !== `${l.title} settle-up`) ctx.errors.push(`${at}.request.for: doesn't name the ledger's title`);
      if (!r.note?.includes(`ledger ${l.id}`)) ctx.errors.push(`${at}.request.note: doesn't name the ledger`);
    }
    for (const [i, u] of value.unpayable.entries()) if (l.members[u.to]?.wallet !== null) ctx.errors.push(`${path}.unpayable[${i}]: the creditor has a wallet`);
  }),
});

Object.assign(fixtureShapes, {
  "ledgers.create.req.json": "groupLedgerCreateReq",
  "ledgers.create.res.json": "groupLedgerRes",
  "ledgers.get.res.json": "groupLedgerRes",
  "ledgers.expense.req.json": "groupLedgerExpenseReq",
  "ledgers.expense.res.json": "groupLedgerExpenseRes",
  "ledgers.expense.fiat.req.json": "groupLedgerExpenseReq",
  "ledgers.expense.fiat.res.json": "groupLedgerExpenseRes",
  "ledgers.settle.req.json": "groupLedgerSettleReq",
  "ledgers.settle.res.json": "groupLedgerSettleRes",
});
// ---- F6 ledger end

// ---------------------------------------------------------------------------------------------- F8 invoices start
// Merchant-grade invoices: terms (installments, an early-pay price, a late fee, chase days), refunds, monthly statements.
// A request id commits to its exact amount, so a term that changes what is owed opens a new request (each a whole invoice
// of its own, kind "invoice"); the invoice's own request asks for installment 1, or the early price.
//   invoiceTermsRes   GET /api/v1/invoices/:id (and POST's reply when terms were given): invoiceRes plus `terms` (the
//                     invoice as a whole: status, paid so far, what to pay now), `term_of` (an invoice a plan opened),
//                     `refunded` and `refunds`. Without terms it is exactly invoiceRes's rule set.
//   refund*           POST /api/v1/refunds (the recipient's signed "Owed refund <amount> <token> of <id> to <payer> for
//                     <recipient> at <ISO>"), GET /api/v1/refunds/:id, GET /api/v1/refunds?requests=.
//   statementRes      GET /api/v1/statements: lines and per-token totals that add up.

const f8Roles = ["installment", "early_price", "full_price", "late_fee"];
const f8Seq = (value, path, ctx) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 12) ctx.errors.push(`${path}: expected 1..12, got ${show(value)}`);
};
const f8Count = (value, path, ctx) => {
  if (!Number.isSafeInteger(value) || value < 2 || value > 12) ctx.errors.push(`${path}: expected 2..12, got ${show(value)}`);
};
const f8Interval = (value, path, ctx) => {
  if (value !== "monthly" && !(Number.isSafeInteger(value) && value >= 7 && value <= 365)) ctx.errors.push(`${path}: expected "monthly" or 7..365 days, got ${show(value)}`);
};
const f8ChaseDays = (value, path, ctx) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return void ctx.errors.push(`${path}: expected 1 to 3 days`);
  let last = 0;
  value.forEach((d, i) => {
    if (!Number.isSafeInteger(d) || d < 1 || d > 90 || d <= last) ctx.errors.push(`${path}[${i}]: expected a day 1..90 after the one before, got ${show(d)}`);
    last = d;
  });
};
const f8Percent = string({ max: 6, pattern: /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/, label: "a percent with at most 2 decimals" });
const f8Status = oneOf("open", "paid", "underpaid", "cancelled", "expired");
const f8SignedAmount = string({ max: 41, pattern: /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, label: "a signed decimal amount" });

const f8TermRequest = object({
  role: oneOf(...f8Roles), seq: f8Seq, amount: positiveAmount, fiat_amount: optional(positiveAmount),
  due_date: invoiceDate, opens_on: invoiceDate,
  status: oneOf("open", "paid", "underpaid", "cancelled", "expired", "scheduled", "skipped"),
  id: nullable(id), link: nullable(httpsUrl), skip_reason: nullable(string({ min: 1, max: 200 })),
  paid: optional(object({ amount: positiveAmount, at: iso, signature, on_time: oneOf(true, false) })),
  superseded_by: optional(id),
}, (value, path, ctx) => {
  const waiting = value.status === "scheduled" || value.status === "skipped";
  if (waiting !== (value.id === null)) ctx.errors.push(`${path}.id: ${value.status} ${value.id === null ? "without" : "with"} a request`);
  if ((value.status === "skipped") !== (value.skip_reason !== null)) ctx.errors.push(`${path}.skip_reason: only a skipped row has one`);
  if (value.id !== null && (value.link === null || !new URL(value.link).pathname.endsWith(`/i/${value.id}`))) ctx.errors.push(`${path}.link: does not end in /i/${value.id}`);
  if (value.role !== "installment" && value.seq !== 1) ctx.errors.push(`${path}.seq: only installments count past 1`);
  if (value.paid && value.status !== "paid" && value.status !== "underpaid" && value.status !== "cancelled") ctx.errors.push(`${path}.paid: set for status ${value.status}`);
  if (value.superseded_by && value.status !== "cancelled" && value.status !== "paid") ctx.errors.push(`${path}.superseded_by: set for status ${value.status}`);
  if (value.opens_on > value.due_date && value.role !== "late_fee") ctx.errors.push(`${path}.opens_on: after its due date`);
});

const f8Terms = object({
  status: f8Status, paid_so_far: amount, remaining: amount,
  pay_now: nullable(object({
    id, link: httpsUrl, amount: positiveAmount, due_date: nullable(invoiceDate), role: oneOf(...f8Roles, "invoice"), seq: nullable(f8Seq),
  })),
  installments: nullable(object({ count: f8Count, interval: f8Interval, interval_label: string({ min: 1, max: 40 }), plan: array(f8TermRequest, { min: 2, max: 12 }) })),
  early_discount: nullable(object({
    early_price: positiveAmount, full_price: positiveAmount, discount: positiveAmount, percent: nullable(f8Percent), until: invoiceDate,
    early: f8TermRequest, full: f8TermRequest, paid_with: nullable(oneOf("early", "full")),
  })),
  late_fee: nullable(object({ amount: positiveAmount, percent: nullable(f8Percent), applies_after: invoiceDate, request: f8TermRequest })),
  chase: nullable(object({ days: f8ChaseDays })),
  refunded: amount,
});

const f8TermOf = object({
  invoice_id: id, link: httpsUrl, role: oneOf(...f8Roles), seq: f8Seq, count: nullable(f8Count), label: string({ min: 1, max: 40 }),
}, (value, path, ctx) => {
  if (!new URL(value.link).pathname.endsWith(`/i/${value.invoice_id}`)) ctx.errors.push(`${path}.link: does not end in /i/${value.invoice_id}`);
  const want = value.role === "installment" ? `Installment ${value.seq}${value.count ? ` of ${value.count}` : ""}` : value.role === "full_price" ? "Full price" : value.role === "late_fee" ? "Late fee" : "Early-pay price";
  if (value.label !== want) ctx.errors.push(`${path}.label: ${show(value.label)}, expected ${show(want)}`);
});

const f8RefundLine = object({
  id: string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char refund id" }), request_id: id, amount: positiveAmount,
  status: oneOf("pending", "confirmed", "lapsed"), confirmed_at: optional(iso), signature: optional(signature),
}, (value, path, ctx) => {
  if ((value.status === "confirmed") !== (value.confirmed_at !== undefined && value.signature !== undefined)) ctx.errors.push(`${path}: confirmed exactly when it carries confirmed_at and signature`);
});

const f8InvoiceFields = {
  id, link: httpsUrl, request_link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
  x402_url: optional(nullable(httpsUrl)), recipient: pubkey, token,
  business_name: untrusted(60), client_name: untrusted(60), invoice_number: untrusted(20), notes: untrusted(280),
  issue_date: invoiceDate, due_date: invoiceDate,
  items: array(object({ description: untrusted(80), quantity: invoiceQuantity, unit_price: positiveAmount, amount: positiveAmount }), { min: 1, max: 20 }),
  total: positiveAmount, status: f8Status, paid: nullable(invoicePaid), created_at: iso, flags: array(flag),
  from_domain: nullable(string({ max: 253, pattern: /^[a-z0-9.-]+$/, label: "a lower-case ASCII domain" })), from_domain_verified_at: nullable(iso),
  expires_at: optional(iso), cancelled_at: optional(iso), fiat: optional(fiatQuote), payer: optional(payerInfo), requester_handle: optional(handle),
  terms: optional(f8Terms), term_of: optional(f8TermOf), refunded: optional(positiveAmount), refunds: optional(array(f8RefundLine, { max: 100 })),
  superseded_by: optional(id),
};

const f8Sum = (list, decimals) => list.reduce((s, v) => s + toAtomic(v, decimals), 0n);

/** An invoice with terms is the invoice as a whole: the plan adds up to the total, the own request pays its first part. */
function f8InvoiceConsistent(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (!new URL(value.link).pathname.endsWith(`/i/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /i/${value.id}`);
  if (!new URL(value.request_link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.request_link: does not end in /r/${value.id}`);
  if (value.created_at.slice(0, 10) !== value.issue_date) ctx.errors.push(`${path}.issue_date: not the UTC date of created_at`);
  if ((value.from_domain === null) !== (value.from_domain_verified_at === null)) ctx.errors.push(`${path}.from_domain: set without from_domain_verified_at, or the reverse`);
  if ((value.status === "paid" || value.status === "underpaid") !== (value.paid !== null)) ctx.errors.push(`${path}.paid: ${value.paid ? "set" : "missing"} for status ${value.status}`);
  payerNotRecipient(value, path, ctx);
  if (decimals === undefined) return;
  // Items add up: to `total`, or (local currency) to fiat.amount, whose quote gives `total`.
  try {
    if (value.fiat) {
      quoteGives(value.fiat, value.total, `${path}.fiat`, ctx);
      const sum = value.items.reduce((s, item) => s + scaled12(item.amount), 0n);
      if (sum !== scaled12(value.fiat.amount)) ctx.errors.push(`${path}.fiat.amount: the items add up to ${fromAtomic(sum, 12)}`);
    } else {
      let total = 0n;
      for (const [i, item] of value.items.entries()) {
        const line = invoiceLineAtomic(item.quantity, item.unit_price, decimals);
        if (line === null || line !== toAtomic(item.amount, decimals)) ctx.errors.push(`${path}.items[${i}].amount: not quantity × unit_price`);
        else total += line;
      }
      if (total !== toAtomic(value.total, decimals)) ctx.errors.push(`${path}.total: ${value.total} but the items add up to ${fromAtomic(total, decimals)}`);
    }
  } catch (error) {
    ctx.errors.push(`${path}.items: ${error.message}`);
  }
  const t = value.terms;
  // What the invoice's own request (this id) asks: installment 1, the early price, or the total.
  let own = value.total;
  if (t?.installments) own = t.installments.plan[0]?.amount ?? value.total;
  else if (t?.early_discount) own = t.early_discount.early_price;
  urlMatchesFields({ id: value.id, recipient: value.recipient, amount: own, token: value.token, reference: value.reference, solana_pay_url: value.solana_pay_url }, path, ctx);
  if (value.term_of && value.term_of.invoice_id === value.id) ctx.errors.push(`${path}.term_of: an invoice can't be opened by its own plan`);
  if (value.superseded_by && value.status !== "cancelled") ctx.errors.push(`${path}.superseded_by: set on a ${value.status} invoice`);
  if (!t) return;
  if (t.status !== value.status) ctx.errors.push(`${path}.terms.status: ${t.status}, the invoice says ${value.status}`);
  if (t.status === "paid" && toAtomic(t.remaining, decimals) !== 0n) ctx.errors.push(`${path}.terms.remaining: paid but ${t.remaining} remains`);
  if (value.paid && toAtomic(value.paid.amount, decimals) !== toAtomic(t.paid_so_far, decimals)) ctx.errors.push(`${path}.paid.amount: not terms.paid_so_far`);
  if (t.installments && t.early_discount) ctx.errors.push(`${path}.terms: installments and an early price at once`);
  if (t.installments) {
    const plan = t.installments.plan;
    if (plan.length !== t.installments.count) ctx.errors.push(`${path}.terms.installments.count: ${t.installments.count}, ${plan.length} listed`);
    plan.forEach((p, i) => {
      if (p.role !== "installment" || p.seq !== i + 1) ctx.errors.push(`${path}.terms.installments.plan[${i}]: not installment ${i + 1}`);
      if (i > 0 && p.due_date <= plan[i - 1].due_date) ctx.errors.push(`${path}.terms.installments.plan[${i}].due_date: not after the one before`);
    });
    if (plan[0]?.id !== value.id) ctx.errors.push(`${path}.terms.installments.plan[0].id: installment 1 is the invoice's own request`);
    if (plan[0]?.due_date !== value.due_date) ctx.errors.push(`${path}.terms.installments.plan[0].due_date: not the invoice's due date`);
    if (f8Sum(plan.map((p) => p.amount), decimals) !== toAtomic(value.total, decimals)) ctx.errors.push(`${path}.terms.installments.plan: amounts don't add up to the total`);
    const parts = plan.map((p) => toAtomic(p.amount, decimals));
    if (parts.some((p) => p - parts[parts.length - 1] > 1n || p < parts[parts.length - 1])) ctx.errors.push(`${path}.terms.installments.plan: not split evenly (leftover units first)`);
    const paid = plan.filter((p) => p.status === "paid").length;
    if ((t.status === "paid") !== (paid === plan.length)) ctx.errors.push(`${path}.terms.status: ${t.status} with ${paid} of ${plan.length} installments paid`);
  }
  if (t.early_discount) {
    const d = t.early_discount;
    if (toAtomic(d.full_price, decimals) !== toAtomic(value.total, decimals)) ctx.errors.push(`${path}.terms.early_discount.full_price: not the total`);
    if (toAtomic(d.early_price, decimals) + toAtomic(d.discount, decimals) !== toAtomic(d.full_price, decimals)) ctx.errors.push(`${path}.terms.early_discount: early_price + discount isn't full_price`);
    if (d.early.role !== "early_price" || d.early.id !== value.id) ctx.errors.push(`${path}.terms.early_discount.early: not the invoice's own request`);
    if (d.full.role !== "full_price" || d.full.due_date !== value.due_date) ctx.errors.push(`${path}.terms.early_discount.full: not the full price due on the invoice's date`);
    if (d.until > value.due_date || d.early.due_date !== d.until) ctx.errors.push(`${path}.terms.early_discount.until: past the due date, or not the early price's`);
    if (d.full.opens_on <= d.until) ctx.errors.push(`${path}.terms.early_discount.full.opens_on: before the early price ends`);
    if (d.early.status === "paid" && d.full.status !== "skipped" && d.full.status !== "cancelled" && d.full.status !== "paid") ctx.errors.push(`${path}.terms.early_discount.full: still payable after the early price was paid`);
    if ((d.paid_with === null) === (t.status === "paid")) ctx.errors.push(`${path}.terms.early_discount.paid_with: ${show(d.paid_with)} for status ${t.status}`);
    if (value.expires_at !== undefined) ctx.errors.push(`${path}.expires_at: the early price's end is terms.early_discount.until`);
  }
  if (t.late_fee) {
    if (t.late_fee.request.role !== "late_fee") ctx.errors.push(`${path}.terms.late_fee.request.role: not late_fee`);
    const first = t.installments ? t.installments.plan[0]?.due_date : value.due_date;
    if (t.late_fee.applies_after !== first || t.late_fee.request.due_date !== first) ctx.errors.push(`${path}.terms.late_fee.applies_after: not the (first) due date`);
    if (toAtomic(t.late_fee.amount, decimals) !== toAtomic(t.late_fee.request.amount, decimals)) ctx.errors.push(`${path}.terms.late_fee.amount: not its request's amount`);
  }
  if (t.pay_now && t.status === "paid") ctx.errors.push(`${path}.terms.pay_now: set on a paid invoice`);
}

/** sha256 refund id, as web/lib/refunds.ts and plugin/src/refund.ts derive it. */
export function refundIdFor({ requestId, payer, token, amountAtomic, reference }) {
  const asset = token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-refund:v1\n${requestId}\n${payer}\n${asset}\n${amountAtomic}\n${reference}`, "utf8").digest();
  return base58Encode(digest).slice(-12);
}

const REFUND_MESSAGE_RE = /^Owed refund ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) (USDC|SOL) of ([1-9A-HJ-NP-Za-km-z]{12}) to ([1-9A-HJ-NP-Za-km-z]{32,44}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/;

function refundSigned(value, expect, path, ctx) {
  const m = REFUND_MESSAGE_RE.exec(value.signed_message);
  if (!m) return void ctx.errors.push(`${path}.signed_message: must read "Owed refund <amount> <token> of <request> to <payer> for <recipient> at <UTC time>"`);
  const [, amountText, tokenText, request, payer, recipient] = m;
  if (expect.amount !== undefined && amountText !== expect.amount) ctx.errors.push(`${path}.signed_message: names ${amountText}, not ${expect.amount}`);
  if (expect.token !== undefined && tokenText !== expect.token) ctx.errors.push(`${path}.signed_message: names ${tokenText}, not ${expect.token}`);
  if (request !== expect.request) ctx.errors.push(`${path}.signed_message: names request ${request}, not ${expect.request}`);
  if (expect.payer !== undefined && payer !== expect.payer) ctx.errors.push(`${path}.signed_message: names payer ${payer}, not ${expect.payer}`);
  if (recipient !== expect.recipient) ctx.errors.push(`${path}.signed_message: names ${recipient}, not the recipient`);
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(value.signature) && !ed25519Verifies(value.signed_message, value.signature, expect.recipient)) {
    ctx.errors.push(`${path}.signature: does not verify for ${expect.recipient} over signed_message`);
  }
}

const f8RefundFields = {
  id: string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-char refund id" }), request_id: id, request_link: httpsUrl,
  recipient: pubkey, payer: pubkey, token, amount: positiveAmount, reference: pubkey,
  memo: string({ pattern: /^owed-refund:[1-9A-HJ-NP-Za-km-z]{12}$/, label: "owed-refund:<id>" }),
  status: oneOf("pending", "confirmed", "lapsed"), created_at: iso, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }),
  confirmed: nullable(object({ signature, amount: positiveAmount, at: iso })),
};

function f8RefundConsistent(value, path, ctx) {
  const decimals = TOKEN_DECIMALS[value.token];
  if (value.memo !== `owed-refund:${value.id}`) ctx.errors.push(`${path}.memo: not owed-refund:${value.id}`);
  if (!new URL(value.request_link).pathname.endsWith(`/r/${value.request_id}`)) ctx.errors.push(`${path}.request_link: does not end in /r/${value.request_id}`);
  if (value.payer === value.recipient) ctx.errors.push(`${path}.payer: the recipient itself`);
  if ((value.status === "confirmed") !== (value.confirmed !== null)) ctx.errors.push(`${path}.confirmed: ${value.confirmed ? "set" : "missing"} for status ${value.status}`);
  try {
    const atomic = toAtomic(value.amount, decimals);
    if (refundIdFor({ requestId: value.request_id, payer: value.payer, token: value.token, amountAtomic: atomic, reference: value.reference }) !== value.id) ctx.errors.push(`${path}.id: not the hash of its terms`);
    if (value.confirmed && toAtomic(value.confirmed.amount, decimals) < atomic) ctx.errors.push(`${path}.confirmed.amount: less than the refund`);
  } catch (error) {
    ctx.errors.push(`${path}.amount: ${error.message}`);
  }
  refundSigned(value, { amount: value.amount, token: value.token, request: value.request_id, payer: value.payer, recipient: value.recipient }, path, ctx);
}

const f8Summary = object({
  request_id: id, token, paid: nullable(positiveAmount), refunded: amount, pending: amount, refundable: amount,
  refunds: array(object({ id: f8RefundFields.id, amount: positiveAmount, status: oneOf("pending", "confirmed", "lapsed"), created_at: iso, confirmed: nullable(object({ signature, amount: positiveAmount, at: iso })) }), { max: 100 }),
}, (value, path, ctx) => {
  const decimals = TOKEN_DECIMALS[value.token];
  if (decimals === undefined) return;
  const sum = (status) => value.refunds.filter((r) => r.status === status).reduce((s, r) => s + toAtomic(r.amount, decimals), 0n);
  if (sum("confirmed") !== toAtomic(value.refunded, decimals)) ctx.errors.push(`${path}.refunded: not the sum of confirmed refunds`);
  if (sum("pending") !== toAtomic(value.pending, decimals)) ctx.errors.push(`${path}.pending: not the sum of pending refunds`);
  const paid = value.paid === null ? 0n : toAtomic(value.paid, decimals);
  const left = paid - toAtomic(value.refunded, decimals) - toAtomic(value.pending, decimals);
  if (toAtomic(value.refundable, decimals) !== (left > 0n ? left : 0n)) ctx.errors.push(`${path}.refundable: not paid - refunded - pending`);
  if (value.paid !== null && toAtomic(value.refunded, decimals) + toAtomic(value.pending, decimals) > paid) ctx.errors.push(`${path}: refunds add up to more than was paid`);
  value.refunds.forEach((r, i) => { if ((r.status === "confirmed") !== (r.confirmed !== null)) ctx.errors.push(`${path}.refunds[${i}].confirmed: wrong for ${r.status}`); });
});

const f8StatementLine = object({
  at: iso, kind: oneOf("invoiced", "cancelled", "expired", "paid", "refunded"), request_id: id, invoice_id: nullable(id),
  invoice_number: untrusted(20), description: string({ min: 1, max: 160 }), token, amount: positiveAmount, signature: nullable(signature), link: httpsUrl,
});

Object.assign(shapes, {
  createInvoiceTermsReq: object({
    recipient: pubkey, token, business_name: string({ min: 1, max: 60 }), client_name: string({ min: 1, max: 60 }),
    items: array(object({ description: string({ min: 1, max: 80 }), quantity: optional(invoiceQuantity), unit_price: positiveAmount }), { min: 1, max: 20 }),
    due_date: invoiceDate, invoice_number: optional(string({ min: 1, max: 20 })), notes: optional(string({ min: 1, max: 280 })),
    from_domain: optional(string({ min: 1, max: 253 })), source: oneOf("plugin", "web"), expires_in_days: optional(expiresInDays),
    currency: optional(fiatCode), payer: optional(payerReq), requester_handle: optional(handleIn),
    installments: optional(object({ count: f8Count, interval: optional(f8Interval), first_due: optional(invoiceDate) })),
    early_discount: optional(object({ amount: optional(positiveAmount), percent: optional(f8Percent), until: invoiceDate })),
    late_fee: optional(object({ amount: optional(positiveAmount), percent: optional(f8Percent) })),
    chase: optional((value, path, ctx) => (value === false ? undefined : object({ days: f8ChaseDays })(value, path, ctx))),
  }, (value, path, ctx) => {
    invoiceItemsFit(value, path, ctx);
    payerNotRecipient(value, path, ctx);
    if (value.installments && value.early_discount) ctx.errors.push(`${path}: installments and an early-pay discount at once`);
    for (const key of ["early_discount", "late_fee"]) {
      const t = value[key];
      if (t && (t.amount === undefined) === (t.percent === undefined)) ctx.errors.push(`${path}.${key}: needs exactly one of amount and percent`);
    }
    if (value.installments?.first_due && value.installments.first_due !== value.due_date) ctx.errors.push(`${path}.installments.first_due: not due_date`);
    if (value.early_discount && value.early_discount.until > value.due_date) ctx.errors.push(`${path}.early_discount.until: after the due date`);
  }),
  invoiceTermsRes: object(f8InvoiceFields, f8InvoiceConsistent),
  createRefundReq: object({ request: id, recipient: pubkey, amount: positiveAmount, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) },
    (value, path, ctx) => refundSigned(value, { amount: value.amount, request: value.request, recipient: value.recipient }, path, ctx)),
  refundRes: object(f8RefundFields, f8RefundConsistent),
  createRefundRes: object({ ...f8RefundFields, paid: positiveAmount, refunded: amount, pending: amount, refundable: amount }, (value, path, ctx) => {
    f8RefundConsistent(value, path, ctx);
    const d = TOKEN_DECIMALS[value.token];
    if (d === undefined) return;
    if (toAtomic(value.refunded, d) + toAtomic(value.pending, d) + toAtomic(value.refundable, d) !== toAtomic(value.paid, d)) ctx.errors.push(`${path}: refunded + pending + refundable isn't paid`);
    if (value.status === "pending" && toAtomic(value.pending, d) < toAtomic(value.amount, d)) ctx.errors.push(`${path}.pending: doesn't include this refund`);
  }),
  refundsLookupRes: object({ requests: array(f8Summary, { max: 20 }), not_found: array(id, { max: 20 }), chain_checked: oneOf(true, false) }, (value, path, ctx) => {
    const ids = [...value.requests.map((r) => r.request_id), ...value.not_found];
    if (new Set(ids).size !== ids.length) ctx.errors.push(`${path}: an id is listed twice`);
  }),
  statementRes: object({
    recipient: pubkey, client: string({ min: 1, max: 64 }), month, from: iso, to: iso, generated_at: iso,
    caution: string({ max: 400, pattern: /^Anyone can create a request that pays your wallet/, label: "the ledger's caution" }), chain_checked: oneOf(true, false),
    invoices: array(object({ id, invoice_number: untrusted(20), issue_date: invoiceDate, due_date: invoiceDate, total: positiveAmount, token, status: f8Status, link: httpsUrl }), { max: 200 }),
    lines: array(f8StatementLine, { max: 5000 }),
    totals: array(object({ token, opening: f8SignedAmount, invoiced: amount, cancelled: amount, paid: amount, refunded: amount, closing: f8SignedAmount }), { max: 2 }),
    truncated: oneOf(true, false),
    csv: nullable(object({ url: httpsUrl, expires_at: iso })), page: nullable(object({ url: httpsUrl, expires_at: iso })),
  }, (value, path, ctx) => {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (value.from !== `${value.month}-01T00:00:00Z`) ctx.errors.push(`${path}.from: not the first of ${value.month}`);
    let last = "";
    for (const [i, l] of value.lines.entries()) {
      const at = Date.parse(l.at);
      if (at < from || at >= to) ctx.errors.push(`${path}.lines[${i}].at: outside the month`);
      if (l.at < last) ctx.errors.push(`${path}.lines[${i}]: out of order`);
      last = l.at;
    }
    for (const t of value.totals) {
      const d = TOKEN_DECIMALS[t.token];
      const signed = (v) => (v.startsWith("-") ? -toAtomic(v.slice(1), d) : toAtomic(v, d));
      const mine = value.lines.filter((l) => l.token === t.token);
      const sum = (...kinds) => mine.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + toAtomic(l.amount, d), 0n);
      if (sum("invoiced") !== toAtomic(t.invoiced, d)) ctx.errors.push(`${path}.totals.${t.token}.invoiced: not the sum of the lines`);
      if (sum("cancelled", "expired") !== toAtomic(t.cancelled, d)) ctx.errors.push(`${path}.totals.${t.token}.cancelled: not the sum of the lines`);
      if (sum("paid") !== toAtomic(t.paid, d)) ctx.errors.push(`${path}.totals.${t.token}.paid: not the sum of the lines`);
      if (sum("refunded") !== toAtomic(t.refunded, d)) ctx.errors.push(`${path}.totals.${t.token}.refunded: not the sum of the lines`);
      const closing = signed(t.opening) + toAtomic(t.invoiced, d) - toAtomic(t.cancelled, d) - toAtomic(t.paid, d) + toAtomic(t.refunded, d);
      if (closing !== signed(t.closing)) ctx.errors.push(`${path}.totals.${t.token}.closing: not opening + invoiced - cancelled - paid + refunded`);
    }
  }),
});

Object.assign(fixtureShapes, {
  "invoice.terms.create.req.json": "createInvoiceTermsReq",
  "invoice.terms.create.res.json": "invoiceTermsRes",
  "invoice.terms.get.res.json": "invoiceTermsRes",
  "invoice.terms.child.res.json": "invoiceTermsRes",
  "invoice.statement.res.json": "statementRes",
  "refund.create.req.json": "createRefundReq",
  "refund.create.res.json": "createRefundRes",
  "refund.get.res.json": "refundRes",
  "refunds.lookup.res.json": "refundsLookupRes",
});
// ---------------------------------------------------------------------------------------------- F8 invoices end

// ---------------------------------------------------------------------------------------------- F5 autopay start
// set_autopay: POST /api/v1/autopay stores a payer's rule; the payer's wallet signs (checked for real here)
//   "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <YYYY-MM-DD> (at <ISO>)"
// with the amounts as fromAtomic writes them; POST /api/v1/autopay/revoke ends one ("Owed autopay revoke <id> for <payer> at <ISO>").
// The signed inbox then carries the payer's live rules and a verdict per line. F3: a request may carry a PayBox Open
// Deposit link (deposit_url, https on paybox.sh, USDC on Solana), never part of its id. Fixtures: contract/autopay-fixtures.mjs.

const ruleIdShape = string({ pattern: /^[1-9A-HJ-NP-Za-km-z]{12}$/, label: "a 12-character autopay rule id" });
const AUTOPAY_RULE_TEXT = /^Owed autopay for ([1-9A-HJ-NP-Za-km-z]{32,44}): pay ([1-9A-HJ-NP-Za-km-z]{32,44}) up to ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) USDC per request and ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) USDC per month until (\d{4}-\d{2}-\d{2}) \(at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\)$/;
const canonicalUsdc = (text) => fromAtomic(toAtomic(text, 6), 6);

/** A rule's signed text must name exactly these fields (amounts canonical) and verify for the payer. */
function ruleSigned(fields, path, ctx) {
  const m = AUTOPAY_RULE_TEXT.exec(fields.signed_message);
  if (!m) return void ctx.errors.push(`${path}.signed_message: must read "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <date> (at <UTC time>)"`);
  const [, payer, requester, max, month, ends] = m;
  if (payer !== fields.payer) ctx.errors.push(`${path}.signed_message: names payer ${payer}, not ${fields.payer}`);
  if (requester !== fields.requester) ctx.errors.push(`${path}.signed_message: names requester ${requester}, not ${fields.requester}`);
  try {
    if (max !== canonicalUsdc(fields.max_per_request)) ctx.errors.push(`${path}.signed_message: says ${max} USDC per request, not ${canonicalUsdc(fields.max_per_request)}`);
    if (month !== canonicalUsdc(fields.max_per_month)) ctx.errors.push(`${path}.signed_message: says ${month} USDC per month, not ${canonicalUsdc(fields.max_per_month)}`);
    if (toAtomic(fields.max_per_month, 6) < toAtomic(fields.max_per_request, 6)) ctx.errors.push(`${path}.max_per_month: below max_per_request`);
  } catch (error) {
    ctx.errors.push(`${path}: ${error.message}`);
  }
  if (ends !== fields.ends) ctx.errors.push(`${path}.signed_message: ends ${ends}, not ${fields.ends}`);
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(fields.signature) && !ed25519Verifies(fields.signed_message, fields.signature, fields.payer)) {
    ctx.errors.push(`${path}.signature: does not verify for ${fields.payer} over signed_message`);
  }
}

const autopayRule = object({
  id: ruleIdShape, payer: pubkey, requester: object({ wallet: pubkey, handle: nullable(handle), sns: nullable(snsName) }),
  token: oneOf("USDC"), max_per_request: positiveAmount, max_per_month: positiveAmount, ends: invoiceDate, ends_at: iso, created_at: iso,
  status: oneOf("active", "ended", "revoked"), revoked_at: nullable(iso), replaced_by: nullable(ruleIdShape),
  month: string({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/, label: "a month written YYYY-MM" }), used_this_month: amount,
  signed_message: string({ min: 1, max: 300 }), signature: string({ min: 64, max: 200 }),
}, (value, path, ctx) => {
  ruleSigned({ ...value, requester: value.requester.wallet }, path, ctx);
  if (value.requester.wallet === value.payer) ctx.errors.push(`${path}.requester.wallet: the payer's own wallet`);
  if (Date.parse(value.ends_at) !== Date.parse(`${value.ends}T00:00:00Z`) + 86_400_000) ctx.errors.push(`${path}.ends_at: not the start of the day after ends`);
  if ((value.status === "revoked") !== (value.revoked_at !== null)) ctx.errors.push(`${path}.revoked_at: ${value.revoked_at === null ? "missing" : "set"} for status ${value.status}`);
  if (value.replaced_by !== null && value.status !== "revoked") ctx.errors.push(`${path}.replaced_by: set on a ${value.status} rule`);
});

const autopayVerdict = object({
  status: oneOf("eligible", "over_limit", "not_covered"), rule_id: optional(ruleIdShape), reason: string({ min: 1, max: 300 }),
}, (value, path, ctx) => {
  if (value.status !== "not_covered" && !value.rule_id) ctx.errors.push(`${path}.rule_id: missing for ${value.status}`);
});

/** A shape plus extra fields: the extras are checked here and stripped before the base shape sees the rest. */
function withFields(base, fields, refine) {
  return (value, path, ctx) => {
    if (kind(value) !== "object") return base(value, path, ctx);
    const rest = { ...value };
    for (const [key, shape] of Object.entries(fields)) {
      if (!(key in rest)) {
        if (!shape.optional) ctx.errors.push(`${path}.${key}: missing`);
        continue;
      }
      shape(rest[key], `${path}.${key}`, ctx);
      delete rest[key];
    }
    base(rest, path, ctx);
    if (refine) refine(value, path, ctx);
  };
}

const depositUrl = string({
  max: 512, label: "an https PayBox Deposit link on paybox.sh",
  test: (text) => {
    try {
      const u = new URL(text);
      return u.protocol === "https:" && !u.username && !u.password && !u.port && (u.hostname === "paybox.sh" || u.hostname.endsWith(".paybox.sh")) && u.href === text;
    } catch {
      return false;
    }
  },
});
/** F3: a deposit link is for USDC requests on Solana only. */
function depositUsdcOnSolana(value, path, ctx) {
  if ("deposit_url" in value && (value.token !== "USDC" || (value.chain ?? "solana") !== "solana" || "currency" in value)) {
    ctx.errors.push(`${path}.deposit_url: only on a USDC request on Solana, asked in USDC`);
  }
}

const autopayInboxEntries = (value, path, ctx) => {
  for (const list of ["owed", "base"]) {
    (value[list] ?? []).forEach((e, i) => {
      if (kind(e) !== "object" || !("autopay" in e)) return;
      autopayVerdict(e.autopay, `${path}.${list}[${i}].autopay`, ctx);
      if (e.autopay.status === "eligible" && (e.chain !== "solana" || e.token !== "USDC" || e.status !== "open")) ctx.errors.push(`${path}.${list}[${i}].autopay: eligible but not an open USDC request on Solana`);
      if (e.autopay.rule_id && !(value.autopay_rules ?? []).some((r) => r.id === e.autopay.rule_id) && e.autopay.status !== "not_covered") {
        ctx.errors.push(`${path}.${list}[${i}].autopay.rule_id: names a rule the inbox doesn't list`);
      }
    });
  }
};
/** The inbox with autopay: rules and verdicts checked, then the F1 inbox shape on the rest. */
function autopayInboxRes(value, path, ctx) {
  if (kind(value) !== "object") return inboxRes(value, path, ctx);
  const strip = (e) => {
    if (kind(e) !== "object") return e;
    const { autopay: _autopay, ...rest } = e;
    return rest;
  };
  const { autopay_rules, ...rest } = value;
  if (autopay_rules !== undefined) array(autopayRule, { max: 20 })(autopay_rules, `${path}.autopay_rules`, ctx);
  autopayInboxEntries(value, path, ctx);
  inboxRes({ ...rest, owed: (rest.owed ?? []).map(strip), base: (rest.base ?? []).map(strip) }, path, ctx);
  for (const r of Array.isArray(autopay_rules) ? autopay_rules : []) if (r?.payer !== value.payer) ctx.errors.push(`${path}.autopay_rules: a rule for another payer`);
}

Object.assign(shapes, {
  autopayCreateReq: object({
    payer: pubkey, requester: object({ wallet: pubkey, handle: optional(handleIn), sns: optional(string({ min: 1, max: 140 })) }), token: optional(oneOf("USDC")),
    max_per_request: positiveAmount, max_per_month: positiveAmount, ends: invoiceDate, signed_message: string({ min: 1, max: 300 }), signature: string({ min: 64, max: 200 }),
  }, (value, path, ctx) => {
    ruleSigned({ ...value, requester: value.requester.wallet }, path, ctx);
    if (value.requester.wallet === value.payer) ctx.errors.push(`${path}.requester.wallet: the payer's own wallet`);
  }),
  autopayCreateRes: object({ rule: autopayRule, replaced: nullable(ruleIdShape) }, (value, path, ctx) => {
    if (value.rule.status !== "active") ctx.errors.push(`${path}.rule.status: ${value.rule.status} right after it was made`);
    if (value.replaced === value.rule.id) ctx.errors.push(`${path}.replaced: the rule itself`);
  }),
  autopayRevokeReq: object({ payer: pubkey, rule_id: ruleIdShape, signed_message: string({ min: 1, max: 200 }), signature: string({ min: 64, max: 200 }) },
    (value, path, ctx) => signedAs(`Owed autopay revoke ${value.rule_id} for ${value.payer} at `, value.payer, value, path, ctx)),
  autopayRevokeRes: object({ rule: autopayRule, already_revoked: oneOf(true, false) }, (value, path, ctx) => {
    if (value.rule.status !== "revoked") ctx.errors.push(`${path}.rule.status: ${value.rule.status} after a revoke`);
  }),
  autopayInboxRes,
  depositCreateRequestReq: withFields(shapes.createRequestReq, { deposit_url: depositUrl }, depositUsdcOnSolana),
  depositCreateRequestRes: withFields(shapes.createRequestRes, { deposit_url: depositUrl }),
  depositGetRequestRes: withFields(shapes.getRequestRes, { deposit_url: depositUrl, deposit_url_added_at: iso }, (value, path, ctx) => {
    depositUsdcOnSolana(value, path, ctx);
    if (Date.parse(value.deposit_url_added_at) < Date.parse(value.created_at)) ctx.errors.push(`${path}.deposit_url_added_at: before created_at`);
  }),
  depositStatusRes: (value, path, ctx) => {
    if (kind(value) !== "object" || !Array.isArray(value.results)) return shapes.statusRes(value, path, ctx);
    const results = value.results.map((r, i) => {
      if (kind(r) !== "object" || !("deposit_link" in r)) return r;
      oneOf(true)(r.deposit_link, `${path}.results[${i}].deposit_link`, ctx);
      const { deposit_link: _d, ...rest } = r;
      return rest;
    });
    shapes.statusRes({ ...value, results }, path, ctx);
  },
  depositCreateInvoiceReq: withFields(shapes.createInvoiceReq, { deposit_url: depositUrl }, depositUsdcOnSolana),
  depositInvoiceRes: withFields(shapes.invoiceRes, { deposit_url: depositUrl }, depositUsdcOnSolana),
});

Object.assign(fixtureShapes, {
  "autopay.create.req.json": "autopayCreateReq",
  "autopay.create.res.json": "autopayCreateRes",
  "autopay.revoke.req.json": "autopayRevokeReq",
  "autopay.revoke.res.json": "autopayRevokeRes",
  "autopay.inbox.req.json": "inboxReq",
  "autopay.inbox.res.json": "autopayInboxRes",
  "autopay.requests.bulk.res.json": "bulkRequestsRes",
  "deposit.create-request.req.json": "depositCreateRequestReq",
  "deposit.create-request.res.json": "depositCreateRequestRes",
  "deposit.get-request.res.json": "depositGetRequestRes",
  "deposit.status.res.json": "depositStatusRes",
  "deposit.invoices.create.req.json": "depositCreateInvoiceReq",
  "deposit.invoices.create.res.json": "depositInvoiceRes",
});
// ---------------------------------------------------------------------------------------------- F5 autopay end
