import { keccak256 } from "./keccak";

// EVM addresses (EIP-55). Owed stores and shows every Base address in its checksummed form.
// Input may be all lower-case or all upper-case hex (no checksum to check), or mixed case,
// which must be a valid checksum: a mistyped mixed-case address is refused, never "fixed".

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && HEX40.test(s);
}

export function toChecksumAddress(address: string): string {
  if (!isHexAddress(address)) throw new Error("not a 0x address");
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

/** The checksummed address, or null when it isn't a 0x address or its mixed-case checksum is wrong. */
export function parseEvmAddress(input: string): string | null {
  const s = input.trim();
  if (!isHexAddress(s)) return null;
  const body = s.slice(2);
  const checksummed = toChecksumAddress(s);
  const uniformCase = body === body.toLowerCase() || body === body.toUpperCase();
  return uniformCase || s === checksummed ? checksummed : null;
}

/** True when the string is a 0x address in its exact EIP-55 form (what Owed stores). */
export function isChecksumAddress(s: unknown): s is string {
  return isHexAddress(s) && toChecksumAddress(s) === s;
}

/** EVM addresses compare case-insensitively; the checksum is only an encoding. */
export function sameEvmAddress(a: string, b: string): boolean {
  return isHexAddress(a) && isHexAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
