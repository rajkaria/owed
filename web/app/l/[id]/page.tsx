import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Wordmark } from "@/components/wordmark";
import { requestOrigin } from "@/lib/site";
import { verifyMessageSignature } from "@/lib/verify-signature";
import { formatUtc, shortAddress, solscanAccount } from "@/lib/view/format";
import { SettleUpRounds } from "./live";
import { ledgerDescription, ledgerTitle, ledgerView, type ExpenseView, type MemberView } from "./model";
import { loadPageLedger } from "./source";

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const textLink = "inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline";

export async function generateMetadata({ params }: PageProps<"/l/[id]">): Promise<Metadata> {
  const { id } = await params;
  const origin = await requestOrigin();
  const ledger = await loadPageLedger(id, origin);
  if (!ledger) return { title: "Ledger not found", robots: { index: false, follow: false } };
  const view = ledgerView(ledger, origin);
  const title = ledgerTitle(view);
  const description = ledgerDescription(view);
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", siteName: "Owed", url: view.link },
    twitter: { card: "summary", title, description },
  };
}

function Name({ text, quoted }: { text: string; quoted: boolean }) {
  return quoted ? <q><bdi>{text}</bdi></q> : <span className="text-muted">{text}</span>;
}

function Balance({ m }: { m: MemberView }) {
  const tone = m.direction === "owed" ? "text-paid" : m.direction === "owes" ? "text-fg" : "text-muted";
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 text-lg font-medium leading-snug break-words">
          <Name text={m.label} quoted={m.quoted} />
          {m.owner && <span className="ml-2 align-middle text-xs font-medium uppercase tracking-wider text-muted">owner</span>}
        </p>
        <p className={`shrink-0 text-right font-semibold tabular-nums ${tone}`}>
          {m.direction === "square" ? "Square" : `${m.direction === "owed" ? "Is owed" : "Owes"} ${m.net}`}
          {m.netFiat && <span className="block text-xs font-normal text-muted">{m.netFiat}</span>}
        </p>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        Paid {m.paid} · their share {m.share}
        {m.pendingOut && ` · ${m.pendingOut} requested from them`}
        {m.pendingIn && ` · ${m.pendingIn} on its way to them`}
      </p>
      <p className="mt-1 text-xs text-muted">
        {m.wallet ? (
          <>
            Wallet{" "}
            <a href={solscanAccount(m.wallet)} target="_blank" rel="noopener noreferrer" className="font-mono text-fg hover:underline" title={m.wallet}>
              {shortAddress(m.wallet)}
            </a>
            {m.handle && <> · @{m.handle} on X, not verified by Owed</>}
            {m.sns && <> · {m.sns} when added</>}
          </>
        ) : (
          "No wallet in this ledger: can owe through a plain link, but can't be paid through Owed"
        )}
      </p>
    </li>
  );
}

function Expense({ e }: { e: ExpenseView }) {
  const when = formatUtc(e.recordedAt);
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 text-lg font-medium leading-snug break-words">
          {e.description ? <q><bdi>{e.description}</bdi></q> : <span className="text-muted">Expense {e.position + 1}</span>}
        </p>
        <p className="shrink-0 text-right font-semibold tabular-nums">
          {e.total}
          {e.usdc && <span className="block text-xs font-normal text-muted">{e.usdc}</span>}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">
        Paid by {e.paidBy} · {e.splitLine}
        {e.extras && ` · ${e.extras}`}
      </p>
      {e.brandWords.length > 0 && (
        <p className="mt-2 flex gap-2 text-sm text-warn">
          <AlertIcon className="mt-0.5 shrink-0" width={16} height={16} />
          Mentions {listFormat.format(e.brandWords.map((w) => `“${w}”`))}. Owed can&apos;t confirm who wrote it.
        </p>
      )}
      {e.items.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {e.items.map((i, k) => (
            <li key={k} className="flex justify-between gap-4">
              <span className="min-w-0 break-words">
                {i.description ? <q><bdi>{i.description}</bdi></q> : <span className="text-muted">Item {k + 1}</span>}
                <span className="text-muted"> · {i.who}</span>
              </span>
              <span className="shrink-0 tabular-nums">{i.amount}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {e.shares.map((s, k) => (
          <li key={k} className="tabular-nums">
            <span className="text-muted">{s.label}{s.weight ? ` (${s.weight} ${s.weight === "1" ? "share" : "shares"})` : ""}:</span> {s.share}
            {s.usdc && <span className="text-muted"> = {s.usdc}</span>}
          </li>
        ))}
      </ul>
      {e.rateLine && <p className="mt-2 text-xs text-muted">{e.rateLine}</p>}
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">
          Recorded by {e.recordedBy}
          {when && (
            <>
              {" "}· <LocalTime iso={e.recordedAt} fallback={when} />
            </>
          )}
          {e.signatureOk ? " · signed by their wallet" : " · signature not checked"}
        </summary>
        <p className="mt-1.5 font-mono break-all">{e.signedMessage}</p>
        <p className="mt-1 font-mono break-all">{e.signature}</p>
      </details>
    </li>
  );
}

export default async function LedgerPage({ params }: PageProps<"/l/[id]">) {
  const { id } = await params;
  const origin = await requestOrigin();
  const ledger = await loadPageLedger(id, origin);
  if (!ledger) notFound();
  const view = ledgerView(ledger, origin, verifyMessageSignature);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8">
      <header className="flex items-center justify-between">
        <Wordmark prefetch={false} />
        <Link href="/" prefetch={false} className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg">
          PayBox plugin · Solana mainnet
        </Link>
      </header>

      <main className="mt-8 flex-1 md:mt-14">
        <div className="mx-auto w-full max-w-2xl">
          <section aria-labelledby="ledger-title">
            <p className="text-lg text-muted sm:text-xl">Group ledger</p>
            <h1 id="ledger-title" className="mt-1 text-4xl font-semibold tracking-tight break-words sm:text-5xl">
              {view.title ? <q><bdi>{view.title}</bdi></q> : "Untitled ledger"}
            </h1>
            <p className="mt-3 text-lg text-muted tabular-nums">
              {view.spent} spent · {view.expenseCount} {view.expenseCount === 1 ? "expense" : "expenses"} · {view.members.length} people
            </p>
            <p className="mt-2 text-xs font-medium uppercase tracking-wider text-muted">Title, names and descriptions written by the members</p>
            <p className="mt-3 text-sm leading-relaxed text-muted">{view.caution}</p>
          </section>

          {view.brandWords.length > 0 && (
            <div role="note" className="mt-5 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
              <AlertIcon className="mt-0.5 shrink-0 text-warn" />
              <p>
                <strong className="font-semibold">Caution: this ledger mentions {listFormat.format(view.brandWords.map((w) => `“${w}”`))}.</strong>{" "}
                Owed can&apos;t confirm who wrote it. Only pay people you know, and check each pay page&apos;s address.
              </p>
            </div>
          )}

          <section aria-labelledby="balances-title" className="mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="balances-title" className="text-2xl font-semibold tracking-tight">Balances</h2>
              {view.settled && (
                <p className="flex items-center gap-2 font-medium text-paid">
                  <CheckIcon width={18} height={18} strokeWidth={2.5} />
                  Everyone is square.
                </p>
              )}
            </div>
            <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
              {view.members.map((m) => (
                <Balance key={m.position} m={m} />
              ))}
            </ul>
            {view.fiatNote && <p className="mt-3 text-xs leading-relaxed text-muted">{view.fiatNote}</p>}
          </section>

          {view.plan.length > 0 && (
            <section aria-labelledby="plan-title" className="mt-8">
              <h2 id="plan-title" className="text-2xl font-semibold tracking-tight">To settle up</h2>
              <p className="mt-1 text-sm text-muted">
                The fewest payments that square everyone: the largest debt pays the largest credit first. A member&apos;s agent
                creates them with settle_up; each becomes an Owed request payable to the person owed.
              </p>
              <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
                {view.plan.map((t, k) => (
                  <li key={k} className="flex items-baseline justify-between gap-4 px-4 py-3 sm:px-5">
                    <p className="min-w-0 leading-snug break-words">
                      {t.from} <span className="text-muted">pays</span> {t.to}
                      {!t.payable && <span className="block text-xs text-warn">{t.to} has no wallet in this ledger yet, so Owed can&apos;t create this request</span>}
                    </p>
                    <span className="shrink-0 font-semibold tabular-nums">{t.amount}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view.rounds.length > 0 && (
            <section aria-labelledby="requests-title" className="mt-8">
              <h2 id="requests-title" className="text-2xl font-semibold tracking-tight">Settle-up requests</h2>
              <p className="mt-1 text-sm text-muted">
                Ordinary Owed requests: each pays the person owed directly, in one Solana transaction. Owed never holds the money.
                This list updates on its own when money lands.
              </p>
              <SettleUpRounds rounds={view.rounds} />
            </section>
          )}

          <section aria-labelledby="expenses-title" className="mt-8">
            <h2 id="expenses-title" className="text-2xl font-semibold tracking-tight">Expenses</h2>
            {view.expenses.length === 0 ? (
              <p className="mt-2 text-muted">Nothing recorded yet. A member&apos;s agent adds expenses with add_expense.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
                {[...view.expenses].reverse().map((e) => (
                  <Expense key={e.position} e={e} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      <footer className="mx-auto mt-12 w-full max-w-2xl border-t border-line pt-5 text-sm leading-relaxed text-muted">
        <p>
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Owed never holds
          money: each person pays the person they owe directly, in one Solana transaction.{" "}
          <Link href="/" prefetch={false} className={textLink}>
            How Owed works
          </Link>
        </p>
      </footer>
    </div>
  );
}
