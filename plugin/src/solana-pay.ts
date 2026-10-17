// Owned by sprint W1-A (plugin-core). Signatures are fixed; bodies are filled by the sprint.
export interface TransferRequest {
  recipient: string;
  amount?: string;        // decimal, token units (per Solana Pay spec), not atomic
  splToken?: string;      // mint; absent = SOL
  references: string[];   // base58 32-byte keys
  label?: string;
  message?: string;
  memo?: string;
}

export type ParsedLink =
  | { kind: "transfer"; request: TransferRequest }
  | { kind: "transaction"; link: string }
  | { kind: "owed"; id: string };

/** Message is shown to the user verbatim. */
export class LinkError extends Error {}

export function parseLink(input: string, owedHosts: string[]): ParsedLink {
  void input; void owedHosts;
  throw new Error("not implemented: parseLink");
}

export function buildTransferUrl(r: TransferRequest): string {
  void r;
  throw new Error("not implemented: buildTransferUrl");
}

/** 32 random bytes, base58. */
export function newReference(): string {
  throw new Error("not implemented: newReference");
}

export function isSolanaAddress(s: string): boolean {
  void s;
  throw new Error("not implemented: isSolanaAddress");
}
