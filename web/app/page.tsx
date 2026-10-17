import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { ArrowRightIcon, CheckIcon, CopyIcon } from "@/components/icons";
import { Mark, Wordmark } from "@/components/wordmark";
import { siteOrigin } from "@/lib/site";
import { groupDigits } from "@/lib/view/money";

// Refresh the live counter at most once a minute.
export const revalidate = 60;

const PAYBOX_MCP_URL = "https://api.paybox.sh/mcp";
const REPO_URL = "https://github.com/rajkaria/owed";

/** Real paid requests from /api/v1/stats. Null hides the counter (zero, missing or unreachable). */
async function getPaidStats(): Promise<{ count: number; volume: string | null } | null> {
  try {
    const res = await fetch(new URL("/api/v1/stats", siteOrigin()), {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { paid_count?: unknown; paid_volume_usdc?: unknown };
    const count = json.paid_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) return null;
    const volume =
      typeof json.paid_volume_usdc === "string" && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(json.paid_volume_usdc)
        ? json.paid_volume_usdc
        : null;
    return { count, volume: volume && volume !== "0" ? volume : null };
  } catch {
    return null;
  }
}

function Bubble({ from, children }: { from: "you" | "agent"; children: ReactNode }) {
  const you = from === "you";
  return (
    <div className={`flex ${you ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[0.95rem] leading-snug ${
          you ? "rounded-br-md bg-fg text-bg" : "rounded-bl-md bg-sunken text-fg"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function ExampleChat() {
  return (
    <figure className="w-full min-w-0">
      <div className="rounded-3xl border border-line bg-surface p-4 shadow-[0_1px_0_var(--line),0_24px_48px_-24px_rgb(0_0_0/0.18)] sm:p-5">
        <div className="flex flex-col gap-3">
          <Bubble from="you">Ask Priya for 15 USDC for dinner</Bubble>
          <Bubble from="agent">
            Request ready: 15 USDC from Priya for &ldquo;dinner&rdquo;. Here&apos;s the link to send her.
          </Bubble>
          <div className="ml-0 mr-auto w-[85%] overflow-hidden rounded-2xl border border-line">
            <div className="flex items-center gap-3 bg-bg px-4 py-3.5">
              <Mark size={34} />
              <div className="min-w-0">
                <p className="text-lg font-semibold leading-tight tabular-nums">15 USDC</p>
                <p className="truncate text-sm text-muted">for &ldquo;dinner&rdquo; · Pay with any Solana wallet</p>
              </div>
            </div>
          </div>
          <Bubble from="you">Did Priya pay?</Bubble>
          <Bubble from="agent">
            <span className="mb-1 flex items-center gap-1.5 font-semibold text-paid">
              <CheckIcon width={16} height={16} strokeWidth={2.75} />
              Paid
            </span>
            Priya sent 15 USDC, confirmed on Solana. Here&apos;s the transaction.
          </Bubble>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-muted">
        Example: what it looks like in Claude or ChatGPT with PayBox
      </figcaption>
    </figure>
  );
}

const STEPS = [
  {
    title: "Ask",
    body: (
      <>
        Tell your agent who owes you and how much. Owed makes a short link, a QR code and a message you can paste into
        WhatsApp or iMessage.
      </>
    ),
  },
  {
    title: "They pay with any wallet",
    body: (
      <>
        Priya opens the link and pays in Phantom, Solflare or Backpack, or asks her own PayBox agent to pay it. She
        doesn&apos;t need an Owed account.
      </>
    ),
  },
  {
    title: "Your agent tells you",
    body: (
      <>
        Ask &ldquo;did Priya pay?&rdquo; Owed checks Solana and answers with the amount, the time and the transaction.
        The pay page flips to Paid on its own.
      </>
    ),
  },
];

const SAFETY = [
  "Owed never holds money. Every payment goes straight from the payer's wallet to yours in one Solana transaction.",
  "Owed charges no fees.",
  "A request counts as paid only when a confirmed transaction sends the full amount of the right token to your address.",
  "Notes appear exactly as the requester wrote them, in quotes. Requests that mention names like MoonPay or PayBox carry a warning.",
];

export default async function Home() {
  const stats = await getPaidStats();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <nav aria-label="Main" className="flex items-center gap-1 text-sm font-medium">
          <a href="#how" className="hidden rounded-lg px-3 py-2 text-muted hover:text-fg sm:inline-block">
            How it works
          </a>
          <a href={REPO_URL} className="rounded-lg px-3 py-2 text-muted hover:text-fg">
            GitHub
          </a>
          <a href="#add" className="ml-1 rounded-lg bg-fg px-3.5 py-2 text-bg hover:opacity-90">
            Add to PayBox
          </a>
        </nav>
      </header>

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
              Say &ldquo;ask Priya for 15 USDC for dinner&rdquo;. Owed makes a link that any Solana wallet or PayBox
              agent can pay. Ask &ldquo;did Priya pay?&rdquo; and it checks the chain and answers with the transaction.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#add"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-fg px-5 font-semibold text-bg hover:opacity-90"
              >
                Add Owed in PayBox
                <ArrowRightIcon width={18} height={18} />
              </a>
              <a
                href="#how"
                className="inline-flex h-12 items-center rounded-xl border border-line bg-surface px-5 font-medium hover:bg-sunken"
              >
                How it works
              </a>
            </div>
            {stats && (
              <p className="mt-6 text-sm text-muted">
                <strong className="font-semibold text-fg tabular-nums">{groupDigits(String(stats.count))}</strong>{" "}
                {stats.count === 1 ? "request" : "requests"} paid on Solana mainnet
                {stats.volume && (
                  <>
                    {" "}
                    · <strong className="font-semibold text-fg tabular-nums">{groupDigits(stats.volume)} USDC</strong>{" "}
                    received
                  </>
                )}
              </p>
            )}
          </div>
          <ExampleChat />
        </section>

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

        <section id="add" aria-labelledby="add-title" className="scroll-mt-6 border-t border-line py-16 md:py-20">
          <h2 id="add-title" className="text-3xl font-semibold tracking-tight">
            Add Owed in PayBox
          </h2>
          <ol className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            <li className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
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
            <li className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-accent">Step 2</p>
              <h3 className="mt-1 text-lg font-semibold">Turn on Owed</h3>
              <p className="mt-2 leading-relaxed text-muted">
                Open{" "}
                <a href="https://app.paybox.sh/plugins" className="font-medium text-accent underline-offset-4 hover:underline">
                  app.paybox.sh/plugins
                </a>{" "}
                and enable Owed.
              </p>
            </li>
            <li className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-accent">Step 3</p>
              <h3 className="mt-1 text-lg font-semibold">Ask for money</h3>
              <p className="mt-2 leading-relaxed text-muted">
                Try &ldquo;ask Priya for 15 USDC for dinner&rdquo;, then later &ldquo;did Priya pay?&rdquo;
              </p>
            </li>
          </ol>
        </section>
      </main>

      <footer className="flex flex-col gap-3 border-t border-line py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <Wordmark size={22} />
        <p>
          Every request and payment is real, on Solana mainnet.{" "}
          <a href={REPO_URL} className="font-medium text-accent underline-offset-4 hover:underline">
            Source on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
