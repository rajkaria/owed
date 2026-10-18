import "server-only";
import { DbError } from "../db";
import { take } from "../ratelimit";
import type { RateDecision } from "./server";

// Each POST /api/mcp that carries a tools/call starts plugin processes, so it is counted per client IP in the same
// Postgres rate_events table as the other limits (lib/ratelimit.ts). initialize, ping, tools/list and notifications
// are served from memory and are not counted. 120 calls a minute is far above one agent session (PayBox itself
// allows one call a second per user). If PayBox proxies remote-plugin calls from a few shared IPs, raise it with
// OWED_MCP_CALLS_PER_MINUTE. Like /status-raw, it fails open when the database is unavailable: the tools reach the
// /api/v1 routes, which keep their own limits.

export const MCP_CALL_LIMITS = { perIp: 120, windowSeconds: 60 } as const;

/** Calls per IP per minute: OWED_MCP_CALLS_PER_MINUTE when it is a whole number from 1 to 100000, else 120. */
export function mcpCallsPerMinute(raw = process.env.OWED_MCP_CALLS_PER_MINUTE): number {
  const value = raw?.trim();
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 100_000) return MCP_CALL_LIMITS.perIp;
  return Number(value);
}

export async function takeMcpCallSlot(ip: string): Promise<RateDecision> {
  try {
    return await take([{ key: `mcp:call:ip:${ip}`, max: mcpCallsPerMinute(), windowSeconds: MCP_CALL_LIMITS.windowSeconds, scope: "ip" }]);
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
    console.error(`mcp rate limit skipped: ${e.message}`);
    return { allowed: true };
  }
}
