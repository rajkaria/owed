import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { AgentIcon, AlertIcon, CheckIcon, CopyIcon, ExternalIcon, LinkIcon, WalletIcon } from "@/components/icons";
import { QrCode } from "@/components/qr-code";
import { Wordmark } from "@/components/wordmark";
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
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted">Invoice</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all sm:text-3xl">
        {model.numberIsId ? (
          <span className="font-mono">{model.number}</span>
        ) : (
          <>
            <span className="sr-only">Invoice number </span>
            <q>{model.number}</q>
          </>
        )}
      </h1>
    </>
  );
}

function Parties({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-7 grid gap-5 sm:grid-cols-2 print:mt-5 print:grid-cols-2">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">From</h2>
        <p className="mt-1 text-lg font-semibold leading-snug break-words">
          <q>{model.businessName}</q>
        </p>
        {/* TODO(W2-H): replace this block with
              <VerifiedBadge domain={model.fromDomain} verifiedAt={model.fromDomainVerifiedAt} />
            from @/components/verified-badge. Until then the API refuses from_domain, so it never renders. */}
        {model.fromDomain && model.fromDomainVerifiedAt && (
          <p className="mt-2 flex items-start gap-2 text-sm">
            <CheckIcon className="mt-0.5 shrink-0 text-paid" width={16} height={16} />
            <span>
              From <span className="font-semibold break-all">{model.fromDomain}</span>
              <span className="text-muted"> · verified by DNS</span>
            </span>
          </p>
        )}
        <p className="mt-2 text-sm text-muted">
          Paid to <span className="font-mono">{model.recipientShort}</span>
        </p>
      </div>
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Bill to</h2>
        <p className="mt-1 text-lg font-semibold leading-snug break-words">
          <q>{model.clientName}</q>
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
        <dt className="text-xs text-muted">Amount due</dt>
        <dd className="mt-0.5 font-semibold tabular-nums">{model.totalLabel}</dd>
      </div>
    </dl>
  );
}

function Items({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-7 print:mt-4">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Line items, written by the sender</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Description</th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">Qty</th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">Unit price</th>
            <th scope="col" className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {model.lines.map((line, i) => (
            <tr key={i} className="border-b border-line align-top print:break-inside-avoid">
              <td className="py-3 pr-3 break-words print:py-1.5">
                <q>{line.description}</q>
                <span className="mt-0.5 block text-xs text-muted tabular-nums sm:hidden print:hidden">
                  {line.quantity} × {line.unitPrice}
                </span>
              </td>
              <td className="hidden py-3 pr-3 text-right tabular-nums sm:table-cell print:table-cell print:py-1.5">{line.quantity}</td>
              <td className="hidden py-3 pr-3 text-right whitespace-nowrap tabular-nums sm:table-cell print:table-cell print:py-1.5">
                {line.unitPrice}
              </td>
              <td className="py-3 text-right font-medium whitespace-nowrap tabular-nums print:py-1.5">{line.amount}</td>
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
              {model.totalLabel}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Notes({ model }: { model: InvoiceModel }) {
  return (
    <div className="mt-6 print:mt-3">
      {model.notes && (
        <div className="print:break-inside-avoid">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Notes</h2>
          <blockquote className="mt-1 leading-relaxed break-words">
            <q>{model.notes}</q>
          </blockquote>
        </div>
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

async function PayPanel({ model }: { model: InvoiceModel }) {
  return (
    <section aria-labelledby="pay-title" className="rounded-xl border border-line px-4 py-5 sm:px-5 print:rounded-none print:border-x-0 print:border-b-0 print:px-0 print:pb-0 print:pt-3">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start print:flex-row print:gap-4">
        <div className="mx-auto w-full max-w-[13rem] shrink-0 rounded-lg bg-white p-2.5 sm:mx-0 sm:w-44 print:mx-0 print:w-[30mm] print:p-0">
          <QrCode value={model.solanaPayUrl} label={`QR code to pay ${model.totalLabel}. Scan it with a Solana wallet.`} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="pay-title" className="text-lg font-semibold">
            Pay <span className="tabular-nums">{model.totalLabel}</span>
          </h2>
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
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm print:hidden">
              <CopyButton
                text={model.recipient}
                label="Copy address"
                copiedLabel="Address copied"
                icon={<CopyIcon className="shrink-0" width={16} height={16} />}
                className="inline-flex items-center gap-1.5 font-medium text-accent"
              />
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

export default async function InvoicePage({ params }: PageProps<"/i/[id]">) {
  const { id } = await params;
  const loaded = await loadPublicInvoice(id);
  if (!loaded) notFound();
  const model = invoiceModel(loaded.invoice, loaded.now);

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
          id={model.id}
          total={model.total}
          token={model.token}
          dueLabel={model.dueLabel}
          overdue={model.overdue}
          sender={`“${model.businessName}”`}
          head={<Head model={model} />}
          pay={<PayPanel model={model} />}
        >
          <Parties model={model} />
          <Dates model={model} />
          <Items model={model} />
          <Notes model={model} />
        </InvoiceLive>

        <div className="mt-5 flex flex-wrap items-center gap-3 print:hidden">
          <PrintButton className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-sunken" />
          <Link
            href={`/r/${model.id}`}
            prefetch={false}
            className="inline-flex h-11 items-center rounded-xl px-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Open the plain pay page
          </Link>
        </div>
      </main>

      <footer className="mt-12 border-t border-line pt-5 text-sm leading-relaxed text-muted print:mt-4 print:pt-2 print:text-[0.8rem]">
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
