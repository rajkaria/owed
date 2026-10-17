import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CheckIcon, ExternalIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { SiteFooter, SiteHeader } from "@/components/marketing/chrome";
import { canonical } from "@/components/marketing/site";
import { payeeDisplay } from "@/lib/payee";
import { teamWallets } from "@/lib/team";
import { formatUtc, shortAddress, solscanAccount, solscanTx } from "@/lib/view/format";
import { groupDigits } from "@/lib/view/money";
import { loadProof, PROOF_LIMIT, type ProofPayment, type ProofSummary } from "./data";

// Real mainnet payments made to or from the team's own wallets (requests.is_team, lib/team.ts).
// Read on every request, so a payment shows up as soon as it is recorded; a failed read says it
// failed, never an empty list that looks real.

const TITLE = "Proof: real payments on Solana mainnet";
const DESCRIPTION =
  "Every payment the Owed team has made or received with Owed, a PayBox plugin, on Solana mainnet, each with its transaction on Solscan.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} · Owed` },
  description: DESCRIPTION,
  alternates: { canonical: canonical("/proof") },
  openGraph: { title: TITLE, description: DESCRIPTION, url: canonical("/proof"), siteName: "Owed", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const KIND: Record<ProofPayment["kind"], string> = { single: "Request", split_share: "Split share", invoice: "Invoice" };
const RAIL: Record<ProofPayment["rail"], string> = { solana_pay: "Solana Pay", x402: "x402" };

function receiptHref(p: ProofPayment): string {
  if (p.kind === "split_share" && p.groupId) return `/g/${p.groupId}`;
  if (p.kind === "invoice") return `/i/${p.id}`;
  return `/r/${p.id}`;
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "paid" }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        tone === "paid" ? "bg-paid-soft text-paid" : "bg-sunken text-muted"
      }`}
    >
      {children}
    </span>
  );
}

function Payment({ p }: { p: ProofPayment }) {
  const payee = p.fromDomain && p.fromDomainVerifiedAt ? payeeDisplay(p.fromDomain) : null;
  const utc = formatUtc(p.paidAt) ?? p.paidAt;
  return (
    <li className="flex min-w-0 flex-col gap-3 border-t border-line py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums">
          {groupDigits(p.amount)} {p.token}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip>{KIND[p.kind]}</Chip>
          <Chip>{RAIL[p.rail]}</Chip>
          {payee && (
            <Chip tone="paid">
              <CheckIcon width={12} height={12} strokeWidth={3} className="shrink-0" />
              <span className="truncate">From {payee.label} · verified</span>
            </Chip>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-sm sm:items-end sm:text-right">
        <p className="text-muted">
          <LocalTime iso={p.paidAt} fallback={utc} />
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 sm:justify-end">
          <a
            href={solscanTx(p.signature)}
            className="inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline"
          >
            Solscan <span className="font-mono text-xs">{shortAddress(p.signature)}</span>
            <ExternalIcon width={14} height={14} />
          </a>
          <Link href={receiptHref(p)} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
            Receipt
          </Link>
        </p>
      </div>
    </li>
  );
}

function Summary({ proof }: { proof: ProofSummary }) {
  const totals = [proof.usdc !== "0" && `${groupDigits(proof.usdc)} USDC`, proof.sol !== "0" && `${groupDigits(proof.sol)} SOL`].filter(Boolean);
  return (
    <dl className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div className="flex flex-col-reverse rounded-2xl border border-line bg-surface p-5">
        <dt className="mt-1 text-muted">{proof.count === 1 ? "payment" : "payments"}</dt>
        <dd className="text-3xl font-semibold tabular-nums">{groupDigits(String(proof.count))}</dd>
      </div>
      <div className="flex flex-col-reverse rounded-2xl border border-line bg-surface p-5">
        <dt className="mt-1 text-muted">moved, payer to payee</dt>
        <dd className="text-3xl font-semibold tabular-nums">{totals.length ? totals.join(" + ") : "0 USDC"}</dd>
      </div>
      <div className="flex flex-col-reverse rounded-2xl border border-line bg-surface p-5">
        <dt className="mt-1 text-muted">Solana Pay · x402</dt>
        <dd className="text-3xl font-semibold tabular-nums">
          {proof.rails.solana_pay} · {proof.rails.x402}
        </dd>
      </div>
    </dl>
  );
}

export default async function ProofPage() {
  await connection();
  const proof = await loadProof().catch((e: unknown) => {
    console.error("proof: could not read payments", e instanceof Error ? e.message : e);
    return null;
  });
  const wallets = teamWallets();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      <SiteHeader current="proof" />
      <main className="pb-16 pt-8 md:pt-14">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Proof</h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-muted">
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. This page lists
          every payment the Owed team has made or received with it on Solana mainnet, newest first, each with its
          transaction on Solscan. Nothing here is staged.
        </p>

        {proof ? (
          <>
            <Summary proof={proof} />
            {proof.payments.length > 0 ? (
              <ol aria-label="Payments" className="mt-10 border-b border-line">
                {proof.payments.map((p) => (
                  <Payment key={p.id} p={p} />
                ))}
              </ol>
            ) : (
              <p className="mt-10 rounded-2xl border border-dashed border-line px-5 py-8 text-center leading-relaxed text-muted">
                No team payments yet. This list only shows real mainnet transactions, so it starts empty and fills in as
                payments land.
              </p>
            )}
            {proof.count > proof.payments.length && (
              <p className="mt-4 text-sm text-muted">Showing the newest {PROOF_LIMIT}.</p>
            )}
          </>
        ) : (
          <p role="alert" className="mt-10 rounded-2xl border border-warn-line bg-warn-soft px-5 py-6 leading-relaxed">
            The payments couldn&apos;t be read just now. Try again in a minute.
          </p>
        )}

        <section aria-labelledby="rule-title" className="mt-12 rounded-2xl bg-sunken px-5 py-5 leading-relaxed text-muted">
          <h2 id="rule-title" className="font-semibold text-fg">
            Which payments are listed
          </h2>
          <p className="mt-2">
            A paid request appears here when it pays one of the team&apos;s wallets or one of them paid it. Requests stay
            private otherwise: each one is reachable only by its own link. The amount is what the chain shows arrived.
          </p>
          {wallets.length > 0 && (
            <p className="mt-3">
              Team wallets:{" "}
              {wallets.map((w, i) => (
                <span key={w}>
                  {i > 0 && ", "}
                  <a href={solscanAccount(w)} className="font-mono text-sm text-accent underline-offset-4 hover:underline">
                    {shortAddress(w)}
                  </a>
                </span>
              ))}
            </p>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
