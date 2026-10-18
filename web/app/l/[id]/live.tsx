"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { AlertIcon, CheckIcon, ExternalIcon, LinkIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { formatUtc, solscanTx } from "@/lib/view/format";
import type { RoundView, TransferStatus, TransferView } from "./model";

const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;
const STATUSES: readonly TransferStatus[] = ["open", "paid", "underpaid", "cancelled", "expired"];

/**
 * The settle-up requests with their live status: one POST /api/v1/status for every request that can still change,
 * every 4 s while the tab is visible, backing off on errors. When one changes, the page is re-rendered on the server
 * (router.refresh), so the balances above always come from the API, never from arithmetic in the browser.
 */
function useLiveStatuses(rounds: RoundView[]): Map<string, TransferStatus> {
  const router = useRouter();
  const [statuses, setStatuses] = useState(() => new Map(rounds.flatMap((r) => r.transfers.map((t) => [t.id, t.status] as const))));
  const current = useRef(statuses);
  const pending = [...statuses].filter(([, s]) => s === "open" || s === "underpaid").map(([id]) => id).join(",");

  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    const body = JSON.stringify({ ids: ids.slice(0, 20) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let delay = POLL_MS;
    let disposed = false;

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
          const json = (await res.json()) as { results?: Array<{ id?: unknown; status?: unknown }> };
          const next = new Map(current.current);
          let changed = false;
          for (const r of json.results ?? []) {
            if (typeof r.id !== "string" || !STATUSES.includes(r.status as TransferStatus)) continue;
            const before = next.get(r.id);
            // Never move a settled request backwards on screen.
            if (before === undefined || before === "paid" || before === r.status) continue;
            next.set(r.id, r.status as TransferStatus);
            changed = true;
          }
          if (changed && !disposed) {
            current.current = next;
            setStatuses(next);
            router.refresh();
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
  }, [pending, router]);

  return statuses;
}

const textLink = "inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline";

function Chip({ status }: { status: TransferStatus }) {
  const base = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold";
  if (status === "paid") {
    return (
      <span className={`${base} bg-paid-soft text-paid`}>
        <CheckIcon width={14} height={14} strokeWidth={3} />
        Paid
      </span>
    );
  }
  if (status === "underpaid") {
    return (
      <span className={`${base} bg-warn-soft text-warn`}>
        <AlertIcon width={14} height={14} />
        Partly paid
      </span>
    );
  }
  if (status === "cancelled") return <span className={`${base} bg-sunken text-muted`}>Cancelled</span>;
  if (status === "expired") return <span className={`${base} bg-sunken text-muted`}>Expired</span>;
  return (
    <span className={`${base} bg-sunken text-fg`}>
      <span className="relative flex size-2" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-accent" />
      </span>
      Waiting
    </span>
  );
}

function TransferRow({ t, status }: { t: TransferView; status: TransferStatus }) {
  const when = t.paidAt ? formatUtc(t.paidAt) : null;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 leading-snug break-words">
          <span className="font-medium">{t.from}</span>
          <span className="text-muted"> pays </span>
          <span className="font-medium">{t.to}</span>
        </p>
        <span className="shrink-0 font-semibold tabular-nums">{t.amount}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Chip status={status} />
        {t.addressed && status === "open" && <span className="text-muted">In their agent&apos;s inbox</span>}
        {status === "paid" && t.paidAt && when && (
          <span className="text-muted">
            <LocalTime iso={t.paidAt} fallback={when} />
          </span>
        )}
        {status === "paid" && t.signature && (
          <a href={solscanTx(t.signature)} target="_blank" rel="noopener noreferrer" className={textLink}>
            Solscan
            <ExternalIcon width={14} height={14} />
          </a>
        )}
        {(status === "open" || status === "underpaid") && (
          <>
            <a href={t.link} className={textLink}>
              Pay page
            </a>
            <CopyButton
              text={t.link}
              label="Copy link"
              copiedLabel="Copied"
              icon={<LinkIcon className="shrink-0" width={14} height={14} />}
              className={textLink}
            />
          </>
        )}
      </div>
    </li>
  );
}

export function SettleUpRounds({ rounds }: { rounds: RoundView[] }) {
  const statuses = useLiveStatuses(rounds);
  return (
    <div className="mt-4 space-y-5">
      {[...rounds].reverse().map((r) => {
        const when = formatUtc(r.recordedAt);
        return (
          <div key={r.round}>
            <p className="text-sm text-muted">
              Settle-up recorded by {r.recordedBy}
              {when && (
                <>
                  {" "}· <LocalTime iso={r.recordedAt} fallback={when} />
                </>
              )}
              {r.signatureOk ? " · signed by their wallet" : ""}
            </p>
            <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface">
              {r.transfers.map((t) => (
                <TransferRow key={t.id} t={t} status={statuses.get(t.id) ?? t.status} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
