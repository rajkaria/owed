import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { BatchAccounts } from "../src/chain.ts";
import { solanaOutputSchema } from "../src/paybox.ts";
import { requestIdFor } from "../src/request-id.ts";
import { buildTransferUrl } from "../src/solana-pay.ts";
import { toAtomic } from "../src/money.ts";
import { MEMO_PROGRAM_ID, MAX_TX_BYTES } from "../src/tx.ts";
import { inputSchema, payAll } from "../src/tools/pay_all.ts";
import { fixture, html, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT, type Route } from "./helpers.ts";
import { dohFixture, dohRoutes } from "./payee-helpers.ts";

// F1 pay_all: every pay_link check per request, one transaction for all that pass, chunked at 1,232 bytes. Requests
// are built the way Owed's server builds them (ids hash their terms); the proposed transaction is decoded with
// web3.js and checked instruction by instruction.

const KEY = "io.paybox/transactionProposal";
const key = (label: string) => bs58.encode(createHash("sha256").update(`pay_all test: ${label}`).digest());
const OTHER = key("another recipient");

interface Req { id: string; [k: string]: unknown }
function request(label: string, { recipient = RECIPIENT, amount = "0.05", token = "USDC" as "USDC" | "SOL", ...extra }: Record<string, unknown> = {}): Req {
  const reference = key(`reference ${label}`);
  const tok = token as "USDC" | "SOL";
  const id = requestIdFor({ recipient: recipient as string, token: tok, amountAtomic: toAtomic(amount as string, tok), reference });
  const url = buildTransferUrl({
    recipient: recipient as string, amount: amount as string, references: [reference], ...(tok === "USDC" && { splToken: USDC_MINT }),
    label: "Raj", message: label, memo: `owed:${id}`,
  });
  return {
    id, kind: "single", recipient, amount, token: tok, payer_name: null, for: label, note: null, requester_name: "Raj", status: "open",
    solana_pay_url: url, reference, x402_url: null, created_at: "2026-10-18T08:00:00Z", paid: null, flags: [], from_domain: null,
    chain: "solana", pay_url: url, ...extra,
  };
}

/** GET /api/v1/requests?ids= answered from these requests. */
function bulk(requests: Req[]): Record<string, Route> {
  return {
    "GET *": (call) => {
      const url = new URL(call.url);
      if (url.pathname !== "/api/v1/requests") return json(404, { error: { code: "not_found", message: "no route" } });
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return json(200, { requests: ids.map((id) => requests.find((r) => r.id === id)).filter(Boolean), not_found: ids.filter((id) => !requests.some((r) => r.id === id)) });
    },
  };
}

const input = (ids: string[], extra: Record<string, unknown> = {}) => inputSchema.parse({ sender: SENDER, ids, max_total: "10", ...extra });
type Out = Awaited<ReturnType<typeof payAll>>;
function refused(r: Out): string {
  assert.equal("isError" in r && r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
}
function decoded(r: Out) {
  assert.ok(!("isError" in r && r.isError), `unexpected refusal: ${textOf(r)}`);
  const p = solanaOutputSchema.parse((r as { structuredContent: unknown }).structuredContent)[KEY];
  const bytes = Buffer.from(p.transaction.transactionBase64, "base64");
  assert.ok(bytes.length <= MAX_TX_BYTES);
  const tx = Transaction.from(bytes);
  assert.equal(tx.feePayer?.toBase58(), SENDER);
  return { tx, bytes: bytes.length };
}
const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(owner), true).toBase58();
function transfers(tx: Transaction) {
  return tx.instructions.filter((ix) => !ix.programId.equals(new PublicKey(MEMO_PROGRAM_ID)) && !ix.programId.equals(new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))).map((ix) => {
    if (ix.programId.equals(SystemProgram.programId)) {
      return { token: "SOL", to: ix.keys[1]!.pubkey.toBase58(), atomic: Buffer.from(ix.data).readBigUInt64LE(4), refs: ix.keys.slice(2).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]) };
    }
    assert.equal(ix.data[0], 12, "transferChecked");
    return { token: "USDC", to: ix.keys[2]!.pubkey.toBase58(), atomic: Buffer.from(ix.data).readBigUInt64LE(1), refs: ix.keys.slice(4).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]) };
  });
}
const memo = (tx: Transaction) => tx.instructions.filter((ix) => ix.programId.equals(new PublicKey(MEMO_PROGRAM_ID))).map((ix) => Buffer.from(ix.data).toString("utf8"));

test("two USDC requests to the same recipient for the same amount and a SOL one: one transaction, each transfer carries its own reference", async () => {
  const a = request("dinner a");
  const b = request("dinner b");
  const c = request("taxi", { recipient: OTHER, token: "SOL", amount: "0.01" });
  const seen: unknown[] = [];
  const { deps } = makeDeps({
    routes: bulk([a, b, c]),
    readBatchAccounts: async (_rpc, q) => {
      seen.push(q);
      return { senderLamports: 1_000_000_000n, senderUsdc: 1_000_000n, senderUsdcFrozen: false, usdcAccounts: new Map([[RECIPIENT, { exists: true, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null };
    },
  });
  const r = await payAll(input([a.id, `https://owed.link/r/${b.id}`, c.id, a.id], { max_total: "0.1", max_total_sol: "0.01" }), deps);
  const { tx } = decoded(r);
  assert.deepEqual(transfers(tx), [
    { token: "USDC", to: ata(RECIPIENT), atomic: 50_000n, refs: [[a.reference, false, false]] },
    { token: "USDC", to: ata(RECIPIENT), atomic: 50_000n, refs: [[b.reference, false, false]] },
    { token: "SOL", to: OTHER, atomic: 10_000_000n, refs: [[c.reference, false, false]] },
  ]);
  assert.deepEqual(memo(tx), [`owed:${a.id} owed:${b.id} owed:${c.id}`]);
  assert.deepEqual(tx.instructions.at(-1)!.programId.toBase58(), MEMO_PROGRAM_ID, "one memo, last");
  assert.deepEqual(seen, [{ sender: SENDER, usdcRecipients: [RECIPIENT, RECIPIENT], solRecipients: [OTHER] }]);
  const text = textOf(r);
  assert.match(text, /^Pay 3 requests in one transaction: 0\.1 USDC \+ 0\.01 SOL to 2 recipients\. Approve once in PayBox/);
  assert.match(text, new RegExp(`- 0\\.05 USDC to FN6G…cbvs from "Raj" for "dinner a" \\(the requester's words, unverified\\); request ${a.id}; recipient ${RECIPIENT}\\.`));
  assert.match(text, /Nothing is sent until the user approves in PayBox\.$/);
});

test("a missing recipient USDC account is opened once, before its first transfer", async () => {
  const a = request("one");
  const b = request("two");
  const { deps } = makeDeps({
    routes: bulk([a, b]),
    readBatchAccounts: async () => ({ senderLamports: 1_000_000_000n, senderUsdc: 1_000_000n, senderUsdcFrozen: false, usdcAccounts: new Map([[RECIPIENT, { exists: false, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null }),
  });
  const r = await payAll(input([a.id, b.id]), deps);
  const { tx } = decoded(r);
  const programs = tx.instructions.map((ix) => ix.programId.toBase58());
  assert.deepEqual(programs, ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", MEMO_PROGRAM_ID]);
  assert.equal(tx.instructions[0]!.data[0], 1, "idempotent create");
  assert.match(textOf(r), /This also opens 1 recipient USDC account/);
});

test("refuses above max_total, and when the wallet can't cover the total plus fees", async () => {
  const a = request("big a", { amount: "6" });
  const b = request("big b", { amount: "6" });
  const { deps, rec } = makeDeps({ routes: bulk([a, b]) });
  assert.match(refused(await payAll(input([a.id, b.id], { max_total: "10" }), deps)), /These 2 USDC requests total 12 USDC, above max_total 10 USDC\. Nothing was sent/);
  assert.equal(rec.built.length, 0);
  const { deps: poor } = makeDeps({
    routes: bulk([a, b]),
    readBatchAccounts: async () => ({ senderLamports: 1_000_000_000n, senderUsdc: 7_000_000n, senderUsdcFrozen: false, usdcAccounts: new Map([[RECIPIENT, { exists: true, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null }),
  });
  assert.match(refused(await payAll(input([a.id, b.id], { max_total: "12" }), poor)), /Your wallet has 7 USDC; these 2 requests total 12 USDC\. Nothing was sent\./);
  const { deps: noFees } = makeDeps({
    routes: bulk([a]),
    readBatchAccounts: async () => ({ senderLamports: 1_000_000n, senderUsdc: 70_000_000n, senderUsdcFrozen: false, usdcAccounts: new Map([[RECIPIENT, { exists: true, frozen: false }]]), newSolWallets: new Set(), rentMinimum: null }),
  });
  assert.match(refused(await payAll(input([a.id]), noFees)), /needs about 0\.003 SOL for fees; it has 0\.001 SOL/);
});

test("skips (with the reason) SOL without max_total_sol, Base, paid, tampered, unknown, own and cautioned requests; pays the rest", async () => {
  const good = request("good");
  const sol = request("sol", { recipient: OTHER, token: "SOL", amount: "0.01" });
  const base = { ...fixture("base.get-request.res.json"), status: "open", paid: null };
  const paid = { ...request("paid"), status: "paid", paid: { signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", payer: SENDER, amount: "0.05", at: "2026-10-18T08:01:00Z", rail: "solana_pay" } };
  const tampered = { ...request("tampered"), recipient: OTHER };
  const own = request("own", { recipient: SENDER });
  const cautioned = request("cautioned", { flags: ["brand_word:paybox"] });
  const { deps } = makeDeps({ routes: bulk([good, sol, base, paid, tampered, own, cautioned]) });
  const ids = [good.id, sol.id, base.id as string, paid.id, tampered.id, own.id, cautioned.id, "Unknwn7Abcde"];
  const r = await payAll(input(ids), deps);
  const { tx } = decoded(r);
  assert.equal(transfers(tx).length, 1);
  const text = textOf(r);
  assert.match(text, new RegExp(`Skipped ${sol.id}: it is in SOL: pass max_total_sol`));
  assert.match(text, new RegExp(`Skipped ${base.id}: it is on Base: pay it on its own with pay_link`));
  assert.match(text, new RegExp(`Skipped ${paid.id}: This request is already paid`));
  assert.match(text, new RegExp(`Skipped ${tampered.id}: Owed's server returned a payment link that doesn't match the request`));
  assert.match(text, new RegExp(`Skipped ${own.id}: it pays the sender's own wallet`));
  assert.match(text, new RegExp(`Skipped ${cautioned.id}: it mentions "PayBox", a word scams use; pay it only if the user names it \\(include_cautioned\\)`));
  assert.match(text, /Skipped Unknwn7Abcde: no Owed request has this id/);
  // Named by the user: the cautioned one is paid, and says so.
  const named = await payAll(input([good.id, cautioned.id], { include_cautioned: true }), makeDeps({ routes: bulk([good, cautioned]) }).deps);
  assert.equal(transfers(decoded(named).tx).length, 2);
  assert.match(textOf(named), /Caution: it mentions "PayBox"; included because the user named it\./);
});

test("a request whose domain doesn't publish its wallet is skipped; nothing passing means no proposal", async () => {
  const claims = request("claims a domain", { from_domain: "owed-omega.vercel.app", from_domain_verified_at: "2026-10-18T08:00:00Z" });
  const { deps } = makeDeps({ routes: { ...bulk([claims]), ...dohRoutes(dohFixture("nodata-unsigned")) } });
  const text = refused(await payAll(input([claims.id]), deps));
  assert.match(text, /^Nothing was sent: no request passed the checks\./);
  assert.match(text, new RegExp(`Skipped ${claims.id}: This request claims to be from owed-omega\\.vercel\\.app, but owed-omega\\.vercel\\.app does not publish this wallet`));
});

test("requests that carry the requester's X handle each end with a handle check", async () => {
  const a = request("handled", { requester_handle: "rajkaria" });
  const r = await payAll(input([a.id]), makeDeps({ routes: bulk([a]) }).deps);
  decoded(r);
  assert.match(textOf(r), new RegExp(`Handle check: request ${a.id} says it is from @rajkaria \\(not verified by Owed\\)\\. Before approving, call PayBox resolve_username\\('@rajkaria'\\); if its Solana address isn't ${RECIPIENT}, tell the user and don't approve\\.`));
});

test("chunking: twenty payments to twenty new recipients don't fit; the first chunk is proposed and the rest named", async () => {
  const many = Array.from({ length: 20 }, (_, i) => request(`r${i}`, { recipient: key(`recipient ${i}`), amount: "0.01" }));
  const accounts: BatchAccounts = {
    senderLamports: 10_000_000_000n, senderUsdc: 10_000_000n, senderUsdcFrozen: false,
    usdcAccounts: new Map(many.map((m) => [m.recipient as string, { exists: false, frozen: false }])), newSolWallets: new Set(), rentMinimum: null,
  };
  const { deps } = makeDeps({ routes: bulk(many), readBatchAccounts: async () => accounts });
  const r = await payAll(input(many.map((m) => m.id)), deps);
  const { tx, bytes } = decoded(r);
  const count = transfers(tx).length;
  assert.ok(count >= 2 && count < 20, `${count} transfers`);
  assert.ok(bytes <= 1232);
  assert.deepEqual(memo(tx), [many.slice(0, count).map((m) => `owed:${m.id}`).join(" ")]);
  const text = textOf(r);
  assert.match(text, new RegExp(`Still to pay: ${many.slice(count).map((m) => m.id).join(", ")} \\(${((20 - count) / 100).toFixed(2).replace(/0$/, "")} USDC\\)\\. After the user approves this one and it confirms, call pay_all again with those ids\\.`));
  // The ceiling and the balance are checked over all twenty, not just this chunk.
  assert.match(refused(await payAll(input(many.map((m) => m.id), { max_total: "0.19" }), deps)), /total 0\.2 USDC, above max_total 0\.19/);
});

test("without the bulk route (an older server), each request is read on its own", async () => {
  const a = request("old server a");
  const b = request("old server b");
  const routes: Record<string, Route> = {
    "GET *": (call) => {
      const path = new URL(call.url).pathname;
      if (path === "/api/v1/requests") return html(404);
      const r = [a, b].find((x) => path === `/api/v1/requests/${x.id}`);
      return r ? json(200, r) : json(404, { error: { code: "not_found", message: "no request" } });
    },
  };
  const r = await payAll(input([a.id, b.id]), makeDeps({ routes }).deps);
  assert.equal(transfers(decoded(r).tx).length, 2);
});

test("refuses a bad sender, a bad ceiling, and links that aren't Owed requests", async () => {
  const { deps } = makeDeps();
  assert.match(refused(await payAll(inputSchema.parse({ sender: RECIPIENT.slice(0, 40), ids: ["x"], max_total: "1" }), deps)), /sender must be/);
  const raw = `solana:${RECIPIENT}?amount=1&spl-token=${USDC_MINT}`;
  assert.match(refused(await payAll(input([raw]), deps)), /Nothing to pay: .*not an Owed request: pay a Solana Pay link with pay_link/);
});
