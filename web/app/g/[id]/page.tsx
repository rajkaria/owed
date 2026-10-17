import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/wordmark";
import { requestOrigin } from "@/lib/site";
import { GroupBoard } from "./board";
import { boardDescription, boardFromGroup, boardTitle, progress } from "./model";
import { loadBoardGroup } from "./source";

export async function generateMetadata({ params }: PageProps<"/g/[id]">): Promise<Metadata> {
  const { id } = await params;
  const origin = await requestOrigin();
  const group = await loadBoardGroup(id, origin);
  if (!group) return { title: "Split not found", robots: { index: false, follow: false } };
  const model = boardFromGroup(group, origin);
  const p = progress(model);
  const title = boardTitle(model, p);
  const description = boardDescription(model, p);
  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", siteName: "Owed", url: model.link },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function GroupPage({ params }: PageProps<"/g/[id]">) {
  const { id } = await params;
  const origin = await requestOrigin();
  const group = await loadBoardGroup(id, origin);
  if (!group) notFound();
  const model = boardFromGroup(group, origin);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8">
      <header className="flex items-center justify-between">
        <Wordmark prefetch={false} />
        <Link
          href="/"
          prefetch={false}
          className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
        >
          PayBox plugin · Solana mainnet
        </Link>
      </header>

      <main className="mt-8 flex-1 md:mt-14">
        <GroupBoard initial={model} />
      </main>

      <footer className="mx-auto mt-12 w-full max-w-2xl border-t border-line pt-5 text-sm leading-relaxed text-muted">
        <p>
          Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Owed never holds
          money: each person pays the recipient directly, in one Solana transaction.{" "}
          <Link href="/" prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
            How Owed works
          </Link>
        </p>
      </footer>
    </div>
  );
}
