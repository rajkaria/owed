import Link from "next/link";

/*
  The Owed mark: an O (a coin, an account) with an arrow landing in it from above. The arrowhead fuses
  with the lower arc, so at favicon size it reads as a check inside a coin: owed, then paid.

  Geometry lives on a 32 x 32 grid with 2 px bleed. The same numbers are in public/brand/*.svg,
  app/icon.svg and the Open Graph cards; change them together (see docs/BRAND.md).
*/
const STROKE = 2.6;
const ARROW = "M16 4.8v19.8M12.2 20.8 16 24.6l3.8-3.8";

function Strokes({ color }: { color: string }) {
  return (
    <>
      <circle cx="16" cy="17.8" r="9" fill="none" stroke={color} strokeWidth={STROKE} />
      <path d={ARROW} fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

export function Mark({
  size = 28,
  className,
  variant = "tile",
  id,
}: {
  size?: number;
  className?: string;
  /** `tile`: white mark on the settled-green gradient tile. `mono`: strokes only, in `currentColor`. */
  variant?: "tile" | "mono";
  /** Gradient id prefix. Two tile marks of the same size on one page may share it; pass your own otherwise. */
  id?: string;
}) {
  if (variant === "mono") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
        <Strokes color="currentColor" />
      </svg>
    );
  }
  const g = id ?? `owed-g-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#12a37c" />
          <stop offset="1" stopColor="#0f7b5f" />
        </linearGradient>
        <linearGradient id={`${g}-h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.18" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${g})`} />
      <rect x="0.25" y="0.25" width="31.5" height="31.5" rx="8.75" fill="none" stroke={`url(#${g}-h)`} strokeWidth="0.5" />
      <Strokes color="#fff" />
    </svg>
  );
}

export function Wordmark({ href = "/", size = 28, prefetch }: { href?: string; size?: number; prefetch?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      className="inline-flex items-center gap-2 rounded-lg text-[1.15rem] font-semibold tracking-[-0.02em] text-fg"
      aria-label="Owed home"
    >
      <Mark size={size} />
      <span>Owed</span>
    </Link>
  );
}
