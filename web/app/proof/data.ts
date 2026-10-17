import "server-only";
import { isoUtc, sql } from "@/lib/db";
import { formatUnits, fromAtomic, TOKENS, type Token } from "@/lib/money";

// /proof: the team's own real mainnet payments, read straight from requests. Only paid rows with
// is_team set (lib/team.ts); nothing requester-written is selected, so nothing a stranger typed can
// reach this page.

export const PROOF_LIMIT = 200;

export type ProofKind = "single" | "split_share" | "invoice";
// 0012: "matched" = the payment carried no reference and the recipient matched it with a signed message.
export type ProofRail = "solana_pay" | "x402" | "matched";

export interface ProofPayment {
  id: string;
  kind: ProofKind;
  groupId: string | null;
  token: Token;
  /** What arrived, as a decimal string in whole tokens. */
  amount: string;
  rail: ProofRail;
  /** 0012: "rest" when the remainder of a partly paid request arrived without the reference and was matched. */
  matchedRest: boolean;
  signature: string;
  paidAt: string;
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
}

export interface ProofSummary {
  payments: ProofPayment[];
  count: number;
  usdc: string;
  sol: string;
  rails: Record<ProofRail, number>;
}

const KINDS: readonly string[] = ["single", "split_share", "invoice"];

export async function loadProof(limit = PROOF_LIMIT): Promise<ProofSummary> {
  const [rows, [totals]] = await Promise.all([
    sql(
      `select id, kind, group_id, token, paid_amount_atomic::text as paid_amount_atomic,
              coalesce(paid_rail, 'solana_pay') as paid_rail, paid_signature, ${isoUtc("paid_at")} as paid_at,
              from_domain, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at,
              exists (select 1 from request_matches m where m.request_id = requests.id and m.covers = 'rest') as matched_rest
         from requests
        where status = 'paid' and is_team and paid_signature is not null and paid_at is not null
        order by paid_at desc, id
        limit $1`,
      [limit],
    ),
    sql(
      `select count(*)::text as count,
              coalesce(sum(paid_amount_atomic) filter (where token = 'USDC'), 0)::text as usdc_atomic,
              coalesce(sum(paid_amount_atomic) filter (where token = 'SOL'), 0)::text as sol_atomic,
              count(*) filter (where paid_rail = 'x402')::text as x402,
              count(*) filter (where paid_rail = 'matched')::text as matched
         from requests
        where status = 'paid' and is_team and paid_signature is not null and paid_at is not null`,
    ),
  ]);

  const payments = rows.map((r): ProofPayment => {
    const token = (r.token === "SOL" ? "SOL" : "USDC") as Token;
    return {
      id: r.id!,
      kind: (KINDS.includes(r.kind!) ? r.kind : "single") as ProofKind,
      groupId: r.group_id,
      token,
      amount: fromAtomic(BigInt(r.paid_amount_atomic ?? "0"), token),
      rail: r.paid_rail === "x402" ? "x402" : r.paid_rail === "matched" ? "matched" : "solana_pay",
      matchedRest: r.matched_rest === "t" || r.matched_rest === "true",
      signature: r.paid_signature!,
      paidAt: r.paid_at!,
      fromDomain: r.from_domain,
      fromDomainVerifiedAt: r.from_domain_verified_at,
    };
  });

  const count = Number(totals.count);
  const x402 = Number(totals.x402);
  const matched = Number(totals.matched);
  return {
    payments,
    count,
    usdc: formatUnits(BigInt(totals.usdc_atomic!), TOKENS.USDC.decimals),
    sol: formatUnits(BigInt(totals.sol_atomic!), TOKENS.SOL.decimals),
    rails: { solana_pay: count - x402 - matched, x402, matched },
  };
}
