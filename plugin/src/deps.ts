import { makeApi, owedHosts, resolveBaseUrl, type ApiClient } from "./api.js";
import { DEFAULT_RPC_URLS, findPayment, makeRpc, payerReadiness, type Rpc } from "./chain.js";
import { fromAtomic, toAtomic } from "./money.js";
import { screenRecipient } from "./screen.js";
import { buildTransferUrl, isSolanaAddress, newReference, parseLink } from "./solana-pay.js";
import { buildTransferTx } from "./tx.js";

/**
 * Everything a tool touches outside its own file. Production uses the real modules; tests pass doubles.
 * Nothing here runs at module load: clients are built per call, so discovery never touches the network.
 */
export interface Deps {
  env(): Record<string, string | undefined>;
  fetch: typeof fetch;
  rpc(): Rpc;
  now(): number;
  toAtomic: typeof toAtomic;
  fromAtomic: typeof fromAtomic;
  parseLink: typeof parseLink;
  buildTransferUrl: typeof buildTransferUrl;
  newReference: typeof newReference;
  isSolanaAddress: typeof isSolanaAddress;
  buildTransferTx: typeof buildTransferTx;
  findPayment: typeof findPayment;
  payerReadiness: typeof payerReadiness;
  /** Sanctions screen (W2-E): OFAC SDN list lookup, local; injectable so tests can force a hit. */
  screenRecipient: typeof screenRecipient;
}

export const defaultDeps: Deps = {
  env: () => process.env,
  fetch: (input, init) => fetch(input, init),
  rpc: () => makeRpc(DEFAULT_RPC_URLS),
  now: () => Date.now(),
  toAtomic, fromAtomic, parseLink, buildTransferUrl, newReference, isSolanaAddress, buildTransferTx, findPayment, payerReadiness,
  screenRecipient,
};

export interface CallContext {
  base: string;
  hosts: string[];
  api: ApiClient;
}

export function callContext(deps: Deps): CallContext {
  const base = resolveBaseUrl(deps.env());
  return { base, hosts: owedHosts(base), api: makeApi({ base, fetch: deps.fetch }) };
}

/** A tool refusal or failure: shown to the user as-is, returned with isError so no output schema applies. */
export function refusal(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Resolves to `onTimeout()` if `promise` hasn't settled within `ms`. Keeps every call inside PayBox's 10 s budget. */
export async function within<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout()), Math.max(0, ms)); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
