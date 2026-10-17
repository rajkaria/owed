// Shared layout for Open Graph images (rendered by next/og, so inline styles
// and flexbox only).

export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#0e0f14";
const MUTED = "#5b5e6b";
const PAPER = "#f8f8f5";
const ACCENT = "#12a37c";
const ACCENT_DEEP = "#0f7b5f";

export function OgCard({ amount, line, cta }: { amount: string; line: string | null; cta: string }) {
  const amountSize = amount.length > 14 ? 112 : amount.length > 10 ? 136 : 160;
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
        <svg width="56" height="56" viewBox="0 0 32 32">
          <defs>
            <linearGradient id="og-card-mark-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={ACCENT} />
              <stop offset="1" stopColor={ACCENT_DEEP} />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="9" fill="url(#og-card-mark-g)" />
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
        <div style={{ display: "flex", fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Owed</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: amountSize, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>
          {amount}
        </div>
        {line && (
          <div style={{ display: "flex", marginTop: 28, fontSize: 52, color: MUTED, lineHeight: 1.15 }}>{line}</div>
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
        <div style={{ display: "flex", fontSize: 28, color: MUTED }}>A PayBox plugin</div>
      </div>
    </div>
  );
}
