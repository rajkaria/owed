import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayView } from "@/components/pay-view";
import { loadPublicRequest } from "@/lib/request-source";
import { requestOrigin } from "@/lib/site";
import { modelFromRequest, pageTitle } from "@/lib/view/request-view";

export async function generateMetadata({ params }: PageProps<"/r/[id]">): Promise<Metadata> {
  const { id } = await params;
  const request = await loadPublicRequest(id);
  if (!request) return { title: "Request not found", robots: { index: false, follow: false } };
  const model = modelFromRequest(request, await requestOrigin());
  const title = pageTitle(model);
  const description = "Pay with any Solana wallet, or with your AI agent in PayBox.";
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", siteName: "Owed", url: model.shareLink },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function RequestPage({ params }: PageProps<"/r/[id]">) {
  const { id } = await params;
  const request = await loadPublicRequest(id);
  if (!request) notFound();
  const model = modelFromRequest(request, await requestOrigin());
  return <PayView model={model} />;
}
