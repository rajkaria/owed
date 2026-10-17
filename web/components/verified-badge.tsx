import { payeeDisplay, verifiedAgo } from "@/lib/payee";
import { AlertIcon, CheckIcon } from "./icons";

// "From <domain> · verified <time ago>" for a request whose domain published its recipient in DNS
// when it was created (SPEC §5.2 T2.8). The full domain, punycode beside Unicode for IDN, never a
// logo, plus the lookalike warnings. Display only: an agent paying with Owed re-reads DNS itself.
// Server component (it reads lib/payee.ts); render it from a page or a server component, or pass
// it as a prop into a client one, e.g. LiveRequest's `info`.

const utc = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function VerifiedBadge({ domain, verifiedAt }: { domain: string | null | undefined; verifiedAt: string | null | undefined }) {
  if (!domain || !verifiedAt) return null;
  const payee = payeeDisplay(domain);
  const ago = verifiedAgo(verifiedAt);
  if (!payee || !ago) return null;
  return (
    <section aria-label={`From ${payee.label}, verified ${ago}`} className="mt-4 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm">
      <p className="flex items-start gap-2.5 leading-snug">
        <CheckIcon className="mt-0.5 shrink-0 text-paid" width={18} height={18} />
        <span>
          <span className="font-semibold">
            From <span className="break-all">{payee.label}</span>
          </span>
          <span className="text-muted">
            {" "}· verified{" "}
            <time dateTime={verifiedAt} title={`${utc.format(Date.parse(verifiedAt))} UTC`}>
              {ago}
            </time>
          </span>
        </span>
      </p>
      <p className="mt-1.5 leading-relaxed text-muted">
        <span className="break-all">{payee.domain}</span> publishes this wallet in its DNS. That shows who controls the
        domain, not that the request is fair: check it is the domain you expect.
      </p>
      {payee.warnings.length > 0 && (
        <div role="note" className="mt-3 flex gap-3 rounded-lg border border-warn-line bg-warn-soft px-3 py-2.5">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" width={18} height={18} />
          <p className="leading-relaxed">
            {payee.warnings.map((w, i) => (
              <span key={i} className={i === payee.warnings.length - 1 ? "font-semibold" : undefined}>
                {i > 0 ? " " : ""}
                {w}
              </span>
            ))}
          </p>
        </div>
      )}
    </section>
  );
}
