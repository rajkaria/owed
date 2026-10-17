// Keccak-256 (the pre-NIST padding Ethereum uses), for EIP-55 address checksums and event topics.
// No dependency: 64-bit lanes as bigint, which is plenty for addresses and short strings.
// plugin/src/evm.ts carries the same code; both pass plugin/test/fixtures/evm-vectors.json.

const MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1088-bit rate for a 256-bit output

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets r[x][y], indexed x + 5y. */
const ROTATIONS = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function permute(a: bigint[]): void {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n];
  const b: bigint[] = new Array<bigint>(25).fill(0n);
  for (const rc of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) a[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
    }
    a[0] = a[0]! ^ rc;
  }
}

export function keccak256(input: Uint8Array | string): Uint8Array {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(Math.floor(bytes.length / RATE_BYTES) * RATE_BYTES + RATE_BYTES);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]!);
      state[i] = state[i]! ^ lane;
    }
    permute(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  return Buffer.from(keccak256(input)).toString("hex");
}
