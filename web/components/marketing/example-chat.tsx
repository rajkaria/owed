import type { ReactNode } from "react";
import { CheckIcon, ExternalIcon } from "@/components/icons";
import { Mark } from "@/components/wordmark";

// The hero illustration: an example conversation with an agent that has Owed, labelled as one.
// Values come from contract/fixtures (create-request.res.json, status.res.json); the QR is a drawing.

/** A chat bubble. `tone="paper"` for the page body, `tone="ink"` for the dark hero. */
export function Bubble({ from, tone = "paper", children }: { from: "you" | "agent"; tone?: "paper" | "ink"; children: ReactNode }) {
  const you = from === "you";
  const ink = tone === "ink";
  const skin = you
    ? ink
      ? "rounded-br-md bg-ink-fg text-ink"
      : "rounded-br-md bg-fg text-bg"
    : ink
      ? "rounded-bl-md bg-ink-sunken text-ink-fg"
      : "rounded-bl-md bg-sunken text-fg";
  return (
    <div className={`flex ${you ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-[0.95rem] leading-snug ${skin}`}>{children}</div>
    </div>
  );
}

// 21 × 21 modules: three finder patterns, timing rows, and a fixed fill. An illustration, not a code.
const QR_ROWS = [
  "111111101101001111111",
  "100000101010101000001",
  "101110100111101011101",
  "101110101100101011101",
  "101110100010001011101",
  "100000101101101000001",
  "111111101010101111111",
  "000000001100100000000",
  "101011110010111010010",
  "011000011011001101100",
  "110110101100110011011",
  "001011010011010100110",
  "111010111000101110101",
  "000000001011010010010",
  "111111100100111011001",
  "100000101110100100110",
  "101110100011011101011",
  "101110101001010010100",
  "101110100110111011011",
  "100000101010001100100",
  "111111100101110011011",
];

function QrDrawing({ className = "" }: { className?: string }) {
  const n = QR_ROWS.length;
  const cells: ReactNode[] = [];
  QR_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />);
    }
  });
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className={className} aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <g fill="#0a0b10">{cells}</g>
    </svg>
  );
}

export function ExampleChat() {
  return (
    <figure className="w-full min-w-0">
      <div className="rounded-3xl border border-ink-line bg-ink-surface p-4 shadow-glow sm:p-5">
        <div className="flex items-center gap-2 border-b border-ink-line pb-3 text-xs text-ink-muted">
          <span className="size-2 rounded-full bg-ink-accent" aria-hidden="true" />
          Your agent, with PayBox and Owed
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <Bubble from="you" tone="ink">
            Ask Priya for 15 USDC for dinner
          </Bubble>
          <Bubble from="agent" tone="ink">
            Request ready. Here&apos;s the link to send Priya; she can pay it from any Solana wallet.
          </Bubble>
          <div className="mr-auto w-[92%] overflow-hidden rounded-2xl border border-ink-line bg-ink">
            <div className="flex items-stretch gap-3 p-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <Mark size={28} />
                  <p className="text-xl font-semibold leading-none tabular-nums text-ink-fg">15 USDC</p>
                </div>
                <p className="mt-2 truncate text-sm text-ink-muted">
                  from Priya · for &ldquo;dinner&rdquo;
                </p>
                <p className="mt-2 truncate font-mono text-xs text-ink-accent">getowed.xyz/r/JArQ6g9JvoWr</p>
              </div>
              <div className="shrink-0 overflow-hidden rounded-lg border border-ink-line bg-white p-1">
                <QrDrawing className="size-[4.5rem]" />
              </div>
            </div>
          </div>
          <Bubble from="you" tone="ink">
            Did Priya pay?
          </Bubble>
          <Bubble from="agent" tone="ink">
            <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-ink-accent-soft px-2 py-0.5 text-xs font-semibold text-ink-accent">
              <CheckIcon width={14} height={14} strokeWidth={3} />
              Paid
            </span>
            <span className="block">
              Priya sent 15 USDC from 9WzD…AWWM, confirmed on Solana at 05:00 UTC.
            </span>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-ink-line px-2.5 py-1 text-xs font-medium text-ink-fg">
              View transaction
              <ExternalIcon width={12} height={12} />
            </span>
          </Bubble>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-ink-muted">Example conversation</figcaption>
    </figure>
  );
}
