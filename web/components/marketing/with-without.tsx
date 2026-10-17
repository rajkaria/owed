import type { ReactNode } from "react";
import { CheckIcon } from "@/components/icons";

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
    <section aria-labelledby="compare-title" className="border-t border-line py-16 md:py-20">
      <h2 id="compare-title" className="text-3xl font-semibold tracking-tight">
        Getting paid, with and without Owed
      </h2>
      <table className="mt-8 w-full border-separate border-spacing-0 text-left">
        <thead className="max-md:sr-only">
          <tr className="text-sm text-muted">
            <th scope="col" className="w-[18%] pb-3 pr-4 font-medium">
              <span className="sr-only">Job</span>
            </th>
            <th scope="col" className="w-[41%] pb-3 pr-6 font-medium">
              Without Owed
            </th>
            <th scope="col" className="w-[41%] pb-3 font-medium text-fg">
              With Owed
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.job} className="max-md:block max-md:border-t max-md:border-line max-md:py-5">
              <th
                scope="row"
                className="align-top font-semibold max-md:block md:border-t md:border-line md:py-5 md:pr-4"
              >
                {row.job}
              </th>
              <td className="align-top leading-relaxed text-muted max-md:mt-2 max-md:block md:border-t md:border-line md:py-5 md:pr-6">
                <span className="mr-1.5 text-sm font-medium md:hidden">Without:</span>
                {row.without}
              </td>
              <td className="align-top leading-relaxed max-md:mt-2 max-md:block md:border-t md:border-line md:py-5">
                <span className="flex gap-2.5">
                  <CheckIcon className="mt-1 shrink-0 text-paid" width={18} height={18} />
                  <span>
                    <span className="mr-1.5 text-sm font-medium text-muted md:hidden">With Owed:</span>
                    {row.with}
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
