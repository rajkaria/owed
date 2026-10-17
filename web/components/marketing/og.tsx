// Open Graph cards for the landing page, /proof and pay links (rendered by next/og: inline styles and
// flexbox only). Same layout as components/og-card.tsx, plus an optional DNS-verified sender line.

export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#0e0f14";
const MUTED = "#5b5e6b";
const PAPER = "#f8f8f5";
const ACCENT = "#12a37c";
const ACCENT_DEEP = "#0f7b5f";
const PAID = "#0a7a4f";

// The Owed mark (same geometry as components/wordmark.tsx): an O with an arrow landing in it.
// Satori rasterises inline SVG, so the gradient tile works here; no filters.
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="og-mark-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={ACCENT} />
          <stop offset="1" stopColor={ACCENT_DEEP} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#og-mark-g)" />
      <circle cx="16" cy="17.8" r="9" fill="none" stroke="#ffffff" strokeWidth="2.6" />
      <path
        d="M16 4.8v19.8M12.2 20.8 16 24.6l3.8-3.8"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandOgCard({
  title,
  line,
  verified,
  cta,
  footnote = "A PayBox plugin",
}: {
  title: string;
  line: string | null;
  /** A domain that published the recipient wallet in DNS when the request was made. Shown in full. */
  verified?: string | null;
  cta: string;
  footnote?: string;
}) {
  const titleSize = title.length > 14 ? 112 : title.length > 10 ? 136 : 160;
  const lineSize = line && line.length > 48 ? 44 : 52;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: PAPER,
        color: INK,
        padding: "64px 72px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Mark size={56} />
        <div style={{ display: "flex", fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Owed</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: titleSize, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>{title}</div>
        {line && (
          <div style={{ display: "flex", marginTop: 28, fontSize: lineSize, color: MUTED, lineHeight: 1.15 }}>{line}</div>
        )}
        {verified && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 24, fontSize: 36, color: PAID, fontWeight: 600 }}>
            <svg width="36" height="36" viewBox="0 0 24 24">
              <path d="M20 6 9 17l-5-5" fill="none" stroke={PAID} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div style={{ display: "flex" }}>{`From ${verified}, verified by DNS`}</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "flex",
            background: INK,
            color: PAPER,
            fontSize: 34,
            fontWeight: 600,
            padding: "18px 30px",
            borderRadius: 18,
          }}
        >
          {cta}
        </div>
        <div style={{ display: "flex", fontSize: 28, color: MUTED }}>{footnote}</div>
      </div>
    </div>
  );
}
