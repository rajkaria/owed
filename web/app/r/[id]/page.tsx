import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayView } from "@/components/pay-view";
import { VerifiedBadge } from "@/components/verified-badge";
import { loadPublicRequest } from "@/lib/request-source";
import { requestOrigin } from "@/lib/site";
import { modelFromRequest, pageDescription, pageTitle } from "@/lib/view/request-view";

export async function generateMetadata({ params }: PageProps<"/r/[id]">): Promise<Metadata> {
  const { id } = await params;
  const request = await loadPublicRequest(id);
  if (!request) return { title: "Request not found", robots: { index: false, follow: false } };
  const model = modelFromRequest(request, await requestOrigin());
  const title = pageTitle(model);
  const description = pageDescription(model);
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
  // W2-H verified payee: "From <domain> · verified <time ago>" when the request names a domain.
  const badge = <VerifiedBadge domain={request.from_domain} verifiedAt={request.from_domain_verified_at} />;
  return <PayView model={model} badge={badge} />;
}
