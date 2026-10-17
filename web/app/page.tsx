import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { ArrowRightIcon, CheckIcon, CopyIcon } from "@/components/icons";
import { SiteFooter, SiteHeader } from "@/components/marketing/chrome";
import { Counters } from "@/components/marketing/counters";
import { getPaidStats, readOwedRecord } from "@/components/marketing/data";
import { ExampleChat } from "@/components/marketing/example-chat";
import { GoldenPathVideo } from "@/components/marketing/golden-path";
import { PayeeCheck } from "@/components/marketing/payee-check";
import { canonical, DEMO_DOMAIN, PAYBOX_MCP_URL, PAYBOX_PLUGINS_URL } from "@/components/marketing/site";
import { WithWithout } from "@/components/marketing/with-without";

// Refresh the live counters and the DNS read at most once a minute.
export const revalidate = 60;

const TITLE = "Owed: your agent asks for money and knows when it lands";
const DESCRIPTION =
  "Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Requests, split bills and invoices any Solana wallet or PayBox agent can pay.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: canonical("/") },
  openGraph: { title: TITLE, description: DESCRIPTION, url: canonical("/"), siteName: "Owed", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const STEPS = [
  {
    title: "Ask",
    body: (
      <>
        Tell your agent who owes you and how much. Owed makes a short link, a QR code and a message to paste into
        WhatsApp or iMessage. A split bill gives each person their own link; an invoice gets a printable page.
      </>
    ),
  },
  {
    title: "They pay from any wallet",
    body: (
      <>
        Priya opens the link and pays from a Solana wallet such as Phantom, or asks her own PayBox agent to pay it. She
        doesn&apos;t need an Owed account, and the money goes straight to your wallet.
      </>
    ),
  },
  {
    title: "Your agent tells you",
    body: (
      <>
        Ask &ldquo;did Priya pay?&rdquo; Owed reads Solana and answers with the amount, the time and the transaction.
        The pay page flips to Paid on its own.
      </>
    ),
  },
];

const TRY = [
  { say: "Ask Priya for 15 USDC for dinner", tool: "ask_for_money" },
  { say: "Split 45 USDC for pizza between Priya, Sam and Alex", tool: "split_bill" },
  { say: "Invoice Acme for 3 hours of consulting at 40 USDC, due Friday", tool: "create_invoice" },
  { say: "Did Priya pay?", tool: "check_payments" },
  { say: "Who still owes me?", tool: "who_owes_me" },
  { say: "Remind Priya about dinner, keep it friendly", tool: "write_reminder" },
  { say: "Pay this link", tool: "pay_link" },
  { say: `Is this request really from ${DEMO_DOMAIN}?`, tool: "verify_payee" },
];

const SAFETY = [
  "Owed never holds money. Every payment goes straight from the payer's wallet to yours in one Solana transaction.",
  "Owed charges no fees.",
  "A request counts as paid only when a confirmed transaction sends the full amount of the right token to your address.",
  "Notes appear in quotes, marked as unverified, with links and hidden characters removed. Requests that mention names like MoonPay or PayBox carry a warning.",
];

export default async function Home() {
  const [stats, record] = await Promise.all([getPaidStats(), readOwedRecord(DEMO_DOMAIN)]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      <SiteHeader current="home" />

      <main>
        <section className="grid grid-cols-1 items-center gap-12 pb-16 pt-8 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] md:gap-14 md:pb-24 md:pt-16">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm font-medium text-muted">
              <span className="size-1.5 rounded-full bg-paid" aria-hidden="true" />
              PayBox plugin · Solana mainnet
            </p>
            <h1 className="mt-5 text-[2.05rem] font-semibold leading-[1.08] tracking-tight text-muted sm:text-5xl md:text-[3.25rem]">
              Owed is a PayBox plugin that lets your agent <span className="text-fg">ask anyone for money</span>, then
              tells you <span className="text-fg">who has paid</span>.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Your agent asks one person, splits a bill or sends an invoice, and any Solana wallet or PayBox agent can pay
              it. Before your agent pays a request from a domain, Owed checks that the domain lists the wallet.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#add"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-fg px-5 font-semibold text-bg hover:opacity-90"
              >
                Add Owed in PayBox
                <ArrowRightIcon width={18} height={18} />
              </a>
              <Link
                href="/proof"
                className="inline-flex h-12 items-center rounded-xl border border-line bg-surface px-5 font-medium hover:bg-sunken"
              >
                See real payments
              </Link>
            </div>
          </div>
          <ExampleChat />
        </section>

        <GoldenPathVideo />

        <section id="how" aria-labelledby="how-title" className="scroll-mt-6 border-t border-line py-16 md:py-20">
          <h2 id="how-title" className="text-3xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
                <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                  {i + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 rounded-2xl bg-sunken px-5 py-4 leading-relaxed text-muted">
            <span className="font-semibold text-fg">It works the other way too.</span> Paste an Owed or Solana Pay link
            into your agent and approve the payment with your passkey in PayBox.
          </p>
        </section>

        <WithWithout />

        <PayeeCheck record={record} />

        <section id="add" aria-labelledby="add-title" className="scroll-mt-6 border-t border-line py-16 md:py-20">
          <h2 id="add-title" className="text-3xl font-semibold tracking-tight">
            Add Owed in PayBox
          </h2>
          <ol className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            <li className="min-w-0 rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-accent">Step 1</p>
              <h3 className="mt-1 text-lg font-semibold">Connect PayBox to your agent</h3>
              <p className="mt-2 leading-relaxed text-muted">In Claude or ChatGPT, add PayBox as a connector with this address:</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken py-1.5 pl-3 pr-1.5">
                <code className="break-all font-mono text-sm">{PAYBOX_MCP_URL}</code>
                <CopyButton
                  text={PAYBOX_MCP_URL}
                  label="Copy"
                  icon={<CopyIcon className="shrink-0" width={16} height={16} />}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface px-2.5 py-1.5 text-sm font-medium"
                />
              </div>
            </li>
            <li className="min-w-0 rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-accent">Step 2</p>
              <h3 className="mt-1 text-lg font-semibold">Turn on Owed</h3>
              <p className="mt-2 leading-relaxed text-muted">
                Owed is in the PayBox developer portal and not yet listed in the public marketplace. Once it is, open{" "}
                <a href={PAYBOX_PLUGINS_URL} className="font-medium text-accent underline-offset-4 hover:underline">
                  app.paybox.sh/plugins
                </a>{" "}
                and enable Owed.
              </p>
            </li>
            <li className="min-w-0 rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-accent">Step 3</p>
              <h3 className="mt-1 text-lg font-semibold">Ask in your own words</h3>
              <p className="mt-2 leading-relaxed text-muted">
                Your agent picks the right Owed tool. Nothing moves until you approve it with your passkey.
              </p>
            </li>
          </ol>
          <h3 className="mt-10 text-lg font-semibold">Things to try</h3>
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TRY.map((t) => (
              <li key={t.tool} className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                <span className="leading-snug">&ldquo;{t.say}&rdquo;</span>
                <code className="mt-0.5 shrink-0 font-mono text-xs text-muted">{t.tool}</code>
              </li>
            ))}
          </ul>
        </section>

        <Counters stats={stats} />

        <section aria-labelledby="safety-title" className="border-t border-line py-16 md:py-20">
          <h2 id="safety-title" className="text-3xl font-semibold tracking-tight">
            Built to be safe to use
          </h2>
          <ul className="mt-8 grid grid-cols-1 gap-x-10 gap-y-5 md:grid-cols-2">
            {SAFETY.map((line) => (
              <li key={line} className="flex gap-3 leading-relaxed">
                <CheckIcon className="mt-0.5 shrink-0 text-paid" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
