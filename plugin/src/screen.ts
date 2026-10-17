import { OFAC_SDN, type SdnAddress } from "./ofac-sdn.js";
import { clean, shortAddress } from "./text.js";

// Recipient sanctions screen (SPEC §6, T2.6). Tools that create payment requests call it before
// creating; pay_link calls it before proposing a payment.
//
// It checks the address against the U.S. Treasury's OFAC SDN list: every Solana and EVM "Digital
// Currency Address" in it, built into the plugin by web/scripts/ofac-sdn.mjs from Treasury's own file
// (src/ofac-sdn.ts records the list's publish date). The lookup is local: no network, no API key, never
// "unavailable", and the server can't weaken it. The server checks the same list on create
// (web/lib/sanctions.ts).
// (Chainalysis's free API was the first plan; its free key needs a paid plan now, and TRM's free API
// returns isSanctioned:false for all four Solana addresses on the SDN list, so neither is used.)

export type Screening =
  | { ok: true; screening: "clear" | "unavailable" | "skipped" }
  | { ok: false; message: string };

export const SCREENING_UNAVAILABLE_LINE = "Recipient screening was unavailable, so this address wasn't screened.";
export const SDN_PUBLISHED = OFAC_SDN.published;

const BY_ADDRESS = new Map<string, SdnAddress>(OFAC_SDN.addresses.map((e) => [e.address, e]));

/** The SDN entry for an address: base58 exactly, EVM case-insensitively. */
export function sdnEntry(address: string): SdnAddress | null {
  const a = address.trim();
  return BY_ADDRESS.get(/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a) ?? null;
}

/** The refusal for a listed address: names the list, the entry and its program, no link. */
export function sanctionedMessage(address: string, entry: SdnAddress): string {
  const name = clean(entry.name, 60).replace(/"/g, "'");
  const programs = entry.programs.map((p) => clean(p, 30)).filter(Boolean).join(", ");
  return `The address ${shortAddress(address)} is on the U.S. Treasury's OFAC sanctions list (SDN entry "${name}"${programs ? `, program ${programs}` : ""}; list of ${OFAC_SDN.published}). Owed doesn't create or pay requests for sanctioned addresses.`;
}

/** Screens one address against OFAC's SDN list. Local and instant; never throws. */
export async function screenRecipient(address: string, _deps?: unknown): Promise<Screening> {
  const entry = sdnEntry(address);
  return entry ? { ok: false, message: sanctionedMessage(address, entry) } : { ok: true, screening: "clear" };
}
