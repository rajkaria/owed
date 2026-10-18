import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CardPay } from "@/components/card-pay";
import { CopyButton } from "@/components/copy-button";
import { AgentIcon, AlertIcon, ExternalIcon, LinkIcon, WalletIcon } from "@/components/icons";
import { QrCode } from "@/components/qr-code";
import { VerifiedBadge } from "@/components/verified-badge";
import { Wordmark } from "@/components/wordmark";
import { cardNotice, cardOffer } from "@/lib/moonpay/offer";
import { BankTransfer } from "@/components/bank-transfer"; // F3 bank rail
import { bankOffer } from "@/lib/moonpay/bank-offer"; // F3 bank rail
import { solscanAccount } from "@/lib/view/format";
import { InvoiceLive } from "./invoice-live";
import { invoiceDescription, invoiceModel, invoiceTitle, type InvoiceModel } from "./model";
import { PrintButton } from "./print-button";
import { loadPublicInvoice } from "./source";

// The printable invoice. Everything the sender typed (names, items, notes, number) is shown quoted
// and labelled as theirs; the amounts, status and payment come from the server and the chain.
// Print CSS: one A4 or Letter page (12 mm margins) for up to 20 items, light colours, no buttons.

const PRINT_CSS = `
@page { size: auto; margin: 12mm; }
@media print {
  :root {
    --bg: #ffffff; --surface: #ffffff; --sunken: #f2f2f2; --fg: #000000; --muted: #4a4a4a; --line: #c8c8c8;
    --accent: #3730a3; --accent-soft: #ffffff; --paid: #046c4e; --paid-soft: #ffffff;
    --warn: #8a3b0a; --warn-soft: #ffffff; --warn-line: #d9a441;
  }
  html { font-size: 11px; color-scheme: light; }
  html:has([data-print-dense]) { font-size: 9.5px; }
  [data-print-dense] td { line-height: 1.25; }
  html:has([data-print-dense]) [data-invoice-footer] { display: none; }
  html, body { background: #ffffff !important; }
  a { color: inherit; text-decoration: none; }
}`;

const secondaryButton =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium leading-tight text-fg transition-colors hover:bg-sunken active:scale-[0.99]";

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

export async function generateMetadata({ params }: PageProps<"/i/[id]">): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadPublicInvoice(id);
  if (!loaded) return { title: "Invoice not found", robots: { index: false, follow: false } };
  const model = invoiceModel(loaded.invoice, loaded.now);
  const title = invoiceTitle(model);
  const description = invoiceDescription(model);
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", siteName: "Owed", url: model.invoiceLink },
    twitter: { card: "summary_large_image", title, description },
  };
}

function Head({ model }: { model: InvoiceModel }) {
  return (
    <>
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted">
        Invoice
        {model.termOf && (
          <>
            {" · "}
            <span data-term-of className="normal-case tracking-normal">
              {model.termOf.label} of{" "}
              <Link href={model.termOf.link} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
                invoice {model.termOf.parentId}
              </Link>
            </span>
          </>
        )}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all sm:text-3xl">
        {model.numberIsId ? (
          <span className="font-mono">{model.number}</span>
        ) : (
          <>
            <span className="sr-only">Invoice number </span>
            <q><bdi>{model.number}</bdi></q>
          </>
        )}
      </h1>
    </>
  );
}

function Parties({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2 print:mt-5 print:grid-cols-2">
      <div className="min-w-0">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">From</h2>
        <p className="mt-1 text-lg font-semibold leading-snug wrap-anywhere">
          <q><bdi>{model.businessName}</bdi></q>
        </p>
        <VerifiedBadge domain={model.fromDomain} verifiedAt={model.fromDomainVerifiedAt} />
        <p className="mt-2 text-sm text-muted">
          Paid to <span className="font-mono">{model.recipientShort}</span>
        </p>
      </div>
      <div className="min-w-0">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Bill to</h2>
        <p className="mt-1 text-lg font-semibold leading-snug wrap-anywhere">
          <q><bdi>{model.clientName}</bdi></q>
        </p>
      </div>
    </div>
  );
}

function Dates({ model }: { model: InvoiceModel }) {
  const cell = "rounded-xl bg-sunken px-3.5 py-3 print:rounded-none print:bg-transparent print:px-0 print:py-1";
  return (
    <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 print:mt-4 print:grid-cols-3 print:gap-6 print:border-y print:border-line print:py-2">
      <div className={cell}>
        <dt className="text-xs text-muted">Issued</dt>
        <dd className="mt-0.5 font-medium">{model.issued}</dd>
      </div>
      <div className={cell}>
        <dt className="text-xs text-muted">Due</dt>
        <dd className={`mt-0.5 font-medium ${model.overdue ? "text-warn" : ""}`}>{model.due}</dd>
      </div>
      <div className={`${cell} col-span-2 sm:col-span-1 print:col-span-1`}>
        <dt className="text-xs text-muted">{model.terms && model.terms.kind !== "plain" ? "Due now" : "Amount due"}</dt>
        {model.terms && model.terms.kind !== "plain" ? (
          <dd className="mt-0.5 font-semibold tabular-nums">{model.payable ? model.payLabel : "Nothing yet"}</dd>
        ) : model.fiat ? (
          <dd className="mt-0.5 tabular-nums">
            <span className="font-semibold">{model.fiat.amount}</span>
            <span className="text-muted"> · </span>
            <span className="font-semibold whitespace-nowrap">{model.totalLabel}</span>
          </dd>
        ) : (
          <dd className="mt-0.5 font-semibold tabular-nums">{model.totalLabel}</dd>
        )}
      </div>
    </dl>
  );
}

function Items({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-7 print:mt-4" data-print-dense={model.lines.length > 10 ? "" : undefined}>
      {/* Sender text uses overflow-wrap:anywhere: unlike break-word it lowers a cell's min-content width, so a
          long unbroken word wraps inside the card instead of widening the table (QA-11). */}
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Line items, written by the sender</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Description<span className="hidden print:inline"> · amounts in {model.itemUnit}</span>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">Qty</th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">
              Unit price
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {model.lines.map((line, i) => (
            <tr key={i} className="border-b border-line align-top print:break-inside-avoid">
              <td className="py-3 pr-3 wrap-anywhere print:py-1">
                <q><bdi>{line.description}</bdi></q>
                <span className="mt-0.5 block text-xs text-muted tabular-nums sm:hidden print:hidden">
                  {line.quantity} × {line.unitPrice}
                </span>
              </td>
              <td className="hidden py-3 pr-3 text-right tabular-nums sm:table-cell print:table-cell print:py-1">{line.quantity}</td>
              <td className="hidden py-3 pr-3 text-right whitespace-nowrap tabular-nums sm:table-cell print:table-cell print:py-1">
                <span className="print:hidden">{line.unitPrice}</span>
                <span className="hidden print:inline">{line.unitPriceValue}</span>
              </td>
              <td className="py-3 text-right font-medium whitespace-nowrap tabular-nums print:py-1">
                <span className="print:hidden">{line.amount}</span>
                <span className="hidden print:inline">{line.amountValue}</span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3} className="hidden pt-4 pr-3 text-right text-base font-semibold sm:table-cell print:table-cell print:pt-2">
              Total
            </th>
            <th scope="row" className="pt-4 text-left text-base font-semibold sm:hidden print:hidden">
              Total
            </th>
            <td className="pt-4 text-right text-xl font-semibold whitespace-nowrap tabular-nums print:pt-2 print:text-lg">
              {model.fiat ? model.fiat.amount : model.totalLabel}
            </td>
          </tr>
          {model.fiat && (
            <tr>
              <th scope="row" colSpan={3} className="hidden pt-1 pr-3 text-right text-base font-semibold sm:table-cell print:table-cell">
                Pay in USDC
              </th>
              <th scope="row" className="pt-1 text-left text-base font-semibold sm:hidden print:hidden">
                Pay in USDC
              </th>
              <td className="pt-1 text-right text-xl font-semibold whitespace-nowrap tabular-nums print:text-lg">{model.totalLabel}</td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  );
}

// F8 invoices start: the plan (installments), the two prices (early-pay discount), the late fee, refunds.
const TONE: Record<string, string> = { paid: "text-paid", open: "text-accent", muted: "text-muted", warn: "text-warn" };

function Terms({ model }: { model: InvoiceModel }) {
  const t = model.terms;
  if (!t && !model.refundedNote) return null;
  return (
    <section data-invoice-terms aria-labelledby="terms-title" className="mt-7 print:mt-4 print:break-inside-avoid">
      <h2 id="terms-title" className="text-xs font-medium uppercase tracking-wider text-muted">
        {t?.kind === "installments" ? "Payment plan" : t?.kind === "early_discount" ? "Pay early, pay less" : "Terms"}
      </h2>
      {t?.earlyNote && <p className="mt-2 leading-relaxed">{t.earlyNote}</p>}
      {t?.summary && <p className="mt-2 leading-relaxed">{t.summary}</p>}
      {t && t.rows.length > 0 && (
        <table className="mt-3 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Each payment this invoice asks for</caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">Payment</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
              <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell print:table-cell">Due</th>
              <th scope="col" className="py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i} className="border-b border-line align-top">
                <td className="py-2.5 pr-3">
                  {r.link ? (
                    <Link href={r.link} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline print:text-fg">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                  <span className="mt-0.5 block text-xs text-muted sm:hidden print:hidden">Due {r.due}</span>
                </td>
                <td className="py-2.5 pr-3 text-right whitespace-nowrap tabular-nums">{r.amount}</td>
                <td className="hidden py-2.5 pr-3 whitespace-nowrap sm:table-cell print:table-cell">{r.due}</td>
                <td className={`py-2.5 text-right text-sm font-medium ${TONE[r.tone] ?? ""}`}>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {t?.lateFeeNote && (
        <p data-late-fee className="mt-3 text-sm leading-relaxed">
          {t.lateFeeNote}
          {t.lateFeeLink && (
            <>
              {" "}
              <Link href={t.lateFeeLink} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
                See the late fee
              </Link>
            </>
          )}
        </p>
      )}
      {model.refundedNote && <p data-refunded className="mt-3 text-sm font-medium text-paid">{model.refundedNote}</p>}
      {t && t.kind !== "plain" && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Each payment is its own Owed request with its own link, so its amount can never change after it is made. This invoice
          shows Paid only when {t.kind === "installments" ? "every installment is paid" : "one of its prices is paid"}.
        </p>
      )}
    </section>
  );
}

function Waiting({ model }: { model: InvoiceModel }) {
  return (
    <section data-terms-waiting className="rounded-xl border border-line bg-sunken px-4 py-4">
      <h2 className="text-lg font-semibold">Nothing to pay right now</h2>
      <p className="mt-1 text-muted">{model.terms?.waiting ?? "The next payment hasn't opened yet."} This page will show it then.</p>
    </section>
  );
}
// F8 invoices end

function Notes({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-6 print:mt-3">
      {model.notes && (
        <div className="print:break-inside-avoid">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Notes</h2>
          <blockquote className="mt-1 leading-relaxed wrap-anywhere">
            <q><bdi>{model.notes}</bdi></q>
          </blockquote>
        </div>
      )}
      {model.fiat && (
        <p data-fiat-quote className="mt-3 text-sm leading-relaxed text-muted">
          Rate locked <span className="whitespace-nowrap text-fg">{model.fiat.lockedAt}</span>
          {" · "}
          <span className="whitespace-nowrap">{model.fiat.rate}</span>
          {model.fiat.source ? <> ({model.fiat.source})</> : null}: {model.fiat.amount} ={" "}
          <span className="whitespace-nowrap">{model.totalLabel}</span>, rounded up. The USDC amount is what you pay and
          never changes; the {model.fiat.currencyName} amount is a quote, not a guarantee.
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Text in quotes was written by the sender. Owed hasn&apos;t checked it. The total and payment status come from
        Solana.
      </p>
      {model.brandWords.length > 0 && (
        <div role="note" className="mt-4 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <p>
            <strong className="font-semibold">
              Caution: this invoice mentions {listFormat.format(model.brandWords.map((w) => `“${w}”`))}.
            </strong>{" "}
            Owed can&apos;t confirm who sent it. Only pay if you know the sender, and check the address below.
          </p>
        </div>
      )}
    </div>
  );
}

async function PayPanel({ model, card, bank }: { model: InvoiceModel; card?: ReactNode; bank?: ReactNode }) {
  return (
    <section aria-labelledby="pay-title" className="rounded-xl border border-line px-4 py-5 sm:px-5 print:rounded-none print:border-x-0 print:border-b-0 print:px-0 print:pb-0 print:pt-3">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start print:flex-row print:gap-4">
        <div className="mx-auto w-full max-w-[13rem] shrink-0 rounded-lg bg-white p-2.5 sm:mx-0 sm:w-44 print:mx-0 print:w-[30mm] print:p-0">
          <QrCode value={model.solanaPayUrl} label={`QR code to pay ${model.payLabel}. Scan it with a Solana wallet.`} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="pay-title" className="text-lg font-semibold tabular-nums">{model.payTitle}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Scan the code with any Solana wallet, or open this invoice at{" "}
            <span className="break-all font-mono text-fg">{model.invoiceLink}</span>. The money goes straight to the
            address below in one transaction; Owed never holds it.
          </p>
          <div className="mt-4 flex flex-col gap-3 print:hidden">
            <a
              href={model.solanaPayUrl}
              className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-fg px-5 text-base font-semibold text-bg transition-opacity hover:opacity-90 active:scale-[0.99]"
            >
              <WalletIcon />
              Open in wallet
            </a>
            {card /* pay by card (MoonPay), when configured */}
            <div className="grid grid-cols-2 gap-3">
              <CopyButton
                text={model.invoiceLink}
                label="Copy invoice link"
                copiedLabel="Link copied"
                icon={<LinkIcon className="shrink-0" width={18} height={18} />}
                className={secondaryButton}
              />
              <CopyButton
                text={model.agentPrompt}
                label="Pay with your AI agent"
                copiedLabel="Copied for your agent"
                icon={<AgentIcon className="shrink-0" width={18} height={18} />}
                className={secondaryButton}
              />
            </div>
          </div>
          <div className="mt-4 print:mt-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Paying to</h3>
            <p className="mt-1 font-mono text-[0.85rem] leading-relaxed break-all">{model.recipient}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted print:hidden">Pay with the QR code or Open in wallet. A payment sent to this address by hand can&apos;t be matched to this invoice.</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm print:hidden">
              <a
                href={solscanAccount(model.recipient)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline"
              >
                View on Solscan
                <ExternalIcon width={16} height={16} />
              </a>
            </div>
          </div>
          {bank /* F3 bank rail: pay by bank transfer, when switched on */}
          <p className="mt-4 flex items-center gap-2.5 text-sm print:hidden">
            <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
            </span>
            <span>
              <span className="font-medium">Waiting for payment.</span>{" "}
              <span className="text-muted">This page updates on its own when the money lands.</span>
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

export default async function InvoicePage({ params, searchParams }: PageProps<"/i/[id]">) {
  const { id } = await params;
  const loaded = await loadPublicInvoice(id);
  if (!loaded) notFound();
  const model = invoiceModel(loaded.invoice, loaded.now);
  // Pay by card (MoonPay): nothing unless MoonPay is configured.
  // F8 invoices: an invoice with terms pays the installment or price due now; with nothing payable, no card offer.
  const offer = model.payable
    ? await cardOffer({ id: model.payId, token: model.token, amount: model.payAmount, status: model.terms ? "open" : loaded.invoice.status }, "i")
    : null;
  const card = offer ? <CardPay offer={offer} notice={cardNotice((await searchParams).card)} /> : undefined;
  // F3 bank rail: nothing unless OWED_BANK_RAIL=1 and the recipient registered a signed virtual account in the invoice's
  // currency. EUR/GBP need the invoice's local-currency quote (plain invoices only); USD is the USDC amount due now.
  const bankDeal = model.payable
    ? await bankOffer({
      recipient: model.recipient, token: model.token, amount: model.payAmount, status: model.terms ? "open" : loaded.invoice.status,
      fiat: model.terms ? null : (loaded.invoice.fiat ?? null),
    })
    : null;
  const bank = bankDeal ? <BankTransfer offer={bankDeal} /> : undefined;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8 print:min-h-0 print:max-w-none print:p-0">
      <style>{PRINT_CSS}</style>
      <header className="flex items-center justify-between print:hidden">
        <Wordmark prefetch={false} />
        <Link
          href="/"
          prefetch={false}
          className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
        >
          PayBox plugin · Solana mainnet
        </Link>
      </header>

      <main className="mt-6 flex-1 md:mt-10 print:mt-0">
        <InvoiceLive
          initial={model.initial}
          id={model.payId}
          total={model.payable ? model.payAmount : model.total}
          token={model.token}
          dueLabel={model.dueLabel}
          overdue={model.overdue}
          sender={`“${model.businessName}”`}
          head={<Head model={model} />}
          pay={model.payable ? <PayPanel model={model} card={card} bank={bank} /> : <Waiting model={model} />}
          expiresAt={model.expiresAt}
          refreshOnChange={model.refreshOnChange}
          cancelledNote={model.cancelledNote}
          poll={model.payable}
        >
          <Parties model={model} />
          <Dates model={model} />
          <Items model={model} />
          <Terms model={model} />
          <Notes model={model} />
        </InvoiceLive>

        <div className="mt-5 flex flex-wrap items-center gap-3 print:hidden">
          <PrintButton className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-sunken" />
          <Link
            href={`/r/${model.payId}`}
            prefetch={false}
            className="inline-flex h-11 items-center rounded-xl px-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Open the plain pay page
          </Link>
        </div>
      </main>

      <footer data-invoice-footer className="mt-12 border-t border-line pt-5 text-sm leading-relaxed text-muted print:mt-4 print:pt-2 print:text-[0.8rem]">
        <p>
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Owed never holds
          money: you pay the sender directly, in one Solana transaction.{" "}
          <Link href="/" prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline print:hidden">
            How Owed works
          </Link>
        </p>
      </footer>
    </div>
  );
}
