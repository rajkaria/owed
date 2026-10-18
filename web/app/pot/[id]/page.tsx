import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { QrCode } from "@/components/qr-code";
import { Wordmark } from "@/components/wordmark";
import { requestOrigin } from "@/lib/site";
import { formatAmount } from "@/lib/view/money";
import { PrintButton } from "@/app/i/[id]/print-button";
import { PotBoard } from "./board";
import { potDescription, potTitle, potView, type PotView } from "./model";
import { loadPagePot } from "./source";

export async function generateMetadata({ params }: PageProps<"/pot/[id]">): Promise<Metadata> {
  const { id } = await params;
  const origin = await requestOrigin();
  const pot = await loadPagePot(id, origin);
  if (!pot) return { title: "Pot not found", robots: { index: false, follow: false } };
  const view = potView(pot, origin);
  const title = potTitle(view);
  const description = potDescription(view);
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", siteName: "Owed", url: view.link },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** One printable QR per fixed amount: each is the pot's Solana Pay transaction request, so every scan mints its own contribution. */
async function QrGrid({ view }: { view: PotView }) {
  return (
    <div className="mt-4">
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2">
        {view.amounts.map((a) => (
          <li key={a.amount} className="rounded-xl border border-line bg-surface px-4 py-4 text-center print:break-inside-avoid print:border-black">
            <p className="text-lg font-semibold tabular-nums">{formatAmount(a.amount, view.token)}</p>
            <div className="mx-auto mt-3 w-full max-w-[13rem] rounded-xl bg-white p-3">
              <QrCode value={a.qr} label={`QR code to chip in ${formatAmount(a.amount, view.token)}. Scan it with a Solana wallet.`} />
            </div>
          </li>
        ))}
      </ul>
      <PrintButton className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-sunken print:hidden" />
    </div>
  );
}

export default async function PotPage({ params }: PageProps<"/pot/[id]">) {
  const { id } = await params;
  const origin = await requestOrigin();
  const pot = await loadPagePot(id, origin);
  if (!pot) notFound();
  const view = potView(pot, origin);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8">
      <header className="flex items-center justify-between print:hidden">
        <Wordmark prefetch={false} />
        <Link href="/" prefetch={false} className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg">
          PayBox plugin · Solana mainnet
        </Link>
      </header>

      <main className="mt-8 flex-1 md:mt-14">
        <PotBoard initial={view} origin={origin} qrCodes={view.ended || view.amounts.length === 0 ? undefined : <QrGrid view={view} />} />
      </main>

      <footer className="mx-auto mt-12 w-full max-w-2xl border-t border-line pt-5 text-sm leading-relaxed text-muted print:hidden">
        <p>
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Owed never holds money: each
          contribution goes straight to the person collecting, in one Solana transaction.{" "}
          <Link href="/" prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
            How Owed works
          </Link>
        </p>
      </footer>
    </div>
  );
}
