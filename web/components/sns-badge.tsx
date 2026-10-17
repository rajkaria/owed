import { cache } from "react";
import { verifiedAgo } from "@/lib/payee";
import { checkSnsForPage, sourceText, type SnsSource } from "@/lib/sns";
import { AlertIcon, CheckIcon } from "./icons";

// W3-S: "To bonfida.sns · verified on-chain" for a request whose recipient was given as an SNS name. The name is
// re-resolved on Solana as the page renders (1.5 s at most), so the badge says "verified" only while the name
// still points to the wallet this request pays. If it now points elsewhere the page warns instead; if Solana
// doesn't answer in time it says when the name was last checked, never "verified". Server component.

const utc = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** One Solana read per name and wallet per render, shared if the badge renders twice. */
const check = cache((name: string, recipient: string) => checkSnsForPage(name, recipient));

export async function SnsBadge({ name, recipient, source, resolvedAt }: {
  name: string | null | undefined;
  recipient: string;
  source: SnsSource | null | undefined;
  resolvedAt: string | null | undefined;
}) {
  if (!name || !resolvedAt || !source) return null;
  const result = await check(name, recipient);
  if (!result) return null;
  const warnings = result.warnings;

  if (result.state === "moved") {
    return (
      <section aria-label={`${result.name} no longer points to this wallet`} role="note" className="mt-4 flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm">
        <AlertIcon className="mt-0.5 shrink-0 text-warn" width={18} height={18} />
        <p className="leading-relaxed">
          <span className="font-semibold">
            Made for <span className="break-all">{result.name}</span>, which no longer points here.
          </span>{" "}
          {result.message} Don&apos;t treat this request as <span className="break-all">{result.name}</span>&apos;s.
        </p>
      </section>
    );
  }

  const verified = result.state === "verified";
  const ago = verifiedAgo(resolvedAt);
  return (
    <section
      aria-label={verified ? `To ${result.name}, verified on-chain` : `To ${result.name}, checked on-chain ${ago ?? ""}`}
      className="mt-4 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm"
    >
      <p className="flex items-start gap-2.5 leading-snug">
        <CheckIcon className={`mt-0.5 shrink-0 ${verified ? "text-paid" : "text-muted"}`} width={18} height={18} />
        <span>
          <span className="font-semibold">
            To <span className="break-all">{result.name}</span>
          </span>
          <span className="text-muted">
            {" "}·{" "}
            {verified ? (
              "verified on-chain"
            ) : (
              <>
                checked on-chain{" "}
                <time dateTime={resolvedAt} title={`${utc.format(Date.parse(resolvedAt))} UTC`}>
                  {ago ?? "when the request was made"}
                </time>
              </>
            )}
          </span>
        </span>
      </p>
      <p className="mt-1.5 leading-relaxed text-muted">
        {verified ? (
          <>
            <span className="break-all">{result.name}</span> points to this wallet ({sourceText(result.source)}), read from
            Solana as this page loaded. That shows who controls the name, not that the request is fair: check it is the
            name you expect.
          </>
        ) : (
          <>
            <span className="break-all">{name}</span> pointed to this wallet ({sourceText(source)}) when the request was
            made. Solana couldn&apos;t be read just now to check it again.
          </>
        )}
      </p>
      {warnings.length > 0 && (
        <div role="note" className="mt-3 flex gap-3 rounded-lg border border-warn-line bg-warn-soft px-3 py-2.5">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" width={18} height={18} />
          <p className="leading-relaxed">
            {warnings.map((w, i) => (
              <span key={i} className={i === warnings.length - 1 ? "font-semibold" : undefined}>
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
