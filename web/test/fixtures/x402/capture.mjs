// Re-capture the x402 test fixtures from mainnet (read-only):
//   cd web && node test/fixtures/x402/capture.mjs
// supported.json: PayAI GET /supported. settled-tx.json: a recent USDC `exact` settlement that
// PayAI's Solana fee payer co-signed (jsonParsed getTransaction, maxSupportedTransactionVersion 1).
import { writeFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const RPC = "https://solana-rpc.publicnode.com";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const supported = await (await fetch("https://facilitator.payai.network/supported", { headers: { accept: "application/json" } })).json();
writeFileSync(new URL("supported.json", dir), JSON.stringify(supported, null, 1) + "\n");
const feePayer = supported.kinds.find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network.startsWith("solana:5eykt")).extra.feePayer;

const sigs = await rpc("getSignaturesForAddress", [feePayer, { limit: 40, commitment: "confirmed" }]);
for (const s of sigs.filter((x) => x.err == null)) {
  const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  const ixs = tx?.transaction.message.instructions ?? [];
  const transfers = ixs.filter((ix) => ix.program === "spl-token" && ix.parsed?.type === "transferChecked" && ix.parsed.info.mint === USDC);
  if (tx?.transaction.message.accountKeys[0].pubkey !== feePayer || transfers.length !== 1) continue;
  const t = transfers[0].parsed.info;
  const owner = (tx.meta.postTokenBalances ?? []).find((b) => tx.transaction.message.accountKeys[b.accountIndex].pubkey === t.destination)?.owner;
  if (!owner || owner === t.authority) continue;
  writeFileSync(new URL("settled-tx.json", dir), JSON.stringify({ signature: s.signature, recipient: owner, amountAtomic: t.tokenAmount.amount, payer: t.authority, feePayer, tx }, null, 1) + "\n");
  console.log(`captured ${s.signature}: ${t.tokenAmount.amount} atomic USDC ${t.authority} -> ${owner}`);
  process.exit(0);
}
throw new Error("no recent single-transfer USDC settlement found; try again later");
