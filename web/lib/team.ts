import { isSolanaAddress } from "./solana-pay";

// W2-F /proof: which paid requests are the team's own real payments (requests.is_team, 0001_core).
// OWED_TEAM_WALLETS lists the team's Solana addresses, comma-separated (public addresses, not a secret).
// A payment is the team's when the request pays one of them or one of them paid it. The flag is written
// when a payment is recorded (lib/requests.ts recordPayment, lib/x402/store.ts verified) and recomputed
// for older rows by scripts/mark-team.ts. /proof lists only paid rows with the flag set.

/** The configured team wallets: valid Solana addresses only, de-duplicated, in the order given. */
export function teamWallets(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.OWED_TEAM_WALLETS ?? "";
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => isSolanaAddress(s)))];
}

/**
 * SQL for the rule, given the placeholder of the team wallet array and of the payer. Used inside the
 * UPDATE that records a payment, so the flag is set in the same statement as the payment itself.
 * A null payer never matches (coalesce keeps the column non-null).
 */
export function isTeamSql(walletsParam: string, payerSql: string): string {
  return `coalesce(recipient = any(${walletsParam}::text[]) or ${payerSql} = any(${walletsParam}::text[]), false)`;
}

/** Settled rows whose flag disagrees with the rule: what scripts/mark-team.ts lists and fixes. */
export function teamMismatchSql(walletsParam: string): string {
  return `paid_signature is not null and is_team is distinct from ${isTeamSql(walletsParam, "paid_payer")}`;
}
