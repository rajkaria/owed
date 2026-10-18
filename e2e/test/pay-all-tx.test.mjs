// F1 pay_all: the harness decodes a proposal that pays several requests in one transaction. Built with the plugin's
// real batch builder (plugin/src/tx.ts) and checked by the independent decoder (e2e/lib/solana-tx.mjs): each transfer
// must carry exactly one request's references and pay exactly its terms, and the memo must name every request.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { base58Encode, TEAM_WALLET, USDC_MINT } from "../../contract/shapes.mjs";
import { inspectProposal, PROPOSAL_KEY } from "../lib/solana-tx.mjs";

const plugin = (path) => new URL(`../../plugin/${path}`, import.meta.url);
const { tsImport } = await import(plugin("node_modules/tsx/dist/esm/api/index.mjs").href);
const { buildBatchTx } = await tsImport(plugin("src/tx.ts").href, import.meta.url);
const { createRequire } = await import("node:module");
const { PublicKey } = createRequire(plugin("package.json"))("@solana/web3.js");

const key = (label) => base58Encode(createHash("sha256").update(`pay-all-tx e2e: ${label}`).digest());
const SENDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = key("other recipient");
const ataFor = (owner, mint) => PublicKey.findProgramAddressSync(
  [new PublicKey(owner).toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(mint).toBuffer()],
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
)[0].toBase58();
const expiresAt = () => new Date(Date.now() + 240_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const proposalOf = (base64) => ({ [PROPOSAL_KEY]: { version: "1", expiresAt: expiresAt(), kind: "solana", chain: "solana:mainnet", transaction: { transactionBase64: base64 } } });

const requests = [
  { id: "AAAAAAAAAAAa", recipient: TEAM_WALLET, amount: "0.05", token: "USDC", splToken: USDC_MINT, references: [key("a")] },
  { id: "BBBBBBBBBBBb", recipient: TEAM_WALLET, amount: "0.05", token: "USDC", splToken: USDC_MINT, references: [key("b")] },
  { id: "CCCCCCCCCCCc", recipient: OTHER, amount: "0.01", token: "SOL", splToken: null, references: [key("c")] },
];
const build = (list, over = {}) => buildBatchTx({
  sender: SENDER,
  transfers: list.map((r) => ({
    id: r.id, recipient: r.recipient, token: r.token, references: r.references, createRecipientAta: r.token === "USDC",
    amountAtomic: r.token === "USDC" ? 50_000n : 10_000_000n, ...over[r.id],
  })),
});

test("a pay_all proposal: two same-amount USDC requests to one recipient and a SOL one, each matched to its own transfer", () => {
  const built = build(requests);
  const { errors, warnings, summary } = inspectProposal(proposalOf(built.transactionBase64), { sender: SENDER, expectedMany: requests, ataFor });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(summary.transfers.length, 3);
  assert.deepEqual(summary.paidIds, requests.map((r) => r.id));
  assert.deepEqual(summary.instructions, ["ata_create_idempotent", "spl_transfer_checked", "spl_transfer_checked", "sol_transfer", "memo"]);
  assert.equal(summary.memo, requests.map((r) => `owed:${r.id}`).join(" "));
  assert.deepEqual(summary.transfers.map((t) => t.references), requests.map((r) => r.references));
  assert.equal(summary.transfers[0].destinationOwner, TEAM_WALLET);
  assert.equal(summary.transfer.amount, "0.05", "transfer stays the first one for older callers");
});

test("pay_all mistakes are caught: wrong amount, a request paid twice, a transfer carrying two requests, a missing memo id", () => {
  const run = (base64) => inspectProposal(proposalOf(base64), { sender: SENDER, expectedMany: requests, ataFor }).errors.join("\n");
  assert.match(run(build(requests, { AAAAAAAAAAAa: { amountAtomic: 40_000n } }).transactionBase64), /transfer 0 pays 0\.04 USDC, request AAAAAAAAAAAa is for 0\.05/);
  const twice = buildBatchTx({ sender: SENDER, transfers: [requests[0], requests[0]].map((r, i) => ({ id: `${r.id.slice(0, 11)}${i}`, recipient: r.recipient, token: "USDC", amountAtomic: 50_000n, references: r.references, createRecipientAta: false })) });
  assert.match(run(twice.transactionBase64), /request AAAAAAAAAAAa is paid twice/);
  const shared = buildBatchTx({ sender: SENDER, transfers: [{ id: "AAAAAAAAAAAa", recipient: TEAM_WALLET, token: "USDC", amountAtomic: 50_000n, references: [...requests[0].references, ...requests[1].references], createRecipientAta: false }] });
  assert.match(run(shared.transactionBase64), /carries the references of 2 requests/);
  const renamed = build(requests.slice(0, 1).map((r) => ({ ...r, id: "ZZZZZZZZZZZz" })));
  assert.match(run(renamed.transactionBase64), /the memo doesn't name owed:AAAAAAAAAAAa/);
});

test("without expectedMany, a multi-transfer proposal still fails the single-payment check (pay_link stays strict)", () => {
  const built = build(requests);
  assert.match(inspectProposal(proposalOf(built.transactionBase64), { sender: SENDER }).errors.join(), /3 transfer instructions, expected exactly 1/);
  assert.deepEqual(inspectProposal(proposalOf(built.transactionBase64), { sender: SENDER, multi: true }).errors, []);
});
