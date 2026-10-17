import type { CardNotice, CardOffer } from "@/lib/moonpay/offer";
import { formatAmount } from "@/lib/view/money";
import { AlertIcon, CardIcon } from "./icons";

// "Pay by card (MoonPay)" on a pay page: a plain link to /api/moonpay/<id>, which signs the widget URL
// on the server and redirects. Server component, no client JavaScript. Rendered only when MoonPay is
// configured (lib/moonpay/offer.ts).

export const cardButtonClass =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-base font-semibold leading-tight text-fg transition-colors hover:bg-sunken active:scale-[0.99]";

export function CardPay({ offer, notice }: { offer: CardOffer | null; notice?: CardNotice }) {
  if (!offer) return null;
  return (
    <div data-card-pay className="flex flex-col gap-2.5">
      {notice === "return" && (
        <p role="status" className="rounded-xl bg-sunken px-4 py-3 text-sm leading-relaxed">
          <span className="font-medium">Back from MoonPay.</span>{" "}
          <span className="text-muted">
            If you paid, MoonPay is sending the USDC now. This page shows it as paid once the transfer is confirmed on
            Solana, usually within a few minutes.
          </span>
        </p>
      )}
      {notice === "region" && (
        <p role="note" className="flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3 text-sm leading-relaxed">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <span>MoonPay doesn&apos;t sell USDC where you are, so paying by card won&apos;t work here. Pay with a wallet instead.</span>
        </p>
      )}
      {notice === "region" ? null : offer.kind === "note" ? (
        <p className="text-sm leading-relaxed text-muted">{offer.text}</p>
      ) : (
        <>
          <a href={offer.href} rel="nofollow noopener" className={cardButtonClass}>
            <CardIcon className="shrink-0" />
            Pay by card (MoonPay)
          </a>
          <p className="text-sm leading-relaxed text-muted">
            No crypto needed. MoonPay sends exactly{" "}
            <span className="whitespace-nowrap text-fg">{formatAmount(offer.amount, "USDC")}</span> to the address below and
            charges your card for it, with MoonPay&apos;s fees added on top. Owed marks this paid once Solana confirms the
            transfer. MoonPay checks your ID the first time, and doesn&apos;t sell USDC in every country (not in Canada,
            India or Japan, among others).
            {offer.sandbox && <strong className="font-medium text-warn"> Sandbox: test cards only, no real money moves.</strong>}
          </p>
        </>
      )}
    </div>
  );
}
