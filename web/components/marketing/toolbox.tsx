import { REMOTE_MCP_URL } from "./site";
import { Container, SectionHeading } from "./ui";

// The plugin's tools, one line each, condensed from the DESCRIPTION in plugin/src/tools/<name>.ts.
// The first eleven are the ones in the build submitted in the PayBox developer portal (docs/FACTS.md, build cecfbd2).
// The seven marked `remote` (F1 what_do_i_owe and pay_all, 0017; F6 start_ledger, add_expense, ledger_balances and
// settle_up, 0020; F8 refund_payment, 0021) are on the remote MCP endpoint (/api/mcp, the current bundle) and go into the
// portal build with its next upload. Newer behaviour of the first eleven (F2 funding plans in pay_link, F8 terms in
// create_invoice, reminders and statements in who_owes_me) is named in its summary with the same qualifier.

export const TOOLS: { name: string; summary: string; remote?: true }[] = [
  {
    name: "ask_for_money",
    summary:
      "Create a payment request and get a short link with a QR code that anyone can pay from a Solana wallet or their own PayBox agent, plus a ready-to-send message. Ask in USDC, SOL or your own currency (locked to USDC at a live rate), to your wallet or your .sns name, on Solana or in USDC on Base. Address it to someone's X handle and it shows up in their own agent's what_do_i_owe.",
  },
  {
    name: "check_payments",
    summary:
      "Check up to 20 requests by reading Solana mainnet (and Base, for Base requests): open, paid, underpaid, cancelled, expired or not found, with the payer, amount and transaction when paid.",
  },
  {
    name: "pay_link",
    summary:
      "Pay an Owed link, any Solana Pay transfer link or an .sns name (USDC or SOL): checks it is still open, the payee is who it claims and the wallet can cover it, then returns an unsigned transaction to approve in PayBox. On Owed's remote MCP endpoint, a wallet that is short gets the exact PayBox steps that fix it instead (swap SOL or another token, bring USDC over from Base, buy the shortfall with MoonPay), each approved by you, ending with the same checked payment.",
  },
  {
    name: "verify_payee",
    summary:
      "Check who a request is from: whether a domain publishes the wallet that gets paid (read from DNS by the plugin itself), or which wallet an .sns name points to on Solana, with warnings for lookalike spellings.",
  },
  {
    name: "split_bill",
    summary:
      "Split a bill into one request per person plus a live group board that shows who has paid. Split in your own currency and every share is locked to USDC at one rate.",
  },
  {
    name: "create_invoice",
    summary:
      "Create a printable invoice with line items, total, due date and invoice number, payable from any Solana wallet by QR or link, or by the client's agent. Price it in your own currency if you like. On Owed's remote MCP endpoint it also takes installments or an early-payment discount, a late fee and reminder days; every term that changes the amount is its own request, so no link ever changes what it asks.",
  },
  {
    name: "who_owes_me",
    summary:
      "List every open request, split share and invoice paid to your wallet, plus the last 30 days of payments, after you sign one message with your wallet. Signing moves no money. On Owed's remote MCP endpoint it also says when a polite, firm or formal reminder is due, and makes a client's monthly statement.",
  },
  {
    name: "write_reminder",
    summary:
      "Draft a friendly, firm or formal reminder with the pay link and days outstanding. It checks Solana first and drafts nothing for a paid request; Owed sends nothing itself.",
  },
  {
    name: "ask_every_month",
    summary:
      "Ask someone for the same amount every month: a new request opens on that day each month, and each one is an ordinary Owed request that check_payments, write_reminder and pay_link work on.",
  },
  {
    name: "cancel_request",
    summary:
      "Cancel one of your own requests, split shares or invoices so nobody pays it, proven by a signature from the wallet it pays. A paid request can't be cancelled.",
  },
  {
    name: "match_payments",
    summary:
      "Find money that reached your wallet without the request's reference (exchanges drop it): transfers of exactly the amount still owed, with reasons and warnings. It counts one only after you sign that it is yours, and can ask for exactly the rest of an underpaid request.",
  },
  {
    name: "what_do_i_owe",
    summary:
      "See what you owe: every open request, split share and invoice someone addressed to your wallet by your X handle, .sns name or wallet, after you sign one message. Names, handles and reasons are the requester's own words, unverified; first-time requesters are marked, and you can block one.",
    remote: true,
  },
  {
    name: "pay_all",
    summary:
      "Pay several requests with one approval: one Solana transaction, every request checked like pay_link (open, payee, sanctions), capped at the total you agreed to. Requests on Base or with a brand-word caution are skipped with the reason. Short of the total, it returns the PayBox steps that fix it.",
    remote: true,
  },
  {
    name: "start_ledger",
    summary:
      "Start a running tab for a trip, a flat or a team: you and up to 19 others, each identified by X handle, .sns name or wallet if you like. Nothing is owed until expenses are added.",
    remote: true,
  },
  {
    name: "add_expense",
    summary:
      "Record who paid what and how it splits: evenly, by shares, exact amounts, or straight off a receipt with tax and tip spread over each person's items. In a local currency, each share is locked to USDC at one live rate. Signed by a wallet in the ledger.",
    remote: true,
  },
  {
    name: "ledger_balances",
    summary:
      "Who is owed and who owes, in USDC with the local currency beside it, the fewest payments that square everyone, and each settle-up request's live status. The plugin re-checks every split, balance and signature first.",
    remote: true,
  },
  {
    name: "settle_up",
    summary:
      "Turn the balances into at most one fewer payment than there are people: ordinary Owed requests, each paid straight to the person owed and addressed to whoever owes it, so it waits in their own what_do_i_owe when the ledger has their wallet. Owed never holds the money.",
    remote: true,
  },
  {
    name: "refund_payment",
    summary:
      "Send all or part of a payment back to the wallet that paid it: you sign one message, then approve one transfer in PayBox. Refunds never add up to more than was paid, and count once Solana confirms them.",
    remote: true,
  },
];

export function Toolbox() {
  return (
    <section id="tools" aria-labelledby="tools-title" className="scroll-mt-20 border-t border-line bg-sunken/60 py-20 md:py-28">
      <Container>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] lg:gap-16">
          <SectionHeading
            id="tools-title"
            eyebrow="The toolbox"
            title="Eighteen tools your agent can call."
            lede={
              <>
                Each one is an MCP tool. Eleven are in the Owed plugin submitted to PayBox. The seven marked{" "}
                <span className="whitespace-nowrap font-medium text-fg">remote MCP</span> are on Owed&apos;s remote MCP endpoint,{" "}
                <code className="break-all font-mono text-[0.9em] text-fg">{REMOTE_MCP_URL}</code>, and join the plugin with its
                next upload. <code className="font-mono text-[0.9em] text-fg">recipient</code>,{" "}
                <code className="font-mono text-[0.9em] text-fg">sender</code> and a ledger&apos;s{" "}
                <code className="font-mono text-[0.9em] text-fg">signer</code> are always your own PayBox wallet, and money leaves
                it only when you approve the transaction in PayBox.
              </>
            }
          />
          <dl className="overflow-hidden rounded-2xl border border-line bg-surface">
            {TOOLS.map((t) => (
              <div key={t.name} className="grid gap-1.5 border-t border-line px-5 py-4 first:border-t-0 sm:grid-cols-[11rem_1fr] sm:gap-6">
                <dt className="flex flex-wrap items-start gap-x-2 gap-y-1 sm:flex-col">
                  <span className="font-mono text-sm font-semibold text-accent">{t.name}</span>
                  {t.remote && (
                    <span className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] font-medium leading-tight text-muted">
                      remote MCP
                    </span>
                  )}
                </dt>
                <dd className="text-[0.95rem] leading-relaxed text-muted">{t.summary}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Container>
    </section>
  );
}
