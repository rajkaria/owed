import * as z from "zod/v4";
import { expiresInDaysSchema } from "./contract.js";

// W3-C: optional expiry on ask_for_money, split_bill and create_invoice. The plugin sends whole days; Owed's
// server sets expires_at from its own clock (never from the client) and the pay page, pay_link, check_payments
// and the x402 endpoint all stop taking payments after it. The plugin only checks the server did what was asked.

export const DAY_MS = 86_400_000;
/** The server's clock and PayBox's may differ a little; a different day count can't hide inside this. */
const CLOCK_SLACK_MS = 60 * 60_000;

export const expiresInDaysInput = expiresInDaysSchema
  .describe("Optional: the link stops taking payments after this many days (a whole number from 1 to 90). Owed's server sets the exact time.");

export type ExpiresInDays = z.output<typeof expiresInDaysSchema>;

/** null when the server's expires_at matches the days asked for; otherwise the refusal. */
export function expiryProblem(days: number | undefined, expiresAt: string | null | undefined, now: number): string | null {
  if (days === undefined) return null;
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return "Owed's server didn't set the expiry you asked for, so the link wasn't used. Try again, or ask without expires_in_days.";
  if (Math.abs(at - (now + days * DAY_MS)) > CLOCK_SLACK_MS) {
    return "Owed's server set a different expiry than the one asked for, so the link wasn't used. Try again, or ask without expires_in_days.";
  }
  return null;
}

/** "Expires 2026-10-24T13:40:00Z (in 7 days): after that the link stops taking payments." */
export function expiryLine(expiresAt: string, days: number, what = "the link"): string {
  return `Expires ${expiresAt} (in ${days === 1 ? "1 day" : `${days} days`}): after that ${what} stops taking payments.`;
}

export const OFFLINE_NO_EXPIRY = "Offline links can't expire: this one stays payable until you stop sharing it.";
