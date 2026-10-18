import type { Metadata } from "next";
import Link from "next/link";
import { BellIcon, LockIcon, ShieldIcon } from "@/components/icons";
import { SiteFooter, SiteHeader } from "@/components/marketing/chrome";
import { canonical } from "@/components/marketing/site";
import { alertChannels } from "@/lib/alerts/config";
import { AlertsSetup } from "./setup";

// S1 paid alerts. The form appears only when a channel is configured on this deployment (lib/alerts/config.ts);
// otherwise the page says alerts aren't switched on, and nothing on it claims otherwise.
export const dynamic = "force-dynamic";

const TITLE = "Paid alerts";
const DESCRIPTION = "Link a Telegram chat to your Solana wallet and get one message when a request paying it is marked paid.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: canonical("/alerts") },
  openGraph: { title: `${TITLE} · Owed`, description: DESCRIPTION, url: canonical("/alerts"), siteName: "Owed", type: "website" },
};

/** Server time at render, for the page's clock correction (the signed time must be within Owed's 5 minutes). */
function renderedAt(): number {
  return Date.now();
}

function Point({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5">{icon}</span>
      <div className="min-w-0">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

export default function AlertsPage() {
  const channels = alertChannels();
  const on = channels.telegram || channels.email;
  const where = channels.telegram && channels.email ? "a Telegram chat or an email address" : channels.email ? "an email address" : "a Telegram chat";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      <SiteHeader />
      <main className="pb-16 pt-8 md:pt-14">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Paid alerts</h1>
          {on ? (
            <p className="mt-5 text-lg leading-relaxed text-muted">
              Link {where} to the Solana wallet your Owed requests pay. When one of those requests is marked paid, on any
              rail, you get one message about it. Your wallet signs once to show it&apos;s yours; nothing moves and
              nothing else is approved.
            </p>
          ) : (
            <>
              <p className="mt-5 text-lg leading-relaxed text-muted">
                Paid alerts aren&apos;t switched on yet on this site, so there is nothing to sign up for today.
              </p>
              <p className="mt-4 leading-relaxed text-muted">
                Owed still marks requests paid within seconds of the payment, even with the page closed. Your agent sees it
                with check_payments and who_owes_me, and every request&apos;s own page shows it.
              </p>
            </>
          )}
        </div>

        {on && <AlertsSetup channels={channels} serverNow={renderedAt()} />}

        <section aria-labelledby="what-title" className="mt-14">
          <h2 id="what-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {on ? "What an alert says" : "What an alert will say"}
          </h2>
          <ul className="mt-6 grid gap-6 md:grid-cols-3">
            <Point icon={<BellIcon />} title="One per request">
              The amount and token that arrived (or &ldquo;part paid&rdquo;), who paid it as a short address, how it was paid, and
              links to the request and its transaction on Solscan.
            </Point>
            <Point icon={<ShieldIcon />} title="The reason, quoted">
              A request&apos;s reason is the requester&apos;s own words: an alert quotes it, cleaned of links, and says Owed
              didn&apos;t check it. The chain decides what is paid, never a message.
            </Point>
            <Point icon={<LockIcon />} title="Easy to turn off">
              {channels.email
                ? "Send /stop to the bot in Telegram. Every alert email has a one-click unsubscribe link."
                : "Send /stop to the bot in Telegram, any time. Owed then forgets the chat."}
            </Point>
          </ul>
        </section>

        <section aria-labelledby="kept-title" className="mt-12 rounded-2xl bg-sunken px-5 py-5 leading-relaxed text-muted">
          <h2 id="kept-title" className="font-semibold text-fg">
            What Owed keeps
          </h2>
          <p className="mt-2">
            The wallet, the chat id{channels.email ? " or the address" : ""} you linked, and the message your wallet signed,
            as the record that you asked. Turning alerts off erases the chat id{channels.email ? " and the address" : ""}.
            A wallet can have up to 5 links. Alerts go only to chats{channels.email ? " and addresses" : ""} linked here.
          </p>
          <p className="mt-3">
            Requests themselves work the same with or without alerts. <Link href="/proof" className="font-medium text-accent underline-offset-4 hover:underline">See real payments on mainnet</Link>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
