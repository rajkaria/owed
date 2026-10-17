"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, AlertIcon, ExternalIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { formatUtc, shortAddress, solscanTx } from "@/lib/view/format";
import { formatAmount, type Token } from "@/lib/view/money";
import { pickStatusResult, stateFromStatus, type LiveState } from "@/lib/view/request-view";

const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;
const STAMP_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

/**
 * Polls POST /api/v1/status every 4 s while the invoice is open and the tab is visible; stops for
 * good once it is paid, underpaid or cancelled. What shows always comes from the API, so a hard
 * refresh after the flip shows the same Paid stamp (the server renders it from the stored payment).
 */
function useInvoiceState(initial: LiveState, id: string, total: string, token: Token): LiveState {
  const [state, setState] = useState<LiveState>(initial);
  const active = state.status === "open";

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let delay = POLL_MS;
    let disposed = false;
    const body = JSON.stringify({ ids: [id] });

    async function tick() {
      timer = undefined;
      if (disposed || document.visibilityState === "hidden") return;
      controller = new AbortController();
      try {
        const res = await fetch("/api/v1/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.ok) {
          const next = stateFromStatus(pickStatusResult(await res.json(), id), total, token);
          if (next && next.status !== "open") {
            setState(next);
            return;
          }
          delay = POLL_MS;
        } else {
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
      } catch {
        if (disposed) return;
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      } finally {
        controller = null;
      }
      if (!disposed) timer = setTimeout(tick, delay);
    }

    function onVisibility() {
      if (document.visibilityState === "visible" && timer === undefined && controller === null) {
        delay = POLL_MS;
        void tick();
      }
    }

    timer = setTimeout(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, id, total, token]);

  return state;
}

function stampDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : STAMP_DATE.format(ms);
}

function StatusChip({ state, dueLabel, overdue }: { state: LiveState; dueLabel: string; overdue: boolean }) {
  const base = "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold print:border print:px-2.5";
  switch (state.status) {
    case "paid":
      return (
        <span className={`${base} bg-paid-soft text-paid print:border-paid`}>
          <CheckIcon width={16} height={16} strokeWidth={2.5} />
          Paid
        </span>
      );
    case "underpaid":
      return <span className={`${base} bg-warn-soft text-warn print:border-warn`}>Partly paid</span>;
    case "cancelled":
      return <span className={`${base} bg-sunken text-muted print:border-line`}>Cancelled</span>;
    default:
      return (
        <span className={`${base} ${overdue ? "bg-warn-soft text-warn print:border-warn" : "bg-accent-soft text-accent print:border-accent"}`}>
          {dueLabel}
        </span>
      );
  }
}

/** The rubber stamp across the top of a paid invoice: "PAID", the date and the transaction. */
function PaidStamp({ state }: { state: Extract<LiveState, { status: "paid" }> }) {
  const date = stampDate(state.at);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-24 z-10 -rotate-[9deg] rounded-lg border-[3px] border-paid bg-surface/80 px-3 py-1.5 text-center text-paid shadow-sm sm:right-10 sm:top-24 print:right-2 print:top-14 print:bg-transparent print:shadow-none [print-color-adjust:exact]"
    >
      <p className="text-3xl font-black uppercase leading-none tracking-[0.2em] sm:text-4xl">Paid</p>
      {(date || state.signature) && (
        <p className="mt-1 font-mono text-[0.7rem] font-semibold leading-tight">
          {date && <>on {date}</>}
          {date && state.signature && " · "}
          {state.signature && <>tx {shortAddress(state.signature)}</>}
        </p>
      )}
    </div>
  );
}

function Receipt({ state, token }: { state: Extract<LiveState, { status: "paid" }>; token: Token }) {
  const when = state.at ? formatUtc(state.at) : null;
  return (
    <section aria-labelledby="receipt-title" className="rounded-xl border border-paid/40 bg-paid-soft px-4 py-4 sm:px-5 print:border-paid">
      <h2 id="receipt-title" className="flex items-center gap-2 text-lg font-semibold text-paid">
        <CheckIcon width={20} height={20} strokeWidth={2.5} />
        Paid on Solana
      </h2>
      <p className="mt-2 leading-relaxed" role="status">
        {state.amount ? <strong className="tabular-nums">{formatAmount(state.amount, token)}</strong> : "The full amount"} arrived
        {state.payer && (
          <>
            {" "}from <span className="font-mono" title={state.payer}>{shortAddress(state.payer)}</span>
          </>
        )}
        {state.at && when && (
          <>
            {" "}on <LocalTime iso={state.at} fallback={when} />
          </>
        )}
        .
      </p>
      {state.signature && (
        <p className="mt-2 text-sm">
          <a
            href={solscanTx(state.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline print:hidden"
          >
            View transaction on Solscan
            <ExternalIcon width={16} height={16} />
          </a>
          <span className="hidden break-all font-mono text-xs print:inline">Transaction {state.signature}</span>
        </p>
      )}
    </section>
  );
}

function Underpaid({ state, token, total, sender }: { state: Extract<LiveState, { status: "underpaid" }>; token: Token; total: string; sender: string }) {
  return (
    <section className="rounded-xl border border-warn-line bg-warn-soft px-4 py-4 sm:px-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-warn">
        <AlertIcon width={20} height={20} />
        Partly paid
      </h2>
      <p className="mt-2 leading-relaxed" role="status">
        {state.amountPaid ? (
          <>
            <strong className="tabular-nums">{formatAmount(state.amountPaid, token)}</strong> of{" "}
            <span className="tabular-nums">{formatAmount(total, token)}</span> arrived.
          </>
        ) : (
          <>Less than the invoice total arrived.</>
        )}
        {state.remaining && (
          <>
            {" "}
            <strong className="tabular-nums">{formatAmount(state.remaining, token)}</strong> is still owed.
          </>
        )}
      </p>
      <p className="mt-2 text-sm text-muted">
        Ask {sender} for a new link for the rest. Paying this invoice again would send the full amount.
      </p>
      {state.signature && (
        <p className="mt-2 text-sm">
          <a href={solscanTx(state.signature)} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline-offset-4 hover:underline">
            View transaction on Solscan
          </a>
        </p>
      )}
    </section>
  );
}

/**
 * The invoice sheet. The server renders the document and the pay panel; this component owns
 * the live status: chip, Paid stamp, and the pay panel giving way to the receipt.
 */
export function InvoiceLive({
  initial,
  id,
  total,
  token,
  dueLabel,
  overdue,
  sender,
  head,
  children,
  pay,
}: {
  initial: LiveState;
  id: string;
  total: string;
  token: Token;
  dueLabel: string;
  overdue: boolean;
  /** How to refer to the sender in the underpaid note: the quoted business name. */
  sender: string;
  head: ReactNode;
  children: ReactNode;
  pay: ReactNode;
}) {
  const state = useInvoiceState(initial, id, total, token);
  const flipped = initial.status === "open" && state.status !== "open";
  return (
    <article
      aria-label="Invoice"
      className="relative overflow-hidden rounded-2xl border border-line bg-surface px-4 py-6 shadow-sm sm:px-8 sm:py-8 print:overflow-visible print:rounded-none print:border-0 print:p-0 print:shadow-none"
    >
      {state.status === "paid" && <PaidStamp state={state} />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">{head}</div>
        <StatusChip state={state} dueLabel={dueLabel} overdue={overdue} />
      </div>
      {children}
      <div className="mt-7 print:mt-4 print:break-inside-avoid">
        {state.status === "open" && pay}
        {state.status === "paid" && <Receipt state={state} token={token} />}
        {state.status === "underpaid" && <Underpaid state={state} token={token} total={total} sender={sender} />}
        {state.status === "cancelled" && (
          <section className="rounded-xl border border-line bg-sunken px-4 py-4">
            <h2 className="text-lg font-semibold">This invoice was cancelled</h2>
            <p className="mt-1 text-muted">Don&apos;t send money for it.</p>
          </section>
        )}
      </div>
      {flipped && (
        <p className="sr-only" role="alert">
          {state.status === "paid" ? "Payment received. This invoice is paid." : "The invoice status changed."}
        </p>
      )}
    </article>
  );
}
