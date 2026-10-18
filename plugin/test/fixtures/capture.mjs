// Captures real Solana mainnet JSON-RPC exchanges into test/fixtures/chain/*.json.
//
//   cd plugin && node test/fixtures/capture.mjs            # every case
//   cd plugin && node test/fixtures/capture.mjs <name>...  # selected cases
//   OWED_CAPTURE_RPC=<url> node test/fixtures/capture.mjs  # another RPC (default publicnode)
//
// Each fixture stores the calls exactly as src/chain.ts sends them ({method, params, result}).
// test/chain.test.ts replays them and fails on any call that was not recorded, so a change to
// chain.ts request params shows up as a test failure, not as silently stale fixtures.
// Results are stored verbatim; nothing is edited by hand.
import { getRandomValues } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const RPC = process.env.OWED_CAPTURE_RPC ?? "https://solana-rpc.publicnode.com";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "chain");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Must match src/chain.ts.
const SIGNATURES_OPTS = { limit: 1000, commitment: "confirmed" }; // same as src/chain.ts (QA-04)
const TX_OPTS = { maxSupportedTransactionVersion: 1, commitment: "confirmed", encoding: "jsonParsed" };
const ACCOUNTS_OPTS = { encoding: "jsonParsed", commitment: "confirmed" };

const ata = (owner) => getAssociatedTokenAddressSync(USDC, new PublicKey(owner), true).toBase58();

const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const ACTIVE_WALLET = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT"; // busy mainnet wallet with SOL + USDC
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const freshKey = () => bs58.encode(getRandomValues(new Uint8Array(32)));

const CASES = {
  // Solana Pay SOL transfer: one SystemProgram.transfer of 3,027,000 lamports with a read-only
  // reference key that has no account and exactly one signature. Payee is an off-curve address.
  "sol-reference-payment": {
    note: "SOL transfer request payment found by scanning mainnet blocks (v1 transaction).",
    findPayment: { reference: "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV" },
  },
  // A key that an automated sender appends read-only to USDC transferChecked instructions, the
  // same shape as a Solana Pay reference. Several transactions credit several owners, so tests
  // cover oldest-first order, unrelated credits and underpayment on real data. When a scan of
  // mainnet turned up no third-party Solana Pay USDC payment, this was the closest real shape;
  // add the golden-path payment here once its signature is in docs/FACTS.md.
  "usdc-appended-key-transfers": {
    note: "USDC transferChecked transactions that append the same read-only, non-signer key.",
    findPayment: { reference: "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg" },
  },
  // A USDC transferChecked that failed on chain (meta.err set).
  "failed-usdc-transfer": {
    note: "Failed USDC transferChecked found by scanning mainnet blocks.",
    transaction: "5fHFfJCDVLBKDDSeADhFSUdxoxQXpH1DnSSUeVSjoZbzAYS58p3ViYSexFntqEX9cno8VroiPVkfNjhZvkWg5NtQ",
  },
  // A fresh 32-byte key: never used on chain, so the signature list is empty.
  "unused-reference": {
    note: "Freshly generated reference key; no transaction has referenced it.",
    findPayment: { reference: freshKey },
  },
  // Sender readiness: one getMultipleAccounts per case, keys in chain.ts order —
  // USDC [sender, sender USDC account, recipient USDC account]; SOL [sender, recipient].
  // Fresh keys stand in for "no account yet" so the cases stay true whenever they are re-captured.
  "readiness-usdc-empty-sender": {
    note: "Fresh address (no SOL, no USDC account) paying a wallet that has a USDC account.",
    accounts: (fresh) => [fresh, ata(fresh), ata(ACTIVE_WALLET)],
  },
  "readiness-usdc-new-recipient": {
    note: "Active wallet holding SOL and USDC paying a fresh address that has no USDC account.",
    accounts: (fresh) => [ACTIVE_WALLET, ata(ACTIVE_WALLET), ata(fresh)],
  },
  "readiness-usdc-existing-recipient": {
    note: "Active wallet holding SOL and USDC paying the team wallet's existing USDC account.",
    accounts: () => [ACTIVE_WALLET, ata(ACTIVE_WALLET), ata(TEAM_WALLET)],
  },
  "readiness-sol-existing-recipient": {
    note: "Payer of the SOL reference payment paying the same (existing, program-owned) payee again.",
    accounts: () => [SOL_PAYER, SOL_PAYEE],
  },
  // A SOL payment to an address with no account must fund at least the rent-exempt minimum,
  // which chain.ts asks the cluster for instead of hard-coding (mainnet rent has changed).
  "readiness-sol-new-recipient": {
    note: "Same payer paying a fresh address that does not exist on chain, plus the rent-exempt minimum.",
    accounts: (fresh) => [SOL_PAYER, fresh],
    rentExemption: true,
  },
  // F2 funding plan: a wallet holding SOL paying a USDC request it can't cover in USDC (the "swap SOL for USDC" case).
  // SOL_PAYER holds SOL; whatever USDC it holds, tests ask for more than that.
  "readiness-usdc-sol-only-sender": {
    note: "A wallet holding SOL paying the team wallet's existing USDC account (F2: USDC short, SOL above the fee reserve).",
    accounts: () => [SOL_PAYER, ata(SOL_PAYER), ata(TEAM_WALLET)],
  },
  // F2: Pyth's sponsored SOL/USD price account (PriceUpdateV2, owned by the Pyth Solana Receiver), read the way
  // src/chain.ts readSolUsdPrice reads it. It sizes a SOL→USDC swap in a funding plan.
  "pyth-sol-usd": {
    note: "Pyth SOL/USD price update account (feed ef0d8b6f…b56d), base64.",
    account: { key: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", opts: { encoding: "base64", commitment: "confirmed" } },
  },
};

let id = 0;
async function call(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return { method, params, result: body.result };
}

async function capture(name, c) {
  const calls = [];
  let query;
  if (c.findPayment) {
    const reference = typeof c.findPayment.reference === "function" ? c.findPayment.reference() : c.findPayment.reference;
    query = { reference };
    const sigs = await call("getSignaturesForAddress", [reference, SIGNATURES_OPTS]);
    calls.push(sigs);
    // chain.ts never fetches transactions the signature list already marks as failed.
    for (const s of sigs.result) {
      if (!s.err) calls.push(await call("getTransaction", [s.signature, TX_OPTS]));
    }
  } else if (c.account) {
    query = { account: c.account.key };
    calls.push(await call("getAccountInfo", [c.account.key, c.account.opts]));
  } else if (c.transaction) {
    query = { signature: c.transaction };
    calls.push(await call("getTransaction", [c.transaction, TX_OPTS]));
  } else {
    const fresh = freshKey();
    const accounts = c.accounts(fresh);
    query = accounts.includes(fresh) || accounts.includes(ata(fresh)) ? { fresh, accounts } : { accounts };
    calls.push(await call("getMultipleAccounts", [accounts, ACCOUNTS_OPTS]));
    if (c.rentExemption) calls.push(await call("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }]));
  }
  const fixture = { name, note: c.note, rpc: RPC, captured_at: new Date().toISOString(), query, calls };
  mkdirSync(OUT, { recursive: true });
  // One call per line keeps large transactions compact and diffs readable.
  const head = JSON.stringify({ ...fixture, calls: undefined }, null, 1).replace(/\n}$/, "");
  const body = calls.map((x) => JSON.stringify(x)).join(",\n");
  writeFileSync(join(OUT, `${name}.json`), `${head},\n "calls": [\n${body}\n ]\n}\n`);
  console.log(`${name}: ${calls.length} call(s)`);
}

const wanted = process.argv.slice(2);
for (const [name, c] of Object.entries(CASES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await capture(name, c);
}
