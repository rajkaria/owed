// Dependency-free shapes of the Owed HTTP API (SPEC §5.3), shared by contract/check.mjs and web/scripts/smoke.mjs.
// Every shape must accept its file in contract/fixtures/ (check.mjs enforces this), so the smoke test and the
// fixtures can't drift apart silently. Amount checks are string/bigint only: no floats anywhere.

import { createHash } from "node:crypto";

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

const statusFields = {
  status: oneOf("open", "paid", "underpaid", "cancelled", "not_found", "invalid"),
  amount_requested: optional(positiveAmount),
  token: optional(token),
  amount_paid: optional(amount),
  payer: optional(pubkey),
  signature: optional(signature),
  paid_at: optional(iso),
  created_at: optional(iso), // W1-C asked for it; the plugin turns it into "waited"
};
function statusConsistent(value, path, ctx) {
  if (["open", "paid", "underpaid", "cancelled"].includes(value.status)) {
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

export const shapes = {
  createGroupReq: object({
    recipient: pubkey, total: positiveAmount, token, title: string({ min: 1, max: 60 }),
    people: array(object({ name: string({ min: 1, max: 40 }), amount: optional(positiveAmount) }), { min: 2, max: 20 }),
    requester_name: optional(string({ max: 40 })), source: oneOf("plugin", "web"),
    from_domain: optional(string({ min: 1, max: 253 })),
  }, peopleFitTotal),
  groupRes: object({
    id: groupId, link: httpsUrl, title: untrusted(60), recipient: pubkey, token, total: positiveAmount,
    requester_name: untrusted(40), created_at: iso, flags: array(flag),
    from_domain: optional(nullable(string({ max: 253, pattern: /^[a-z0-9.-]+$/, label: "a lower-case ASCII domain" }))),
    from_domain_verified_at: optional(nullable(iso)),
    share_count: integer({ min: 2 }), paid_count: integer(), amount_received: amount,
    shares: array(object({
      id, name: untrusted(40), amount: positiveAmount, status: oneOf("open", "paid", "underpaid", "cancelled"),
      link: httpsUrl, solana_pay_url: solanaPayTransfer, reference: pubkey, paid: nullable(paidInfo),
    }), { min: 2, max: 20 }),
  }, groupConsistent),
  createRequestReq: object({
    recipient: pubkey, amount: positiveAmount, token,
    payer_name: optional(string({ max: 40 })), for: optional(string({ max: 80 })), note: optional(string({ max: 140 })),
    requester_name: optional(string({ max: 40 })), kind: optional(oneOf("single")), group_id: optional(string({ max: 40 })),
    source: oneOf("plugin", "web"), from_domain: optional(string({ min: 1, max: 253 })),
  }, decimalsFit("amount")),
  createRequestRes: object({
    id, link: httpsUrl, solana_pay_url: solanaPayTransfer, qr_url: httpsUrl, reference: pubkey,
    x402_url: optional(nullable(httpsUrl)), created_at: iso, flags: array(flag), from_domain: optional(nullable(domain)),
  }, (value, path, ctx) => {
    urlMatchesFields(value, path, ctx);
    if (!new URL(value.link).pathname.endsWith(`/r/${value.id}`)) ctx.errors.push(`${path}.link: does not end in /r/${value.id}`);
  }),
  getRequestRes: object({
    id, kind: oneOf("single", "split_share", "invoice"), recipient: pubkey, amount: positiveAmount, token,
    payer_name: untrusted(40), for: untrusted(80), note: untrusted(140), requester_name: untrusted(40),
    status: oneOf("open", "paid", "underpaid", "cancelled"),
    solana_pay_url: solanaPayTransfer, reference: pubkey, x402_url: optional(nullable(httpsUrl)), created_at: iso,
    paid: optional(nullable(object({ signature, payer: pubkey, amount, at: iso, rail: oneOf("solana_pay", "x402") }))),
    flags: array(flag), from_domain: optional(nullable(domain)), from_domain_verified_at: optional(nullable(iso)),
  }, (value, path, ctx) => {
    decimalsFit("amount")(value, path, ctx);
    if (value.from_domain && !value.from_domain_verified_at) ctx.errors.push(`${path}.from_domain_verified_at: from_domain is set but its verified time is ${show(value.from_domain_verified_at)}`);
    urlMatchesFields(value, path, ctx);
    if (value.status === "paid" && !value.paid) ctx.errors.push(`${path}.paid: status is paid but paid is ${show(value.paid)}`);
    if (value.status === "open" && value.paid) ctx.errors.push(`${path}.paid: status is open but paid is set`);
  }),
  statusReq: object({ ids: array(id, { min: 1, max: 20 }) }),
  statusRes: object({ results: array(object({ id, ...statusFields }, statusConsistent), { max: 20 }) }),
  statusRawReq: object({ solana_pay_url: string({ max: 2048, pattern: /^solana:/, label: "a solana: URL" }) }),
  statusRawRes: object(statusFields, statusConsistent),
  statsRes: object({ paid_count: integer(), paid_volume_usdc: amount, since: iso }),
  errorRes: object({ error: object({ code: oneOf(...ERROR_CODES), message: string({ min: 1, max: 500 }) }) }),
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
};
