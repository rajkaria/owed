import type { ReactNode } from "react";

// Small layout primitives shared by the landing page sections. Server components, no state.

/** Page-width column: 72rem, 16 px gutters on a phone. */
export function Container({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>;
}

/** Small mono label above a section title. `ink` for the dark bands. */
export function Eyebrow({ children, ink = false }: { children: ReactNode; ink?: boolean }) {
  return (
    <p className={`font-mono text-xs font-medium uppercase tracking-[0.14em] ${ink ? "text-ink-accent" : "text-accent"}`}>
      {children}
    </p>
  );
}

/** Section title block: eyebrow, h2 (the `aria-labelledby` target) and an optional one-paragraph lede. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  lede,
  ink = false,
  align = "left",
}: {
  id: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  ink?: boolean;
  align?: "left" | "center";
}) {
  const centered = align === "center";
  return (
    <div className={`max-w-3xl ${centered ? "mx-auto text-center" : ""}`}>
      {eyebrow && <Eyebrow ink={ink}>{eyebrow}</Eyebrow>}
      <h2
        id={id}
        className={`mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl ${ink ? "text-ink-fg" : "text-fg"}`}
      >
        {title}
      </h2>
      {lede && <p className={`mt-4 text-pretty text-lg leading-relaxed ${ink ? "text-ink-muted" : "text-muted"}`}>{lede}</p>}
    </div>
  );
}

/** Numbered badge for ordered steps. */
export function StepBadge({ n, ink = false }: { n: number; ink?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-9 shrink-0 place-items-center rounded-full font-mono text-sm font-semibold tabular-nums ${
        ink ? "bg-ink-accent-soft text-ink-accent" : "bg-accent-soft text-accent"
      }`}
    >
      {n}
    </span>
  );
}
