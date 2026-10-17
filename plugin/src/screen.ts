// Recipient screening, called by tools that create payment requests.
// This is the placeholder signature: it screens nothing and says so ("skipped").
// W2-E replaces the body with a real sanctions lookup; callers keep this type.

export type Screening =
  | { ok: true; screening: "clear" | "unavailable" | "skipped" }
  | { ok: false; message: string };

export async function screenRecipient(_addr: string): Promise<Screening> {
  return { ok: true, screening: "skipped" };
}
