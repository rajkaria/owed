import type { Metadata } from "next";
import { MessagePage } from "@/components/message-page";
import { PayView } from "@/components/pay-view";
import { requestOrigin } from "@/lib/site";
import { PAY_URL_ERROR_TEXT, parseTransferRequest } from "@/lib/view/pay-url";
import { modelFromTransfer, pageTitle } from "@/lib/view/request-view";

// Stateless pay page: everything comes from the Solana Pay link in ?u=, no
// database. The plugin falls back to these links when the API is unreachable.

function readLink(u: string | string[] | undefined) {
  return parseTransferRequest(Array.isArray(u) ? u[0] : u);
}

export async function generateMetadata({ searchParams }: PageProps<"/p">): Promise<Metadata> {
  const parsed = readLink((await searchParams).u);
  const robots = { index: false, follow: false };
  if (!parsed.ok) return { title: "Payment link", robots };
  const model = modelFromTransfer(parsed.value, await requestOrigin());
  const title = pageTitle(model);
  const description = "Pay with any Solana wallet, or with your AI agent in PayBox.";
  return {
    title: { absolute: title },
    description,
    robots,
    openGraph: { title, description, type: "website", siteName: "Owed" },
    twitter: { card: "summary", title, description },
  };
}

export default async function StatelessPayPage({ searchParams }: PageProps<"/p">) {
  const parsed = readLink((await searchParams).u);
  if (!parsed.ok) {
    return (
      <MessagePage eyebrow="Payment link" title="This payment link doesn't work">
        <p>{PAY_URL_ERROR_TEXT[parsed.error]}</p>
      </MessagePage>
    );
  }
  return <PayView model={modelFromTransfer(parsed.value, await requestOrigin())} />;
}
