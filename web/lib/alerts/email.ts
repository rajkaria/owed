import "server-only";
import { ALERT_EMAIL } from "../contract";
import type { EmailConfig } from "./config";

// S1 paid alerts by email (dormant until RESEND_API_KEY and OWED_ALERTS_FROM are set): Resend's documented HTTP API,
// POST https://api.resend.com/emails with "Authorization: Bearer <key>" and {from, to, subject, text, html, headers}.
// Idempotency-Key (Resend keeps it 24 hours) stops a retry after a lost answer from sending the same email twice.

export const RESEND_EMAILS = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 5000;

export class EmailError extends Error {
  status?: number;
  /** Resend refused the message itself (validation, unverified domain): retrying won't help. */
  permanent = false;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 160);

/** Throws EmailError; its message never contains the API key. */
export async function sendEmail(cfg: EmailConfig, email: OutgoingEmail): Promise<void> {
  let res: Response;
  try {
    res = await fetch(RESEND_EMAILS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...(email.idempotencyKey && { "Idempotency-Key": email.idempotencyKey.slice(0, 256) }),
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.headers && { headers: email.headers }),
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new EmailError(`Resend ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown; name?: unknown };
    if (typeof body.message === "string") detail = `: ${clean(body.message)}`;
  } catch {
    // not JSON
  }
  const err = new EmailError(`Resend answered HTTP ${res.status}${detail}`);
  err.status = res.status;
  err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 409 && res.status !== 429;
  throw err;
}

/** An address Owed will send to (ASCII, one @, a dotted domain; the contract's ALERT_EMAIL), lower-cased; else null. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (s.length > 254 || !ALERT_EMAIL.test(s) || s.includes("..") || s.startsWith(".") || s.split("@")[0].endsWith(".")) return null;
  return s;
}
