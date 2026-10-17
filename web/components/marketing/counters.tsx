import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { formatUtc } from "@/lib/view/format";
import { groupDigits } from "@/lib/view/money";
import type { PaidStats } from "./data";

// Live counters from /api/v1/stats: every paid request on mainnet, anyone's, counted by the API.

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <dt className="mt-2 text-muted">{label}</dt>
      <dd className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{value}</dd>
    </div>
  );
}

export function Counters({ stats }: { stats: PaidStats | null }) {
  const since = stats?.since ? formatUtc(stats.since)?.replace(/, \d\d:\d\d UTC$/, "") : null;
  return (
    <section aria-labelledby="live-title" className="border-t border-line py-16 md:py-20">
      <h2 id="live-title" className="text-3xl font-semibold tracking-tight">
        Live from Solana mainnet
      </h2>
      {stats ? (
        <>
          <dl className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Stat value={groupDigits(String(stats.count))} label={stats.count === 1 ? "request paid with Owed" : "requests paid with Owed"} />
            <Stat value={`${groupDigits(stats.usdc)} USDC`} label="received through Owed links" />
          </dl>
          <p className="mt-4 text-sm text-muted">
            Counted from confirmed transactions{since ? ` since ${since}` : ""}, refreshed every minute. Nothing here is
            seeded.
          </p>
        </>
      ) : (
        <p className="mt-6 leading-relaxed text-muted">The live count couldn&apos;t be loaded just now.</p>
      )}
      <Link
        href="/proof"
        className="mt-6 inline-flex items-center gap-2 font-semibold text-accent underline-offset-4 hover:underline"
      >
        See the team&apos;s own payments, each with its transaction
        <ArrowRightIcon width={18} height={18} />
      </Link>
    </section>
  );
}
