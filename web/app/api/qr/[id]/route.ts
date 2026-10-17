import QRCode from "qrcode";
import { errorResponse, toErrorResponse } from "@/lib/http";
import { getRequest, payUrl } from "@/lib/requests";

export const runtime = "nodejs";

const FILE = /^([1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?)\.(png|svg)$/;
const MIN_SIZE = 128;
const MAX_SIZE = 1024;
const DEFAULT_SIZE = 512;

/** GET /api/qr/:id.png | :id.svg?size= — QR code of the request's Solana Pay URL (W3-B: its EIP-681 link on Base). */
export async function GET(req: Request, ctx: RouteContext<"/api/qr/[id]">): Promise<Response> {
  try {
    const match = FILE.exec((await ctx.params).id);
    if (!match) return errorResponse("not_found", "use /api/qr/<id>.png or /api/qr/<id>.svg");
    const [, id, format] = match;

    const sizeParam = Number.parseInt(new URL(req.url).searchParams.get("size") ?? "", 10);
    const size = Number.isFinite(sizeParam) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, sizeParam)) : DEFAULT_SIZE;

    const row = await getRequest(id);
    if (!row) return errorResponse("not_found", "no request with this id");

    const options = { margin: 2, width: size, errorCorrectionLevel: "M" as const };
    // The wallet link of an id never changes, so the image is cacheable forever.
    const headers = { "Cache-Control": "public, max-age=31536000, immutable" };
    if (format === "svg") {
      const svg = await QRCode.toString(payUrl(row), { ...options, type: "svg" });
      return new Response(svg, { headers: { ...headers, "Content-Type": "image/svg+xml" } });
    }
    const png = await QRCode.toBuffer(payUrl(row), { ...options, type: "png" });
    return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
