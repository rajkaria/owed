import "server-only";
import { isoUtc, isUniqueViolation, sql, transaction } from "../db";
import type { Credit } from "../validate";
import { isTeamSql, teamWallets } from "../team"; // W2-F is_team
import { watchSoon } from "../notify/helius"; // W3-A
import { alertsSoon } from "../alerts/soon"; // S1 alerts
import { POLL_EVERY_SECONDS, POLL_FOR_SECONDS, type PurchaseState } from "./attribution";
import type { MoonpayTx } from "./transaction";

// moonpay_checkouts and moonpay_purchases (migration 0014), and the step that marks a request paid
// by card. Only lib/moonpay/settle.ts and the widget route call this.

export interface Purchase {
  moonpayId: string;
  requestId: string;
  state: PurchaseState;
  signature: string | null;
  moonpayUpdatedAt: string | null;
  /** Seconds since the row was created. */
  ageSeconds: number;
}

export interface Checkout {
  requestId: string;
  /** first_started_at as Unix seconds: the earliest a MoonPay delivery for it can be. */
  firstStartedUnix: number;
  /** Opened in the last day, so still worth asking MoonPay about. */
  pollable: boolean;
}

const PURCHASE_COLUMNS = `moonpay_id, request_id, state, signature, ${isoUtc("moonpay_updated_at")} as moonpay_updated_at,
  extract(epoch from now() - created_at)::int::text as age_seconds`;

function purchaseFromRow(r: Record<string, string | null>): Purchase {
  return {
    moonpayId: r.moonpay_id!,
    requestId: r.request_id!,
    state: r.state as PurchaseState,
    signature: r.signature,
    moonpayUpdatedAt: r.moonpay_updated_at,
    ageSeconds: Number(r.age_seconds),
  };
}

export interface Store {
  /** The payer is being sent to the widget for this request. */
  startCheckout(requestId: string): Promise<void>;
  checkouts(requestIds: readonly string[]): Promise<Checkout[]>;
  /** Take this request's poll slot (at most one MoonPay lookup per 15 s, for a day after the last checkout). */
  claimPoll(requestId: string): Promise<boolean>;
  /** Purchases still waiting on MoonPay or the chain. */
  open(requestIds: readonly string[]): Promise<Purchase[]>;
  get(moonpayId: string): Promise<Purchase | null>;
  /** Write MoonPay's report. `expected` is the state it was read in (null = new row); false if it changed meanwhile. */
  report(tx: MoonpayTx, requestId: string, state: "pending" | "failed" | "sent", error: string | null, expected: PurchaseState | null): Promise<boolean>;
  fail(moonpayId: string, error: string): Promise<void>;
  /** Mark the purchase and the request paid (or underpaid) by card, in one transaction. False if the request was already settled. */
  settle(purchase: Pick<Purchase, "moonpayId" | "requestId">, outcome: "verified" | "underpaid", credit: Credit): Promise<boolean>;
}

export const store: Store = {
  async startCheckout(requestId) {
    await sql(
      `insert into moonpay_checkouts (request_id) values ($1)
       on conflict (request_id) do update set last_started_at = now(), starts = moonpay_checkouts.starts + 1`,
      [requestId],
    );
  },

  async checkouts(requestIds) {
    if (requestIds.length === 0) return [];
    const rows = await sql(
      `select request_id, extract(epoch from first_started_at)::bigint::text as first_unix,
              (last_started_at > now() - make_interval(secs => $2))::text as pollable
         from moonpay_checkouts where request_id = any($1::text[])`,
      [requestIds, POLL_FOR_SECONDS],
    );
    return rows.map((r) => ({ requestId: r.request_id!, firstStartedUnix: Number(r.first_unix), pollable: r.pollable === "true" }));
  },

  async claimPoll(requestId) {
    const rows = await sql(
      `update moonpay_checkouts set last_polled_at = now()
        where request_id = $1 and last_started_at > now() - make_interval(secs => $2)
          and (last_polled_at is null or last_polled_at < now() - make_interval(secs => $3))
        returning request_id`,
      [requestId, POLL_FOR_SECONDS, POLL_EVERY_SECONDS],
    );
    return rows.length > 0;
  },

  async open(requestIds) {
    if (requestIds.length === 0) return [];
    const rows = await sql(
      `select ${PURCHASE_COLUMNS} from moonpay_purchases where state in ('pending', 'sent') and request_id = any($1::text[])`,
      [requestIds],
    );
    return rows.map(purchaseFromRow);
  },

  async get(moonpayId) {
    const rows = await sql(`select ${PURCHASE_COLUMNS} from moonpay_purchases where moonpay_id = $1`, [moonpayId]);
    return rows.length ? purchaseFromRow(rows[0]) : null;
  },

  async report(tx, requestId, state, error, expected) {
    const signature = state === "sent" ? tx.cryptoTransactionId : null;
    const values = [tx.id, requestId, state, tx.status, tx.updatedAt, tx.walletAddress, tx.currencyCode, signature, error?.slice(0, 300) ?? null];
    try {
      if (expected === null) {
        const rows = await sql(
          `insert into moonpay_purchases (moonpay_id, request_id, state, moonpay_status, moonpay_updated_at, wallet_address, currency_code, signature, error)
           values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9)
           on conflict (moonpay_id) do nothing returning moonpay_id`,
          values,
        );
        return rows.length > 0;
      }
      const rows = await sql(
        `update moonpay_purchases
            set state = $3, moonpay_status = $4, moonpay_updated_at = coalesce($5::timestamptz, moonpay_updated_at),
                signature = coalesce($6, signature), error = $7, updated_at = now()
          where moonpay_id = $1 and request_id = $2 and state = $8
          returning moonpay_id`,
        [tx.id, requestId, state, tx.status, tx.updatedAt, signature, error?.slice(0, 300) ?? null, expected],
      );
      return rows.length > 0;
    } catch (e) {
      if (isUniqueViolation(e, "moonpay_purchases_signature_key")) {
        // The same Solana transaction is already another purchase: it can't pay this one too.
        await sql(
          `insert into moonpay_purchases (moonpay_id, request_id, state, moonpay_status, moonpay_updated_at, wallet_address, currency_code, error)
           values ($1, $2, 'mismatch', $3, $4::timestamptz, $5, $6, 'transaction already reported for another purchase')
           on conflict (moonpay_id) do update set state = 'mismatch', error = excluded.error, updated_at = now()`,
          [tx.id, requestId, tx.status, tx.updatedAt, tx.walletAddress, tx.currencyCode],
        );
        return false;
      }
      throw e;
    }
  },

  async fail(moonpayId, error) {
    await sql(
      `update moonpay_purchases set state = 'mismatch', error = $2, updated_at = now() where moonpay_id = $1 and state in ('pending', 'sent')`,
      [moonpayId, error.slice(0, 300)],
    );
  },

  async settle(purchase, outcome, credit) {
    try {
      const [, updated] = await transaction([
        {
          text: `update moonpay_purchases set state = $2, payer = $3, credited_atomic = $4, verified_at = now(), updated_at = now()
                  where moonpay_id = $1 and state = 'sent'`,
          params: [purchase.moonpayId, outcome, credit.payer, credit.amountAtomic],
        },
        {
          // W3-C: a delivery to a cancelled or expired request moved real money, so it is recorded (as for Solana Pay).
          text: `update requests
                    set status = $2, paid_signature = $3, paid_payer = $4, paid_amount_atomic = $5,
                        paid_at = $6::timestamptz, paid_rail = 'moonpay_card',
                        is_team = ${isTeamSql("$7", "$4::text")} -- W2-F is_team (lib/team.ts)
                  where id = $1 and status in ('open', 'cancelled') and chain = 'solana' and token = 'USDC'
                  returning id`,
          params: [purchase.requestId, outcome === "verified" ? "paid" : "underpaid", credit.signature, credit.payer, credit.amountAtomic, credit.at, teamWallets()],
        },
      ]);
      if (updated.length > 0 && outcome === "verified") watchSoon(); // W3-A: a paid request leaves the Helius watch
      if (updated.length > 0) alertsSoon(); // S1 alerts: send what the 0025 trigger queued, after the response
      return updated.length > 0;
    } catch (e) {
      if (isUniqueViolation(e, "requests_paid_signature_key")) {
        console.warn(`moonpay purchase ${purchase.moonpayId}: transaction ${credit.signature} already settles another request`);
        await this.fail(purchase.moonpayId, "transaction already settles another request");
        return false;
      }
      throw e;
    }
  },
};
