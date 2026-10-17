// Small formatting helpers shared by the pay pages and the preview card.

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

// W3-B Base requests: Base transactions and addresses go to Basescan (a 0x hash/address is never a Solana one).
export function basescanTx(hash: string): string {
  return `https://basescan.org/tx/${encodeURIComponent(hash)}`;
}

export function basescanAddress(address: string): string {
  return `https://basescan.org/address/${encodeURIComponent(address)}`;
}

/** Explorer for a payment: Basescan for a 0x transaction hash, Solscan otherwise. */
export function explorerTx(signature: string): { href: string; name: "Basescan" | "Solscan" } {
  return signature.startsWith("0x") ? { href: basescanTx(signature), name: "Basescan" } : { href: solscanTx(signature), name: "Solscan" };
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
