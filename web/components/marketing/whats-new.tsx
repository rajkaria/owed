import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon, AtIcon, CardIcon, CoinsIcon, LayersIcon, ListIcon, QrIcon, ReceiptIcon, SearchIcon, UsersIcon, WalletIcon } from "@/components/icons";
import { Container, SectionHeading } from "./ui";

// What shipped after the first release, newest work first. Every "Live" card is on production from main
// cecfbd2 (docs/FACTS.md, "Web production: main cecfbd2"); the proof links point at real mainnet payments.
// The first four cards (F6 group ledgers, F8 invoice terms and refunds, F2 funding plans, F1 what_do_i_owe / pay_all /
// X handles) are on the remote MCP endpoint (/api/mcp, the current bundle) from the deploy that ships this copy, and
// in the PayBox portal build with its next upload; each says so. Their pages and API routes are on production.
// The card-payment card says "Live" only when MoonPay is configured with live keys (lib/moonpay/config.ts),
// the same switch that puts "Pay by card (MoonPay)" on the pay page, so the two never disagree.

interface Item {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  tools: string[];
  live: boolean;
  proof?: { href: string; label: string };
}

function items(cardLive: boolean): Item[] {
  return [
    {
      icon: <UsersIcon />,
      title: "Group ledgers that settle in the fewest payments",
      body: (
        <>
          Start a tab for a trip or a flat, add expenses as they happen (evenly, by shares, exact amounts, or straight off a
          receipt, in USDC or the local currency), then settle up: at most one fewer payment than there are people, each one
          an ordinary Owed request paid straight to the person owed. Every expense is signed by a wallet in the ledger. On
          Owed&apos;s remote MCP endpoint now; in the PayBox plugin with its next upload.
        </>
      ),
      tools: ["start_ledger", "add_expense", "ledger_balances", "settle_up"],
      live: true,
    },
    {
      icon: <ReceiptIcon />,
      title: "Invoices with terms, and refunds",
      body: (
        <>
          Installments or an early-payment discount, a late fee and reminder days, where every term that changes the amount
          is its own request, so no link ever changes what it asks. Your agent says when a reminder is due, makes a
          client&apos;s monthly statement, and sends a refund back to the wallet that paid, never more than was paid. On
          Owed&apos;s remote MCP endpoint now; in the PayBox plugin with its next upload.
        </>
      ),
      tools: ["create_invoice", "who_owes_me", "refund_payment"],
      live: true,
    },
    {
      icon: <WalletIcon />,
      title: "A short balance doesn't end a payment",
      body: (
        <>
          Not enough USDC? Your agent gets the exact PayBox steps that fix it: swap SOL (sized at Pyth&apos;s price), bring USDC over
          from Base, buy the shortfall with MoonPay, or pay over x402 when only the network fee is missing. You approve each
          step, and the payment is checked again from scratch. On Owed&apos;s remote MCP endpoint now; in the PayBox plugin
          with its next upload.
        </>
      ),
      tools: ["pay_link", "pay_all"],
      live: true,
    },
    {
      icon: <ListIcon />,
      title: "Ask by X handle, pay them all at once",
      body: (
        <>
          Ask @sam and the request shows up in Sam&apos;s own agent when he asks &ldquo;what do I owe?&rdquo;, with no link to paste.
          He picks what to pay, and his agent checks each request on its own, then pays them all in one Solana transaction
          with one approval. Handles are labels Owed never verifies: his agent checks them with PayBox before paying. On
          Owed&apos;s remote MCP endpoint now; in the PayBox plugin with its next upload.
        </>
      ),
      tools: ["what_do_i_owe", "pay_all", "ask_for_money"],
      live: true,
    },
    {
      icon: <SearchIcon />,
      title: "Find payments that lost their link",
      body: (
        <>
          Exchanges and some wallets drop the Solana Pay reference, so the money lands but the request stays open. Your agent
          finds transfers of exactly the amount still owed, says why each one fits, and counts one only after you sign that
          it&apos;s yours. Underpaid? It asks for exactly the rest.
        </>
      ),
      tools: ["match_payments"],
      live: true,
    },
    {
      icon: <CoinsIcon />,
      title: "Ask in your own currency",
      body: (
        <>
          &ldquo;Ask Priya for ₹1,200 for dinner.&rdquo; Owed locks the USDC at a live rate from Coinbase, checked against a
          second source, rounds it up, and the pay page shows both amounts. 38 currencies, for requests, splits and
          invoices.
        </>
      ),
      tools: ["ask_for_money", "split_bill", "create_invoice"],
      live: true,
    },
    {
      icon: <AtIcon />,
      title: "Get paid to a name",
      body: (
        <>
          Give your wallet as an <code className="font-mono text-[0.9em] text-fg">.sns</code> name. Owed resolves it on Solana
          itself, the pay page says &ldquo;verified on-chain&rdquo;, and your payer&apos;s agent refuses to pay if the name has
          since moved to another wallet.
        </>
      ),
      tools: ["ask_for_money", "pay_link", "verify_payee"],
      live: true,
    },
    {
      icon: <LayersIcon />,
      title: "USDC on Base",
      body: (
        <>
          Ask on Base when that is where your payer keeps USDC. They open one link in their Base wallet, and Owed reads the
          transfer on Base to mark the request paid, with the payer, amount and transaction.
        </>
      ),
      tools: ["ask_for_money", "check_payments"],
      live: true,
      proof: { href: "/proof", label: "First Base payment" },
    },
    {
      icon: <QrIcon />,
      title: "Scan with Phantom, and it counts",
      body: (
        <>
          Phantom&apos;s scanner turned a payment link into a plain send and dropped the reference, so the payment couldn&apos;t be
          matched. The QR now asks the wallet to sign a transaction Owed built, with the reference inside.
        </>
      ),
      tools: ["pay page"],
      live: true,
      proof: { href: "/proof", label: "Paid by Phantom scan" },
    },
    {
      icon: <CardIcon />,
      title: "Pay by card with MoonPay",
      body: cardLive ? (
        <>
          No wallet? The payer&apos;s card buys exactly the USDC owed in MoonPay&apos;s checkout, delivered straight to you. Owed
          marks it paid only once Solana confirms the transfer, never on MoonPay&apos;s word alone.
        </>
      ) : (
        <>
          No wallet? The payer&apos;s card buys exactly the USDC owed in MoonPay&apos;s checkout, delivered straight to you, and Owed
          marks it paid only once Solana confirms the transfer. Built and merged; it switches on once MoonPay live keys are in.
        </>
      ),
      tools: ["pay page", "invoice page"],
      live: cardLive,
    },
  ];
}

export function WhatsNew({ cardLive }: { cardLive: boolean }) {
  return (
    <section id="new" aria-labelledby="new-title" className="scroll-mt-20 border-t border-line py-20 md:py-28">
      <Container>
        <SectionHeading
          id="new-title"
          eyebrow="What's new"
          title="Shipped since launch."
          lede="Built in public on Solana mainnet. Each of these is running on production today, except the one marked next."
        />
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items(cardLive).map((item) => (
            <li key={item.title} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-6">
              <div className="flex items-center justify-between gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5">{item.icon}</span>
                {item.live ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-paid-soft px-2.5 py-1 text-xs font-semibold text-paid">
                    <span className="size-1.5 rounded-full bg-paid" aria-hidden="true" />
                    Live
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-xs font-semibold text-muted">
                    Next
                  </span>
                )}
              </div>
              <h3 className="mt-5 text-lg font-semibold">{item.title}</h3>
              <p className="mt-2 flex-1 leading-relaxed text-muted">{item.body}</p>
              <p className="mt-5 font-mono text-xs text-muted">{item.tools.join(" · ")}</p>
              {item.proof && (
                <Link
                  href={item.proof.href}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
                >
                  {item.proof.label}
                  <ArrowRightIcon width={16} height={16} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
