// Small formatting helpers shared by the pay pages and the preview card.

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

export function solscanAccount(address: string): string {
  return `https://solscan.io/account/${encodeURIComponent(address)}`;
}

const UTC_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Stable server-side rendering of a timestamp: "Oct 17, 2026, 05:00 UTC". */
export function formatUtc(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${UTC_FORMAT.format(ms)} UTC`;
}
