import { requestTermsNotes } from "@/lib/invoice-terms-notes";

// F8 invoices: what a request's pay page (/r/<id>) says about refunds and term plans, as one server component the page
// drops beside its badges (the coordinator wires it into app/r/[id]/page.tsx; see .ocean/notes/sp7-docs.md):
//   - "Refunded 0.4 USDC to the payer, confirmed on Solana." once a refund lands (lib/refunds.ts);
//   - "Cancelled by Owed: the other price of this invoice was paid." when the 0021 trigger superseded it;
//   - "Installment 2 of 3 of invoice X" / "Full price of invoice X" / "Late fee of invoice X" for a request a plan opened.
// Every value comes from Owed's own rows (amounts, ids), never from requester text. Renders nothing for other requests,
// and nothing if the rows can't be read (the page itself still renders).

/** Server component for app/r/[id]/page.tsx's badge slot. */
export async function RequestTermsNotes({ id }: { id: string }) {
  let notes: string[] = [];
  try {
    notes = await requestTermsNotes(id);
  } catch {
    notes = [];
  }
  if (notes.length === 0) return null;
  return (
    <div data-request-terms className="mt-4 space-y-1 text-sm text-muted">
      {notes.map((n, i) => (
        <p key={i}>{n}</p>
      ))}
    </div>
  );
}

