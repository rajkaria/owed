// QA-18 (Low): ask_for_money creates a SOL request below the rent-exempt minimum for a wallet that has
// no account yet, which no payer can pay: pay_link refuses ("This address has never been used, so the
// first payment must be at least 0.00065024 SOL") and wallets fail simulation. Production: split
// Vkcbbp2q8f1R (shares of 3, 2 and 2 lamports to an unused wallet). The plugin already reads the rent
// minimum when paying (chain.ts payerReadiness); creation should read it too and refuse or warn.
// Owner: LEAD to assign. Run: command node e2e/qa/run.mjs QA-18
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rpc } from "../../../plugin/src/chain.ts";
import { askForMoney, inputSchema } from "../../../plugin/src/tools/ask_for_money.ts";
import { json, makeDeps, textOf } from "../../../plugin/test/helpers.ts";

const UNUSED = "B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp"; // QA wallet: no account on mainnet
// Answers in the shape of mainnet's (2026-10-17): no account for UNUSED; rent minimum for 0 bytes 650,240.
const rpc: Rpc = {
  call: (async (method: string) => {
    if (method === "getMultipleAccounts") return { context: { slot: 1 }, value: [null] };
    if (method === "getAccountInfo") return { context: { slot: 1 }, value: null };
    if (method === "getBalance") return { context: { slot: 1 }, value: 0 };
    if (method === "getMinimumBalanceForRentExemption") return 650_240;
    throw new Error(`unexpected ${method}`);
  }) as Rpc["call"],
};

test("QA-18 a 3-lamport SOL request to a wallet with no account is refused or carries a warning", async () => {
  const { deps } = makeDeps({ rpc: () => rpc, routes: { "POST /api/v1/requests": () => json(503, { error: { code: "upstream_unavailable", message: "x" } }) } });
  const result = await askForMoney(inputSchema.parse({ recipient: UNUSED, amount: "0.000000003", token: "SOL" }), deps);
  const text = textOf(result);
  assert.match(text, /at least 0\.00065024 SOL|rent|never been used/i, `no word that nobody can pay this:\n${text}`);
});

test("QA-18 control (passes today): a USDC request is unaffected", async () => {
  const { deps } = makeDeps({ rpc: () => rpc, routes: { "POST /api/v1/requests": () => json(503, { error: { code: "upstream_unavailable", message: "x" } }) } });
  const result = await askForMoney(inputSchema.parse({ recipient: UNUSED, amount: "0.01", token: "USDC" }), deps);
  assert.ok(!result.isError, textOf(result));
});
