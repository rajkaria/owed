import type { ReactNode } from "react";
import { CheckIcon } from "@/components/icons";
import { Container, SectionHeading } from "./ui";

const ROWS: { job: string; without: ReactNode; with: ReactNode }[] = [
  {
    job: "Asking",
    without: "Paste your wallet address into the chat and say how much.",
    with: <>Say &ldquo;ask Priya for 15 USDC for dinner&rdquo;. Owed makes the link, the QR code and the message.</>,
  },
  {
    job: "Paying",
    without: "They copy the address, pick the token, type the amount and hope it is right.",
    with: "They open the link in a Solana wallet, or hand it to their own PayBox agent. Amount, token and wallet are filled in.",
  },
  {
    job: "Splitting a bill",
    without: "Work out every share, message each person, keep score in your head.",
    with: "One sentence gives each person their own link and you one board that shows who has paid.",
  },
  {
    job: "Invoicing",
    without: "Make a PDF, paste an address under it, match the payment by hand later.",
    with: "A printable invoice with line items and a due date that the client pays by QR or link.",
  },
  {
    job: "Knowing who paid",
    without: "Scroll a block explorer and match amounts to names.",
    with: <>Ask &ldquo;did Priya pay?&rdquo; and get the amount, the time and the transaction.</>,
  },
  {
    job: "Knowing who you pay",
    without: "A wallet address in a chat can be swapped, and nothing tells you.",
    with: "When a request names a domain, Owed reads that domain's DNS before your agent pays and refuses a wallet it doesn't list.",
  },
];

export function WithWithout() {
  return (
    <section aria-labelledby="compare-title" className="border-t border-line py-20 md:py-28">
      <Container>
        <SectionHeading
          id="compare-title"
          eyebrow="Before and after"
          title="Getting paid, with and without Owed."
          lede="The same six jobs, done by hand and done by asking your agent."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-surface">
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead className="max-md:sr-only">
              <tr className="text-sm">
                <th scope="col" className="w-[18%] border-b border-line px-5 py-3 font-medium text-muted">
                  <span className="sr-only">Job</span>
                </th>
                <th scope="col" className="w-[41%] border-b border-line px-5 py-3 font-medium text-muted">
                  Without Owed
                </th>
                <th scope="col" className="w-[41%] border-b border-line bg-accent-soft/60 px-5 py-3 font-semibold text-accent">
                  With Owed
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => {
                const divider = i > 0 ? "md:border-t md:border-line" : "";
                return (
                  <tr key={row.job} className={`max-md:block ${i > 0 ? "max-md:border-t max-md:border-line" : ""}`}>
                    <th scope="row" className={`px-5 pt-5 align-top font-semibold max-md:block md:py-5 ${divider}`}>
                      {row.job}
                    </th>
                    <td className={`px-5 pt-2 align-top leading-relaxed text-muted max-md:block md:py-5 ${divider}`}>
                      <span className="mr-1.5 text-sm font-medium md:hidden">Without:</span>
                      {row.without}
                    </td>
                    <td className={`bg-accent-soft/60 px-5 py-4 align-top leading-relaxed max-md:mt-3 max-md:block md:py-5 ${divider}`}>
                      <span className="flex gap-2.5">
                        <CheckIcon className="mt-1 shrink-0 text-paid" width={18} height={18} strokeWidth={2.5} />
                        <span>
                          <span className="mr-1.5 text-sm font-medium text-muted md:hidden">With Owed:</span>
                          {row.with}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Container>
    </section>
  );
}
