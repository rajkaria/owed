import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { explorerTx } from "@/lib/view/format";
import { modelFromRequest, pageDescription, stateFromRequest, stateFromStatus } from "@/lib/view/request-view";
import type { PublicRequest } from "@/lib/public-api";

// W3-B: the pay page's Base branch (proposed LEAD commit): the model says Base, opens the EIP-681
// link, reads 0x payers and transaction hashes, and links Basescan.

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const paid = fx("base.get-request.res.json") as PublicRequest;
const open = { ...paid, status: "open", paid: null } as PublicRequest;

test("a Base request's pay model: chain base, the EIP-681 link for the wallet button and QR, Base wording", () => {
  const m = modelFromRequest(open, "https://www.getowed.xyz");
  assert.equal(m.chain, "base");
  assert.equal(m.solanaPayUrl, open.pay_url);
  assert.match(m.solanaPayUrl, /^ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453\/transfer\?address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed&uint256=500000$/);
  assert.equal(m.x402Url, `https://www.getowed.xyz/x/${open.id}`);
  assert.equal(pageDescription(m), "0.5 USDC for “coffee”. Pay from any Base wallet, or with your AI agent in PayBox.");
  const sol = modelFromRequest(fx("get-request.res.json") as PublicRequest, "https://www.getowed.xyz");
  assert.equal(sol.chain, "solana");
  assert.match(pageDescription(sol), /Pay with any Solana wallet/);
});

test("a paid Base request renders its 0x payer and transaction, with the Basescan link and rail", () => {
  const s = stateFromRequest(paid);
  assert.deepEqual(s, { status: "paid", amount: "0.5", payer: paid.paid!.payer, signature: paid.paid!.signature, at: paid.paid!.at, rail: "base_transfer" });
  const live = stateFromStatus(fx("base.status.res.json").results[0], "0.5", "USDC");
  assert.equal(live?.status, "paid");
  assert.ok(live && live.status === "paid" && live.signature === paid.paid!.signature && live.payer === paid.paid!.payer);
  assert.deepEqual(explorerTx(paid.paid!.signature), { href: `https://basescan.org/tx/${paid.paid!.signature}`, name: "Basescan" });
  assert.equal(explorerTx("5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv").name, "Solscan");
});
