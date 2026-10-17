import type { ReactNode } from "react";
import { BellIcon, ListIcon, ReceiptIcon, ShieldIcon, UsersIcon, UtensilsIcon } from "@/components/icons";
import { Container, SectionHeading } from "./ui";

// Six things people ask their agent to do with Owed. Each sentence follows the tool's own description
// in plugin/src/tools/*.ts; the chip is the phrase you would say.

interface UseCase {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  say: string;
  tools: string[];
}

const CASES: UseCase[] = [
  {
    icon: <UtensilsIcon />,
    title: "Dinner",
    body: "One person owes you. Your agent makes a short link, a QR code and a ready-to-send message; they pay from any Solana wallet or their own PayBox agent.",
    say: "Ask Priya for 15 USDC for dinner",
    tools: ["ask_for_money"],
  },
  {
    icon: <UsersIcon />,
    title: "Split the bill",
    body: "One request per person, a set amount for anyone who owes a specific sum and an even split for the rest, plus a live board that shows who has paid.",
    say: "Split 45 USDC for pizza between Priya, Sam and Alex",
    tools: ["split_bill"],
  },
  {
    icon: <ReceiptIcon />,
    title: "Freelance invoice",
    body: "A printable invoice with line items, total, due date and invoice number, payable by QR, by link or by the client's own agent.",
    say: "Invoice Acme for 3 hours of consulting at 40 USDC, due Friday",
    tools: ["create_invoice"],
  },
  {
    icon: <ListIcon />,
    title: "Who owes me",
    body: "Every open request, split share and invoice paid to your wallet, what came in over the last 30 days, and the totals. You sign one message to prove the wallet is yours; no money moves.",
    say: "Who still owes me?",
    tools: ["who_owes_me"],
  },
  {
    icon: <BellIcon />,
    title: "Reminders",
    body: "A friendly, firm or formal reminder for SMS, WhatsApp or email, with the pay link and how long it has been outstanding. Owed checks Solana first, so nobody is chased for money they already sent, and you send it yourself.",
    say: "Nudge Sam about the 20 USDC",
    tools: ["write_reminder"],
  },
  {
    icon: <ShieldIcon />,
    title: "Paying safely",
    body: "Paste any Owed or Solana Pay link. Your agent checks it is still open, that your wallet can cover it and, when the request names a domain, that the domain publishes the payee wallet. Then you approve with your passkey in PayBox.",
    say: "Pay this link",
    tools: ["pay_link", "verify_payee"],
  },
];

export function UseCases() {
  return (
    <section id="use-cases" aria-labelledby="use-cases-title" className="scroll-mt-20 border-t border-line py-20 md:py-28">
      <Container>
        <SectionHeading
          id="use-cases-title"
          eyebrow="Use cases"
          title="Say it the way you would say it to a friend."
          lede="Your agent picks the right Owed tool from plain words. Nothing is sent or paid until you approve it."
        />
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CASES.map((c) => (
            <li key={c.title} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-6">
              <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5">{c.icon}</span>
              <h3 className="mt-5 text-lg font-semibold">{c.title}</h3>
              <p className="mt-2 flex-1 leading-relaxed text-muted">{c.body}</p>
              <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <code className="rounded-md bg-sunken px-2 py-1 font-mono text-[0.8rem] text-fg">&ldquo;{c.say}&rdquo;</code>
              </p>
              <p className="mt-2 font-mono text-xs text-muted">{c.tools.join(" + ")}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
