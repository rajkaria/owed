"use client";

import { useEffect, useState, type ReactNode } from "react";
import { formatAmount, type Token } from "@/lib/view/money";
import { explorerTx, formatUtc, shortAddress } from "@/lib/view/format";
import {
  MATCHED_LABEL,
  pickStatusResult,
  stateFromStatus,
  type FiatView,
  type Headline,
  type LiveState,
  type PollTarget,
} from "@/lib/view/request-view";
import { AlertIcon, CheckIcon, ExternalIcon } from "./icons";
import { LocalTime } from "./local-time";

const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;

/**
 * Polls the status API every 4 s while the request is open and the tab is
 * visible. Stops for good once the request is paid, underpaid, cancelled or
 * expired (W3-C: the server says "expired" once expires_at passes, so an open
 * page flips to Expired within one poll and stops asking).
 * What shows on screen always comes from the API, so a hard refresh after a
 * flip shows the same thing.
 */
function useLiveState(initial: LiveState, poll: PollTarget | null, requested: string | null, token: Token) {
  const [state, setState] = useState<LiveState>(initial);
  const active = poll !== null && state.status === "open";
  const endpoint = poll?.endpoint;
  const subject = poll ? (poll.endpoint === "/api/v1/status" ? poll.id : poll.solanaPayUrl) : null;

  useEffect(() => {
    if (!active || !endpoint || subject === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let delay = POLL_MS;
    let disposed = false;

    const body = JSON.stringify(endpoint === "/api/v1/status" ? { ids: [subject] } : { solana_pay_url: subject });

    async function tick() {
      timer = undefined;
      if (disposed || document.visibilityState === "hidden") return;
      controller = new AbortController();
      try {
        const res = await fetch(endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.ok) {
          const json: unknown = await res.json();
          const result = endpoint === "/api/v1/status" ? pickStatusResult(json, subject!) : json;
          const next = stateFromStatus(result, requested, token);
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
  }, [active, endpoint, subject, requested, token]);

  return state;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

// W3-B: a Base payment (0x hash) links to Basescan, a Solana one to Solscan.
function SolscanLink({ signature }: { signature: string }) {
  const explorer = explorerTx(signature);
  return (
    <a
      href={explorer.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline"
    >
      View transaction on {explorer.name}
      <ExternalIcon width={16} height={16} />
    </a>
  );
}

const RAIL_NAMES = { x402: "x402", base_transfer: "USDC transfer on Base", solana_pay: "Solana Pay", matched: MATCHED_LABEL, moonpay_card: "Card, via MoonPay" } as const;

/**
 * 0012: a payment that arrived without this request's reference and that the recipient matched by hand, with a
 * signed message. Shown apart from referenced payments: Owed counts it because the recipient said so, and the
 * chain shows it credited them exactly what was owed.
 */
function MatchedNote({ state, token }: { state: Extract<LiveState, { status: "paid" }>; token: Token }) {
  const m = state.matched;
  if (!m) return null;
  const confirmed = m.confirmedAt ? formatUtc(m.confirmedAt) : null;
  return (
    <div role="note" data-matched className="mt-4 rounded-xl border border-line bg-sunken px-4 py-3 text-sm leading-relaxed">
      <p className="font-medium">{MATCHED_LABEL}</p>
      <p className="mt-1 text-muted">
        {m.covers === "rest" && m.amount ? (
          <>The rest, <span className="whitespace-nowrap tabular-nums text-fg">{formatAmount(m.amount, token)}</span>, arrived in a separate payment without this request&apos;s reference. </>
        ) : (
          <>This payment arrived without this request&apos;s reference. </>
        )}
        The wallet it pays signed that it belongs to this request{m.confirmedAt && confirmed ? <> (<LocalTime iso={m.confirmedAt} fallback={confirmed} />)</> : null}, and Owed checked on chain that it credited exactly the amount owed.
      </p>
      {m.covers === "rest" && m.signature ? (
        <p className="mt-2">
          <SolscanLink signature={m.signature} />
        </p>
      ) : null}
    </div>
  );
}

function PaidCard({ state, token }: { state: Extract<LiveState, { status: "paid" }>; token: Token }) {
  const when = state.at ? formatUtc(state.at) : null;
  const matched = state.rail === "matched";
  return (
    <section aria-labelledby="receipt-title" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-paid-soft text-paid">
          <CheckIcon width={24} height={24} strokeWidth={2.5} />
        </span>
        <div>
          <h2 id="receipt-title" className="text-xl font-semibold tracking-tight text-paid">
            Paid
          </h2>
          <p className="text-sm text-muted">
            {matched ? "Matched by the recipient · confirmed on Solana" : state.rail === "moonpay_card" ? "Paid by card via MoonPay, confirmed on Solana" : <>Confirmed on {state.signature?.startsWith("0x") ? "Base" : "Solana"}</>}
          </p>
        </div>
      </div>
      {state.amount && (
        <p className="mt-5 text-4xl font-semibold tracking-tight tabular-nums">{formatAmount(state.amount, token)}</p>
      )}
      <dl className="mt-4 divide-y divide-line border-y border-line">
        {state.payer && (
          <Row label={state.rail === "moonpay_card" ? "Sent by MoonPay from" : "From"}>
            <span className="font-mono" title={state.payer}>
              {shortAddress(state.payer)}
            </span>
          </Row>
        )}
        {state.at && when && (
          <Row label="When">
            <LocalTime iso={state.at} fallback={when} />
          </Row>
        )}
        {state.rail && <Row label="Paid with">{RAIL_NAMES[state.rail]}</Row>}
      </dl>
      <MatchedNote state={state} token={token} />
      {state.signature && (
        <p className="mt-4">
          <SolscanLink signature={state.signature} />
        </p>
      )}
    </section>
  );
}

function UnderpaidCard({
  state,
  token,
  requested,
  asker,
}: {
  state: Extract<LiveState, { status: "underpaid" }>;
  token: Token;
  requested: string | null;
  asker: string;
}) {
  return (
    <section
      aria-labelledby="underpaid-title"
      className="rounded-2xl border border-warn-line bg-warn-soft p-5 text-fg sm:p-6"
    >
      <div className="flex items-center gap-3 text-warn">
        <AlertIcon width={24} height={24} />
        <h2 id="underpaid-title" className="text-xl font-semibold tracking-tight">
          Partly paid
        </h2>
      </div>
      <p className="mt-4 text-lg">
        {state.amountPaid && requested ? (
          <>
            <strong className="whitespace-nowrap tabular-nums">{formatAmount(state.amountPaid, token)}</strong> of{" "}
            <span className="whitespace-nowrap tabular-nums">{formatAmount(requested, token)}</span> arrived.
          </>
        ) : (
          <>Less than the requested amount arrived.</>
        )}
        {state.remaining && (
          <>
            {" "}
            <strong className="whitespace-nowrap tabular-nums">{formatAmount(state.remaining, token)}</strong> is still owed.
          </>
        )}
      </p>
      {state.restRequestId ? (
        <p className="mt-3 text-sm text-muted">
          {/* 0012: ask_for_rest made a follow-up request for exactly the remainder. */}
          <bdi>{asker}</bdi> asked for the rest in a new request:{" "}
          <a href={`/r/${encodeURIComponent(state.restRequestId)}`} className="font-medium text-accent underline-offset-4 hover:underline">
            pay the rest here
          </a>
          . Paying this link again would send the full amount.
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted">
          Ask <bdi>{asker}</bdi> for a new link for the rest. Paying this link again would send the full amount.
        </p>
      )}
      {state.signature && (
        <p className="mt-4">
          <SolscanLink signature={state.signature} />
        </p>
      )}
    </section>
  );
}

// W3-C: cancelled by the recipient's own wallet (a signed message), or past its expiry. No pay buttons, no QR.
function CancelledCard({ at }: { at?: string | null }) {
  const when = at ? formatUtc(at) : null;
  return (
    <section aria-labelledby="ended-title" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h2 id="ended-title" className="text-xl font-semibold tracking-tight">
        This request was cancelled
      </h2>
      <p className="mt-2 text-muted">
        {at && when ? (
          <>
            Cancelled <LocalTime iso={at} fallback={when} /> by the wallet it pays, with a signed message.{" "}
          </>
        ) : null}
        Don&apos;t send money to this link.
      </p>
    </section>
  );
}

function ExpiredCard({ at, asker }: { at?: string | null; asker: string }) {
  const when = at ? formatUtc(at) : null;
  return (
    <section aria-labelledby="ended-title" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h2 id="ended-title" className="text-xl font-semibold tracking-tight">
        This request has expired
      </h2>
      <p className="mt-2 text-muted">
        {at && when ? (
          <>
            It stopped taking payments <LocalTime iso={at} fallback={when} />.{" "}
          </>
        ) : null}
        Don&apos;t send money to this link. If you still owe {asker}, ask for a new one.
      </p>
    </section>
  );
}

function ExpiresNote({ at }: { at: string }) {
  const when = formatUtc(at);
  if (!when) return null;
  return (
    <p className="mt-2 text-sm text-muted">
      Expires <LocalTime iso={at} fallback={when} />. After that this link stops taking payments.
    </p>
  );
}

function Waiting({ tracking }: { tracking: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-sunken px-4 py-3">
      <span className="relative mt-1.5 flex size-2.5 shrink-0" aria-hidden="true">
        {tracking && <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />}
        <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
      </span>
      <p className="text-sm">
        <span className="font-medium">{tracking ? "Waiting for payment." : "No live status for this link."}</span>{" "}
        <span className="text-muted">
          {tracking
            ? "This page updates on its own when the money lands."
            : "It has no tracking reference, so this page can't confirm the payment. Check your wallet history instead."}
        </span>
      </p>
    </div>
  );
}

const OPEN_AREAS =
  "[grid-template-areas:'info'_'status'_'actions'_'side'_'recipient'] md:[grid-template-areas:'info_side'_'status_side'_'actions_side'_'recipient_side'] md:grid-rows-[auto_auto_auto_1fr]";
const DONE_AREAS =
  "[grid-template-areas:'info'_'side'_'recipient'] md:[grid-template-areas:'info_side'_'recipient_side'] md:grid-rows-[auto_1fr]";

/** Local-currency ask: when and at what rate the USDC was locked, and that the local amount is only a quote. */
function FiatNote({ fiat }: { fiat: FiatView }) {
  return (
    <p data-fiat-quote className="mt-3 text-sm leading-relaxed text-muted">
      Rate locked <span className="whitespace-nowrap text-fg">{fiat.lockedAt}</span>
      {" · "}
      <span className="whitespace-nowrap">{fiat.rate}</span>
      {fiat.source ? <> ({fiat.source})</> : null}. The USDC amount is what you pay and never changes; the{" "}
      {fiat.currencyName} amount is a quote, not a guarantee.
    </p>
  );
}

export function LiveRequest({
  initial,
  poll,
  requested,
  token,
  asker,
  heading,
  info,
  actions,
  qr,
  recipient,
  expiresAt = null,
  fiat = null,
}: {
  /** W3-C: when an open request stops taking payments. */
  expiresAt?: string | null;
  /** Local-currency ask: the quote shown as the headline, with the USDC actually paid under it. */
  fiat?: FiatView | null;
  initial: LiveState;
  poll: PollTarget | null;
  requested: string | null;
  token: Token;
  asker: string;
  heading: Headline & { mono: boolean };
  info: ReactNode;
  actions: ReactNode;
  qr: ReactNode;
  recipient: ReactNode;
}) {
  const state = useLiveState(initial, poll, requested, token);
  const open = state.status === "open";
  const flipped = initial.status === "open" && !open;

  return (
    <div
      className={`grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:gap-x-12 md:gap-y-6 lg:gap-x-16 ${open ? OPEN_AREAS : DONE_AREAS}`}
    >
      <div className="[grid-area:info]">
        <h1>
          <span className={`block text-lg text-muted sm:text-xl ${heading.mono ? "font-mono text-base sm:text-lg" : ""}`}>
            {open ? heading.lead : heading.past}
          </span>
          <span className="mt-1 block text-5xl font-semibold tracking-tight tabular-nums break-words sm:text-6xl">
            {fiat ? fiat.amount : heading.amount}
          </span>
          {fiat && (
            <span className="mt-2 block text-2xl font-semibold tracking-tight tabular-nums break-words sm:text-3xl">
              <span className="sr-only">, </span>
              <span className="text-muted">= </span>
              {fiat.usdc}
            </span>
          )}
        </h1>
        {fiat && <FiatNote fiat={fiat} />}
        {info}
      </div>
      {open ? (
        <>
          <div className="[grid-area:status]">
            <Waiting tracking={poll !== null} />
            {expiresAt && <ExpiresNote at={expiresAt} />}
          </div>
          <div className="[grid-area:actions]">{actions}</div>
          <div className="[grid-area:side]">{qr}</div>
        </>
      ) : (
        <div className="[grid-area:side]">
          {state.status === "paid" && <PaidCard state={state} token={token} />}
          {state.status === "underpaid" && (
            <UnderpaidCard state={state} token={token} requested={requested} asker={asker} />
          )}
          {state.status === "cancelled" && <CancelledCard at={state.at} />}
          {state.status === "expired" && <ExpiredCard at={state.at} asker={asker} />}
        </div>
      )}
      {/* W3-C: once paid, underpaid, cancelled or expired there is no QR or Open in wallet, so drop the "Pay with…" hint. */}
      <div className={open ? "[grid-area:recipient]" : "[grid-area:recipient] [&_[data-pay-hint]]:hidden"}>{recipient}</div>
      <p className="sr-only" aria-live="assertive">
        {flipped && state.status === "paid" ? "Payment received." : ""}
        {flipped && state.status === "underpaid" ? "A partial payment arrived." : ""}
      </p>
    </div>
  );
}
