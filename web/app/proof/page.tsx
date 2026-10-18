import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { CheckIcon, ExternalIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { SiteFooter, SiteHeader } from "@/components/marketing/chrome";
import { canonical } from "@/components/marketing/site";
import { payeeDisplay } from "@/lib/payee";
import { teamWallets } from "@/lib/team";
import { explorerTx, formatUtc, shortAddress, solscanAccount } from "@/lib/view/format";
import { groupDigits } from "@/lib/view/money";
import { loadProof, PROOF_LIMIT, type ProofPayment, type ProofSummary } from "./data";
import { PAID_ON, REFUSALS, type Evidence, type Observed, type Refusal } from "./refusals";

// Real mainnet payments made from the team's own wallets (requests.is_team, lib/team.ts).
// Served from the cache and re-read in the background at most every 30 s. A failed re-read keeps the
// last good page; only a build that can't reach the database renders the "couldn't be read" notice,
// never an empty list that looks real.
export const revalidate = 30;

const cachedProof = unstable_cache(() => loadProof(), ["proof", "v1"], { revalidate: 30 });

const TITLE = "Proof: real payments on Solana mainnet";
const DESCRIPTION =
  "Every payment the Owed team has made with Owed, a PayBox plugin, on Solana mainnet, each with its transaction on Solscan.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} · Owed` },
  description: DESCRIPTION,
  alternates: { canonical: canonical("/proof") },
  openGraph: { title: TITLE, description: DESCRIPTION, url: canonical("/proof"), siteName: "Owed", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const KIND: Record<ProofPayment["kind"], string> = { single: "Request", split_share: "Split share", invoice: "Invoice" };
// 0012: a matched payment is never shown with the Solana Pay chip: it carried no reference.
const RAIL: Record<ProofPayment["rail"], string> = { solana_pay: "Solana Pay", x402: "x402", base_transfer: "USDC on Base", matched: "Matched by the recipient (no reference)", moonpay_card: "Card, via MoonPay", bank_transfer: "Bank transfer, via MoonPay" }; // F3 bank rail: + bank_transfer

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
          {p.matchedRest && <Chip>Rest matched by the recipient (no reference)</Chip>}
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
            href={explorerTx(p.signature).href}
            className="inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline"
          >
            {explorerTx(p.signature).name} <span className="font-mono text-xs">{shortAddress(p.signature)}</span>
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
  const rails: Array<[string, number]> = [
    ["Solana Pay", proof.rails.solana_pay],
    ...(proof.rails.x402 > 0 ? [["x402", proof.rails.x402] as [string, number]] : []),
    ...(proof.rails.base_transfer > 0 ? [["Base", proof.rails.base_transfer] as [string, number]] : []),
    ...(proof.rails.matched > 0 ? [["matched by recipient", proof.rails.matched] as [string, number]] : []),
    ...(proof.rails.moonpay_card > 0 ? [["card via MoonPay", proof.rails.moonpay_card] as [string, number]] : []),
    ...(proof.rails.bank_transfer > 0 ? [["bank transfer via MoonPay", proof.rails.bank_transfer] as [string, number]] : []), // F3 bank rail
  ];
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
        {/* A rail is named only once a real payment used it. */}
        <dt className="mt-1 text-muted">{rails.length > 1 ? rails.map(([label]) => label).join(" · ") : "paid with Solana Pay"}</dt>
        <dd className="text-3xl font-semibold tabular-nums">
          {rails.length > 1 ? rails.map(([, n]) => n).join(" · ") : proof.rails.solana_pay}
        </dd>
      </div>
    </dl>
  );
}

const OBSERVED: Record<Observed, string> = {
  production: "Production",
  mainnet: "Mainnet",
  "unit test": "Unit test",
  "PayBox portal": "PayBox portal test console",
};

function EvidenceLink({ e }: { e: Evidence }) {
  const external = e.href.startsWith("https://");
  const className = "inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline";
  return external ? (
    <a href={e.href} className={className}>
      {e.label}
      <ExternalIcon width={14} height={14} />
    </a>
  ) : (
    <Link href={e.href} prefetch={false} className={className}>
      {e.label}
    </Link>
  );
}

// Every line comes from docs/FACTS.md (app/proof/refusals.ts cites each one). The list below only shows payments
// from the team's own wallets, so these three are named here whoever paid them.
function PaidOn() {
  return (
    <section aria-labelledby="paid-on-title" className="mt-8">
      <h2 id="paid-on-title" className="font-semibold">
        Paid on all three rails
      </h2>
      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PAID_ON.map((r) => (
          <li key={r.requestId} className="min-w-0 rounded-2xl border border-line bg-surface p-4">
            <p className="font-semibold">{r.rail}</p>
            <p className="text-sm text-muted">
              {r.via} · <span className="tabular-nums">{r.amount}</span>
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a href={r.tx.href} className="inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline">
                {r.tx.label}
                <ExternalIcon width={14} height={14} />
              </a>
              <Link href={`/r/${r.requestId}`} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
                Receipt
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RefusalRow({ r }: { r: Refusal }) {
  return (
    <li className="grid min-w-0 gap-3 border-t border-line py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)] sm:gap-6">
      <div className="min-w-0">
        <h3 className="font-semibold">{r.scenario}</h3>
        <p className="mt-1 leading-relaxed text-muted">{r.outcome}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-sm sm:items-end sm:text-right">
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          {r.observed.map((o) => (
            <Chip key={o}>{OBSERVED[o]}</Chip>
          ))}
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 sm:justify-end">
          {r.evidence.map((e) => (
            <EvidenceLink key={e.href} e={e} />
          ))}
        </p>
      </div>
    </li>
  );
}

function Refusals() {
  return (
    <section aria-labelledby="refusals-title" className="mt-14">
      <h2 id="refusals-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
        What Owed refuses
      </h2>
      <p className="mt-3 max-w-3xl leading-relaxed text-muted">
        Getting paid is half of it. These are the cases where Owed says no, each with where it was seen: on production,
        on Solana mainnet, in the PayBox portal&apos;s test console, or only in a unit test.
      </p>
      <ul aria-label="Refusals" className="mt-6 border-b border-line">
        {REFUSALS.map((r) => (
          <RefusalRow key={r.scenario} r={r} />
        ))}
      </ul>
    </section>
  );
}

async function readProof(): Promise<ProofSummary | null> {
  try {
    return await cachedProof();
  } catch (e) {
    // At runtime, throwing makes Next keep serving the previous page instead of caching an error.
    if (process.env.NEXT_PHASE !== "phase-production-build") throw e;
    console.error("proof: could not read payments at build", e instanceof Error ? e.message : e);
    return null;
  }
}

export default async function ProofPage() {
  const proof = await readProof();
  const wallets = teamWallets();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      <SiteHeader current="proof" />
      <main className="pb-16 pt-8 md:pt-14">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Proof</h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-muted">
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. This page lists
          every payment the Owed team has made with it from its own wallets on Solana mainnet, newest first, each with its
          transaction on Solscan, then what Owed refuses. Nothing here is staged.
        </p>
        <PaidOn />

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

        <Refusals />

        <section aria-labelledby="rule-title" className="mt-12 rounded-2xl bg-sunken px-5 py-5 leading-relaxed text-muted">
          <h2 id="rule-title" className="font-semibold text-fg">
            Which payments are listed
          </h2>
          <p className="mt-2">
            A paid request appears here when one of the team&apos;s wallets below paid it. Who it paid doesn&apos;t count,
            because anyone can create a request to our wallet. Requests stay private otherwise: each one is reachable only
            by its own link. The amount is what the chain shows arrived.
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
