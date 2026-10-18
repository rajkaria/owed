import type { DepositOffer } from "@/lib/deposit-link";
import { cardButtonClass } from "./card-pay";
import { ExternalIcon } from "./icons";

// F3 "Pay with PayBox Deposit" on a pay page (decision D17): a plain link to the PayBox Open Deposit URL the requester's
// agent added (PayBox get_deposit_link). Rendered only when lib/deposit-link.ts depositOffer says so: OWED_DEPOSIT_LINK=1,
// the request open, USDC on Solana, and within 24 hours of the link being added. Owed's own words only; the URL is on
// paybox.sh (checked when it was stored and again here). Server component, no client JavaScript.

export const DEPOSIT_COPY = {
  button: "Pay with PayBox Deposit",
  lead: "No wallet? The requester added a PayBox Deposit link: you pay in your browser on PayBox.",
  where: "The link goes to the requester's PayBox account, and Owed can't check where it pays.",
  counts: "It counts as paid here only once the requester matches your payment to this request.",
} as const;

export function DepositPay({ offer }: { offer: DepositOffer | null }) {
  if (!offer) return null;
  return (
    <div data-deposit-pay className="flex flex-col gap-2.5">
      <a href={offer.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className={cardButtonClass}>
        <ExternalIcon className="shrink-0" />
        {DEPOSIT_COPY.button}
      </a>
      <p className="text-sm leading-relaxed text-muted">
        {DEPOSIT_COPY.lead} <span className="text-fg">{DEPOSIT_COPY.where}</span> {DEPOSIT_COPY.counts} Opens{" "}
        <span className="font-mono text-fg">{offer.host}</span>.
      </p>
    </div>
  );
}
