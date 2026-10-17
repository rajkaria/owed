import { baseUrl, readJson } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { buildRequestTx, payerKey, PayTxError } from "@/lib/pay-tx";
import { getRequest, isBaseRow, settleFromChain, type RequestRow } from "@/lib/requests";
import { rpcBatch } from "@/lib/solana";

export const runtime = "nodejs";

// Solana Pay transaction request for one Owed request: the QR code and "Open in wallet" point
// here (solana:https://…/api/v1/pay/<id>) so the wallet signs a transaction this server built,
// with the request's reference and memo in it (see lib/pay-tx.ts for why).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Encoding",
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
    return Response.json({ transaction, message: `Owed request ${row.id}. The money goes straight to the recipient.` }, { headers: CORS });
  } catch (e) {
    console.error("transaction request failed", e);
    return refuse(503, "upstream_unavailable", "Owed couldn't prepare this payment. Try again in a moment.");
  }
}
