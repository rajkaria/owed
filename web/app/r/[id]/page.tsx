import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CardPay } from "@/components/card-pay";
import { PayView } from "@/components/pay-view";
import { VerifiedBadge } from "@/components/verified-badge";
import { cardNotice, cardOffer } from "@/lib/moonpay/offer";
import { SnsBadge } from "@/components/sns-badge"; // W3-S
import { HandleBadge } from "@/components/handle-badge"; // F1
import { RequestTermsNotes } from "@/app/i/request-notes"; // F8 invoices
import type { PublicRequestWithPayer } from "@/lib/requests"; // F1
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

export default async function RequestPage({ params, searchParams }: PageProps<"/r/[id]">) {
  const { id } = await params;
  const request = await loadPublicRequest(id);
  if (!request) notFound();
  const model = modelFromRequest(request, await requestOrigin());
  // W2-H verified payee: "From <domain> · verified <time ago>" when the request names a domain.
  // W3-S: "To <name>.sns · verified on-chain" when the recipient was given as an SNS name (re-checked as the page renders).
  // F8: refunds, "the other price was paid" and "Installment 2 of 3 of invoice X" notes (nothing for other requests).
  const badge = (
    <>
      <VerifiedBadge domain={request.from_domain} verifiedAt={request.from_domain_verified_at} />
      <SnsBadge name={request.sns_name} recipient={request.recipient} source={request.sns_source} resolvedAt={request.sns_resolved_at} />
      <HandleBadge handle={(request as PublicRequestWithPayer).requester_handle} />
      <RequestTermsNotes id={request.id} />
    </>
  );
  // Pay by card (MoonPay): nothing unless MoonPay is configured; a note when the amount can't be bought by card.
  const offer = await cardOffer(request, "r");
  const card = offer ? <CardPay offer={offer} notice={cardNotice((await searchParams).card)} /> : undefined;
  return <PayView model={model} badge={badge} card={card} />;
}
