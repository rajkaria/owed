import type { Metadata } from "next";
import Link from "next/link";
import { MessagePage } from "@/components/message-page";
import { emailConfig } from "@/lib/alerts/config";
import { viewToken, type TokenView } from "@/lib/alerts/subscribe";
import { TokenAction } from "../token-action";

// S1 paid alerts: where an email confirmation link lands. Opening it changes nothing; the button confirms.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Confirm paid alerts", robots: { index: false, follow: false } };

const again = (
  <Link href="/alerts" className="font-medium text-accent underline-offset-4 hover:underline">
    sign up again
  </Link>
);

export default async function ConfirmAlertsPage({ searchParams }: PageProps<"/alerts/confirm">) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  if (!emailConfig()) {
    return (
      <MessagePage eyebrow="Paid alerts" title="Email alerts aren't switched on">
        This site doesn&apos;t send alert emails, so there is nothing to confirm.
      </MessagePage>
    );
  }
  let view: TokenView | null = null;
  try {
    view = await viewToken("confirm", token);
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
        Copy the whole link from the email, or {again}.
      </MessagePage>
    );
  }
  if (view.status === "active") {
    return (
      <MessagePage eyebrow="Paid alerts" title="Alerts are already on">
        Paid alerts for wallet <span className="break-all font-mono text-base text-fg">{view.wallet}</span> go to this address.
      </MessagePage>
    );
  }
  if (view.status === "unsubscribed" || view.expired) {
    return (
      <MessagePage eyebrow="Paid alerts" title={view.expired ? "This link has expired" : "These alerts were turned off"}>
        {view.expired ? "Confirmation links work for 24 hours. " : ""}To get alerts at this address, {again}.
      </MessagePage>
    );
  }
  return (
    <MessagePage eyebrow="Paid alerts" title="Turn on paid alerts?">
      <p>
        Wallet <span className="break-all font-mono text-base text-fg">{view.wallet}</span> asked Owed to email{" "}
        <span className="text-fg">{view.email}</span> each time a request paying it is marked paid. Every alert has a one-click
        unsubscribe link.
      </p>
      <div className="mt-6 text-base">
        <TokenAction endpoint="/api/v1/alerts/confirm" token={token} label="Turn on alerts" done="Alerts are on for this address." />
      </div>
    </MessagePage>
  );
}
