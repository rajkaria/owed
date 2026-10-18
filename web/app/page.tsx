import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "@/components/icons";
import { SiteFooter, SiteHeader } from "@/components/marketing/chrome";
import { Counters } from "@/components/marketing/counters";
import { getPaidStats, readOwedRecord } from "@/components/marketing/data";
import { Developers } from "@/components/marketing/developers";
import { ExampleChat } from "@/components/marketing/example-chat";
import { FinalCta } from "@/components/marketing/final-cta";
import { GoldenPathVideo } from "@/components/marketing/golden-path";
import { PayeeCheck } from "@/components/marketing/payee-check";
import { canonical, DEMO_DOMAIN } from "@/components/marketing/site";
import { Toolbox } from "@/components/marketing/toolbox";
import { TrustStrip } from "@/components/marketing/trust-strip";
import { Container, SectionHeading, StepBadge } from "@/components/marketing/ui";
import { UseCases } from "@/components/marketing/use-cases";
import { WhatsNew } from "@/components/marketing/whats-new";
import { WithWithout } from "@/components/marketing/with-without";
import { moonpayConfig, moonpaySellConfig } from "@/lib/moonpay/config";
import { alertsConfigured } from "@/lib/alerts/config"; // S1 alerts

// Refresh the live counters and the DNS read at most once a minute.
export const revalidate = 60;

const TITLE = "Owed: your agent asks for money and knows when it lands";
const DESCRIPTION =
  "Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Requests, split bills and invoices in USDC, SOL or your own currency, payable from any Solana wallet, a Base wallet or a PayBox agent, with no fees and nothing held by Owed.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: canonical("/") },
  openGraph: { title: TITLE, description: DESCRIPTION, url: canonical("/"), siteName: "Owed", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const FACTS = ["No fees", "Owed never holds funds", "One transaction, wallet to wallet", "Open source"];

const STEPS = [
  {
    title: "Ask",
    body: (
      <>
        Tell your agent who owes you and how much. Owed makes a short link, a QR code and a message to paste into WhatsApp or
        iMessage. A split bill gives each person their own link; an invoice gets a printable page.
      </>
    ),
  },
  {
    title: "They pay from any wallet",
    body: (
      <>
        Priya scans the QR with Phantom, opens the link in a Solana wallet, or asks her own PayBox agent to pay it. She
        doesn&apos;t need an Owed account, and the money goes straight to your wallet.
      </>
    ),
  },
  {
    title: "Your agent tells you",
    body: (
      <>
        Ask &ldquo;did Priya pay?&rdquo; Owed reads the chain and answers with the amount, the time and the transaction. The pay
        page flips to Paid on its own. If she paid from an exchange that dropped the reference, Owed finds it for you to
        confirm.
      </>
    ),
  },
];

const SAFETY = [
  "Owed never holds money. Every payment goes straight from the payer's wallet to yours in one Solana transaction.",
  "Owed charges no fees.",
  "A request counts as paid only when a confirmed transaction sends the full amount of the right token to your address.",
  "Notes appear in quotes, marked as unverified, with links and hidden characters removed. Requests that mention names like MoonPay or PayBox carry a warning.",
  "Recipients on the U.S. Treasury's OFAC sanctions list are refused, by the plugin and by the server.",
  "A request id is a hash of its terms, so a server can't swap who gets paid or how much behind a shared link.",
  "Owed never guesses who paid: a transfer without the request's reference counts only after the recipient signs that it's theirs, and Owed re-checks it on chain first.",
  "An .sns name is resolved on Solana by the plugin itself, and a request made for a name is paid only while the name still points to its wallet.",
];

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-ink text-ink-fg">
      <div aria-hidden="true" className="bg-grid mask-fade-b pointer-events-none absolute inset-0 opacity-80" />
      <div aria-hidden="true" className="bg-glow pointer-events-none absolute -top-56 left-1/2 h-[40rem] w-[64rem] -translate-x-1/2 rounded-full blur-3xl" />
      <Container className="relative grid grid-cols-1 items-center gap-12 pb-20 pt-14 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:gap-14 md:pb-28 md:pt-24 lg:gap-20">
        <div>
          <p className="animate-rise inline-flex items-center gap-2 rounded-full border border-ink-line bg-ink-surface/70 px-3 py-1 text-sm font-medium text-ink-muted">
            <span className="animate-pulse-dot size-1.5 rounded-full bg-ink-accent" aria-hidden="true" />
            PayBox plugin · MCP server · Solana and Base
          </p>
          <h1
            id="hero-title"
            className="animate-rise mt-6 text-balance text-[2.5rem] font-semibold leading-[1.04] tracking-tight [animation-delay:60ms] sm:text-5xl lg:text-[3.75rem]"
          >
            Your agent asks for money. <span className="text-gradient">And knows when it lands.</span>
          </h1>
          <p className="animate-rise mt-6 max-w-xl text-pretty text-lg leading-relaxed text-ink-muted [animation-delay:120ms]">
            Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Ask one person
            in USDC, SOL or your own currency, split a bill or send an invoice; anyone can pay from a Solana or Base wallet
            or their own PayBox agent. Before your agent pays, Owed checks the payee is who it claims.
          </p>
          <div className="animate-rise mt-8 flex flex-wrap gap-3 [animation-delay:180ms]">
            <a
              href="#add"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-ink-accent px-5 font-semibold text-ink hover:brightness-105"
            >
              Add Owed to PayBox
              <ArrowRightIcon width={18} height={18} />
            </a>
            <Link
              href="/proof"
              className="inline-flex h-12 items-center rounded-xl border border-ink-line bg-ink-surface/40 px-5 font-medium text-ink-fg hover:bg-ink-accent-soft"
            >
              See real payments
            </Link>
          </div>
          <ul className="dot-list animate-rise mt-8 flex flex-wrap text-sm text-ink-muted [animation-delay:240ms]" aria-label="Facts">
            {FACTS.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
        <div className="animate-rise [animation-delay:200ms]">
          <ExampleChat />
        </div>
      </Container>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 py-20 md:py-28">
      <Container>
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="Three steps, and the last one is the point."
          lede="Asking is easy anywhere. Knowing it landed, without checking a block explorer, is what Owed adds."
        />
        <ol className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="relative rounded-2xl border border-line bg-surface p-6">
              <StepBadge n={i + 1} />
              <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 rounded-2xl border border-line bg-surface px-5 py-4 leading-relaxed text-muted">
          <span className="font-semibold text-fg">It works the other way too.</span> Paste an Owed or Solana Pay link into your
          agent and approve the payment with your passkey in PayBox. When the request names a domain, Owed reads that
          domain&apos;s DNS record before it proposes anything.
        </p>
      </Container>
    </section>
  );
}

function Safety() {
  return (
    <section aria-labelledby="safety-title" className="border-t border-line py-20 md:py-28">
      <Container>
        <SectionHeading id="safety-title" eyebrow="Safety" title="Built to be safe to use." />
        <ul className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          {SAFETY.map((line) => (
            <li key={line} className="flex gap-4 rounded-2xl border border-line bg-surface p-5 leading-relaxed">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-paid-soft text-paid">
                <CheckIcon width={16} height={16} strokeWidth={2.75} />
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

export default async function Home() {
  const [stats, record] = await Promise.all([getPaidStats(), readOwedRecord(DEMO_DOMAIN)]);
  // The same switch as "Pay by card (MoonPay)" on the pay page; sandbox keys never count as live.
  const card = moonpayConfig();
  const cardLive = card !== null && !card.sandbox;
  // Wave 3: the same switches as the /alerts form and POST /api/v1/cash-out.
  const alertsLive = alertsConfigured();
  const sell = moonpaySellConfig();
  const cashOutLive = sell !== null && !sell.sandbox;

  return (
    <>
      <SiteHeader current="home" />
      <main>
        <Hero />
        <TrustStrip />
        <Container>
          <GoldenPathVideo />
        </Container>
        <HowItWorks />
        <WhatsNew cardLive={cardLive} alertsLive={alertsLive} cashOutLive={cashOutLive} />
        <UseCases />
        <Toolbox />
        <Developers />
        <PayeeCheck record={record} />
        <Counters stats={stats} />
        <WithWithout />
        <Safety />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
