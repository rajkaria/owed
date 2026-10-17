import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { REPO_URL } from "./site";

// Header and footer shared by the landing page and /proof.

export function SiteHeader({ current }: { current?: "home" | "proof" }) {
  const add = current === "home" ? "#add" : "/#add";
  return (
    <header className="flex items-center justify-between gap-2 py-5">
      <Wordmark />
      <nav aria-label="Main" className="flex items-center gap-0.5 text-sm font-medium sm:gap-1">
        <Link
          href={current === "home" ? "#how" : "/#how"}
          className="hidden rounded-lg px-3 py-2 text-muted hover:text-fg sm:inline-block"
        >
          How it works
        </Link>
        <Link
          href="/proof"
          aria-current={current === "proof" ? "page" : undefined}
          className="rounded-lg px-2.5 py-2 text-muted hover:text-fg aria-[current=page]:text-fg sm:px-3"
        >
          Proof
        </Link>
        <a href={REPO_URL} className="rounded-lg px-2.5 py-2 text-muted hover:text-fg sm:px-3">
          GitHub
        </a>
        <Link href={add} className="ml-1 whitespace-nowrap rounded-lg bg-fg px-3 py-2 text-bg hover:opacity-90 sm:px-3.5">
          Add to PayBox
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="flex flex-col gap-4 border-t border-line py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
      <Wordmark size={22} />
      <p className="leading-relaxed">
        Every request and payment on this site is real, on Solana mainnet.{" "}
        <span className="whitespace-nowrap">
          <Link href="/proof" className="font-medium text-accent underline-offset-4 hover:underline">
            Proof
          </Link>
          {" · "}
          <a href="/llms.txt" className="font-medium text-accent underline-offset-4 hover:underline">
            llms.txt
          </a>
          {" · "}
          <a href={REPO_URL} className="font-medium text-accent underline-offset-4 hover:underline">
            Source on GitHub
          </a>
        </span>
      </p>
    </footer>
  );
}
