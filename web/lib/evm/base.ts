import { isHexAddress, parseEvmAddress } from "./address";

// Base mainnet facts for Owed's Base requests (sprint W3-B). USDC only.

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
