import bs58 from "bs58";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ID_LENGTH = 10;
const ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{10}$/;

/** 10-char base58 request id (~58 bits), uniform over the alphabet. */
export function newRequestId(): string {
  let id = "";
  while (id.length < ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      // 232 = 4 * 58: rejecting higher bytes keeps every character equally likely.
      if (b < 232 && id.length < ID_LENGTH) id += BASE58[b % 58];
    }
  }
  return id;
}

export function isRequestId(s: unknown): s is string {
  return typeof s === "string" && ID_PATTERN.test(s);
}

/** Solana Pay reference: 32 random bytes, base58. Any 32 bytes are a valid account key. */
export function newReference(): string {
  return bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
}
