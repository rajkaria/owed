import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { formatAmount } from "@/lib/view/money";
import { requestOrigin } from "@/lib/site";
import { buildStatement, checkStatementLink, parseClient, STATEMENT_LINK_TTL_SECONDS, type Statement } from "@/lib/statements";

// F8 invoices: a client's monthly statement, from a 10-minute link GET /api/v1/statements hands out after the recipient's
// wallet signature. Everything the invoices' creator wrote (client name, invoice numbers) is shown quoted; amounts come
// from the requests and the chain.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Statement" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const KIND_LABEL: Record<Statement["lines"][number]["kind"], string> = {
  invoiced: "Invoiced",
  cancelled: "Cancelled",
  expired: "Ended unpaid",
  paid: "Paid",
  refunded: "Refunded",
};
const SIGN: Record<Statement["lines"][number]["kind"], string> = { invoiced: "+", cancelled: "−", expired: "−", paid: "−", refunded: "+" };

function day(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(Date.parse(iso));
}

function signed(amount: string, token: "USDC" | "SOL"): string {
  return amount.startsWith("-") ? `−${formatAmount(amount.slice(1), token)}` : formatAmount(amount, token);
}

export default async function StatementPage({ searchParams }: PageProps<"/i/statement">) {
  const raw = await searchParams;
  const params = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const check = checkStatementLink(params);
  let statement: Statement | null = null;
  let problem: string | null = check.ok ? null : check.message;
  if (check.ok) {
    try {
      statement = await buildStatement(check.recipient, parseClient(check.client), check.month, { base: await requestOrigin(), chainBudgetMs: null });
    } catch {
      problem = "this statement couldn't be read right now; try the link again in a minute";
    }
  }
  const csvHref = `/api/v1/statements/csv?${params}`;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8 print:max-w-none print:p-0">
      <header className="flex items-center justify-between print:hidden">
        <Wordmark prefetch={false} />
        <Link href="/" prefetch={false} className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg">
          PayBox plugin · Solana mainnet
        </Link>
      </header>
      <main className="mt-6 flex-1 md:mt-10 print:mt-0">
        {!statement ? (
          <section className="rounded-xl border border-line bg-sunken px-4 py-5">
            <h1 className="text-xl font-semibold">This statement link doesn&apos;t work</h1>
            <p className="mt-2 text-muted">{problem ?? "Ask for a fresh statement."} Links last {STATEMENT_LINK_TTL_SECONDS / 60} minutes.</p>
          </section>
        ) : (
          <article aria-label="Statement" className="rounded-2xl border border-line bg-surface px-4 py-6 shadow-sm sm:px-8 sm:py-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted">Statement · {statement.month}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight wrap-anywhere">
              <q><bdi>{statement.client}</bdi></q>
            </h1>
            <p className="mt-2 text-sm text-muted">
              Paid to <span className="break-all font-mono">{statement.recipient}</span> · {day(statement.from)} to {day(new Date(Date.parse(statement.to) - 1).toISOString())} (UTC)
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {statement.totals.map((t) => (
                <div key={t.token} className="contents">
                  <div className="rounded-xl bg-sunken px-3.5 py-3">
                    <dt className="text-xs text-muted">Opening balance</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">{signed(t.opening, t.token)}</dd>
                  </div>
                  <div className="rounded-xl bg-sunken px-3.5 py-3">
                    <dt className="text-xs text-muted">Invoiced</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">{formatAmount(t.invoiced, t.token)}</dd>
                  </div>
                  <div className="rounded-xl bg-sunken px-3.5 py-3">
                    <dt className="text-xs text-muted">Paid</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">{formatAmount(t.paid, t.token)}</dd>
                  </div>
                  <div className="rounded-xl bg-sunken px-3.5 py-3">
                    <dt className="text-xs text-muted">Closing balance</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">{signed(t.closing, t.token)}</dd>
                  </div>
                </div>
              ))}
            </dl>
            {statement.lines.length === 0 ? (
              <p className="mt-6 text-muted">Nothing happened on this client&apos;s invoices this month.</p>
            ) : (
              <table className="mt-6 w-full border-collapse text-left text-sm">
                <caption className="sr-only">What happened this month</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-3 font-medium">What</th>
                    <th scope="col" className="py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.lines.map((l, i) => (
                    <tr key={i} className="border-b border-line align-top">
                      <td className="py-2.5 pr-3 whitespace-nowrap">{day(l.at)}</td>
                      <td className="py-2.5 pr-3 wrap-anywhere">
                        {KIND_LABEL[l.kind]}:{" "}
                        <Link href={l.link} prefetch={false} className="text-accent underline-offset-4 hover:underline">
                          {l.invoice_number ? <q><bdi>{l.invoice_number}</bdi></q> : l.request_id}
                        </Link>
                        {l.signature && (
                          <a href={`https://solscan.io/tx/${l.signature}`} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-muted underline-offset-4 hover:underline print:hidden">
                            transaction
                          </a>
                        )}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap tabular-nums">
                        {SIGN[l.kind]}
                        {formatAmount(l.amount, l.token)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-5 text-xs leading-relaxed text-muted">{statement.caution} Text in quotes was written by whoever made the invoices.</p>
            {statement.truncated && <p className="mt-2 text-xs text-muted">Only the first 200 invoices for this client are included.</p>}
            <div className="mt-5 flex flex-wrap gap-3 print:hidden">
              <a href={csvHref} className="inline-flex h-11 items-center rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-sunken">
                Download CSV
              </a>
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
