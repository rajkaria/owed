import Link from "next/link";
import type { ReactNode } from "react";
import { headline, type PayModel } from "@/lib/view/request-view";
import { basescanAddress, solscanAccount } from "@/lib/view/format";
import { CopyButton } from "./copy-button";
import { AgentIcon, AlertIcon, CopyIcon, ExternalIcon, LinkIcon, WalletIcon } from "./icons";
import { LiveRequest } from "./live-request";
import { QrCode } from "./qr-code";
import { Wordmark } from "./wordmark";

const secondaryButton =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium leading-tight text-fg transition-colors hover:bg-sunken active:scale-[0.99]";

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

function RequesterDetails({ model }: { model: PayModel }) {
  const hasText = model.forText !== null || model.note !== null || model.claimedName !== null;
  return (
    <div>
      {hasText && (
        <figure className="mt-5 rounded-xl border border-line bg-surface px-4 py-3.5">
          <figcaption className="text-xs font-medium uppercase tracking-wider text-muted">
            Written by the requester
          </figcaption>
          {model.claimedName && (
            <blockquote className="mt-2 text-lg leading-snug break-words">
              <span className="text-muted">Name </span>
              <q className="font-medium"><bdi>{model.claimedName}</bdi></q>
            </blockquote>
          )}
          {model.forText && (
            <blockquote className="mt-2 text-lg leading-snug break-words">
              <span className="text-muted">For </span>
              <q className="font-medium"><bdi>{model.forText}</bdi></q>
            </blockquote>
          )}
          {model.note && (
            <blockquote className="mt-2 leading-snug break-words text-muted">
              <q><bdi>{model.note}</bdi></q>
            </blockquote>
          )}
        </figure>
      )}

      {model.brandWords.length > 0 && (
        <div role="note" className="mt-4 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <p>
            <strong className="font-semibold">
              Caution: this request mentions {listFormat.format(model.brandWords.map((w) => `\u201c${w}\u201d`))}.
            </strong>{" "}
            Owed can&apos;t confirm who sent it. Only pay if you know the person asking, and check the address below.
          </p>
        </div>
      )}
    </div>
  );
}

function Actions({ model, card }: { model: PayModel; card?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <a
        href={model.solanaPayUrl}
        className="inline-flex h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-fg px-5 text-base font-semibold text-bg transition-opacity hover:opacity-90 active:scale-[0.99]"
      >
        <WalletIcon />
        Open in wallet
      </a>
      {card /* pay by card (MoonPay): <CardPay>, wired by the page when MoonPay is configured */}
      <div className="grid grid-cols-2 gap-3">
        <CopyButton
          text={model.shareLink}
          label="Copy link"
          copiedLabel="Link copied"
          icon={<LinkIcon className="shrink-0" width={18} height={18} />}
          className={secondaryButton}
        />
        <CopyButton
          text={model.agentPrompt}
          label="Pay with your AI agent"
          copiedLabel="Copied for your agent"
          icon={<AgentIcon className="shrink-0" width={18} height={18} />}
          className={secondaryButton}
        />
      </div>
      <p className="text-sm leading-relaxed text-muted">
        {model.chain === "base" ? (
          <>Opens MetaMask, Coinbase Wallet, Phantom or any Base wallet on this device, to send USDC on Base (chain 8453). </>
        ) : (
          <>Opens Phantom, Solflare, Backpack or any Solana wallet on this device. </>
        )}
        <em className="not-italic text-fg">Pay with your AI agent</em> copies a message to paste into Claude or ChatGPT with
        PayBox connected.
      </p>
      {model.x402Url && process.env.NEXT_PUBLIC_OWED_X402_PUBLIC === "1" ? <p className="text-sm leading-relaxed text-muted">AI agents can pay this at <span className="break-all font-mono text-fg">{model.x402Url}</span></p> : null}
    </div>
  );
}

async function QrPanel({ model }: { model: PayModel }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5 md:sticky md:top-8">
      <div className="mx-auto w-full max-w-[19rem] rounded-xl bg-white p-3.5">
        <QrCode value={model.solanaPayUrl} label={`QR code for this payment. Scan it with a ${model.chain === "base" ? "Base" : "Solana"} wallet.`} />
      </div>
      <p className="mt-3 text-center text-sm text-muted">Scan with any {model.chain === "base" ? "Base" : "Solana"} wallet app</p>
    </div>
  );
}

function Recipient({ model }: { model: PayModel }) {
  return (
    <section aria-labelledby="recipient-title" className="rounded-xl border border-line px-4 py-3.5">
      <h2 id="recipient-title" className="text-xs font-medium uppercase tracking-wider text-muted">
        Paying to
      </h2>
      <p className="mt-1.5 font-mono text-[0.9rem] leading-relaxed break-all">{model.recipient}</p>
      {model.chain === "base" ? null : <p data-pay-hint className="mt-2 text-xs leading-relaxed text-muted">Pay with the QR code or Open in wallet. A payment sent to this address by hand isn&apos;t counted on its own: the recipient has to match it to this request.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {model.chain === "base" ? (
          <CopyButton
            text={model.recipient}
            label="Copy address"
            copiedLabel="Address copied"
            icon={<CopyIcon className="shrink-0" width={16} height={16} />}
            className="inline-flex items-center gap-1.5 font-medium text-accent"
          />
        ) : null}
        <a
          href={model.chain === "base" ? basescanAddress(model.recipient) : solscanAccount(model.recipient)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium text-accent underline-offset-4 hover:underline"
        >
          View on {model.chain === "base" ? "Basescan" : "Solscan"}
          <ExternalIcon width={16} height={16} />
        </a>
      </div>
    </section>
  );
}

export function PayView({ model, badge, card }: { model: PayModel; badge?: ReactNode; card?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8">
      <header className="flex items-center justify-between">
        <Wordmark prefetch={false} />
        <Link
          href="/"
          prefetch={false}
          className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
        >
          PayBox plugin · {model.chain === "base" ? "Base mainnet" : "Solana mainnet"}
        </Link>
      </header>

      <main className="mt-8 flex-1 md:mt-14">
        <LiveRequest
          initial={model.initial}
          poll={model.poll}
          requested={model.amount}
          token={model.token}
          asker={model.asker}
          heading={{ ...headline(model), mono: model.askerIsAddress }}
          info={
            <>
              {badge /* W2-H verified payee: <VerifiedBadge>, wired by the page */}
              {model.restOf ? (
                <p data-rest-of className="mt-4 text-sm text-muted">
                  {/* 0012: Owed wrote this link (requests.rest_of), not the requester. */}
                  This asks for the rest of an earlier request that was only partly paid:{" "}
                  <a href={`/r/${encodeURIComponent(model.restOf)}`} className="font-medium text-accent underline-offset-4 hover:underline">
                    see the first request
                  </a>
                  .
                </p>
              ) : null}
              <RequesterDetails model={model} />
            </>
          }
          actions={<Actions model={model} card={card} />}
          qr={<QrPanel model={model} />}
          recipient={<Recipient model={model} />}
          expiresAt={model.expiresAt ?? null}
          fiat={model.fiat ?? null}
        />
      </main>

      <footer className="mt-12 border-t border-line pt-5 text-sm leading-relaxed text-muted">
        <p>
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Owed never holds
          money: you pay the recipient directly, in one {model.chain === "base" ? "transaction on Base" : "Solana transaction"}.{" "}
          <Link href="/" prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
            How Owed works
          </Link>
        </p>
      </footer>
    </div>
  );
}
