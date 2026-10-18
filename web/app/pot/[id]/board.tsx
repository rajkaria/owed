"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { AgentIcon, AlertIcon, CheckIcon, ExternalIcon, LinkIcon, WalletIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { formatUtc, shortAddress, solscanAccount, solscanTx } from "@/lib/view/format";
import { formatAmount } from "@/lib/view/money";
import { applyPot, countLine, customAmount, mintedFrom, raisedLine, type MintedView, type PotView } from "./model";

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 30000;
const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const textLink = "inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline";
const secondary =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-sunken active:scale-[0.99]";
const RAILS: Record<string, string> = { solana_pay: "Solana Pay", x402: "x402", matched: "matched by the recipient", moonpay_card: "card" };

/**
 * GET /api/v1/pots/:id every 5 s while the tab is visible and the pot is open (the server settles the newest
 * contributions from the chain first); backs off on errors. What shows comes from the API, so a refresh shows
 * the same board.
 */
function useLivePot(initial: PotView, origin: string): PotView {
  const [view, setView] = useState(initial);
  const live = !view.ended;

  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let delay = POLL_MS;
    let disposed = false;

    async function tick() {
      timer = undefined;
      if (disposed || document.visibilityState === "hidden") return;
      controller = new AbortController();
      try {
        const res = await fetch(`/api/v1/pots/${encodeURIComponent(initial.id)}`, { cache: "no-store", signal: controller.signal });
        if (res.ok) {
          const json: unknown = await res.json();
          setView((current) => applyPot(current, json, origin));
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
  }, [live, initial.id, origin]);

  return view;
}

function Deadline({ view }: { view: PotView }) {
  const when = formatUtc(view.deadline);
  if (!when) return null;
  return (
    <p className="mt-3 text-sm text-muted">
      {view.ended ? "This pot ended " : "Takes contributions until "}
      <LocalTime iso={view.deadline} fallback={when} />
      {view.ended ? ". It takes no new contributions." : "."}
    </p>
  );
}

/** Pick an amount, then mint one contribution for this visitor (only on click: a page view never writes a row). */
function OwnLink({ view, origin }: { view: PotView; origin: string }) {
  const [choice, setChoice] = useState<string | null>(view.amounts[0]?.amount ?? null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedView | null>(null);
  const typed = custom.trim() ? customAmount(custom, view.token) : null;
  const amount = view.anyAmount && custom.trim() ? typed : choice;

  async function mint() {
    if (!amount) {
      setError(`Type an amount in ${view.token}, like 10 or 2.5.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/pots/${encodeURIComponent(view.id)}/contributions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, source: "web" }),
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
        setError(typeof message === "string" ? message.slice(0, 300) : "Owed couldn't make a payment link right now. Try again in a moment.");
        return;
      }
      const next = mintedFrom(json, view, amount, origin);
      if (!next) setError("Owed returned a payment link that doesn't match this pot, so it isn't shown. Try again.");
      else setMinted(next);
    } catch {
      setError("Owed couldn't be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (minted) {
    const until = minted.expiresAt ? formatUtc(minted.expiresAt) : null;
    return (
      <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-4" aria-live="polite">
        <p className="font-medium">Your payment link for {formatAmount(minted.amount, view.token)}</p>
        <p className="mt-1 text-sm text-muted">
          It is yours alone, so your contribution is counted on its own.
          {minted.expiresAt && until && (
            <>
              {" "}It works until <LocalTime iso={minted.expiresAt} fallback={until} />.
            </>
          )}
        </p>
        <a
          href={minted.walletUrl}
          className="mt-4 inline-flex h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-fg px-5 text-base font-semibold text-bg transition-opacity hover:opacity-90 active:scale-[0.99]"
        >
          <WalletIcon width={20} height={20} />
          Open in wallet
        </a>
        <div className="mx-auto mt-4 w-full max-w-[14rem] rounded-xl bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG the server draws for this contribution */}
          <img src={minted.qrSrc} alt={`QR code for your ${formatAmount(minted.amount, view.token)} contribution. Scan it with a Solana wallet.`} className="block aspect-square w-full" />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CopyButton text={minted.transferUrl} label="Copy payment link" copiedLabel="Payment link copied" icon={<LinkIcon className="shrink-0" width={16} height={16} />} className={secondary} />
          <a href={minted.page} className={secondary}>
            More ways to pay
          </a>
        </div>
        <button type="button" onClick={() => setMinted(null)} className={`mt-3 text-sm ${textLink}`}>
          Pick another amount
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-4">
      <p className="font-medium">Or get your own payment link</p>
      {view.amounts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Amount">
          {view.amounts.map((a) => {
            const on = !custom.trim() && choice === a.amount;
            return (
              <button
                key={a.amount}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setChoice(a.amount);
                  setCustom("");
                }}
                className={`min-h-11 rounded-full border px-4 text-sm font-semibold tabular-nums transition-colors ${on ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg hover:bg-sunken"}`}
              >
                {formatAmount(a.amount, view.token)}
              </button>
            );
          })}
        </div>
      )}
      {view.anyAmount && (
        <label className="mt-3 block text-sm">
          <span className="text-muted">{view.amounts.length > 0 ? "Or another amount" : "Amount"} ({view.token})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={view.token === "SOL" ? "0.5" : "10"}
            className="mt-1 block h-12 w-full rounded-xl border border-line bg-bg px-3 text-base tabular-nums outline-none focus:border-accent"
          />
        </label>
      )}
      {custom.trim() && !typed && <p className="mt-2 text-sm text-warn">That isn&apos;t an amount in {view.token}.</p>}
      <button
        type="button"
        onClick={mint}
        disabled={busy || !amount}
        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-fg px-5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Making your link…" : amount ? `Get my link for ${formatAmount(amount, view.token)}` : "Get my payment link"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

export function PotBoard({ initial, origin, qrCodes, badge }: { initial: PotView; origin: string; qrCodes?: ReactNode; badge?: ReactNode }) {
  const view = useLivePot(initial, origin);
  const { token } = view;
  const newOnes = view.count - initial.count;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <section aria-labelledby="pot-title">
        <p className="text-lg text-muted sm:text-xl">{view.requester ? `${view.requester} is collecting` : "Chip-in pot"}</p>
        <h1 id="pot-title" className="mt-1 text-5xl font-semibold tracking-tight tabular-nums break-words sm:text-6xl">
          {formatAmount(view.raised, token)}
        </h1>
        <p className="mt-2 text-lg text-muted tabular-nums">
          {view.target ? `raised of ${formatAmount(view.target, token)}` : "raised"} · {countLine(view.count)}
        </p>
        {view.title && (
          <p className="mt-3 text-xl leading-snug break-words">
            <span className="text-muted">for </span>
            <q className="font-medium"><bdi>{view.title}</bdi></q>
          </p>
        )}
        {view.note && (
          <p className="mt-2 leading-relaxed break-words text-muted">
            <q><bdi>{view.note}</bdi></q>
          </p>
        )}
        <p className="mt-2 text-xs font-medium uppercase tracking-wider text-muted">Title and note written by the requester</p>
        {badge}
      </section>

      {view.brandWords.length > 0 && (
        <div role="note" className="mt-5 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <p>
            <strong className="font-semibold">Caution: this pot mentions {listFormat.format(view.brandWords.map((w) => `“${w}”`))}.</strong>{" "}
            Owed can&apos;t confirm who started it. Only chip in if you know the person collecting, and check the address below.
          </p>
        </div>
      )}

      <section aria-labelledby="progress-title" className="mt-8">
        <h2 id="progress-title" className="sr-only">
          Progress
        </h2>
        {view.progressBps !== null && (
          <div
            role="progressbar"
            aria-label="Raised so far"
            aria-valuemin={0}
            aria-valuemax={10000}
            aria-valuenow={view.progressBps}
            aria-valuetext={raisedLine(view)}
            className="h-3 overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line"
          >
            <span className="block h-full rounded-full bg-paid transition-[width] duration-700" style={{ width: `${view.progressBps / 100}%` }} />
          </div>
        )}
        <Deadline view={view} />
        {view.progressBps === 10000 && (
          <p className="mt-3 flex items-center gap-2 font-medium text-paid">
            <CheckIcon width={18} height={18} strokeWidth={2.5} />
            The target is reached.
          </p>
        )}
        {!view.chainChecked && <p className="mt-3 text-sm text-muted">Solana couldn&apos;t be read just now; the total shows what was last confirmed and updates on its own.</p>}
      </section>

      {!view.ended && (
        <section aria-labelledby="chip-in-title" className="mt-8">
          <h2 id="chip-in-title" className="text-2xl font-semibold tracking-tight">
            Chip in
          </h2>
          {qrCodes && view.amounts.length > 0 && (
            <>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Scan with a Solana wallet app. Each scan makes a fresh payment for whoever scans, so every contribution is counted on its own.
              </p>
              {qrCodes}
            </>
          )}
          <OwnLink view={view} origin={origin} />
          {view.x402.length > 0 && (
            <div className="mt-4 rounded-xl border border-line px-4 py-3.5 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AgentIcon className="shrink-0" width={18} height={18} />
                For AI agents: pay a preset over x402
              </p>
              <ul className="mt-2 space-y-1.5">
                {view.x402.map((x) => (
                  <li key={x.amount} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-semibold tabular-nums">{formatAmount(x.amount, token)}</span>
                    <span className="font-mono text-xs break-all text-muted">{x.url}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Or ask your agent in PayBox to pay this pot&apos;s link with Owed.</p>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="contributions-title" className="mt-8">
        <h2 id="contributions-title" className="text-2xl font-semibold tracking-tight">
          Contributions
        </h2>
        {view.contributions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No contributions have landed yet. This board updates on its own when money arrives.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
            {view.contributions.map((c) => {
              const when = formatUtc(c.at);
              return (
                <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                  <span className="text-lg font-semibold tabular-nums">{formatAmount(c.amount, token)}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                    <span>
                      from{" "}
                      <span className="font-mono text-fg" title={c.payer}>
                        {shortAddress(c.payer)}
                      </span>
                    </span>
                    {when && <LocalTime iso={c.at} fallback={when} />}
                    {c.rail !== "solana_pay" && <span>{RAILS[c.rail] ?? c.rail}</span>}
                    <a href={solscanTx(c.signature)} target="_blank" rel="noopener noreferrer" className={textLink}>
                      Solscan
                      <ExternalIcon width={14} height={14} />
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {view.count > view.contributions.length && <p className="mt-2 text-sm text-muted">Showing the newest {view.contributions.length} of {view.count}.</p>}
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        <CopyButton text={view.link} label="Copy pot link" copiedLabel="Pot link copied" icon={<LinkIcon className="shrink-0" width={18} height={18} />} className={secondary} />
      </div>

      <section aria-labelledby="recipient-title" className="mt-8 rounded-xl border border-line px-4 py-3.5">
        <h2 id="recipient-title" className="text-xs font-medium uppercase tracking-wider text-muted">
          Every contribution pays
        </h2>
        <p className="mt-1.5 font-mono text-[0.9rem] leading-relaxed break-all">{view.recipient}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Owed never holds the money: each contribution goes straight to this wallet in one Solana transaction. Pay with a QR code or your
          own link above; a payment sent to this address by hand can&apos;t be counted on this board.
        </p>
        <div className="mt-3 text-sm">
          <a href={solscanAccount(view.recipient)} target="_blank" rel="noopener noreferrer" className={textLink}>
            View on Solscan
            <ExternalIcon width={16} height={16} />
          </a>
        </div>
      </section>

      <p className="sr-only" aria-live="polite">
        {newOnes > 0 ? `${newOnes} new ${newOnes === 1 ? "contribution" : "contributions"} landed.` : ""}
      </p>
    </div>
  );
}
