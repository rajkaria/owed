import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { incomingTransfers } from "../chain.js";
import { addressSchema, cashOutIdSchema, decimalSchema, requestIdSchema, type CashOutRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT } from "../money.js";
import { proposeSolana, solanaOutputSchema } from "../paybox.js";
import { explorerUrl, shortAddress } from "../text.js";
import { signatureMatches } from "./who_owes_me.js";

// F4 cash out: sell USDC to MoonPay, which pays the user's bank. Owed never holds the money and the plugin only ever
// talks to Owed's server (MoonPay's keys live there). Two calls:
//   1. wallet + amount (or request_ids: paid requests), optional fiat_currency -> Owed's server starts a cash-out and
//      returns MoonPay's sell widget link (signed by the server): the user opens it, finishes MoonPay's checks and bank
//      details, and starts the sale. Nothing moves.
//   2. wallet + cash_out_id (+ the amount from call 1) -> the server re-reads the sale from MoonPay. While MoonPay waits
//      for the deposit, ONE unsigned USDC transfer of exactly that amount from the wallet to the deposit address MoonPay
//      named (or, on MoonPay Enterprise, the liquidation address the wallet itself signed for) comes back for the user to
//      approve with their passkey. Later calls report the status.
// There is no input that takes an address: the only place a transfer can go is the address Owed's server read from
// MoonPay, and the plugin re-checks every term it can before proposing (this wallet, USDC, the exact amount, MoonPay
// waiting for this sale, the wallet's own signature on an Enterprise address, not already sent).

export const CASH_OUT_BUDGET_MS = 8500;
export const CREATE_TIMEOUT_MS = 5000;
/** The server asks MoonPay (up to 3 s) before it answers. */
export const STATUS_TIMEOUT_MS = 5000;
const CHAIN_MS = 2200;

const SELL_HOSTS = ["sell.moonpay.com", "sell-sandbox.moonpay.com"];
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
/** Addresses USDC must never be sent to as if they were a wallet. */
const NEVER = new Set([USDC_MINT, "11111111111111111111111111111111", ...TOKEN_PROGRAMS, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);

export const inputSchema = z.object({
  wallet: addressSchema
    .describe("The user's own PayBox Solana wallet address (from list_credentials): the USDC is sold from it, and MoonPay refunds a sale it can't finish to it."),
  amount: decimalSchema.optional()
    .describe("First call: how much USDC to cash out (whole cents, e.g. \"10\" or \"12.5\"). Second call: the exact amount the first answer gave, so a different amount is never proposed."),
  request_ids: z.array(requestIdSchema).min(1).max(20).optional()
    .describe("First call, instead of amount: Owed request ids already paid to this wallet; cashes out what they brought in (after refunds), rounded down to whole cents."),
  fiat_currency: z.string().regex(/^[A-Za-z]{3}$/).optional()
    .describe("First call, optional: the currency MoonPay pays the bank in, e.g. EUR, GBP or USD. Leave it out to choose in MoonPay."),
  cash_out_id: cashOutIdSchema.optional()
    .describe("Second and later calls: the cash_out_id from the first answer. Returns the transfer to approve once MoonPay waits for it, or where the cash-out stands."),
}).strict();

export const outputSchema = solanaOutputSchema;
export type CashOutInput = z.output<typeof inputSchema>;

const DESCRIPTION = [
  "Cash out USDC from the user's wallet to their bank account through MoonPay (Owed never holds the money).",
  "Use it when the user says \"cash out what Priya paid me\", \"send 50 USDC to my bank\" or \"withdraw my Owed money to my bank\".",
  "First call with wallet (the user's own PayBox Solana wallet from list_credentials) and amount in USDC, or request_ids of requests already paid to that wallet, and optionally fiat_currency: it returns a MoonPay link and a cash_out_id. Nothing moves yet.",
  "The user opens the link, finishes MoonPay's checks (ID the first time) and bank details, and starts the sale. Then call cash_out again with wallet, cash_out_id and the same amount: once MoonPay is waiting for the USDC it returns one unsigned USDC transfer from the wallet to the user's MoonPay cash-out address, for the user to approve in PayBox with their passkey. MoonPay pays the bank after the transfer lands.",
  "Call it again with cash_out_id any time to see where the cash-out stands. MoonPay needs the USDC within 48 hours of starting the sale. MoonPay doesn't buy USDC from residents of every country or US state.",
].join(" ");

const json = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

export async function cashOut(args: CashOutInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => CASH_OUT_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.wallet)) return refusal("wallet must be the user's own PayBox Solana wallet address (from list_credentials).");
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  if (args.cash_out_id !== undefined) {
    if (args.request_ids !== undefined || args.fiat_currency !== undefined) {
      return refusal("With cash_out_id, pass only wallet and amount (the amount the first answer gave). request_ids and fiat_currency belong to the first call.");
    }
    return secondCall(args, args.cash_out_id, ctx, deps, remaining);
  }
  if ((args.amount === undefined) === (args.request_ids === undefined)) {
    return refusal("Pass amount (USDC to cash out) or request_ids (requests already paid to this wallet), not both. Nothing was set up.");
  }
  return firstCall(args, ctx, deps, remaining);
}

function apiFailure(error: unknown, what: string): string {
  if (error instanceof ApiError) {
    if (error.detail && /isn't switched on/.test(error.detail)) return `Cash-out isn't switched on yet on Owed's server (MoonPay's selling keys aren't set up), so ${what}. Nothing moved; the USDC is still in the wallet.`;
    if (error.httpStatus === 404 && error.code === "upstream_unavailable") return `This Owed server doesn't do cash-outs yet, so ${what}. Nothing moved.`;
    if (error.code === "invalid_input" || error.code === "rate_limited") return `Owed refused: ${error.message}. Nothing moved.`;
  }
  return `Owed's server couldn't be reached, so ${what}. Nothing moved; try again shortly.`;
}

/** Why the server's sell widget link isn't the link this cash-out needs, or null. */
export function widgetProblem(res: CashOutRes): string | null {
  if (res.widget_url === null) return "no link";
  let url: URL;
  try {
    url = new URL(res.widget_url);
  } catch {
    return "not a URL";
  }
  const p = url.searchParams;
  if (url.protocol !== "https:" || !SELL_HOSTS.includes(url.host)) return "not MoonPay's sell widget";
  if (p.get("baseCurrencyCode") !== "usdc_sol") return "it doesn't sell USDC on Solana";
  if (p.get("baseCurrencyAmount") !== res.amount || p.get("lockAmount") !== "true") return "it doesn't sell exactly this amount";
  if (p.get("refundWalletAddress") !== res.wallet) return "it refunds a different wallet";
  if (p.get("externalTransactionId") !== res.id) return "it belongs to a different cash-out";
  if (!p.get("signature")) return "it isn't signed";
  return null;
}

// ---------------------------------------------------------------- first call: set up the sale

async function firstCall(args: CashOutInput, ctx: CallContext, deps: Deps, remaining: () => number) {
  let wantAtomic: bigint | null = null;
  if (args.amount !== undefined) {
    try {
      wantAtomic = deps.toAtomic(args.amount, "USDC");
    } catch (error) {
      return refusal(`The amount isn't valid: ${errorText(error, "use a positive decimal amount of USDC.")}`);
    }
  }
  let res: CashOutRes | null;
  try {
    res = await within(
      makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.max(500, Math.min(CREATE_TIMEOUT_MS, remaining() - 300)) }).createCashOut({
        wallet: args.wallet,
        ...(args.amount !== undefined && { amount: args.amount }),
        ...(args.request_ids !== undefined && { request_ids: args.request_ids }),
        ...(args.fiat_currency !== undefined && { fiat_currency: args.fiat_currency }),
      }),
      Math.max(0, remaining() - 200), () => null,
    );
  } catch (error) {
    return refusal(apiFailure(error, "no cash-out was set up"));
  }
  if (!res) return refusal("Owed's server didn't answer in time, so no cash-out was set up. Nothing moved; try again shortly.");
  const bad = "Owed's server answered with a cash-out that doesn't match what was asked, so it wasn't used. Nothing moved.";
  if (res.wallet !== args.wallet || res.token !== "USDC" || res.status !== "created" || res.deposit_address !== null) return refusal(bad);
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(res.amount, "USDC");
  } catch {
    return refusal(bad);
  }
  if (wantAtomic !== null && amountAtomic !== wantAtomic) return refusal(bad);
  if (args.request_ids !== undefined) {
    const asked = [...new Set(args.request_ids)].sort().join(",");
    if ([...res.request_ids].sort().join(",") !== asked) return refusal(bad);
    if (res.requests_total !== undefined && amountAtomic > deps.toAtomic(res.requests_total, "USDC")) return refusal(bad);
  }
  const fromRequests = args.request_ids !== undefined
    ? ` from ${res.request_ids.length} paid request${res.request_ids.length === 1 ? "" : "s"}${res.requests_total !== undefined && res.requests_total !== res.amount ? ` (they brought in ${res.requests_total} USDC after refunds; MoonPay sells whole cents, so the rest stays in the wallet)` : ""}`
    : "";
  const then = { tool: "cash_out", args: { wallet: args.wallet, cash_out_id: res.id, amount: res.amount } };

  if (res.mode === "enterprise") {
    return refusal([
      `Cash-out ${res.id} set up (step 1 of 2): ${res.amount} USDC${fromRequests}, paid out by MoonPay to the bank account on the user's MoonPay cash-out route. Nothing has moved yet.`,
      `Next: call cash_out again with wallet, cash_out_id "${res.id}" and amount "${res.amount}". It checks the cash-out address against the one this wallet signed for and returns one USDC transfer to approve with the passkey.`,
      json({ step: "transfer_next", cash_out_id: res.id, amount: res.amount, token: "USDC", mode: res.mode, then }),
    ].join("\n"));
  }
  const problem = widgetProblem(res);
  if (problem) return refusal(`Owed's server returned a MoonPay link that isn't right for this cash-out (${problem}), so it wasn't shown. Nothing moved.`);
  return refusal([
    `Cash-out ${res.id} set up (step 1 of 2): sell ${res.amount} USDC${fromRequests} to MoonPay${res.fiat_currency ? `, paid to the bank in ${res.fiat_currency.toUpperCase()}` : ""}. Nothing has moved yet.`,
    "1. Open this MoonPay link (it sells exactly this amount and refunds to this wallet if MoonPay can't finish):",
    res.widget_url!,
    "2. Finish MoonPay's checks (ID the first time) and bank details, and start the sale.",
    `3. Then call cash_out again with wallet, cash_out_id "${res.id}" and amount "${res.amount}": once MoonPay is waiting for the USDC, it returns one transfer from this wallet to the user's MoonPay cash-out address to approve with the passkey. MoonPay pays the bank after it lands.`,
    "MoonPay needs the USDC within 48 hours of starting the sale.",
    json({ step: "open_link", cash_out_id: res.id, amount: res.amount, token: "USDC", widget_url: res.widget_url, then }),
  ].join("\n"));
}

// ---------------------------------------------------------------- second call: the transfer, or the status

const SIGNED_ACCOUNT = /^Owed cash-out account ([0-9a-f-]{36}) to ([1-9A-HJ-NP-Za-km-z]{32,44}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Enterprise: the wallet's own signature must name exactly this route and this address. Null when it does. */
export function accountProblem(res: CashOutRes, wallet: string): string | null {
  const a = res.account;
  if (!a) return "the server sent no signed cash-out account";
  if (a.liquidation_address !== res.deposit_address) return "the cash-out address isn't the one in the signed account";
  const m = SIGNED_ACCOUNT.exec(a.signed_message);
  if (!m || m[1] !== a.id || m[2] !== res.deposit_address || m[3] !== wallet) return "the signed account doesn't name this route, address and wallet";
  if (!signatureMatches(a.signed_message, a.signature, wallet)) return "the cash-out account isn't signed by this wallet";
  return null;
}

async function secondCall(args: CashOutInput, id: string, ctx: CallContext, deps: Deps, remaining: () => number) {
  let res: CashOutRes | null;
  try {
    res = await within(
      makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.max(500, Math.min(STATUS_TIMEOUT_MS, remaining() - 3000)) }).getCashOut(id, args.wallet),
      Math.max(0, remaining() - 2800), () => null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found" && error.httpStatus === 404 && !/^Owed's server/.test(error.message)) {
      return refusal(`This wallet has no cash-out ${id}. Check the cash_out_id and the wallet (a cash-out can only be read by the wallet that started it).`);
    }
    return refusal(apiFailure(error, "the cash-out couldn't be checked"));
  }
  if (!res) return refusal("Owed's server didn't answer in time (it asks MoonPay first). Nothing moved; try again shortly.");
  if (res.id !== id) return refusal("Owed's server answered about a different cash-out, so nothing was proposed.");
  if (res.wallet !== args.wallet) return refusal(`Cash-out ${id} belongs to ${shortAddress(res.wallet)}, not this wallet, so nothing was proposed.`);
  if (res.token !== "USDC") return refusal("Owed's server returned a cash-out that isn't USDC, so nothing was proposed.");
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(res.amount, "USDC");
  } catch {
    return refusal("Owed's server returned a cash-out amount it can't read, so nothing was proposed.");
  }
  if (args.amount !== undefined) {
    let asked: bigint | null;
    try {
      asked = deps.toAtomic(args.amount, "USDC");
    } catch {
      asked = null;
    }
    if (asked !== amountAtomic) return refusal(`Cash-out ${id} is for ${res.amount} USDC, not ${args.amount} USDC, so nothing was proposed. Check the amount in the first answer.`);
  }
  const link = res.mode === "sell_widget" && res.widget_url && widgetProblem(res) === null ? res.widget_url : null;
  const status = (lines: string[]) => refusal([...lines, json({ cash_out_id: res.id, status: res.status, amount: res.amount, token: "USDC", moonpay_transaction_id: res.moonpay_transaction_id, transfer_signature: res.transfer_signature })].join("\n"));

  switch (res.status) {
    case "completed":
      return status([`Cash-out ${id} is done: MoonPay received ${res.amount} USDC${res.transfer_signature ? ` (${txLink(res.transfer_signature)})` : ""} and paid it out to the bank. Bank transfers can take a day or two to show.`]);
    case "pending":
      return status([`MoonPay received the ${res.amount} USDC for cash-out ${id}${res.transfer_signature ? ` (${txLink(res.transfer_signature)})` : ""} and is paying the bank now. Nothing more to send.`]);
    case "failed":
      return status([
        `MoonPay ended the sale for cash-out ${id}${res.failure_reason ? `: "${res.failure_reason.slice(0, 200)}"` : ""}. Nothing more will be sent for it.`,
        ...(link ? [`To try again, open the same link and start a new sale, then call cash_out with this cash_out_id again: ${link}`] : ["Start a new cash-out with cash_out to try again."]),
      ]);
    case "created":
    case "requote_required":
      return status([
        `No transfer yet for cash-out ${id}: ${res.problem ?? "MoonPay isn't waiting for the USDC yet"}.`,
        ...(link ? [`The MoonPay link for it: ${link}`] : []),
        `Call cash_out again with wallet, cash_out_id "${id}" and amount "${res.amount}" once the sale is started.`,
      ]);
    case "waiting_for_deposit":
      break;
  }
  if (!res.deposit_address) {
    return status([`MoonPay is waiting for the USDC, but no transfer can be proposed yet: ${res.problem ?? "Owed doesn't have MoonPay's deposit address yet"}. Call cash_out again in a minute.`]);
  }
  const deposit = res.deposit_address;
  if (!deps.isSolanaAddress(deposit) || NEVER.has(deposit)) return refusal("Owed's server returned a cash-out address that isn't a Solana wallet, so nothing was proposed.");
  if (deposit === args.wallet) return refusal("Owed's server returned this wallet itself as the cash-out address, so nothing was proposed.");
  if (res.mode === "enterprise") {
    const problem = accountProblem(res, args.wallet);
    if (problem) return refusal(`The MoonPay cash-out address can't be trusted (${problem}), so nothing was proposed.`);
  } else if (!res.moonpay_transaction_id) {
    return refusal("Owed's server released a deposit address without naming MoonPay's sale, so nothing was proposed.");
  }
  const screening = await deps.screenRecipient(deposit, deps);
  if (!screening.ok) return refusal(`${screening.message} Nothing was proposed.`);

  // Three reads at once: what the address is, whether this wallet already sent this cash-out, and whether it can send.
  const chainMs = Math.max(0, Math.min(CHAIN_MS, remaining() - 900));
  const rpc = deps.rpc();
  const sinceUnix = Math.floor(Date.parse(res.created_at) / 1000) - 120;
  const [info, scan, ready] = await Promise.all([
    within(rpc.call<{ value: { owner?: string } | null } | null>("getAccountInfo", [deposit, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]).catch(() => undefined), chainMs, () => undefined),
    within(incomingTransfers(rpc, { recipient: deposit, token: "USDC", sinceUnix }, chainMs).catch(() => null), chainMs + 100, () => null),
    within(deps.payerReadiness(rpc, { sender: args.wallet, recipient: deposit, token: "USDC", amountAtomic }, chainMs).catch(() => null), chainMs + 100, () => null),
  ]);
  if (info?.value?.owner && TOKEN_PROGRAMS.includes(info.value.owner)) {
    return refusal("MoonPay's cash-out address is a token account, not a wallet, so a normal USDC transfer to it would be lost. Nothing was proposed; contact MoonPay support with the cash-out id.");
  }
  const already = scan?.transfers.find((t) => t.payer === args.wallet && t.amountAtomic === amountAtomic);
  if (already) {
    return status([`This wallet already sent ${res.amount} USDC to the MoonPay cash-out address for ${id} (${txLink(already.signature)}). MoonPay shows it shortly; don't send it again. Call cash_out with this cash_out_id later to see the payout.`]);
  }
  if (!ready) return refusal("Solana couldn't be reached to check the wallet's balance, so nothing was proposed. Try again in a moment.");
  if (!ready.ok) return refusal(`This wallet can't send the cash-out right now: ${(ready.reason ?? "it can't cover the amount and fees.").replace("this request is", "the cash-out is")} Nothing was proposed.`);

  let structuredContent;
  try {
    const built = deps.buildTransferTx({
      sender: args.wallet,
      request: { recipient: deposit, amount: res.amount, splToken: USDC_MINT, references: [] },
      token: "USDC",
      amountAtomic,
      createRecipientAta: !ready.recipientAtaExists,
    });
    structuredContent = proposeSolana({ transactionBase64: built.transactionBase64 }).structuredContent;
  } catch (error) {
    return refusal(`Couldn't build the cash-out transfer: ${errorText(error, "unknown error")}. Nothing was proposed.`);
  }
  const notes = [
    ...(!ready.recipientAtaExists ? ["This also opens the cash-out address's USDC account (about 0.002 SOL, paid by this wallet)."] : []),
    ...(scan === null ? ["Solana's history couldn't be read just now to confirm this wasn't already sent: if the user already approved a transfer for this cash-out, don't approve this one."] : []),
  ];
  return {
    content: [{
      type: "text" as const,
      text: [
        `To your MoonPay cash-out address, paid out to your bank: ${res.amount} USDC from ${shortAddress(args.wallet)} to ${deposit} (cash-out ${id}${res.mode === "enterprise" ? ", the address this wallet signed for" : `, MoonPay sale ${res.moonpay_transaction_id}`}). Approve it in PayBox with the passkey.`,
        "MoonPay pays the bank once the transfer lands; call cash_out with this cash_out_id to see the payout.",
        ...notes,
      ].join("\n"),
    }],
    structuredContent,
  };
}

const txLink = (signature: string) => (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature) ? explorerUrl(signature) : `transaction ${signature.slice(0, 20)}`);

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("cash_out", {
    title: "Cash out to a bank",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args) => cashOut(args, deps));
}
