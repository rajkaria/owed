import "server-only";
import { sql } from "./db";
import type { Token } from "./money";
import { refundedText } from "./refunds";

// F8 invoices: what a request's pay page (/r/<id>) says about refunds and term plans (app/i/request-notes.tsx renders it):
//   - "Refunded 0.4 USDC to the payer, confirmed on Solana." once a refund lands (lib/refunds.ts);
//   - "Cancelled by Owed: the other price of this invoice was paid." when the 0021 trigger superseded it;
//   - "Installment 2 of 3 of invoice X" / "The full price of invoice X" / "The late fee of invoice X" for a request a plan opened.
// Every value comes from Owed's own rows (amounts, ids), never from requester text.

export async function requestTermsNotes(id: string): Promise<string[]> {
  const rows = await sql(
    `select r.token, r.superseded_by, r.status,
            (select coalesce(sum(f.amount_atomic), 0)::text from refunds f where f.request_id = r.id and f.status = 'confirmed') as refunded,
            r.paid_amount_atomic::text as paid,
            (select json_build_object('invoice_id', t.invoice_id, 'role', t.role, 'seq', t.seq, 'count', it.installment_count)::text
               from invoice_term_requests t left join invoice_terms it on it.invoice_id = t.invoice_id
              where t.request_id = r.id and t.invoice_id <> r.id) as term_of
       from requests r where r.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return [];
  const token = r.token as Token;
  const notes: string[] = [];
  if (r.term_of) {
    const t = JSON.parse(r.term_of) as { invoice_id: string; role: string; seq: number; count: number | null };
    const what = t.role === "installment" ? `Installment ${t.seq}${t.count ? ` of ${t.count}` : ""}` : t.role === "full_price" ? "The full price" : "The late fee";
    notes.push(`${what} of invoice ${t.invoice_id}.`);
  }
  if (r.superseded_by && r.status === "cancelled") notes.push(`Cancelled by Owed: the other price of this invoice was paid (request ${r.superseded_by}).`);
  const refunded = BigInt(r.refunded ?? "0");
  if (refunded > 0n) {
    const text = refundedText({ refundedAtomic: refunded, paidAtomic: r.paid == null ? null : BigInt(r.paid), token });
    if (text) notes.push(`${text[0]!.toUpperCase()}${text.slice(1)} to the payer, confirmed on Solana.`);
  }
  return notes;
}
