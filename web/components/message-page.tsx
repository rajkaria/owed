import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "./wordmark";

/** Shared shell for not-found, error and invalid-link screens. */
export function MessagePage({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-10 pt-5 sm:px-6 md:pt-8">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 items-center py-12">
        <div className="max-w-lg">
          <p className="text-sm font-medium text-accent">{eyebrow}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <div className="mt-4 text-lg leading-relaxed text-muted">{children}</div>
          <div className="mt-8 flex flex-wrap gap-3">
            {action}
            <Link
              href="/"
              className="inline-flex h-12 items-center rounded-xl border border-line bg-surface px-5 font-medium hover:bg-sunken"
            >
              What is Owed?
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
