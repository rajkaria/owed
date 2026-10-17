// W3-B Base requests, plugin side: Keccak-256, EIP-55 addresses, Base USDC facts and the EIP-681
// transfer link. Same code as web/lib/evm/{keccak,address,base}.ts; both sides pass
// plugin/test/fixtures/evm-vectors.json. Pure: no I/O, nothing random or time-based.

// ---- Keccak-256 (pre-NIST padding, as Ethereum uses)

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

// ---- EIP-55 addresses

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

// ---- Base mainnet

export const CHAINS = ["solana", "base"] as const;
export type Chain = (typeof CHAINS)[number];

export function isChain(s: unknown): s is Chain {
  return s === "solana" || s === "base";
}

export const BASE_CHAIN_ID = 8453;
/** CAIP-2 id, as x402 v2 and PayBox name the network. */
export const BASE_CAIP2 = "eip155:8453";
/** Circle's native USDC on Base (EIP-55), 6 decimals. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_USDC_DECIMALS = 6;
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Base produces a block every 2 seconds (checked against mainnet headers, 2026-10-17). */
export const BASE_BLOCK_SECONDS = 2;

const TX_HASH = /^0x[0-9a-f]{64}$/;

export function isTxHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH.test(s);
}

export function basescanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

export function basescanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

/**
 * EIP-681 link for a USDC transfer on Base: wallets that scan it (MetaMask, Coinbase Wallet, …) open
 * `USDC.transfer(recipient, amount)` on chain 8453. The amount is in atomic units (6 decimals).
 */
export function eip681Transfer(recipient: string, amountAtomic: bigint): string {
  if (!isHexAddress(recipient)) throw new Error("recipient must be a 0x address");
  if (amountAtomic <= 0n) throw new Error("amount must be positive");
  return `ethereum:${BASE_USDC}@${BASE_CHAIN_ID}/transfer?address=${recipient}&uint256=${amountAtomic}`;
}

export interface Eip681Transfer {
  token: string;
  chainId: number;
  recipient: string;
  amountAtomic: bigint;
}

const EIP681 = /^ethereum:(0x[0-9a-fA-F]{40})@([1-9][0-9]{0,18})\/transfer\?address=(0x[0-9a-fA-F]{40})&uint256=([1-9][0-9]{0,77})$/;

/** Parses exactly the links eip681Transfer builds (any ERC-20, any chain); null for anything else. */
export function parseEip681Transfer(url: string): Eip681Transfer | null {
  const m = EIP681.exec(url);
  if (!m) return null;
  const token = parseEvmAddress(m[1]!);
  const recipient = parseEvmAddress(m[3]!);
  if (!token || !recipient) return null;
  return { token, chainId: Number(m[2]!), recipient, amountAtomic: BigInt(m[4]!) };
}
