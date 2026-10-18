import "server-only";
import { createHash } from "node:crypto";
import { isoUtc, sql, transaction, type Row } from "../db";
import { ApiError } from "../http";
import { isoSeconds, parseIsoUtc, verifyMessageSignature, verifySignedMessage } from "../verify-signature";
import {
  fetchAutoramp,
  isUuid,
  liquidationOf,
  virtualAccountOf,
  type Autoramp,
  type EnterpriseConfig,
  type PayerRail,
  type PayoutCurrency,
} from "./enterprise";
import { isSolanaAddress } from "./sell";

// The user's own MoonPay Enterprise routes, each stored with the user's wallet signature over exactly what Owed will
// act on (migrations 0023 and 0024):
// - cash_out_accounts (F4): the offramp's liquidation address. The wallet signs
//     "Owed cash-out account <autoramp> to <liquidation address> for <wallet> at <ISO>".
//   Before every transfer the server re-reads the autoramp from MoonPay and requires its Solana deposit rail to be that
//   same address (liquidationGuard); the plugin re-checks the wallet's signature itself before it proposes a transfer.
// - virtual_accounts (F3 bank rail): the onramp's bank details. The wallet signs
//     "Owed bank account <autoramp> details <hash> for <wallet> at <ISO>"
//   where <hash> is the first 16 hex digits of sha256 over the canonical payer-facing details; pages show the details
//   only when that signature verifies over the details they are about to show (bankDetailsGuard).
// Registering is two calls, like a refund: the first reads the route from MoonPay and returns the exact message to sign
// (PayBox request_wallet_sign, op solanaMessage); the second re-reads it and stores the record if the signature is the
// wallet's, at most 5 minutes old, and used once.

export function cashOutAccountPrefix(autorampId: string, liquidation: string, wallet: string): string {
  return `Owed cash-out account ${autorampId} to ${liquidation} for ${wallet}`;
}

export function bankAccountPrefix(autorampId: string, detailsHash: string, wallet: string): string {
  return `Owed bank account ${autorampId} details ${detailsHash} for ${wallet}`;
}

/** JSON with object keys sorted at every level: one byte string per value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface PayerDetails {
  currency: PayoutCurrency;
  rails: PayerRail[];
}

export function detailsHash(details: PayerDetails): string {
  return createHash("sha256").update(canonicalJson(details), "utf8").digest("hex").slice(0, 16);
}

const SIGNED_CASH_OUT = /^Owed cash-out account ([0-9a-f-]{36}) to ([1-9A-HJ-NP-Za-km-z]{32,44}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at (\S+)$/;

/** The parts of a signed cash-out account message, or null if it isn't one. */
export function parseCashOutAccountMessage(message: string): { autorampId: string; liquidation: string; wallet: string; atMs: number } | null {
  const m = SIGNED_CASH_OUT.exec(message);
  if (!m || !isUuid(m[1])) return null;
  const atMs = parseIsoUtc(m[4]);
  return atMs === null ? null : { autorampId: m[1], liquidation: m[2], wallet: m[3], atMs };
}

// ---------------------------------------------------------------- records

export interface CashOutAccount {
  id: string;
  wallet: string;
  providerCustomerId: string;
  liquidationAddress: string;
  currency: PayoutCurrency;
  payoutRail: string;
  signedMessage: string;
  signature: string;
  status: "active" | "closed";
  createdAt: string;
}

const ACCOUNT_COLUMNS = `id, wallet, provider_customer_id, liquidation_address, currency, payout_rail, signed_message, signature, status, ${isoUtc("created_at")} as created_at`;

function accountFromRow(r: Row): CashOutAccount {
  return {
    id: r.id!, wallet: r.wallet!, providerCustomerId: r.provider_customer_id!, liquidationAddress: r.liquidation_address!,
    currency: r.currency as PayoutCurrency, payoutRail: r.payout_rail!, signedMessage: r.signed_message!, signature: r.signature!,
    status: r.status as CashOutAccount["status"], createdAt: r.created_at!,
  };
}

export async function activeCashOutAccount(wallet: string): Promise<CashOutAccount | null> {
  const rows = await sql(`select ${ACCOUNT_COLUMNS} from cash_out_accounts where wallet = $1 and status = 'active'`, [wallet]);
  return rows.length ? accountFromRow(rows[0]) : null;
}

export async function getCashOutAccount(id: string): Promise<CashOutAccount | null> {
  const rows = await sql(`select ${ACCOUNT_COLUMNS} from cash_out_accounts where id = $1`, [id]);
  return rows.length ? accountFromRow(rows[0]) : null;
}

/**
 * Why Owed must not send this wallet's USDC to MoonPay now, or null when it may: the stored record is this wallet's,
 * active, signed by this wallet over exactly this route and address, and MoonPay's own answer for the route (read just
 * now) still names that address as its Solana deposit rail. Pure.
 */
export function liquidationGuard(record: CashOutAccount, autoramp: Autoramp | null, wallet: string): string | null {
  if (record.status !== "active") return "this cash-out account was closed";
  if (record.wallet !== wallet) return "this cash-out account belongs to a different wallet";
  const signed = parseCashOutAccountMessage(record.signedMessage);
  if (!signed || signed.autorampId !== record.id || signed.liquidation !== record.liquidationAddress || signed.wallet !== wallet) {
    return "the stored cash-out account doesn't match the message its wallet signed";
  }
  if (!verifyMessageSignature(record.signedMessage, record.signature, wallet)) return "the stored cash-out account isn't signed by this wallet";
  if (!autoramp) return "MoonPay no longer knows this cash-out route";
  if (autoramp.id !== record.id || autoramp.customerId !== record.providerCustomerId) return "MoonPay answered about a different cash-out route";
  const live = liquidationOf(autoramp);
  if (!live.ok) return live.problem;
  if (live.address !== record.liquidationAddress) return "MoonPay's cash-out address for this route isn't the one this wallet signed for";
  if (live.address === wallet) return "MoonPay's cash-out address is this wallet itself";
  return null;
}

export interface VirtualAccount {
  id: string;
  wallet: string;
  providerCustomerId: string;
  currency: PayoutCurrency;
  rails: string[];
  details: PayerDetails;
  detailsHash: string;
  signedMessage: string;
  signature: string;
  status: "active" | "closed";
  createdAt: string;
}

const VA_COLUMNS = `id, wallet, provider_customer_id, currency, array_to_json(rails)::text as rails, account_details::text as account_details,
  details_hash, signed_message, signature, status, ${isoUtc("created_at")} as created_at`;

function vaFromRow(r: Row): VirtualAccount {
  return {
    id: r.id!, wallet: r.wallet!, providerCustomerId: r.provider_customer_id!, currency: r.currency as PayoutCurrency,
    rails: JSON.parse(r.rails!), details: JSON.parse(r.account_details!) as PayerDetails, detailsHash: r.details_hash!,
    signedMessage: r.signed_message!, signature: r.signature!, status: r.status as VirtualAccount["status"], createdAt: r.created_at!,
  };
}

export async function activeVirtualAccounts(wallet: string): Promise<VirtualAccount[]> {
  return (await sql(`select ${VA_COLUMNS} from virtual_accounts where wallet = $1 and status = 'active' order by currency`, [wallet])).map(vaFromRow);
}

export async function getVirtualAccount(id: string): Promise<VirtualAccount | null> {
  const rows = await sql(`select ${VA_COLUMNS} from virtual_accounts where id = $1`, [id]);
  return rows.length ? vaFromRow(rows[0]) : null;
}

/** Whether these stored bank details are exactly what the recipient's wallet signed for. Pure. */
export function bankDetailsGuard(va: VirtualAccount): string | null {
  if (va.status !== "active") return "this bank account was closed";
  const hash = detailsHash(va.details);
  if (hash !== va.detailsHash) return "the stored bank details changed after the recipient signed them";
  const lead = `${bankAccountPrefix(va.id, hash, va.wallet)} at `;
  if (!va.signedMessage.startsWith(lead) || parseIsoUtc(va.signedMessage.slice(lead.length)) === null) return "the stored bank details don't match the message the recipient signed";
  if (!verifyMessageSignature(va.signedMessage, va.signature, va.wallet)) return "the stored bank details aren't signed by the recipient's wallet";
  return null;
}

// ---------------------------------------------------------------- registering

export interface RegisterInput {
  wallet: string;
  autorampId: string;
  signedMessage?: string;
  signature?: string;
}

export interface RegisterDeps {
  config: EnterpriseConfig;
  fetchAutoramp: typeof fetchAutoramp;
  now: () => number;
}

function checkInput(input: RegisterInput): void {
  if (!isSolanaAddress(input.wallet)) throw new ApiError("invalid_input", "wallet must be a base58 Solana address");
  if (!isUuid(input.autorampId)) throw new ApiError("invalid_input", "autoramp_id must be the MoonPay Enterprise route id (a lower-case UUID)");
  if ((input.signedMessage === undefined) !== (input.signature === undefined)) throw new ApiError("invalid_input", "send both signed_message and signature, or neither");
}

async function readRoute(input: RegisterInput, deps: RegisterDeps): Promise<Autoramp> {
  let autoramp: Autoramp | null;
  try {
    autoramp = await deps.fetchAutoramp(input.autorampId, deps.config);
  } catch (e) {
    console.warn(`moonpay enterprise autoramp ${input.autorampId}: ${e instanceof Error ? e.message : String(e)}`);
    throw new ApiError("upstream_unavailable", "MoonPay Enterprise couldn't be reached to read this route; try again shortly");
  }
  if (!autoramp) throw new ApiError("not_found", `MoonPay Enterprise has no route ${input.autorampId}`);
  return autoramp;
}

/** POST /api/v1/cash-out/accounts: register the wallet's offramp (its liquidation address) for cash_out. */
export async function registerCashOutAccount(input: RegisterInput, deps: RegisterDeps): Promise<{ step: "sign"; messageToSign: string; signBy: string; liquidation: string; currency: PayoutCurrency; rail: string } | { step: "stored"; account: CashOutAccount }> {
  checkInput(input);
  const autoramp = await readRoute(input, deps);
  const live = liquidationOf(autoramp);
  if (!live.ok) throw new ApiError("invalid_input", live.problem);
  if (live.address === input.wallet) throw new ApiError("invalid_input", "MoonPay's cash-out address is this wallet itself");
  const prefix = cashOutAccountPrefix(autoramp.id, live.address, input.wallet);
  if (input.signedMessage === undefined) {
    const now = deps.now();
    return { step: "sign", messageToSign: `${prefix} at ${isoSeconds(now)}`, signBy: isoSeconds(now + 5 * 60_000), liquidation: live.address, currency: live.currency, rail: live.rail };
  }
  await verifySignedMessage("cash_out_account", { message: input.signedMessage, signature: input.signature!, signer: input.wallet, prefix, now: deps.now() });
  await transaction([
    { text: `update cash_out_accounts set status = 'closed' where wallet = $1 and status = 'active' and id <> $2`, params: [input.wallet, autoramp.id] },
    {
      text: `insert into cash_out_accounts (id, wallet, provider_customer_id, liquidation_address, currency, payout_rail, signed_message, signature, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
             on conflict (id) do update set wallet = excluded.wallet, provider_customer_id = excluded.provider_customer_id,
               liquidation_address = excluded.liquidation_address, currency = excluded.currency, payout_rail = excluded.payout_rail,
               signed_message = excluded.signed_message, signature = excluded.signature, status = 'active'`,
      params: [autoramp.id, input.wallet, autoramp.customerId, live.address, live.currency, live.rail, input.signedMessage, input.signature!],
    },
  ]);
  return { step: "stored", account: (await getCashOutAccount(autoramp.id))! };
}

/** POST /api/v1/virtual-accounts: register the recipient's onramp (bank details shown on their invoices). */
export async function registerVirtualAccount(input: RegisterInput, deps: RegisterDeps): Promise<{ step: "sign"; messageToSign: string; signBy: string; details: PayerDetails } | { step: "stored"; account: VirtualAccount }> {
  checkInput(input);
  const autoramp = await readRoute(input, deps);
  const va = virtualAccountOf(autoramp, input.wallet);
  if (!va.ok) throw new ApiError("invalid_input", va.problem);
  const details: PayerDetails = { currency: va.currency, rails: va.rails };
  const hash = detailsHash(details);
  const prefix = bankAccountPrefix(autoramp.id, hash, input.wallet);
  if (input.signedMessage === undefined) {
    const now = deps.now();
    return { step: "sign", messageToSign: `${prefix} at ${isoSeconds(now)}`, signBy: isoSeconds(now + 5 * 60_000), details };
  }
  await verifySignedMessage("bank_account", { message: input.signedMessage, signature: input.signature!, signer: input.wallet, prefix, now: deps.now() });
  await transaction([
    { text: `update virtual_accounts set status = 'closed', updated_at = now() where wallet = $1 and currency = $2 and status = 'active' and id <> $3`, params: [input.wallet, va.currency, autoramp.id] },
    {
      text: `insert into virtual_accounts (id, wallet, provider_customer_id, currency, rails, account_details, details_hash, status, signed_message, signature)
             values ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, 'active', $8, $9)
             on conflict (id) do update set wallet = excluded.wallet, provider_customer_id = excluded.provider_customer_id, currency = excluded.currency,
               rails = excluded.rails, account_details = excluded.account_details, details_hash = excluded.details_hash, status = 'active',
               signed_message = excluded.signed_message, signature = excluded.signature, updated_at = now()`,
      params: [autoramp.id, input.wallet, autoramp.customerId, va.currency, [...new Set(va.rails.map((r) => r.type))], JSON.stringify(details), hash, input.signedMessage, input.signature!],
    },
  ]);
  return { step: "stored", account: (await getVirtualAccount(autoramp.id))! };
}
