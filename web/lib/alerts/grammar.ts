// S1 paid alerts: the one message a wallet signs to turn alerts on. Shared by the server (lib/alerts/subscribe.ts
// rebuilds the prefix and lib/verify-signature.ts checks wording, freshness and signature) and the /alerts page, which
// builds the exact text for a browser wallet or for PayBox request_wallet_sign. No server-only imports here.

/** "Owed alerts for <wallet>": the signed message is this, then " at <ISO time>". */
export function alertsPrefix(wallet: string): string {
  return `Owed alerts for ${wallet}`;
}

/** "Owed alerts for <wallet> at 2026-10-18T12:00:00Z": whole seconds, UTC, like every other Owed signed message. */
export function alertsMessage(wallet: string, ms: number): string {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return `${alertsPrefix(wallet)} at ${iso}`;
}

/** How long a signed message stays good (lib/verify-signature.ts SIGNATURE_MAX_AGE_MS). */
export const ALERTS_MESSAGE_MAX_AGE_MS = 5 * 60_000;
