import type { ReactNode } from "react";
import { CheckIcon } from "@/components/icons";
import { Mark } from "@/components/wordmark";

export function Bubble({ from, children }: { from: "you" | "agent"; children: ReactNode }) {
  const you = from === "you";
  return (
    <div className={`flex ${you ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-[0.95rem] leading-snug ${
          you ? "rounded-br-md bg-fg text-bg" : "rounded-bl-md bg-sunken text-fg"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/** The hero illustration: an example conversation, labelled as one. */
export function ExampleChat() {
  return (
    <figure className="w-full min-w-0">
      <div className="rounded-3xl border border-line bg-surface p-4 shadow-[0_1px_0_var(--line),0_24px_48px_-24px_rgb(0_0_0/0.18)] sm:p-5">
        <div className="flex flex-col gap-3">
          <Bubble from="you">Ask Priya for 15 USDC for dinner</Bubble>
          <Bubble from="agent">
            Request ready: 15 USDC from Priya for &ldquo;dinner&rdquo;. Here&apos;s the link to send her.
          </Bubble>
          <div className="ml-0 mr-auto w-[88%] overflow-hidden rounded-2xl border border-line">
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
