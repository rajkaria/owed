"use client";

import type { ReactNode } from "react";
import type { PayboxCtaView } from "@/lib/cta";
import { CopyButton } from "./copy-button";
import { CopyIcon, ExternalIcon } from "./icons";

// SP1 "New to crypto? Pay with PayBox" on an open pay page (lib/cta.ts decides when and writes every word; nothing
// here comes from the requester). A client component only for the copy button's counter:
// - the account link is a plain link to GET /api/v1/cta/paybox, which counts the click on the server and redirects
//   to app.paybox.sh (works without JavaScript, never prefetched);
// - the copy button copies first; the count is one small POST sent without waiting, and its outcome is ignored.
// It sits in the pay page's actions, so it disappears with them once the live status leaves "open".

const CTA_ENDPOINT = "/api/v1/cta";

function countCopy(request: string): void {
  try {
    void fetch(CTA_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "prompt_copy", request }),
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    // Counting never gets in the way of the copy.
  }
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-xs font-semibold tabular-nums text-fg"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

export function PayboxCta({ cta }: { cta: PayboxCtaView }) {
  return (
    <section
      aria-labelledby="paybox-cta-title"
      data-paybox-cta
      className="mt-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <h2 id="paybox-cta-title" className="text-base font-semibold tracking-tight">
        {cta.heading}
      </h2>
      <ol className="mt-4 flex flex-col gap-4 text-sm leading-relaxed">
        <Step n={1}>
          <p>
            {cta.account.text}{" "}
            <a
              href={cta.accountHref}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline"
            >
              {cta.account.linkText}
              <ExternalIcon width={14} height={14} className="shrink-0" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {cta.account.after}
          </p>
          <p className="mt-1 text-muted">{cta.account.note}</p>
        </Step>
        <Step n={2}>
          <p>{cta.buy}</p>
          <p className="mt-1 text-muted">{cta.checkout}</p>
        </Step>
        <Step n={3}>
          <p>{cta.tell}</p>
          <div className="mt-2 flex flex-col gap-2 rounded-xl bg-sunken p-3 sm:flex-row sm:items-center sm:py-2 sm:pr-2">
            <code data-paybox-prompt className="min-w-0 font-mono text-[0.8125rem] leading-snug text-fg [overflow-wrap:anywhere] sm:flex-1">
              {cta.prompt}
            </code>
            {/* The button's own click copies; this wrapper hears it bubble up afterwards and counts it. */}
            <span className="contents" onClick={() => countCopy(cta.requestId)}>
              <CopyButton
                text={cta.prompt}
                label="Copy for Claude"
                copiedLabel="Copied"
                icon={<CopyIcon className="shrink-0" width={16} height={16} />}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg sm:self-auto border border-line bg-surface px-3 text-sm font-medium text-fg transition-colors hover:bg-bg active:scale-[0.99]"
              />
            </span>
          </div>
          <p className="mt-2 text-muted">{cta.approve}</p>
        </Step>
      </ol>
    </section>
  );
}
