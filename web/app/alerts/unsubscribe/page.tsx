import type { Metadata } from "next";
import { MessagePage } from "@/components/message-page";
import { viewToken, type TokenView } from "@/lib/alerts/subscribe";
import { TokenAction } from "../token-action";

// S1 paid alerts: where an alert email's unsubscribe link lands. Opening it changes nothing (mail scanners open every
// link); the button unsubscribes. Mail apps' one-click unsubscribe POSTs to /api/v1/alerts/unsubscribe directly.
// Works whether or not a channel is still configured.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Turn off paid alerts", robots: { index: false, follow: false } };

export default async function UnsubscribeAlertsPage({ searchParams }: PageProps<"/alerts/unsubscribe">) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  let view: TokenView | null = null;
  try {
    view = await viewToken("unsubscribe", token);
  } catch {
    return (
      <MessagePage eyebrow="Paid alerts" title="Couldn't check this link">
        Owed couldn&apos;t read its records just now. Open the link again in a minute.
      </MessagePage>
    );
  }
  if (!view) {
    return (
      <MessagePage eyebrow="Paid alerts" title="This link isn't valid">
        Copy the whole unsubscribe link from the alert email and open it again.
      </MessagePage>
    );
  }
  if (view.status === "unsubscribed") {
    return (
      <MessagePage eyebrow="Paid alerts" title="Alerts are off">
        Owed sends no more paid alerts here for wallet <span className="break-all font-mono text-base text-fg">{view.wallet}</span>,
        and it no longer keeps this address.
      </MessagePage>
    );
  }
  return (
    <MessagePage eyebrow="Paid alerts" title="Turn off paid alerts?">
      <p>
        {view.email ? <span className="text-fg">{view.email}</span> : "This address"} gets an email each time a request paying wallet{" "}
        <span className="break-all font-mono text-base text-fg">{view.wallet}</span> is marked paid.
      </p>
      <div className="mt-6 text-base">
        <TokenAction endpoint="/api/v1/alerts/unsubscribe" token={token} label="Turn off alerts" done="Alerts are off. Owed no longer keeps this address." />
      </div>
    </MessagePage>
  );
}
