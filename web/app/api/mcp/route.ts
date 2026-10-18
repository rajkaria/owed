import { bundleExecutor, readBundleMeta } from "@/lib/mcp/bundle";
import { takeMcpCallSlot } from "@/lib/mcp/limits";
import { createMcpHandler, methodNotAllowed, preflight } from "@/lib/mcp/server";
import { clientIp } from "@/lib/ratelimit";

// POST /api/mcp — Owed as a remote MCP server (Streamable HTTP, stateless, JSON replies). Add
// https://www.getowed.xyz/api/mcp to PayBox or any MCP client: every tool is the committed plugin bundle
// (web/mcp/owed-plugin.mjs) run in a fresh process per call, exactly as PayBox runs it (decision D4).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A tools/call has 10 s in the bundle; a batch runs at most two rounds of four. */
export const maxDuration = 30;

let handler: ReturnType<typeof createMcpHandler> | null = null;

/** One handler per warm instance, so tools/list is read from the bundle once and then served from memory. */
function mcp() {
  if (!handler) {
    let server = { name: "owed", version: "0.0.0" };
    try {
      server = readBundleMeta().server;
    } catch (e) {
      console.error(`mcp: cannot read web/mcp/owed-plugin.meta.json: ${(e as Error).message}`);
    }
    handler = createMcpHandler({ execute: bundleExecutor(), takeCallSlot: takeMcpCallSlot, clientIp, server });
  }
  return handler;
}

export async function POST(req: Request): Promise<Response> {
  return mcp().post(req);
}

export function OPTIONS(): Response {
  return preflight();
}

export function GET(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

export function PUT(): Response {
  return methodNotAllowed();
}

export function PATCH(): Response {
  return methodNotAllowed();
}
