import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, tokenSchema, type GetRequestRes } from "../contract.js";
// W3-B Base requests start
import { evmAddressSchema } from "../contract.js";
import { checkBaseTerms } from "../base-request.js";
import { parseEvmAddress } from "../evm.js";
// W3-B Base requests end
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import {
  DOH_HOSTS, domainLabel, normalizeDomain, PAYEE_BUDGET_MS, RECORD_LABEL, RECORD_PREFIX, verifyPayee, type PayeeResult,
} from "../payee.js";
import { idMatchesTerms, VERIFIED_ID_LENGTH } from "../request-id.js";
import type { TransferRequest } from "../solana-pay.js";
import { clean, shortAddress } from "../text.js";
// W3-S SNS names start
import { snsSourceSchema } from "../contract.js";
import { pointsTo, sourceText, type SnsResult } from "../sns.js";
import { resolveName, SNS_BUDGET_MS } from "../sns-payee.js";
// W3-S SNS names end

export const inputSchema = z.object({
  link: z.string().min(1).max(2048).optional().describe("An Owed link or id, or a Solana Pay transfer link (solana:...): checks the domain the request claims against the wallet it pays."),
  address: z.union([addressSchema, evmAddressSchema]).optional().describe("A Solana (or Base 0x) wallet address to check, together with domain (instead of link)."), // W3-B: 0x
  domain: z.string().min(1).max(253).optional().describe("The domain to check, e.g. \"example.com\". Required with address. With link, checks the link's wallet against this domain instead of the one the request claims (use it when the user expects a particular sender)."),
  name: z.string().min(1).max(140).optional().describe("An SNS name to check, e.g. \"example.sns\": Owed reads Solana itself and says which wallet it points to. Alone, it resolves the name; with link or address, it checks that the name points to that wallet. A link to a request made for an SNS name is checked against that name automatically."), // W3-S
}).strict();

export const statusSchema = z.enum(["verified", "unverified", "dns_unavailable", "invalid_domain", "no_domain"]);

export const outputSchema = z.object({
  status: statusSchema.describe("verified: the domain publishes this wallet in DNS. no_domain: the request names no domain."),
  domain: z.string().describe("The DNS name checked, lower-case ASCII (punycode for internationalized names); empty if none."),
  display_domain: z.string().describe("The domain as people read it (Unicode)."),
  dnssec: z.boolean().describe("The resolver validated the answer with DNSSEC."),
  records: z.number().int().nonnegative().describe("owed-pay= records the domain publishes, for any wallet."),
  warnings: z.array(z.string()).describe("Lookalike and internationalized-name warnings to show the user."),
  address: z.string().describe("The wallet that was checked (the request's recipient when given a link)."),
  record_name: z.string().nullable().describe("Where the domain must publish the record: _owed.<domain>."),
  expected_record: z.string().describe("The TXT value that verifies this wallet: owed-pay=<address>."),
  request_id: z.string().nullable().optional(),
  claimed_domain: z.string().nullable().optional().describe("The domain the request itself claims, if any."),
  amount: z.string().nullable().optional(),
  token: tokenSchema.optional(),
  request_status: z.string().optional(),
  // W3-S SNS names start
  sns: z.object({
    name: z.string().nullable().describe("The name checked, normalized (lower-case); null if it isn't a name Owed accepts."),
    status: z.enum(["verified", "resolved", "mismatch", "invalid_name", "sol_tld", "not_found", "tokenized", "bad_record", "no_wallet", "unavailable"])
      .describe("verified: the name points to address. resolved: name given alone, wallet is what it points to. mismatch: it points to another wallet."),
    wallet: z.string().nullable().describe("The wallet the name points to right now, if any."),
    source: snsSourceSchema.nullable().describe("Which SNS rule picked the wallet."),
    warnings: z.array(z.string()),
    message: z.string().optional().describe("Why the name couldn't be resolved."),
  }).optional().describe("The SNS name check, when a name was given or the request names one."),
  // W3-S SNS names end
}).strict();

export type VerifyInput = z.output<typeof inputSchema>;
export type VerifyOutput = z.output<typeof outputSchema>;

/** One API read plus both DoH resolvers inside PayBox's 10 s per call. */
export const VERIFY_BUDGET_MS = 8500;

const DESCRIPTION = [
  "Check who a payment request is from: whether a domain publishes the wallet that gets paid, read from DNS by the plugin itself (record _owed.<domain>, value owed-pay=<wallet>), never from Owed's server.",
  "Use it when the user asks \"is this really from example.com?\", \"who is this request from?\", or before paying a request from a business.",
  "Pass link (an Owed link or id, or a Solana Pay link) to check the domain the request claims, optionally with domain to check against the sender the user expects; or pass address and domain.",
  "Verified means the domain publishes the wallet: it proves who controls the domain, not that the request is fair. Always show the full domain and any warnings, which flag lookalike spellings and internationalized names.",
  "pay_link runs the same check automatically before paying a request that names a domain.",
  "Pass name (an SNS name like example.sns) to see which wallet it points to on Solana, or with link/address to check it points there; Owed refuses .sol names (SNS moved to .sns), tokenized names and names with lookalike characters.", // W3-S
].join(" ");

interface Target {
  address: string;
  claimed: string | null;
  requestId: string | null;
  amount: string | null;
  token?: Token;
  requestStatus?: string;
  snsName?: string | null; // W3-S: the SNS name the request was made for
}

export async function verifyPayeeTool(args: VerifyInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  if (args.link !== undefined && args.address !== undefined) return refusal("Pass either link, or address with domain, not both.");
  if (args.link === undefined && args.name === undefined && (args.address === undefined || args.domain === undefined)) { // W3-S: or name
    return refusal("Pass link (an Owed or Solana Pay link), both address and domain, or an SNS name.");
  }

  let target: Target;
  let snsDone: SnsResult | undefined; // W3-S: a name given alone, already resolved
  if (args.link !== undefined) {
    let ctx: CallContext;
    try {
      ctx = callContext(deps);
    } catch (error) {
      return refusal(errorText(error, "Owed is misconfigured."));
    }
    const resolved = await resolveLink(args.link.trim(), ctx, deps);
    if (typeof resolved === "string") return refusal(resolved);
    target = resolved;
  } else if (args.address === undefined) {
    // W3-S: a name alone resolves to the wallet it points to; a domain given with it is checked against that wallet.
    const named = await resolveName(args.name!, deps, SNS_BUDGET_MS);
    if (!named.ok) {
      const output: VerifyOutput = {
        status: "no_domain", domain: "", display_domain: "", dnssec: false, records: 0, warnings: [],
        address: "", record_name: null, expected_record: "", sns: snsOutput(named, null),
      };
      return { content: [{ type: "text" as const, text: `Couldn't resolve the name: ${named.message}` }], structuredContent: output };
    }
    target = { address: named.wallet, claimed: null, requestId: null, amount: null, snsName: named.name };
    snsDone = named;
  } else {
    // W3-B Base requests start: a Base (0x) wallet is checked in its EIP-55 form.
    const evm = args.address!.startsWith("0x") ? parseEvmAddress(args.address!) : null;
    if (args.address!.startsWith("0x") && !evm) return refusal("That Base address has a wrong checksum (mixed case); copy it again.");
    // W3-B Base requests end
    if (!evm && !deps.isSolanaAddress(args.address!)) return refusal("address must be a Solana wallet address.");
    target = { address: evm ?? args.address!, claimed: null, requestId: null, amount: null };
  }

  const domain = args.domain ?? target.claimed;
  const expected_record = `${RECORD_PREFIX}${target.address}`;
  // W3-S SNS names start: the name asked about, or the one the request was made for, against the wallet.
  const snsName = args.name ?? target.snsName ?? null;
  const snsPromise = snsName === null ? undefined
    : snsDone ? Promise.resolve(snsDone)
      : target.address.startsWith("0x") ? Promise.resolve<SnsResult>({ ok: false, name: null, code: "no_wallet", message: "SNS names point to Solana wallets, and this is a Base (0x) address." })
        : resolveName(snsName, deps, Math.min(SNS_BUDGET_MS, VERIFY_BUDGET_MS - (deps.now() - started)));
  const snsResult = snsPromise ? await snsPromise : undefined;
  const sns = snsResult ? snsOutput(snsResult, snsDone ? null : target.address) : undefined;
  const snsText = snsResult ? snsTextLines(snsResult, snsDone ? null : target.address, target.snsName ?? null) : [];
  // W3-S SNS names end
  const extra = {
    ...(args.link !== undefined && { request_id: target.requestId, claimed_domain: target.claimed, amount: target.amount }),
    ...(target.token && { token: target.token }),
    ...(target.requestStatus && { request_status: target.requestStatus }),
    ...(sns && { sns }), // W3-S
  };

  if (domain === null || domain === undefined) {
    const output: VerifyOutput = {
      status: "no_domain", domain: "", display_domain: "", dnssec: false, records: 0, warnings: [],
      address: target.address, record_name: null, expected_record, ...extra,
    };
    const text = (sns ? [...snsText, requestLine(target)] : [ // W3-S: a name check stands on its own
      `This request doesn't name a domain, so there's nothing to verify. It pays ${target.address}.`,
      requestLine(target),
      "To check it against a domain you expect, call verify_payee again with that domain.",
    ]).filter(Boolean).join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }

  const payee = await verifyPayee(domain, target.address, Math.min(PAYEE_BUDGET_MS, VERIFY_BUDGET_MS - (deps.now() - started)), deps);
  const output: VerifyOutput = {
    ...payee, address: target.address,
    record_name: payee.domain ? `${RECORD_LABEL}.${payee.domain}` : null, expected_record, ...extra,
  };
  const lines = [...mismatchLine(args.domain, target.claimed), ...resultLines(payee, target.address, domain), requestLine(target), ...payee.warnings, ...snsText]; // W3-S: + the name check
  return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }], structuredContent: output };
}

function resultLines(payee: PayeeResult, address: string, asked: string): string[] {
  const label = domainLabel(payee);
  const wallet = shortAddress(address);
  switch (payee.status) {
    case "verified":
      return [
        `Verified: ${label} publishes this wallet (${wallet}) in its DNS${payee.dnssec ? ", DNSSEC-signed" : " (not DNSSEC-signed)"}.`,
        `That proves who controls ${payee.domain}, not that the request is fair: still check the amount and what it's for.`,
      ];
    case "unverified":
      return [
        `Not verified: ${label} does not publish this wallet (${wallet}). Don't treat this request as coming from ${payee.domain}.`,
        payee.records > 0
          ? `${RECORD_LABEL}.${payee.domain} lists ${payee.records === 1 ? "1 Owed wallet" : `${payee.records} Owed wallets`}, none of them this one.`
          : `${RECORD_LABEL}.${payee.domain} has no Owed record.`,
      ];
    case "dns_unavailable":
      return [`Couldn't check ${label}: DNS didn't answer (${DOH_HOSTS.join(", ")}). Nothing is known either way; try again shortly.`];
    case "invalid_domain":
      return [`"${clean(asked, 60)}" isn't a domain name Owed can check.`];
  }
}

/** When the user names a domain that differs from the one the request claims, say so first. */
function mismatchLine(asked: string | undefined, claimed: string | null): string[] {
  if (asked === undefined || claimed === null) return [];
  const a = normalizeDomain(asked);
  const c = normalizeDomain(claimed);
  if (a && c && a.ascii === c.ascii) return [];
  const claimedText = c ? domainLabel({ domain: c.ascii, display_domain: c.unicode }) : `"${clean(claimed, 60)}"`;
  const askedText = a ? domainLabel({ domain: a.ascii, display_domain: a.unicode }) : `"${clean(asked, 60)}"`;
  return [`This request claims to be from ${claimedText}, not ${askedText}.`];
}

function requestLine(t: Target): string {
  if (t.amount === null && !t.token) return "";
  const amount = t.amount !== null && t.token ? `${t.amount} ${t.token}` : t.token ? `an open amount of ${t.token}` : "";
  return `Request: ${amount}${t.requestStatus ? ` (${t.requestStatus})` : ""}.`;
}

function tokenOf(r: TransferRequest): Token | null {
  if (r.splToken === undefined) return "SOL";
  return r.splToken === USDC_MINT ? "USDC" : null;
}

async function resolveLink(link: string, ctx: CallContext, deps: Deps): Promise<Target | string> {
  let parsed;
  try {
    parsed = deps.parseLink(link, ctx.hosts);
  } catch (error) {
    return errorText(error, "This isn't a payment link Owed can read.");
  }
  if (parsed.kind === "transaction") {
    return "This is a Solana Pay checkout link (transaction request): the wallet it pays isn't in the link, so there is nothing to verify.";
  }
  if (parsed.kind === "transfer") {
    const token = tokenOf(parsed.request);
    if (!token) return "Owed reads USDC or SOL links only.";
    return { address: parsed.request.recipient, claimed: null, requestId: null, amount: parsed.request.amount ?? null, token };
  }

  const id = parsed.id;
  if (id.length !== VERIFIED_ID_LENGTH) {
    return "This is an older Owed link whose payment details can't be checked against its id. Ask the requester for a new link.";
  }
  let rq: GetRequestRes;
  try {
    rq = await ctx.api.getRequest(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return `No Owed request has the id ${id}. Check the link with the requester.`;
    if (error instanceof ApiError && error.code === "upstream_unavailable") {
      return "Owed's server is unreachable, so this link can't be read right now. Try again shortly, or pass the wallet address and domain instead.";
    }
    return `Owed couldn't load this request: ${errorText(error, "unknown error")}`;
  }
  // W3-B Base requests start: a Base request's terms are checked against its id the same way.
  if (rq.chain === "base") {
    const terms = checkBaseTerms(rq, id, deps);
    if (typeof terms === "string") return terms;
    return { address: terms.recipient, claimed: rq.from_domain ?? null, requestId: rq.id, amount: deps.fromAtomic(terms.amountAtomic, "USDC"), token: "USDC", requestStatus: rq.status };
  }
  if (rq.solana_pay_url === null) return "Owed's server returned a payment link it can't read.";
  // W3-B Base requests end
  // Same rule as pay_link: the id is a hash of the terms, so the server can't swap the wallet behind it.
  let inner;
  try {
    inner = deps.parseLink(rq.solana_pay_url, ctx.hosts);
  } catch {
    return "Owed's server returned a payment link it can't read.";
  }
  const tampered = "This link's payment details don't match its id: the recipient or amount may have been changed after the link was made. Don't pay it; ask the requester for a new link.";
  const token = inner.kind === "transfer" ? tokenOf(inner.request) : null;
  if (inner.kind !== "transfer" || token === null || token !== rq.token || inner.request.recipient !== rq.recipient || rq.id !== id
    || inner.request.amount === undefined || !inner.request.references.includes(rq.reference)) {
    return tampered;
  }
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(rq.amount, token);
    if (deps.toAtomic(inner.request.amount, token) !== amountAtomic) return tampered;
  } catch {
    return tampered;
  }
  if (!idMatchesTerms(id, { recipient: rq.recipient, token, amountAtomic, reference: rq.reference })) return tampered;
  return {
    address: rq.recipient, claimed: rq.from_domain ?? null, requestId: rq.id,
    amount: deps.fromAtomic(amountAtomic, token), token, requestStatus: rq.status,
    snsName: rq.sns_name ?? null, // W3-S
  };
}

// W3-S SNS names start
/** The structured name check. `expected` is the wallet it must point to, or null when the name was given alone. */
function snsOutput(r: SnsResult, expected: string | null): NonNullable<VerifyOutput["sns"]> {
  if (!r.ok) return { name: r.name, status: r.code, wallet: null, source: null, warnings: [], message: r.message };
  const status = expected === null ? "resolved" : r.wallet === expected ? "verified" : "mismatch";
  return { name: r.name, status, wallet: r.wallet, source: r.source, warnings: r.warnings };
}

function snsTextLines(r: SnsResult, expected: string | null, requestName: string | null): string[] {
  const madeFor = requestName ? ` This request was made for ${requestName}.` : "";
  if (!r.ok) return [`Name not verified: ${r.message}${madeFor}`];
  if (expected === null) {
    return [`${pointsTo(r.name, r.wallet, r.source)}: ${r.wallet}. Read from Solana just now; it proves who controls the name, not that a request is fair.`, ...r.warnings];
  }
  if (r.wallet === expected) {
    return [`Verified on-chain: ${pointsTo(r.name, r.wallet, r.source)}, the wallet this pays. That proves who controls the name, not that the request is fair.`, ...r.warnings];
  }
  return [`Not verified: ${r.name} points to ${shortAddress(r.wallet)} (${sourceText(r.source)}), not to ${shortAddress(expected)}, the wallet this pays. Don't treat it as ${r.name}'s.${madeFor}`, ...r.warnings];
}
// W3-S SNS names end

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("verify_payee", {
    title: "Check who a payment request is from",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => verifyPayeeTool(args, deps));
}
