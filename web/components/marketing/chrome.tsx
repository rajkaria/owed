import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { Mark, Wordmark } from "@/components/wordmark";
import { API_URL, LLMS_URL, REPO_URL, TESTING_URL } from "./site";

// Header and footer shared by the landing page and /proof.
//
// The header is ink on every page so it reads over the ink hero and over the paper body alike. It may be
// rendered inside a centred column (as on /proof), so its background is a 100vw pseudo-element behind the
// content; body { overflow-x: clip } (globals.css) absorbs the scrollbar's width.

const NAV = [
  { label: "Product", hash: "#how" },
  { label: "What's new", hash: "#new" },
  { label: "Use cases", hash: "#use-cases" },
  { label: "Developers", hash: "#developers" },
] as const;

export function SiteHeader({ current }: { current?: "home" | "proof" }) {
  const home = current === "home";
  const at = (hash: string) => (home ? hash : `/${hash}`);
  return (
    <header className="sticky top-0 z-40 isolate text-ink-fg before:absolute before:inset-y-0 before:left-1/2 before:-z-10 before:w-screen before:-translate-x-1/2 before:border-b before:border-ink-line before:bg-ink/80 before:backdrop-blur-md before:content-['']">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <span className="[&_a]:text-ink-fg">
          <Wordmark />
        </span>
        <nav aria-label="Main" className="flex items-center gap-0.5 text-sm font-medium sm:gap-1">
          {NAV.map((item) => (
            <a
              key={item.hash}
              href={at(item.hash)}
              className="hidden rounded-lg px-3 py-2 text-ink-muted hover:text-ink-fg md:inline-block"
            >
              {item.label}
            </a>
          ))}
          <Link
            href="/proof"
            aria-current={current === "proof" ? "page" : undefined}
            className="rounded-lg px-2.5 py-2 text-ink-muted hover:text-ink-fg aria-[current=page]:text-ink-fg sm:px-3"
          >
            Proof
          </Link>
          <a href={REPO_URL} className="hidden rounded-lg px-3 py-2 text-ink-muted hover:text-ink-fg sm:inline-block">
            GitHub
          </a>
          <a
            href={at("#add")}
            className="ml-1.5 inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg bg-ink-accent px-3 font-semibold text-ink hover:brightness-105 sm:px-3.5"
          >
            Add to PayBox
            <ArrowRightIcon width={16} height={16} className="hidden sm:block" />
          </a>
        </nav>
      </div>
    </header>
  );
}

function FooterLink({ href, children, external = false }: { href: string; children: React.ReactNode; external?: boolean }) {
  const cls = "text-muted underline-offset-4 hover:text-fg hover:underline";
  const internalPage = href.startsWith("/") && !href.includes(".") && !external;
  return internalPage ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <a href={href} className={cls}>
      {children}
    </a>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div className="max-w-sm">
          <Wordmark size={24} />
          <p className="mt-4 text-sm leading-relaxed text-muted">
            A PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Every request and payment on this site is real, on Solana and Base mainnet.
          </p>
        </div>
        <div>
          <h2 className="text-sm font-semibold">Product</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li>
              <FooterLink href="/#how">How it works</FooterLink>
            </li>
            <li>
              <FooterLink href="/#new">What&apos;s new</FooterLink>
            </li>
            <li>
              <FooterLink href="/#use-cases">Use cases</FooterLink>
            </li>
            <li>
              <FooterLink href="/#add">Add to PayBox</FooterLink>
            </li>
            <li>
              <FooterLink href="/proof">Proof</FooterLink>
            </li>
          </ul>
        </div>
        <div>
          <h2 className="text-sm font-semibold">Developers</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li>
              <FooterLink href={LLMS_URL}>Docs for agents (llms.txt)</FooterLink>
            </li>
            <li>
              <FooterLink href="/#developers">API</FooterLink>
            </li>
            <li>
              <FooterLink href={`${API_URL}/stats`} external>
                Live stats endpoint
              </FooterLink>
            </li>
            <li>
              <FooterLink href={REPO_URL} external>
                GitHub
              </FooterLink>
            </li>
            <li>
              <FooterLink href={TESTING_URL} external>
                Testing
              </FooterLink>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-muted sm:px-6 lg:px-8">
          <span className="inline-flex items-center gap-2">
            <Mark size={16} />
            Owed, a PayBox plugin on Solana and Base mainnet
          </span>
          <span>USDC, SOL or your own currency · No fees · Open source</span>
        </div>
      </div>
    </footer>
  );
}
