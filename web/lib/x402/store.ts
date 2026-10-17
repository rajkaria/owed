import "server-only";
import { isoUtc, isUniqueViolation, sql, transaction } from "../db";
import type { Credit } from "../validate";
import { isTeamSql, teamWallets } from "../team"; // W2-F is_team

// x402_receipts (migration 0004): one row per settlement attempt, and the step that marks a
// request paid over x402. See the migration for the states.

/** Longer than a Solana blockhash lives (~150 slots, about a minute), so a released lock can't race a landing transaction. */
export const LOCK_TTL_SECONDS = 150;
/** A transaction the facilitator says it settled but the chain never shows. */
export const SETTLED_GIVE_UP_SECONDS = 600;

export interface Receipt {
  id: string;
  requestId: string;
  state: "settling" | "settled" | "verified" | "failed" | "mismatch" | "unknown" | "abandoned";
  x402Version: 1 | 2;
  network: string;
  amountAtomic: bigint;
  payer: string | null;
  feePayer: string | null;
  signature: string | null;
  createdAt: string;
  /** created_at as Unix seconds. */
  createdUnix: number;
  settledAt: string | null;
  ageSeconds: number;
}

const COLUMNS = `id::text as id, request_id, state, x402_version::text as x402_version, network,
  amount_atomic::text as amount_atomic, payer, fee_payer, signature, ${isoUtc("created_at")} as created_at,
  extract(epoch from created_at)::bigint::text as created_unix,
  ${isoUtc("settled_at")} as settled_at, extract(epoch from now() - created_at)::int::text as age_seconds`;

function fromRow(r: Record<string, string | null>): Receipt {
  return {
    id: r.id!,
    requestId: r.request_id!,
    state: r.state as Receipt["state"],
    x402Version: Number(r.x402_version) as 1 | 2,
    network: r.network!,
    amountAtomic: BigInt(r.amount_atomic!),
    payer: r.payer,
    feePayer: r.fee_payer,
    signature: r.signature,
    createdAt: r.created_at!,
    createdUnix: Number(r.created_unix),
    settledAt: r.settled_at,
    ageSeconds: Number(r.age_seconds),
  };
}

export interface Store {
  /** Take the request's settlement lock, or say who holds it. */
  begin(input: { requestId: string; version: 1 | 2; network: string; amountAtomic: bigint; payer: string | null; feePayer: string | null }):
    Promise<{ ok: true; receiptId: string } | { ok: false; holder: Receipt | null }>;
  fail(receiptId: string, state: "failed" | "unknown" | "mismatch", error: string): Promise<void>;
  settled(receiptId: string, signature: string, payer: string | null): Promise<void>;
  /** Mark the receipt verified and the request paid over x402, in one transaction. Returns false if the request was no longer open. */
  verified(receipt: { id: string; requestId: string }, credit: Credit): Promise<boolean>;
  /** Settled receipts waiting for the chain, and timed-out ones whose transaction may have landed. */
  pending(requestIds: readonly string[]): Promise<Receipt[]>;
}

export const store: Store = {
  async begin(input) {
    // Release locks whose transaction can no longer land.
    await sql(
      `update x402_receipts set state = 'abandoned', error = coalesce(error, 'lock expired')
        where request_id = $1 and state in ('settling', 'unknown') and created_at < now() - make_interval(secs => $2)`,
      [input.requestId, LOCK_TTL_SECONDS],
    );
    try {
      const rows = await sql(
        `insert into x402_receipts (request_id, state, x402_version, network, amount_atomic, payer, fee_payer)
         values ($1, 'settling', $2, $3, $4, $5, $6) returning id::text as id`,
        [input.requestId, input.version, input.network, input.amountAtomic, input.payer, input.feePayer],
      );
      return { ok: true, receiptId: rows[0].id! };
    } catch (e) {
      if (!isUniqueViolation(e, "x402_receipts_active_key")) throw e;
      const rows = await sql(
        `select ${COLUMNS} from x402_receipts
          where request_id = $1 and state in ('settling', 'settled', 'verified', 'unknown') limit 1`,
        [input.requestId],
      );
      return { ok: false, holder: rows.length ? fromRow(rows[0]) : null };
    }
  },

  async fail(receiptId, state, error) {
    await sql(`update x402_receipts set state = $2, error = $3 where id = $1::bigint`, [receiptId, state, error.slice(0, 300)]);
  },

  async settled(receiptId, signature, payer) {
    await sql(
      `update x402_receipts set state = 'settled', signature = $2, payer = coalesce($3, payer), settled_at = now()
        where id = $1::bigint`,
      [receiptId, signature, payer],
    );
  },

  async verified(receipt, credit) {
    try {
      const [, updated] = await transaction([
        { text: `update x402_receipts set state = 'verified', verified_at = now() where id = $1::bigint`, params: [receipt.id] },
        {
          text: `update requests
                    set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = $4,
                        paid_at = $5::timestamptz, paid_rail = 'x402',
                        is_team = ${isTeamSql("$6", "$3::text")} -- W2-F is_team (lib/team.ts)
                  where id = $1 and status = 'open'
                  returning id`,
          params: [receipt.requestId, credit.signature, credit.payer, credit.amountAtomic, credit.at, teamWallets()],
        },
      ]);
      return updated.length > 0;
    } catch (e) {
      if (isUniqueViolation(e, "requests_paid_signature_key")) {
        console.warn(`x402 receipt ${receipt.id}: transaction ${credit.signature} already settles another request`);
        await this.fail(receipt.id, "mismatch", "transaction already settles another request");
        return false;
      }
      throw e;
    }
  },

  async pending(requestIds) {
    if (requestIds.length === 0) return [];
    const rows = await sql(
      `select ${COLUMNS} from x402_receipts where state in ('settled', 'unknown') and request_id = any($1::text[])`,
      [requestIds],
    );
    return rows.map(fromRow);
  },
};
