import type { BankOffer } from "@/lib/moonpay/bank-offer";
import type { PayerRail } from "@/lib/moonpay/enterprise";
import { CopyButton } from "./copy-button";

// F3 bank rail: "Pay by bank transfer" on an invoice, shown only when lib/moonpay/bank-offer.ts returns an offer (flag
// on, an open invoice in a whole number of cents, and the recipient's own signed virtual account in its currency).
// Server component; the copy buttons are the only client parts. The account details are the recipient's, as MoonPay
// issued them and the recipient's wallet signed them; Owed never receives the money.

const SYMBOL: Record<BankOffer["currency"], string> = { EUR: "€", GBP: "£", USD: "$" };

function money(currency: BankOffer["currency"], amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  return `${SYMBOL[currency]}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac.padEnd(2, "0")} ${currency}`;
}

const RAIL_NAME: Record<PayerRail["type"], string> = {
  SEPA: "SEPA transfer (EUR)",
  ACH: "ACH (USD)",
  Wire: "Domestic wire (USD)",
  RTP: "RTP instant payment (USD)",
  FedNow: "FedNow instant payment (USD)",
  CHAPS: "CHAPS (GBP)",
  FPS: "Faster Payments (GBP)",
};

function fields(rail: PayerRail): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (rail.account_holder) out.push(["Account holder", rail.account_holder]);
  if (rail.type === "SEPA") {
    out.push(["IBAN", rail.iban]);
    if (rail.bic) out.push(["BIC", rail.bic]);
  } else if ("sort_code" in rail) {
    out.push(["Sort code", rail.sort_code], ["Account number", rail.account_number]);
  } else {
    out.push(["Routing number", rail.routing_number], ["Account number", rail.account_number]);
  }
  if (rail.bank_name) out.push(["Bank", rail.bank_name]);
  return out;
}

const copyClass =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-fg hover:bg-sunken print:hidden";

export function BankTransfer({ offer }: { offer: BankOffer | null }) {
  if (!offer) return null;
  const amount = money(offer.currency, offer.amount);
  // Rails that share the same account details are listed once, named together.
  const groups = new Map<string, { names: string[]; rail: PayerRail }>();
  for (const rail of offer.rails) {
    const key = JSON.stringify(fields(rail));
    const g = groups.get(key);
    if (g) g.names.push(RAIL_NAME[rail.type]);
    else groups.set(key, { names: [RAIL_NAME[rail.type]], rail });
  }
  return (
    <section data-bank-transfer aria-labelledby="bank-title" className="mt-4 rounded-xl border border-line px-4 py-4 print:mt-2 print:rounded-none print:border-x-0 print:px-0">
      <h3 id="bank-title" className="text-base font-semibold">Pay by bank transfer</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Send exactly <span className="whitespace-nowrap font-semibold text-fg tabular-nums">{amount}</span> from your bank.
        No payment reference needed. This is the sender&apos;s own account at MoonPay, which turns it into USDC on their
        Solana wallet; this invoice shows paid once Solana confirms it. Bank fees are yours, and a smaller amount leaves the
        invoice part paid.
        {offer.sandbox && <strong className="font-medium text-warn"> Sandbox account: no real money moves.</strong>}
      </p>
      {[...groups.values()].map(({ names, rail }) => (
        <div key={names.join("+")} className="mt-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted">{names.join(" · ")}</h4>
          <dl className="mt-1.5 grid gap-1.5">
            {fields(rail).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 rounded-lg bg-sunken px-3 py-2 print:bg-transparent print:px-0 print:py-0.5">
                <div className="min-w-0">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="font-mono text-sm break-all">{value}</dd>
                </div>
                {label !== "Bank" && label !== "Account holder" && <CopyButton text={value.replace(/\s+/g, "")} label="Copy" copiedLabel="Copied" className={copyClass} />}
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        If another open invoice from this sender asks the same amount, the sender matches your payment to the right one by
        hand.
      </p>
    </section>
  );
}
