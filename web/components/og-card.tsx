// Shared layout for Open Graph images (rendered by next/og, so inline styles
// and flexbox only).

export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#141417";
const MUTED = "#55555e";
const PAPER = "#f6f6f3";
const ACCENT = "#4338ca";

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
          <rect width="32" height="32" rx="9" fill={ACCENT} />
          <path
            d="M16 7.5v12M10.5 14.5 16 20l5.5-5.5M9.5 24.5h13"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.75"
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
