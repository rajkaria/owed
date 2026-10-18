import { ApiError, baseUrl, readJson } from "@/lib/http";
import { fromAtomic } from "@/lib/money";
import { isRequestId } from "@/lib/ids";
import { buildRequestTx, payerKey, PayTxError } from "@/lib/pay-tx";
import { getRequest, isBaseRow, settleFromChain, type RequestRow } from "@/lib/requests";
import { requireNotSanctioned } from "@/lib/sanctions";
import { rpcBatch } from "@/lib/solana";
// F7 pots start
import { isPotId } from "@/lib/ids";
import { contributionAmount, getPot, mintContribution, potAmount, potEndedText, requireContributionSlot } from "@/lib/pots";
import { requireSolMinimum } from "@/lib/sol-minimum";
// F7 pots end

export const runtime = "nodejs";

// Solana Pay transaction request for one Owed request: the QR code and "Open in wallet" point
// here (solana:https://…/api/v1/pay/<id>) so the wallet signs a transaction this server built,
// with the request's reference and memo in it (see lib/pay-tx.ts for why).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Cache-Control": "no-store",
};

/** Wallets read `message`; the {error:{code,message}} shape keeps the API contract for everyone else. */
function refuse(status: number, code: string, message: string): Response {
  return Response.json({ message, error: { code, message } }, { status, headers: CORS });
}

const STATUS_TEXT: Partial<Record<RequestRow["status"], string>> = {
  paid: "This request is already paid.",
  underpaid: "Part of this request was already paid. Ask for a new link for the rest.",
  cancelled: "This request was cancelled. Don't pay it.",
  expired: "This request has expired. Ask for a new link.",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request): Promise<Response> {
  const base = baseUrl(req);
  return Response.json({ label: "Owed", icon: `${base}/icon.svg` }, { headers: CORS });
}

export async function POST(req: Request, ctx: RouteContext<"/api/v1/pay/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (isPotId(id)) return await potTransaction(req, id); // F7 pots: each scan mints a fresh contribution
    if (!isRequestId(id)) return refuse(400, "invalid_input", "This isn't an Owed request id.");
    const body = (await readJson(req)) as { account?: unknown } | null;
    let payer;
    try {
      payer = payerKey(body?.account);
    } catch (e) {
      return refuse(400, "invalid_input", e instanceof PayTxError ? e.message : "account must be a Solana address");
    }

    let row = await getRequest(id);
    if (!row) return refuse(404, "not_found", "No Owed request with this id.");
    if (isBaseRow(row)) return refuse(400, "invalid_input", "This request is paid on Base, not Solana.");
    // W2-E: never hand out a transaction that pays an address on OFAC's SDN list.
    try {
      requireNotSanctioned(row.recipient);
    } catch (e) {
      if (e instanceof ApiError) return refuse(403, e.code, e.message);
      throw e;
    }
    // Never hand out a transaction for something that's already been paid.
    try {
      [row] = await settleFromChain([row], { deadline: Date.now() + 1500, timeoutMs: 1500 });
    } catch {
      // Chain unreadable: fall back to the stored status.
    }
    const blocked = STATUS_TEXT[row.status];
    if (blocked) return refuse(400, "invalid_input", blocked);

    const [latest] = (await rpcBatch([{ method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }], { timeoutMs: 2500 })) as [
      { value?: { blockhash?: string } } | null,
    ];
    const blockhash = latest?.value?.blockhash;
    if (!blockhash) return refuse(503, "upstream_unavailable", "Solana is busy. Try again in a moment.");

    let transaction: string;
    try {
      transaction = buildRequestTx(row, payer, blockhash);
    } catch (e) {
      return refuse(400, "invalid_input", e instanceof PayTxError ? e.message : "This payment couldn't be built.");
    }
    // Shown by the wallet as Owed's words, so never requester-written text: the verified payee domain or the address.
    const who = row.fromDomain && row.fromDomainVerifiedAt ? row.fromDomain : `${row.recipient.slice(0, 4)}…${row.recipient.slice(-4)}`;
    const message = `Pay ${fromAtomic(row.amountAtomic, row.token)} ${row.token} to ${who}`;
    return Response.json({ transaction, message }, { headers: CORS });
  } catch (e) {
    console.error("transaction request failed", e);
    return refuse(503, "upstream_unavailable", "Owed couldn't prepare this payment. Try again in a moment.");
  }
}

// F7 pots start
const API_STATUS: Record<ApiError["code"], number> = { invalid_input: 400, blocked: 403, not_found: 404, rate_limited: 429, upstream_unavailable: 503 };

/**
 * A pot's QR code: solana:https://…/api/v1/pay/<pot id>?amount=<x>. Each POST mints a fresh contribution (its own
 * reference, so each scan is paid and counted on its own) and returns the same transaction as for any request:
 * ATA create (idempotent), memo owed:<contribution id>, transfer with the reference. Without ?amount= the pot's
 * suggested amount is used; with neither, the payer is sent to the pot page to pick one. Every check that can refuse
 * runs before the row is written, and the blockhash is read first, so a refused or busy scan mints nothing.
 */
async function potTransaction(req: Request, id: string): Promise<Response> {
  const body = (await readJson(req).catch(() => null)) as { account?: unknown } | null;
  let payer;
  try {
    payer = payerKey(body?.account);
  } catch (e) {
    return refuse(400, "invalid_input", e instanceof PayTxError ? e.message : "account must be a Solana address");
  }
  const base = baseUrl(req);
  const pot = await getPot(id);
  if (!pot) return refuse(404, "not_found", "No Owed pot with this id.");
  if (pot.ended) return refuse(400, "invalid_input", potEndedText(pot));
  let amount: bigint;
  try {
    requireNotSanctioned(pot.recipient);
    const asked = new URL(req.url).searchParams.get("amount");
    if (asked === null && pot.suggestedAtomic === null) {
      return refuse(400, "invalid_input", `This pot has no set amount. Pick an amount on the pot page: ${base}/pot/${pot.id}`);
    }
    amount = contributionAmount(pot, asked === null ? null : potAmount(asked, pot.token, "amount"), base);
  } catch (e) {
    if (e instanceof ApiError) return refuse(API_STATUS[e.code], e.code, e.message);
    throw e;
  }
  if (payer.toBase58() === pot.recipient) return refuse(400, "invalid_input", "This wallet is the one being paid. Pay from a different wallet.");

  const [latest] = (await rpcBatch([{ method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }], { timeoutMs: 2500 })) as [
    { value?: { blockhash?: string } } | null,
  ];
  const blockhash = latest?.value?.blockhash;
  if (!blockhash) return refuse(503, "upstream_unavailable", "Solana is busy. Try again in a moment.");

  let row: RequestRow;
  try {
    if (pot.token === "SOL") await requireSolMinimum(pot.recipient, amount, "amount");
    await requireContributionSlot(req, pot.id, payer.toBase58());
    row = await mintContribution(pot, amount, "web");
  } catch (e) {
    if (e instanceof ApiError) return refuse(API_STATUS[e.code], e.code, e.message);
    throw e;
  }
  let transaction: string;
  try {
    transaction = buildRequestTx(row, payer, blockhash);
  } catch (e) {
    return refuse(400, "invalid_input", e instanceof PayTxError ? e.message : "This payment couldn't be built.");
  }
  // Owed's words only: never the requester-written title.
  const message = `Contribute ${fromAtomic(row.amountAtomic, row.token)} ${row.token} to ${row.recipient.slice(0, 4)}…${row.recipient.slice(-4)}`;
  return Response.json({ transaction, message }, { headers: CORS });
}
// F7 pots end
