// Cross-check between the plugin's real pipeline (W1-A solana-pay.ts parse/build → W1-B tx.ts) and the harness's
// independent parser + decoder. If they disagree about what a link pays, one of them is wrong before PayBox sees it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parseSolanaPayUrl, TEAM_WALLET } from "../../contract/shapes.mjs";
import { inspectProposal, PROPOSAL_KEY } from "../lib/solana-tx.mjs";

const plugin = (path) => new URL(`../../plugin/${path}`, import.meta.url);
const { tsImport } = await import(plugin("node_modules/tsx/dist/esm/api/index.mjs").href);
const solanaPay = await tsImport(plugin("src/solana-pay.ts").href, import.meta.url);
const { buildTransferTx } = await tsImport(plugin("src/tx.ts").href, import.meta.url);
const { toAtomic } = await tsImport(plugin("src/money.ts").href, import.meta.url);
const { createRequire } = await import("node:module");
const { PublicKey } = createRequire(plugin("package.json"))("@solana/web3.js");

const ataFor = (owner, mint) => PublicKey.findProgramAddressSync(
  [new PublicKey(owner).toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(mint).toBuffer()],
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
)[0].toBase58();
const fixtureUrl = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8")).solana_pay_url;
const expiresAt = () => new Date(Date.now() + 240_000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function links() {
  const sol = solanaPay.buildTransferUrl({ recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "0.25", references: [solanaPay.newReference()], memo: "owed:Bq3wL8mNc2" });
  return [await fixtureUrl("create-request.res.json"), await fixtureUrl("status-raw.req.json"), sol];
}

test("every link the plugin parses builds a tx the harness agrees with", async () => {
  for (const url of await links()) {
    const parsed = solanaPay.parseLink(url, []);
    assert.equal(parsed.kind, "transfer", url);
    const token = solanaPay.transferToken(parsed.request);
    for (const createRecipientAta of token === "USDC" ? [true, false] : [false]) {
      const built = buildTransferTx({ sender: TEAM_WALLET, request: parsed.request, token, amountAtomic: toAtomic(parsed.request.amount, token), createRecipientAta });
      const proposal = { [PROPOSAL_KEY]: { version: "1", expiresAt: expiresAt(), kind: "solana", chain: "solana:mainnet", transaction: { transactionBase64: built.transactionBase64 } } };
      const independent = parseSolanaPayUrl(url);
      const { errors, warnings, summary } = inspectProposal(proposal, { sender: TEAM_WALLET, expected: independent, ataFor });
      assert.deepEqual(errors, [], `${url} (ata ${createRecipientAta})`);
      assert.deepEqual(warnings, []);
      assert.equal(summary.bytes, built.bytes);
      assert.equal(summary.transfer.amount, independent.amount);
      assert.equal(summary.transfer.token, independent.token);
      assert.equal(summary.createsRecipientAta, createRecipientAta);
      assert.equal(summary.memo, independent.memo);
    }
  }
});

test("transaction requests are told apart identically", () => {
  const url = "solana:https%3A%2F%2Fshop.example%2Fapi%2Fsolana-pay";
  assert.equal(solanaPay.parseLink(url, []).kind, "transaction");
  assert.equal(parseSolanaPayUrl(url).kind, "transaction");
});
