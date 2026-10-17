"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { AlertIcon, CheckIcon, ExternalIcon, LinkIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { formatUtc, shortAddress, solscanAccount, solscanTx } from "@/lib/view/format";
import { formatAmount, type Token } from "@/lib/view/money";
import { applyStatus, paidLine, progress, receivedLine, unsettledIds, type BoardModel, type BoardShare, type ShareStatus } from "./model";

const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * One POST /api/v1/status for every share that can still change, every 4 s while the tab is
 * visible; backs off on errors and stops once every share is paid, cancelled or expired. What shows
 * comes from the API, so a hard refresh shows the same board.
 */
function useLiveBoard(initial: BoardModel): BoardModel {
  const [model, setModel] = useState(initial);
  const pending = unsettledIds(model).join(",");

  useEffect(() => {
    if (!pending) return;
    const body = JSON.stringify({ ids: pending.split(",") });
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
          const json: unknown = await res.json();
          setModel((current) => applyStatus(current, json));
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
  }, [pending]);

  return model;
}

const SEGMENT: Record<ShareStatus, string> = {
  paid: "bg-paid",
  underpaid: "bg-warn",
  open: "bg-sunken",
  cancelled: "bg-line",
  expired: "bg-line", // W3-C
};

function Chip({ status }: { status: ShareStatus }) {
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
  if (status === "expired") return <span className={`${base} bg-sunken text-muted`}>Expired</span>; // W3-C
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

// W3-C: when the shares stop taking payments, or that they already have.
function BoardExpiry({ at, ended }: { at: string; ended: boolean }) {
  const when = formatUtc(at);
  if (!when) return null;
  return (
    <p className="mt-3 text-sm text-muted">
      {ended ? "This split expired " : "Shares stop taking payments "}
      <LocalTime iso={at} fallback={when} />
      {ended ? ". Unpaid shares no longer take payments." : "."}
    </p>
  );
}

const textLink = "inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline";

function ShareRow({ share, token }: { share: BoardShare; token: Token }) {
  const settled = share.status === "paid" || share.status === "underpaid";
  const when = share.at ? formatUtc(share.at) : null;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline justify-between gap-4">
        <a href={share.payLink} className="min-w-0 text-lg font-medium leading-snug break-words hover:underline">
          {share.quoted ? <q><bdi>{share.label}</bdi></q> : <span className="text-muted">{share.label}</span>}
        </a>
        <span className="shrink-0 text-lg font-semibold tabular-nums">{formatAmount(share.amount, token)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Chip status={share.status} />
        {settled ? (
          <>
            {share.status === "underpaid" && share.paidAmount && (
              <span className="text-muted tabular-nums">{formatAmount(share.paidAmount, token)} arrived</span>
            )}
            {share.payer && (
              <span className="text-muted">
                from{" "}
                <span className="font-mono text-fg" title={share.payer}>
                  {shortAddress(share.payer)}
                </span>
              </span>
            )}
            {share.at && when && (
              <span className="text-muted">
                <LocalTime iso={share.at} fallback={when} />
              </span>
            )}
            {share.signature && (
              <a href={solscanTx(share.signature)} target="_blank" rel="noopener noreferrer" className={textLink}>
                Solscan
                <ExternalIcon width={14} height={14} />
              </a>
            )}
          </>
        ) : (
          share.status === "open" && (
            <>
              <a href={share.payLink} className={textLink}>
                Pay page
              </a>
              <CopyButton
                text={share.payLink}
                label="Copy link"
                copiedLabel="Copied"
                icon={<LinkIcon className="shrink-0" width={14} height={14} />}
                className={textLink}
              />
            </>
          )
        )}
      </div>
    </li>
  );
}

export function GroupBoard({ initial, badge }: { initial: BoardModel; badge?: ReactNode }) {
  const model = useLiveBoard(initial);
  const p = progress(model);
  const { token } = model;
  const initialStatus = new Map(initial.shares.map((s) => [s.id, s.status]));
  const justPaid = model.shares.filter((s) => s.status === "paid" && initialStatus.get(s.id) !== "paid").map((s) => s.label);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <section aria-labelledby="board-title">
        <p className="text-lg text-muted sm:text-xl">{model.requester ? `${model.requester} is collecting` : "Split bill"}</p>
        <h1 id="board-title" className="mt-1 text-5xl font-semibold tracking-tight tabular-nums break-words sm:text-6xl">
          {formatAmount(model.total, token)}
        </h1>
        {model.title && (
          <p className="mt-3 text-xl leading-snug break-words">
            <span className="text-muted">for </span>
            <q className="font-medium"><bdi>{model.title}</bdi></q>
          </p>
        )}
        <p className="mt-2 text-xs font-medium uppercase tracking-wider text-muted">
          Title and names written by the requester
        </p>
        {badge /* W2-H: <VerifiedBadge>, rendered by the server page */}
      </section>

      {model.brandWords.length > 0 && (
        <div role="note" className="mt-5 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <p>
            <strong className="font-semibold">
              Caution: this split mentions {listFormat.format(model.brandWords.map((w) => `“${w}”`))}.
            </strong>{" "}
            Owed can&apos;t confirm who sent it. Only pay if you know the person asking, and check the address below.
          </p>
        </div>
      )}

      <section aria-labelledby="progress-title" className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="progress-title" className="text-2xl font-semibold tracking-tight">
            {paidLine(p)}
          </h2>
          <p className="text-sm text-muted tabular-nums">{receivedLine(model, p)}</p>
        </div>
        <div
          role="progressbar"
          aria-label="Shares paid"
          aria-valuemin={0}
          aria-valuemax={p.count}
          aria-valuenow={p.paid}
          aria-valuetext={paidLine(p)}
          className="mt-3 flex h-3 gap-1"
        >
          {p.segments.map((seg) => (
            <span
              key={seg.id}
              className={`min-w-2 rounded-full transition-colors duration-500 ${SEGMENT[seg.status]} ${seg.status === "open" ? "ring-1 ring-inset ring-line" : ""}`}
              style={{ flexGrow: Math.max(seg.basisPoints, 1), flexBasis: 0 }}
            />
          ))}
        </div>
        {model.expiresAt && <BoardExpiry at={model.expiresAt} ended={model.shares.some((s) => s.status === "expired")} />}
        {p.done && p.paid === p.count && (
          <p className="mt-4 flex items-center gap-2 font-medium text-paid">
            <CheckIcon width={18} height={18} strokeWidth={2.5} />
            Everyone has paid.
          </p>
        )}
      </section>

      <ul className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface">
        {model.shares.map((share) => (
          <ShareRow key={share.id} share={share} token={token} />
        ))}
      </ul>

      <p className="mt-4 text-sm leading-relaxed text-muted">
        Each person pays their own link from any Solana wallet, or asks their AI agent in PayBox to pay it. This board
        updates on its own when money lands.
      </p>
      <div className="mt-4">
        <CopyButton
          text={model.link}
          label="Copy board link"
          copiedLabel="Board link copied"
          icon={<LinkIcon className="shrink-0" width={18} height={18} />}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-sunken active:scale-[0.99]"
        />
      </div>

      <section aria-labelledby="recipient-title" className="mt-8 rounded-xl border border-line px-4 py-3.5">
        <h2 id="recipient-title" className="text-xs font-medium uppercase tracking-wider text-muted">
          Every share pays
        </h2>
        <p className="mt-1.5 font-mono text-[0.9rem] leading-relaxed break-all">{model.recipient}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">Pay with the QR code or Open in wallet. A payment sent to this address by hand can&apos;t be matched to any share.</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <a href={solscanAccount(model.recipient)} target="_blank" rel="noopener noreferrer" className={textLink}>
            View on Solscan
            <ExternalIcon width={16} height={16} />
          </a>
        </div>
      </section>

      <p className="sr-only" aria-live="polite">
        {justPaid.length > 0 ? `${listFormat.format(justPaid)} paid.` : ""}
      </p>
    </div>
  );
}
