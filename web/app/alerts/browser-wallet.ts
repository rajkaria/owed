// Browser wallets for /alerts, without any wallet SDK (no new dependencies): the Wallet Standard registry that
// current Solana wallets register with, and an injected window.solana provider as a fallback. Owed's copy never names
// a wallet; when several are installed, the chooser shows each wallet's own name as the wallet reports it.

export interface BrowserWallet {
  key: string;
  /** The wallet's own name (from the wallet), or a generic label for an injected provider. */
  name: string;
  /** Asks the wallet to connect; returns the addresses it shares, first one first. */
  connect(): Promise<string[]>;
  /** Signs the message's exact bytes with `address`; returns the 64-byte ed25519 signature. */
  signMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
}

interface StandardAccount {
  address: string;
  publicKey?: Uint8Array;
  chains?: readonly string[];
}

interface StandardWallet {
  name?: unknown;
  accounts?: readonly StandardAccount[];
  features?: Record<string, unknown>;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>;
}

interface SignMessageFeature {
  signMessage(...inputs: { account: StandardAccount; message: Uint8Array }[]): Promise<{ signedMessage?: Uint8Array; signature: Uint8Array }[]>;
}

interface InjectedProvider {
  publicKey?: { toBase58?: () => string; toString(): string } | null;
  connect(): Promise<{ publicKey?: { toBase58?: () => string; toString(): string } } | undefined>;
  signMessage(message: Uint8Array, display?: string): Promise<{ signature?: Uint8Array } | Uint8Array>;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyText = (k: { toBase58?: () => string; toString(): string } | null | undefined) => (k ? (k.toBase58 ? k.toBase58() : k.toString()) : "");

function fromStandard(w: StandardWallet): BrowserWallet | null {
  const connect = w.features?.["standard:connect"] as ConnectFeature | undefined;
  const sign = w.features?.["solana:signMessage"] as SignMessageFeature | undefined;
  if (typeof connect?.connect !== "function" || typeof sign?.signMessage !== "function") return null;
  const name = typeof w.name === "string" && w.name.trim() ? w.name.trim().slice(0, 40) : "Browser wallet";
  let accounts: readonly StandardAccount[] = [];
  return {
    key: `standard:${name}`,
    name,
    async connect() {
      const out = await connect.connect();
      accounts = out?.accounts?.length ? out.accounts : (w.accounts ?? []);
      return accounts.map((a) => a.address).filter((a) => typeof a === "string");
    },
    async signMessage(address, message) {
      const account = accounts.find((a) => a.address === address) ?? (w.accounts ?? []).find((a) => a.address === address);
      if (!account) throw new Error("the wallet didn't share that address");
      const [out] = await sign.signMessage({ account, message });
      if (!out?.signature || out.signature.length !== 64) throw new Error("the wallet returned no signature");
      if (out.signedMessage && !sameBytes(out.signedMessage, message)) throw new Error("the wallet signed a different text than the one shown");
      return out.signature;
    },
  };
}

function fromInjected(p: InjectedProvider): BrowserWallet {
  return {
    key: "injected",
    name: "Browser wallet",
    async connect() {
      const out = await p.connect();
      const address = keyText(out?.publicKey ?? p.publicKey);
      return address ? [address] : [];
    },
    async signMessage(_address, message) {
      const out = await p.signMessage(message, "utf8");
      const signature = out instanceof Uint8Array ? out : out?.signature;
      if (!signature || signature.length !== 64) throw new Error("the wallet returned no signature");
      return Uint8Array.from(signature);
    },
  };
}

/**
 * Finds the browser wallets that can sign a message and reports them (asynchronously, and again whenever another
 * registers). Returns a function that stops listening.
 */
export function discoverWallets(onChange: (wallets: BrowserWallet[]) => void): () => void {
  const found = new Map<string, BrowserWallet>();
  let stopped = false;
  const emit = () => {
    if (stopped) return;
    const list = [...found.values()];
    // A wallet that registers with the standard and also injects window.solana is listed once.
    onChange(list.some((w) => w.key !== "injected") ? list.filter((w) => w.key !== "injected") : list);
  };
  const add = (w: StandardWallet) => {
    const wallet = w && typeof w === "object" ? fromStandard(w) : null;
    if (!wallet || found.has(wallet.key)) return;
    found.set(wallet.key, wallet);
    queueMicrotask(emit);
  };
  const api = {
    register: (...wallets: StandardWallet[]) => {
      wallets.forEach(add);
      return () => undefined;
    },
  };
  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback !== "function") return;
    try {
      (callback as (a: typeof api) => void)(api);
    } catch {
      // a wallet's own error
    }
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    // very old browser
  }
  const injected = (window as unknown as { solana?: InjectedProvider }).solana;
  if (injected && typeof injected.connect === "function" && typeof injected.signMessage === "function") found.set("injected", fromInjected(injected));
  queueMicrotask(emit);
  return () => {
    stopped = true;
    window.removeEventListener("wallet-standard:register-wallet", onRegister);
  };
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
