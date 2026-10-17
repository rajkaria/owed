import { AlertIcon } from "@/components/icons";
import { VerifiedBadge } from "@/components/verified-badge";
import { verifiedAgo } from "@/lib/payee";
import { shortAddress } from "@/lib/view/format";
import { Bubble } from "./example-chat";
import type { OwedRecord } from "./data";
import { DEMO_DOMAIN, SWAPPED_WALLET, TEAM_WALLET } from "./site";
import { Container, SectionHeading, StepBadge } from "./ui";

// "Only pay people who are who they say": the verified-payee check on real data. The record is read
// from DNS when the page renders (components/marketing/data.ts); the badge is the pay page's own
// component; the refusal is pay_link's wording (plugin/src/payee.ts) for a wallet the record doesn't list.

function Card({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center gap-3">
        <StepBadge n={step} />
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="mt-4 flex min-w-0 flex-1 flex-col">{children}</div>
    </li>
  );
}

export function PayeeCheck({ record }: { record: OwedRecord | null }) {
  const listsTeam = record?.wallets.includes(TEAM_WALLET) ?? false;
  const listsSwapped = record?.wallets.includes(SWAPPED_WALLET) ?? false;
  const ago = record ? verifiedAgo(record.readAt) : null;

  return (
    <section id="verified" aria-labelledby="verified-title" className="scroll-mt-20 border-t border-line py-20 md:py-28">
      <Container>
        <SectionHeading
          id="verified-title"
          eyebrow="Verified payee"
          title="Only pay people who are who they say."
          lede={
            <>
              Anyone can type &ldquo;from Acme&rdquo; on a payment request. Owed asks Acme&apos;s DNS instead. A business lists
              its wallet in a TXT record on its own domain, and before your agent pays a request that names the domain, Owed
              reads that record itself and refuses a wallet that isn&apos;t in it.
            </>
          }
        />

        <ol className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card step={1} title="The business lists its wallet">
            {record ? (
              <>
                <div className="rounded-xl bg-sunken p-3.5 font-mono text-[0.8rem] leading-relaxed">
                  <p className="break-all">
                    <span className="text-muted">name </span>
                    {record.name}
                  </p>
                  <p>
                    <span className="text-muted">type </span>TXT
                  </p>
                  {record.wallets.length > 0 ? (
                    record.wallets.map((w) => (
                      <p key={w} className="break-all">
                        <span className="text-muted">value </span>owed-pay={w}
                      </p>
                    ))
                  ) : (
                    <p className="text-muted">no owed-pay records</p>
                  )}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  Read from {record.resolver} for this page{ago ? ` ${ago}` : ""}.{" "}
                  {record.dnssec ? "The answer was DNSSEC-signed." : "Not DNSSEC-signed, so Owed says “verified by DNS”."}
                </p>
              </>
            ) : (
              <>
                <div className="rounded-xl bg-sunken p-3.5 font-mono text-[0.8rem] leading-relaxed">
                  <p className="break-all">
                    <span className="text-muted">name </span>_owed.{DEMO_DOMAIN}
                  </p>
                  <p>
                    <span className="text-muted">type </span>TXT
                  </p>
                  <p className="break-all">
                    <span className="text-muted">value </span>owed-pay=&lt;wallet address&gt;
                  </p>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  DNS couldn&apos;t be read for this page just now, so this shows the record&apos;s format only.
                </p>
              </>
            )}
          </Card>

          <Card step={2} title="Payers see who it is from">
            {record && listsTeam ? (
              <>
                <div className="-mt-4">
                  <VerifiedBadge domain={DEMO_DOMAIN} verifiedAt={record.readAt} />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  The badge a pay page shows for a request from {DEMO_DOMAIN} to {shortAddress(TEAM_WALLET)}, checked against
                  the record in step 1.
                </p>
              </>
            ) : (
              <p className="leading-relaxed text-muted">
                A request that names a domain shows &ldquo;From &lt;domain&gt; · verified&rdquo; on its pay page, with the
                full domain and a warning for lookalike spellings.
                {record ? ` Right now ${DEMO_DOMAIN} doesn't list ${shortAddress(TEAM_WALLET)}, so no badge is shown.` : ""}
              </p>
            )}
          </Card>

          <Card step={3} title="A swapped wallet is refused">
            <div className="flex flex-col gap-3">
              <Bubble from="you">Pay this request from {DEMO_DOMAIN}</Bubble>
              <Bubble from="agent">
                <span className="mb-1 flex items-center gap-1.5 font-semibold text-warn">
                  <AlertIcon width={16} height={16} strokeWidth={2.5} />
                  Not paying
                </span>
                This request claims to be from {DEMO_DOMAIN}, but {DEMO_DOMAIN} does not publish this wallet. Not paying.
              </Bubble>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Owed&apos;s answer when a copy of the request pays {shortAddress(SWAPPED_WALLET)}
              {record && !listsSwapped ? `, a wallet the record doesn't list` : ""}. The check runs inside the plugin, so
              Owed&apos;s own server can&apos;t vouch for anyone.
            </p>
          </Card>
        </ol>

        <p className="mt-6 rounded-2xl border border-line bg-surface px-5 py-4 leading-relaxed text-muted">
          <span className="font-semibold text-fg">For your own domain:</span> add a TXT record named{" "}
          <code className="break-all font-mono text-[0.9em] text-fg">_owed.&lt;your domain&gt;</code> with the value{" "}
          <code className="break-all font-mono text-[0.9em] text-fg">owed-pay=&lt;your wallet&gt;</code>, then ask your agent
          to send the request from that domain. Verified means the domain lists the wallet. It shows who controls the
          domain, not that a request is fair.
        </p>
      </Container>
    </section>
  );
}
