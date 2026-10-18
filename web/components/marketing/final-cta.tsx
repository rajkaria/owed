import { CopyButton } from "@/components/copy-button";
import { ArrowRightIcon, CopyIcon } from "@/components/icons";
import { DEMO_DOMAIN, PAYBOX_MCP_URL, PAYBOX_PLUGINS_URL } from "./site";
import { Container, StepBadge } from "./ui";

// The closing call to action: the three steps to add Owed in PayBox, as one ink card.

const TRY = [
  { say: "Ask Priya for 15 USDC for dinner", tool: "ask_for_money" },
  { say: "Split 45 USDC for pizza between Priya, Sam and Alex", tool: "split_bill" },
  { say: "Invoice Acme for 3 hours of consulting at 40 USDC, due Friday", tool: "create_invoice" },
  { say: "Did Priya pay?", tool: "check_payments" },
  { say: "Who still owes me?", tool: "who_owes_me" },
  { say: "Pay this link", tool: "pay_link" },
  { say: `Is this request really from ${DEMO_DOMAIN}?`, tool: "verify_payee" },
  { say: "Nudge Sam about the 20 USDC", tool: "write_reminder" },
  { say: "Ask Sam for 450 USDC rent on the 1st", tool: "ask_every_month" },
  { say: "Priya paid me in cash, cancel her link", tool: "cancel_request" },
  { say: "Ask Priya for ₹1,200 for dinner", tool: "ask_for_money" },
  { say: "Bill Alex 20 USDC on Base", tool: "ask_for_money" },
  { say: "Pay bonfida.sns 2 USDC", tool: "pay_link" },
  { say: "Sam says he paid from Coinbase, but it still shows open", tool: "match_payments" },
  { say: "Ask @sam for 10 USDC", tool: "ask_for_money" },
  { say: "What do I owe?", tool: "what_do_i_owe" },
  { say: "Pay them all", tool: "pay_all" },
  { say: "Start a tab for our Lisbon trip with Priya, Sam and Alex", tool: "start_ledger" },
  { say: "I paid 84.60 EUR for dinner, split it evenly", tool: "add_expense" },
  { say: "Who owes what on the trip?", tool: "ledger_balances" },
  { say: "Settle up the trip", tool: "settle_up" },
  { say: "Invoice Acme 1,200 USDC in 3 monthly installments", tool: "create_invoice" },
  { say: "Refund Priya the 5 USDC she overpaid", tool: "refund_payment" },
];

export function FinalCta() {
  return (
    <section id="add" aria-labelledby="add-title" className="scroll-mt-20 border-t border-line py-20 md:py-28">
      <Container>
        <div className="relative isolate overflow-hidden rounded-3xl bg-ink p-6 text-ink-fg shadow-glow sm:p-10 lg:p-14">
          <div aria-hidden="true" className="bg-grid mask-fade-b pointer-events-none absolute inset-0 opacity-60" />
          <div aria-hidden="true" className="bg-glow pointer-events-none absolute -top-40 left-1/2 h-[28rem] w-[44rem] -translate-x-1/2 rounded-full opacity-80 blur-3xl" />
          <div className="relative">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-ink-accent">Get started</p>
            <h2 id="add-title" className="mt-3 max-w-2xl text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl lg:text-5xl">
              Add Owed to PayBox in two minutes.
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-lg leading-relaxed text-ink-muted">
              No account with Owed, no keys to paste. PayBox holds your wallet; Owed only ever hands your agent unsigned
              proposals.
            </p>

            <ol className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <li className="min-w-0 rounded-2xl border border-ink-line bg-ink-surface/80 p-5">
                <div className="flex items-center gap-3">
                  <StepBadge n={1} ink />
                  <h3 className="font-semibold">Connect PayBox to your agent</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">In Claude or ChatGPT, add PayBox as a connector with this address.</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink py-1.5 pl-3 pr-1.5 ring-1 ring-ink-line">
                  <code className="break-all font-mono text-sm text-ink-fg">{PAYBOX_MCP_URL}</code>
                  <CopyButton
                    text={PAYBOX_MCP_URL}
                    label="Copy"
                    icon={<CopyIcon className="shrink-0" width={16} height={16} />}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink-surface px-2.5 text-sm font-medium text-ink-fg hover:bg-ink-accent-soft"
                  />
                </div>
              </li>
              <li className="min-w-0 rounded-2xl border border-ink-line bg-ink-surface/80 p-5">
                <div className="flex items-center gap-3">
                  <StepBadge n={2} ink />
                  <h3 className="font-semibold">Turn on Owed</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                  Owed is submitted to PayBox and waiting for its listing in the plugin marketplace. Once it is listed, open{" "}
                  <a href={PAYBOX_PLUGINS_URL} className="font-medium text-ink-accent underline-offset-4 hover:underline">
                    app.paybox.sh/plugins
                  </a>{" "}
                  and enable Owed.
                </p>
              </li>
              <li className="min-w-0 rounded-2xl border border-ink-line bg-ink-surface/80 p-5">
                <div className="flex items-center gap-3">
                  <StepBadge n={3} ink />
                  <h3 className="font-semibold">Ask in your own words</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                  Your agent picks the right Owed tool. Nothing moves until you approve it with your passkey.
                </p>
              </li>
            </ol>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={PAYBOX_PLUGINS_URL}
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-ink-accent px-5 font-semibold text-ink hover:brightness-105"
              >
                Open PayBox plugins
                <ArrowRightIcon width={18} height={18} />
              </a>
              <a
                href="/llms.txt"
                className="inline-flex h-12 items-center rounded-xl border border-ink-line px-5 font-medium text-ink-fg hover:bg-ink-accent-soft"
              >
                Read the docs for agents
              </a>
            </div>

            <h3 className="mt-12 text-sm font-semibold text-ink-muted">Things to try</h3>
            <ul className="mt-3 flex flex-wrap gap-2">
              {TRY.map((t) => (
                <li key={t.say} className="inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-full border border-ink-line bg-ink-surface/80 py-1.5 pl-3.5 pr-2 text-sm">
                  <span className="leading-snug">&ldquo;{t.say}&rdquo;</span>
                  <code className="rounded-full bg-ink-accent-soft px-2 py-0.5 font-mono text-[0.7rem] text-ink-accent">{t.tool}</code>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">
              Asking by X handle, <code className="font-mono text-ink-fg">what_do_i_owe</code>,{" "}
              <code className="font-mono text-ink-fg">pay_all</code>, group ledgers, invoice terms, refunds and the steps for a
              short balance are on Owed&apos;s remote MCP endpoint now and come to the PayBox plugin with its next upload.
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
