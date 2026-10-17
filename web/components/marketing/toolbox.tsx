import { Container, SectionHeading } from "./ui";

// The plugin's tools, one line each, condensed from the DESCRIPTION in plugin/src/tools/<name>.ts.
// The ten here are the ones in the build uploaded to the PayBox developer portal (docs/FACTS.md, build 79a06eb).

export const TOOLS: { name: string; summary: string }[] = [
  {
    name: "ask_for_money",
    summary:
      "Create a payment request and get a short link with a QR code that anyone can pay from any Solana wallet or from their own PayBox agent, plus a ready-to-send message.",
  },
  {
    name: "check_payments",
    summary:
      "Check up to 20 requests by reading Solana mainnet: open, paid, underpaid, cancelled, expired or not found, with the payer, amount and transaction when paid.",
  },
  {
    name: "pay_link",
    summary:
      "Pay an Owed link or any Solana Pay transfer link (USDC or SOL): checks it is still open and the wallet can cover it, then returns an unsigned transaction to approve in PayBox.",
  },
  {
    name: "verify_payee",
    summary:
      "Check who a request is from: whether a domain publishes the wallet that gets paid, read from DNS by the plugin itself, with warnings for lookalike spellings.",
  },
  {
    name: "split_bill",
    summary: "Split a bill into one request per person plus a live group board that shows who has paid.",
  },
  {
    name: "create_invoice",
    summary:
      "Create a printable invoice with line items, total, due date and invoice number, payable from any Solana wallet by QR or link, or by the client's agent.",
  },
  {
    name: "who_owes_me",
    summary:
      "List every open request, split share and invoice paid to your wallet, plus the last 30 days of payments, after you sign one message with your wallet. Signing moves no money.",
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
];

export function Toolbox() {
  return (
    <section id="tools" aria-labelledby="tools-title" className="scroll-mt-20 border-t border-line bg-sunken/60 py-20 md:py-28">
      <Container>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] lg:gap-16">
          <SectionHeading
            id="tools-title"
            eyebrow="The toolbox"
            title="Ten tools your agent can call."
            lede={
              <>
                Each one is an MCP tool in the Owed plugin. <code className="font-mono text-[0.9em] text-fg">recipient</code> and{" "}
                <code className="font-mono text-[0.9em] text-fg">sender</code> are always your own PayBox wallet, so money can
                only ever be asked for into it or paid from it with your approval.
              </>
            }
          />
          <dl className="overflow-hidden rounded-2xl border border-line bg-surface">
            {TOOLS.map((t) => (
              <div key={t.name} className="grid gap-1.5 border-t border-line px-5 py-4 first:border-t-0 sm:grid-cols-[11rem_1fr] sm:gap-6">
                <dt className="font-mono text-sm font-semibold text-accent">{t.name}</dt>
                <dd className="text-[0.95rem] leading-relaxed text-muted">{t.summary}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Container>
    </section>
  );
}
