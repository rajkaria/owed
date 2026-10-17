import "server-only";
import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "./http";
import { rpcBatch } from "./solana";

// W3-S Solana Name Service payees, the server's copy. A request may name the SNS name ("bonfida.sns") its
// recipient was given as; the server re-resolves it at creation and stores it only if it points to the recipient
// right then, for display. The plugin re-resolves it itself before paying and never trusts this copy, and the pay
// page re-checks it on every render. The core below is plugin/src/sns.ts's, byte for byte (web/test/sns.test.ts
// compares them); both suites replay plugin/test/fixtures/sns/ (real mainnet accounts). Why ".sns" and never
// ".sol", and why tokenized names are refused: see the top of plugin/src/sns.ts.

// ---- SNS core start (identical in plugin/src/sns.ts and web/lib/sns.ts)

export const SNS_TLD = ".sns";
export const NAME_PROGRAM_ID = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
/** The .sns TLD account (the former .sol root, renamed by SNS in August 2026). */
export const SNS_ROOT = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
/** Class of SOL record v2 accounts: the SNS records program's central state. */
export const SNS_RECORDS_CENTRAL_STATE = "2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo";
export const NAME_TOKENIZER_ID = "nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk";
/** The finalized slot from which the SNS SDK refuses ".sol" (SOL_TLD_CUTOFF_SLOT). */
export const SOL_TLD_CUTOFF_SLOT = 452_825_395;
export const SNS_HASH_PREFIX = "SPL Name Service";
const HEADER_LEN = 96;
const MAX_LABEL = 63;
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export type SnsSource = "sol_record_v2" | "sol_record_v1" | "owner";
export type SnsFailure = "invalid_name" | "sol_tld" | "not_found" | "tokenized" | "bad_record" | "no_wallet" | "unavailable";

export type SnsName =
  | { ok: true; name: string; labels: string[]; warnings: string[] }
  | { ok: false; code: "invalid_name" | "sol_tld"; message: string };

export type SnsResult =
  | { ok: true; name: string; wallet: string; source: SnsSource; warnings: string[] }
  | { ok: false; name: string | null; code: SnsFailure; message: string };

/** One account from getMultipleAccounts with base64 encoding. */
export interface RawAccount {
  owner: string;
  data: Buffer;
}

/** A JSON-RPC call: the plugin's Rpc.call, or the server's rpcBatch for one call. */
export type SnsRpc = (method: string, params: unknown[]) => Promise<unknown>;

/** Text that may be an SNS name (as opposed to an address, an id or a link). */
export function looksLikeSnsName(text: string): boolean {
  const s = text.trim().toLowerCase().replace(/\.$/, "");
  return (s.endsWith(SNS_TLD) || s.endsWith(".sol")) && s.length <= 140 && !/[\s/:?#@]/.test(s);
}

const CJK_SCRIPTS = [
  { name: "Han", re: /^\p{Script=Han}+$/u },
  { name: "Hiragana", re: /^\p{Script=Hiragana}+$/u },
  { name: "Hangul", re: /^[가-힣]+$/u },
] as const;

/**
 * Lower-case, NFC, ".sns" only, one or two labels. A label is plain a-z, 0-9, "-" and "_", or else written
 * entirely in one of Han, Hiragana or Hangul syllables (none of which has letters that pass for Latin ones or
 * for each other; Katakana does, so it isn't accepted). Anything else (other alphabets, mixed scripts, full-width
 * letters, emoji, accents, invisible characters) is refused: a name that can pass for another isn't safe to pay.
 */
export function parseSnsName(input: string): SnsName {
  const raw = typeof input === "string" ? input.trim() : "";
  const shown = raw.replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
  const invalid = (why: string): SnsName => ({ ok: false, code: "invalid_name", message: `"${shown}" ${why}` });
  if (!raw) return invalid("is empty: give a name like example.sns.");
  if (/[\p{Cc}\p{Cf}\p{Z}]/u.test(raw)) return invalid("contains spaces or invisible characters, so Owed won't resolve it.");
  let s = raw.normalize("NFC").toLowerCase();
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.endsWith(".sol")) {
    const base = s.slice(0, -4);
    const plain = /^[a-z0-9_-]+(\.[a-z0-9_-]+)?$/.test(base);
    return {
      ok: false, code: "sol_tld",
      message: `${plain ? `${base}.sol` : `"${shown}"`} is a .sol name. SNS moved its names to .sns in August 2026 and ".sol" now belongs to the Solana Record Service, which isn't live yet; SNS's own resolver stopped resolving .sol at Solana slot 452,825,395 (October 2026). Owed won't guess who a .sol name pays.${plain ? ` If the user means the SNS name, ask again with ${base}.sns, and check with them that it is theirs.` : ""}`,
    };
  }
  if (!s.endsWith(SNS_TLD)) return invalid("isn't an SNS name: Owed resolves names ending in .sns.");
  const labels = s.slice(0, -SNS_TLD.length).split(".");
  if (labels.some((l) => l.length === 0)) return invalid("isn't an SNS name: a part of it is empty.");
  if (labels.length > 2) return invalid("has more than one subdomain level; Owed resolves name.sns and sub.name.sns only.");
  for (const label of labels) {
    if ([...label].length > MAX_LABEL) return invalid(`has a part longer than ${MAX_LABEL} characters.`);
    if (/^[a-z0-9_-]+$/.test(label)) continue;
    if (/[\x00-\x7f]/.test(label) || label.includes("〇") || !CJK_SCRIPTS.some(({ re }) => re.test(label))) {
      return invalid("mixes alphabets or uses characters that can pass for others (accents, full-width or non-Latin letters, emoji). Owed resolves names in plain a-z, 0-9, \"-\" and \"_\", or written entirely in Han, Hiragana or Hangul.");
    }
  }
  const name = `${labels.join(".")}${SNS_TLD}`;
  return { ok: true, name, labels, warnings: snsWarnings(name, labels) };
}

const LOOKALIKES: Array<{ re: RegExp; text: string }> = [
  { re: /[a-z]0|0[a-z]/, text: "\"0\" (zero) for \"o\"" },
  { re: /[a-z]1|1[a-z]/, text: "\"1\" (one) for \"l\"" },
  { re: /rn/, text: "\"rn\" for \"m\"" },
  { re: /vv/, text: "\"vv\" for \"w\"" },
  { re: /_/, text: "\"_\" for \"-\"" },
];

/** Sentences for people: subdomain control, non-Latin script, lookalike characters; the last says to check the spelling. */
export function snsWarnings(name: string, labels: string[]): string[] {
  const out: string[] = [];
  if (labels.length === 2) out.push(`${name} is a subdomain of ${labels[1]}${SNS_TLD}: whoever controls ${labels[1]}${SNS_TLD} can change it.`);
  const script = CJK_SCRIPTS.find(({ re }) => labels.some((l) => re.test(l)));
  if (script) out.push(`${name} is written in ${script.name} characters.`);
  const plain = labels.filter((l) => /^[\x00-\x7f]+$/.test(l)).join(".");
  const hits = LOOKALIKES.filter(({ re }) => re.test(plain)).map(({ text }) => text);
  if (hits.length > 0) out.push(`${name} has characters that can pass for others: ${hits.length <= 2 ? hits.join(" and ") : `${hits.slice(0, -1).join(", ")} and ${hits.at(-1)}`}.`);
  if (out.length > 0) out.push("Check the name letter by letter.");
  return out;
}

const hashed = (text: string) => createHash("sha256").update(Buffer.from(SNS_HASH_PREFIX + text, "utf8")).digest();
const pda = (seeds: Buffer[], program: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0];

/** getNameAccountKeySync: PDA of [sha256(prefix + name), class or 32 zero bytes, parent or 32 zero bytes]. */
export function nameAccountKey(hashedName: Buffer, nameClass: string | null, parent: string | null): string {
  const zero = Buffer.alloc(32);
  return pda([hashedName, nameClass ? new PublicKey(nameClass).toBuffer() : zero, parent ? new PublicKey(parent).toBuffer() : zero], NAME_PROGRAM_ID).toBase58();
}

export interface SnsKeys {
  domain: string;
  nftRecord: string;
  solRecordV1: string;
  solRecordV2: string;
}

/** Every account the resolution reads, for "name.sns" (labels ["name"]) or "sub.name.sns" (["sub", "name"]). */
export function snsKeys(labels: string[]): SnsKeys {
  const parent = nameAccountKey(hashed(labels.at(-1)!), null, SNS_ROOT);
  // A subdomain's name is "\0" + label under its parent (getSnsDomainKeySync).
  const domain = labels.length === 2 ? nameAccountKey(hashed(`\0${labels[0]}`), null, parent) : parent;
  return {
    domain,
    nftRecord: pda([Buffer.from("nft_record"), new PublicKey(domain).toBuffer()], NAME_TOKENIZER_ID).toBase58(),
    // getRecordV1Key: "\x01SOL" under the domain, no class. getRecordV2Key: "\x02SOL" under it, records class.
    solRecordV1: nameAccountKey(hashed("\x01SOL"), null, domain),
    solRecordV2: nameAccountKey(hashed("\x02SOL"), SNS_RECORDS_CENTRAL_STATE, domain),
  };
}

export function isWallet(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

const key = (bytes: Buffer) => new PublicKey(bytes).toBase58();
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** A base64 account from an RPC result, or null. Anything off-shape is treated as missing. */
export function rawAccount(value: unknown): RawAccount | null {
  const v = value as { owner?: unknown; data?: unknown } | null;
  if (!v || typeof v.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return null;
  return { owner: v.owner, data: Buffer.from(v.data[0], "base64") };
}

const SOLANA = 1;
const validationLength = (v: number) => (v === 0 ? 0 : v === 2 ? 20 : v === 1 || v === 3 ? 32 : -1);

export interface SnsAccounts {
  nftRecord: RawAccount | null;
  v1: RawAccount | null;
  v2: RawAccount | null;
  domain: RawAccount | null;
}

/** SNS-IP 5 from the four accounts read in one getMultipleAccounts call. `warnings` are the name's own. */
export function decide(name: string, keys: SnsKeys, accounts: SnsAccounts, warnings: string[] = []): SnsResult {
  const fail = (code: SnsFailure, message: string): SnsResult => ({ ok: false, name, code, message });
  const resolved = (wallet: string, source: SnsSource): SnsResult => (isWallet(wallet)
    ? { ok: true, name, wallet, source, warnings }
    : fail("no_wallet", `${name} points to ${wallet}, which is a program or token account, not a wallet. Owed won't pay it.`));
  const d = accounts.domain;
  if (!d) return fail("not_found", `${name} isn't registered on SNS. Check the spelling.`);
  if (d.owner !== NAME_PROGRAM_ID || d.data.length < HEADER_LEN) return fail("bad_record", `${name}'s account isn't an SNS name account. Owed won't resolve it.`);
  const ownerBytes = d.data.subarray(32, 64);
  const owner = key(ownerBytes);

  // 1. Tokenized: an active NFT record (tag 2) means the NFT's holder controls the name; the registry owner is an
  // escrow. The holder can't be read over Owed's RPC hosts (see the top of this file), so the name is refused.
  const nft = accounts.nftRecord;
  if (nft && nft.owner === NAME_TOKENIZER_ID && nft.data.length >= 2 && nft.data[0] === 2) {
    return fail("tokenized", `${name} is tokenized (held as an NFT), and the wallet holding that NFT can't be read from Solana's public RPC, so Owed can't tell which wallet it names. Pay the holder's wallet address instead.`);
  }

  // 2. SOL record v2: header (96), then u16 staleness validation, u16 RoA validation, u32 length, ids, content.
  const v2 = accounts.v2;
  if (v2) {
    const bad = (why: string) => fail("bad_record", `${name} has a SOL record that ${why}, so SNS itself won't resolve it. Ask the owner to fix the record, or pay a wallet address instead.`);
    if (v2.owner !== NAME_PROGRAM_ID || v2.data.length < HEADER_LEN + 8) return bad("is malformed");
    const staleness = v2.data.readUInt16LE(HEADER_LEN);
    const roa = v2.data.readUInt16LE(HEADER_LEN + 2);
    const sLen = validationLength(staleness);
    const rLen = validationLength(roa);
    if (sLen < 0 || rLen < 0) return bad("is malformed");
    const body = v2.data.subarray(HEADER_LEN + 8);
    const content = body.subarray(sLen + rLen);
    if (body.length < sLen + rLen || content.length !== 32) return bad("is malformed");
    if (roa !== SOLANA || staleness !== SOLANA) return bad("isn't validated by its wallet's signature");
    if (body.subarray(0, sLen).equals(ownerBytes)) {
      if (!body.subarray(sLen, sLen + rLen).equals(content)) return bad("isn't signed by the wallet it names");
      return resolved(key(content), "sol_record_v2");
    }
    // Stale: set by a previous owner. Ignored, as the SDK does.
  }

  // 3. SOL record v1: 32-byte wallet + the owner's ed25519 signature over hex(wallet || record key).
  const v1 = accounts.v1;
  if (v1 && v1.owner === NAME_PROGRAM_ID && v1.data.length >= HEADER_LEN + 96) {
    const wallet = v1.data.subarray(HEADER_LEN, HEADER_LEN + 32);
    const signature = v1.data.subarray(HEADER_LEN + 32, HEADER_LEN + 96);
    const message = Buffer.from(Buffer.concat([wallet, new PublicKey(keys.solRecordV1).toBuffer()]).toString("hex"), "utf8");
    let valid = false;
    try {
      valid = verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, ownerBytes]), format: "der", type: "spki" }), signature);
    } catch {
      valid = false;
    }
    if (valid) return resolved(key(wallet), "sol_record_v1");
  }

  // 4. The owner, when it is a wallet. A program-owned name (off-curve owner) has no wallet to pay.
  if (!isWallet(owner)) return fail("no_wallet", `${name} is owned by a program address (${short(owner)}) and has no SOL record, so it doesn't name a wallet. Owed won't pay it.`);
  return resolved(owner, "owner");
}

const ACCOUNT_OPTS = { encoding: "base64", commitment: "confirmed" } as const;

/** Resolves an SNS name to the wallet it pays: one getMultipleAccounts call. Never throws. */
export async function resolveSnsName(input: string, rpc: SnsRpc): Promise<SnsResult> {
  const parsed = parseSnsName(input);
  if (!parsed.ok) return { ok: false, name: null, code: parsed.code, message: parsed.message };
  const { name, labels, warnings } = parsed;
  const unavailable: SnsResult = { ok: false, name, code: "unavailable", message: `Solana couldn't be read to resolve ${name} right now. Try again in a moment.` };
  try {
    const keys = snsKeys(labels);
    const res = await rpc("getMultipleAccounts", [[keys.nftRecord, keys.solRecordV1, keys.solRecordV2, keys.domain], ACCOUNT_OPTS]) as { value?: unknown[] } | null;
    if (!res || !Array.isArray(res.value) || res.value.length !== 4) return unavailable;
    const [nftRecord, v1, v2, domain] = res.value.map(rawAccount);
    return decide(name, keys, { nftRecord: nftRecord!, v1: v1!, v2: v2!, domain: domain! }, warnings);
  } catch {
    return unavailable;
  }
}

const SOURCE_TEXT: Record<SnsSource, string> = {
  sol_record_v2: "its SOL record",
  sol_record_v1: "its signed SOL record",
  owner: "its owner",
};

/** "its SOL record", "its owner", ...: which of SNS's rules picked the wallet. */
export function sourceText(source: SnsSource): string {
  return SOURCE_TEXT[source];
}

/** "bonfida.sns points to Fw1E…Lb1v (its owner)": the sentence tools and the pay page use. */
export function pointsTo(name: string, wallet: string, source: SnsSource): string {
  return `${name} points to ${short(wallet)} (${sourceText(source)})`;
}

// ---- SNS core end

// ---------------------------------------------------------------- server

/**
 * Inside a plugin call: POST /requests must answer within the plugin's 4 s API timeout, and the DNS check for
 * from_domain (3 s) runs beside this one, so 1.5 s here. The pay page uses the same budget.
 */
export const SNS_BUDGET_MS = 1500;

/** Resolves over the server's RPC (Helius when configured, then the public hosts). Never throws. */
export async function resolveSnsOnServer(name: string, budgetMs: number = SNS_BUDGET_MS): Promise<SnsResult> {
  const deadline = Date.now() + budgetMs;
  return resolveSnsName(name, async (method, params) => (await rpcBatch([{ method, params }], { deadline, timeoutMs: budgetMs }))[0]);
}

/**
 * For POST /requests with sns_name: the normalized name and the rule that picked the wallet, only if the name
 * points to `recipient` right now. Otherwise invalid_input (or upstream_unavailable when Solana can't be read).
 */
export async function requireSnsName(name: string, recipient: string, resolve: (n: string) => Promise<SnsResult> = resolveSnsOnServer): Promise<{ name: string; source: SnsSource }> {
  const r = await resolve(name);
  if (!r.ok) {
    if (r.code === "unavailable") throw new ApiError("upstream_unavailable", `sns_name: ${r.message}`);
    throw new ApiError("invalid_input", `sns_name: ${r.message}`);
  }
  if (r.wallet !== recipient) {
    throw new ApiError("invalid_input", `sns_name: ${r.name} points to ${r.wallet} (${sourceText(r.source)}), not to the recipient ${recipient}`);
  }
  return { name: r.name, source: r.source };
}

export type SnsCheck =
  | { state: "verified"; name: string; source: SnsSource; warnings: string[] }
  | { state: "moved"; name: string; wallet: string | null; message: string; warnings: string[] }
  | { state: "unchecked"; name: string; warnings: string[] };

/**
 * For the pay page: is the stored name still pointing to the request's recipient? "moved" when it now points
 * elsewhere (or can no longer name a wallet); "unchecked" when Solana didn't answer in time.
 */
export async function checkSnsForPage(name: string, recipient: string, resolve: (n: string) => Promise<SnsResult> = resolveSnsOnServer): Promise<SnsCheck | null> {
  const parsed = parseSnsName(name);
  if (!parsed.ok) return null;
  const r = await resolve(parsed.name);
  if (r.ok && r.wallet === recipient) return { state: "verified", name: r.name, source: r.source, warnings: parsed.warnings };
  if (!r.ok && r.code === "unavailable") return { state: "unchecked", name: parsed.name, warnings: parsed.warnings };
  return {
    state: "moved", name: parsed.name, wallet: r.ok ? r.wallet : null, warnings: parsed.warnings,
    message: r.ok ? `${parsed.name} now points to a different wallet than this request pays.` : r.message,
  };
}
