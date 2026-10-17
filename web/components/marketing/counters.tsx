import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { formatUtc } from "@/lib/view/format";
import { groupDigits } from "@/lib/view/money";
import type { PaidStats } from "./data";
import { Container } from "./ui";

// Live counters from /api/v1/stats: every paid request on mainnet, anyone's, counted by the API.

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="mt-2 text-sm text-muted sm:text-base">{label}</dt>
      <dd className="text-5xl font-semibold leading-none tracking-tight tabular-nums sm:text-6xl">
        {value}
        {unit && <span className="ml-2 text-2xl font-medium text-muted sm:text-3xl">{unit}</span>}
      </dd>
    </div>
  );
}

export function Counters({ stats }: { stats: PaidStats | null }) {
  const since = stats?.since ? formatUtc(stats.since)?.replace(/, \d\d:\d\d UTC$/, "") : null;
  return (
    <section aria-labelledby="live-title" className="border-t border-line py-20 md:py-28">
      <Container>
        <div className="grid gap-10 rounded-3xl border border-line bg-surface p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-16">
          <div>
            <p className="inline-flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.14em] text-accent">
              <span className="animate-pulse-dot size-2 rounded-full bg-accent-strong" aria-hidden="true" />
              Live
            </p>
            <h2 id="live-title" className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
              Counted from Solana mainnet, not from a database of promises.
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-muted">
              A request counts as paid only when a confirmed transaction sends the full amount of the right token to the
              recipient. These numbers come from{" "}
              <code className="font-mono text-[0.9em] text-fg">/api/v1/stats</code>
              {since ? `, counting since ${since}` : ""}, refreshed every minute. Nothing here is seeded.
            </p>
            <Link href="/proof" className="mt-6 inline-flex items-center gap-2 font-semibold text-accent underline-offset-4 hover:underline">
              See the team&apos;s own payments, each with its transaction
              <ArrowRightIcon width={18} height={18} />
            </Link>
          </div>
          {stats ? (
            <dl className="grid grid-cols-1 gap-8 self-center sm:grid-cols-2 sm:gap-6">
              <Stat value={groupDigits(String(stats.count))} label={stats.count === 1 ? "request paid with Owed" : "requests paid with Owed"} />
              <Stat value={groupDigits(stats.usdc)} unit="USDC" label="received through Owed links" />
            </dl>
          ) : (
            <p className="self-center leading-relaxed text-muted">The live count couldn&apos;t be loaded just now.</p>
          )}
        </div>
      </Container>
    </section>
  );
}
