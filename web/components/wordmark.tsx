import Link from "next/link";

/** The Owed mark: an arrow landing in a tray, money coming to you. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path
        d="M16 7.5v12M10.5 14.5 16 20l5.5-5.5M9.5 24.5h13"
        fill="none"
        stroke="var(--bg)"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ href = "/", size = 28 }: { href?: string; size?: number }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg text-[1.15rem] font-semibold tracking-tight text-fg"
      aria-label="Owed home"
    >
      <Mark size={size} />
      <span>Owed</span>
    </Link>
  );
}
