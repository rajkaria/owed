import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { inputSchema, outputSchema, refundPayment, refundProblem } from "../src/tools/refund_payment.ts";
import { parseRefundMessage, refundIdFor, refundMessage } from "../src/refund.ts";
import { createRefundResSchema, getRequestResSchema, type GetRequestRes } from "../src/contract.ts";
import type { Rpc } from "../src/chain.ts";
import { MEMO_PROGRAM_ID } from "../src/tx.ts";
import { fixture, json, makeDeps, textOf, USDC_MINT, type Route } from "./helpers.ts";

// refund_payment's two calls against doubles of GET /api/v1/requests/:id, GET /api/v1/refunds?requests= and POST
// /api/v1/refunds, answered from contract/fixtures/refund.*.json (made by the real routes on PGlite). Signatures are real
// ed25519 from the throwaway key that signed those fixtures (fixed seed, holds nothing). Every proposal is decoded and
// checked: one transfer from the user's wallet to the payer, the refund's reference read-only on it, the memo.

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}
const ME = signer("owed contract fixture signer: refund (holds nothing)");
const MALLORY = signer("owed test signer: refund_payment.test.ts, someone else");
const created = fixture("refund.create.res.json");
const PAYER: string = created.payer;
const ID: string = created.request_id;
const NOW = Date.parse(created.created_at);
const PAID_SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
assert.equal(ME.address, created.recipient, "the fixtures were signed by this key");

const paidRequest = (over: Partial<GetRequestRes> = {}): GetRequestRes => getRequestResSchema.parse({
  id: ID, kind: "single", recipient: ME.address, amount: "1", token: "USDC", payer_name: "Priya", for: "dinner", note: null, requester_name: null,
  status: "paid", solana_pay_url: `solana:${ME.address}?amount=1&spl-token=${USDC_MINT}&reference=8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e&memo=owed%3A${ID}`,
  reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e", x402_url: null, created_at: "2026-10-18T07:00:00Z",
  paid: { signature: PAID_SIG, payer: PAYER, amount: "1", at: "2026-10-18T07:22:27Z", rail: "solana_pay" }, flags: [],
  ...over,
});
const lookup = (over: Record<string, unknown> = {}) => ({
  requests: [{ request_id: ID, token: "USDC", paid: "1", refunded: "0", pending: "0", refundable: "1", refunds: [], ...over }], not_found: [], chain_checked: true,
});
const GET_REQ = `GET /api/v1/requests/${ID}`;
const LOOKUP = `GET /api/v1/refunds?requests=${ID}`;
const POST = "POST /api/v1/refunds";

/** The payment on chain: `from` sent `amount` USDC to ME's USDC account (jsonParsed, as mainnet returns it). */
function paymentRpc(from = PAYER, amount = 1_000_000n): Rpc {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(ME.address), true).toBase58();
  const fromAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(from), true).toBase58();
  const tx = {
    slot: 1, blockTime: 1_792_300_000,
    meta: {
      err: null, preBalances: [1, 1, 1], postBalances: [1, 1, 1], innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: ME.address, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: ME.address, uiTokenAmount: { amount: String(amount) } }],
    },
    transaction: {
      signatures: [PAID_SIG],
      message: {
        accountKeys: [{ pubkey: from, signer: true }, { pubkey: fromAta, signer: false }, { pubkey: ata, signer: false }],
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: fromAta, destination: ata, authority: from, mint: USDC_MINT, tokenAmount: { amount: String(amount) } } } }],
      },
    },
  };
  return { call: async <T>(method: string) => (method === "getTransaction" ? tx : null) as T };
}

type Result = Awaited<ReturnType<typeof refundPayment>>;
const refused = (r: Result) => {
  assert.equal((r as { isError?: boolean }).isError, true, `expected a refusal, got ${textOf(r)}`);
  return textOf(r);
};
const proposal = (r: Result) => {
  assert.ok(!("isError" in r) || !r.isError, `unexpected refusal: ${textOf(r)}`);
  const sc = outputSchema.parse((r as { structuredContent: unknown }).structuredContent);
  return Transaction.from(Buffer.from(sc["io.paybox/transactionProposal"].transaction.transactionBase64, "base64"));
};
const deps = (routes: Record<string, Route>, extra: Parameters<typeof makeDeps>[0] = {}) => makeDeps({ now: () => NOW, rpc: () => paymentRpc(), routes, ...extra });
const first = (extra: Record<string, unknown> = {}) => inputSchema.parse({ link: ID, recipient: ME.address, ...extra });
const second = (message: string = created.signed_message, signature = ME.sign(message), extra: Record<string, unknown> = {}) =>
  first({ amount: parseRefundMessage(message)?.amount, signed_message: message, signature, ...extra });

// ---------------------------------------------------------------- first call

test("first call: checks the request, its refunds and who paid on Solana, then returns the exact message to sign", async () => {
  const { deps: d, rec } = deps({ [GET_REQ]: () => json(200, paidRequest()), [LOOKUP]: () => json(200, lookup()) });
  const text = refused(await refundPayment(first({ amount: "0.25" }), d));
  const message = refundMessage("0.25", "USDC", ID, PAYER, ME.address, NOW);
  assert.match(text, /^Refund ready to sign \(step 1 of 2\)\. Nothing has moved yet\./);
  assert.ok(text.includes(`\n${message}\n`));
  assert.ok(text.includes(`{"op":"solanaMessage","address":"${ME.address}","message":"${message}"}`));
  assert.match(text, /Refundable now: 1 USDC \(0 USDC refunded so far\)/);
  const plan = JSON.parse(text.slice(text.indexOf("```json\n") + 8, text.lastIndexOf("\n```")));
  assert.deepEqual([plan.step, plan.amount, plan.payer, plan.message_to_sign, plan.then.tool], ["sign", "0.25", PAYER, message, "refund_payment"]);
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, "")}`).sort(), [LOOKUP, GET_REQ].sort());
});

test("first call: no amount means everything still refundable; more than that is refused with the numbers", async () => {
  const { deps: d } = deps({ [GET_REQ]: () => json(200, paidRequest()), [LOOKUP]: () => json(200, lookup({ refunded: "0.25", refundable: "0.75", refunds: [{ id: created.id, amount: "0.25", status: "confirmed", created_at: created.created_at, confirmed: { signature: PAID_SIG, amount: "0.25", at: created.created_at } }] })) });
  const text = refused(await refundPayment(first(), d));
  assert.ok(text.includes(refundMessage("0.75", "USDC", ID, PAYER, ME.address, NOW)));
  const over = refused(await refundPayment(first({ amount: "0.8" }), d));
  assert.equal(over, "At most 0.75 USDC can be refunded on request YA9kgB8e9r5N (paid 1 USDC, 0.25 USDC refunded so far). Nothing was refunded.");
  const { deps: none } = deps({ [GET_REQ]: () => json(200, paidRequest()), [LOOKUP]: () => json(200, lookup({ refunded: "1", refundable: "0" })) });
  assert.match(refused(await refundPayment(first(), none)), /^Nothing is left to refund on request YA9kgB8e9r5N: it was paid 1 USDC, 1 USDC refunded so far\.$/);
});

test("first call refuses what can't go back to the paying wallet: unpaid, someone else's, card, matched, Base, a payer Solana disagrees with", async () => {
  const no = (rq: GetRequestRes, re: RegExp) => { const p = refundProblem(rq, ME.address); assert.ok(p && re.test(p), p ?? "no problem"); };
  no(paidRequest({ status: "open", paid: null }), /isn't paid \(it is open\)/);
  no(paidRequest({ recipient: MALLORY.address }), /Only the wallet a request paid can refund it/);
  no(paidRequest({ paid: { signature: PAID_SIG, payer: PAYER, amount: "1", at: "2026-10-18T07:22:27Z", rail: "moonpay_card" } }), /MoonPay/);
  no(paidRequest({ paid: { signature: PAID_SIG, payer: PAYER, amount: "1", at: "2026-10-18T07:22:27Z", rail: "matched" } }), /matched this payment by hand/);
  assert.equal(refundProblem(paidRequest(), ME.address), null);
  // Solana says someone else sent the payment: refused before anything is signed.
  const { deps: d } = deps({ [GET_REQ]: () => json(200, paidRequest()), [LOOKUP]: () => json(200, lookup()) }, { rpc: () => paymentRpc(MALLORY.address) });
  assert.match(refused(await refundPayment(first(), d)), /came from .+, not BoNf.+ as Owed recorded\. Nothing was refunded/);
  // A server without refunds yet (its route is a 404 page).
  const { deps: old } = deps({ [GET_REQ]: () => json(200, paidRequest()), [LOOKUP]: () => new Response("<html>404</html>", { status: 404 }) });
  assert.equal(refused(await refundPayment(first(), old)), "This Owed server doesn't take refunds yet, so nothing was refunded.");
});

// ---------------------------------------------------------------- second call

test("second call: a partial refund is recorded, then proposed as one USDC transfer to the payer with the refund's reference and memo", async () => {
  const { deps: d, rec } = deps({ [POST]: () => json(201, created) });
  const r = await refundPayment(second(created.signed_message, created.signature), d);
  const tx = proposal(r);
  assert.equal(tx.feePayer?.toBase58(), ME.address);
  const memo = tx.instructions.find((ix) => ix.programId.toBase58() === MEMO_PROGRAM_ID)!;
  assert.equal(memo.data.toString("utf8"), `owed-refund:${created.id}`);
  const transfer = tx.instructions.at(-1)!;
  const mint = new PublicKey(USDC_MINT);
  // transferChecked: source, mint, destination, owner, then the reference read-only.
  assert.equal(transfer.keys[0]!.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, new PublicKey(ME.address), true).toBase58());
  assert.equal(transfer.keys[2]!.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, new PublicKey(PAYER), true).toBase58());
  assert.equal(transfer.keys[3]!.pubkey.toBase58(), ME.address);
  assert.deepEqual(transfer.keys.slice(4).map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), [[created.reference, false, false]]);
  assert.equal(transfer.data.readBigUInt64LE(1), 250_000n);
  // The balance was checked before the signature was spent, for the refund's amount, to the payer.
  assert.deepEqual(rec.readiness, [{ sender: ME.address, recipient: PAYER, token: "USDC", amountAtomic: 250_000n }]);
  assert.deepEqual(rec.calls.map((c) => [c.method, c.body]), [["POST", fixture("refund.create.req.json")]]);
  assert.match(textOf(r), /^Refund 0\.25 USDC to BoNf\S+ for request YA9kgB8e9r5N\. Approve in PayBox to send it\./);
  assert.match(textOf(r), /Paid 1 USDC; refunded 0, waiting 0\.25, still refundable 0\.75\./);
});

test("second call: a full refund, a SOL refund, and opening the payer's USDC account when it's gone", async () => {
  const msg = refundMessage("1", "USDC", ID, PAYER, ME.address, NOW);
  const full = createRefundResSchema.parse({ ...created, amount: "1", signed_message: msg, signature: ME.sign(msg), pending: "1", refundable: "0",
    id: refundIdFor({ requestId: ID, payer: PAYER, token: "USDC", amountAtomic: 1_000_000n, reference: created.reference }) });
  const fullFixed = { ...full, memo: `owed-refund:${full.id}` };
  const { deps: d } = deps({ [POST]: () => json(201, fullFixed) }, { payerReadiness: async () => ({ ok: true, recipientAtaExists: false }) });
  const tx = proposal(await refundPayment(second(msg), d));
  assert.equal(tx.instructions.length, 3); // create the payer's USDC account, memo, transfer
  assert.equal(tx.instructions.at(-1)!.data.readBigUInt64LE(1), 1_000_000n);

  const smsg = refundMessage("0.025", "SOL", ID, PAYER, ME.address, NOW);
  const solRefund = { ...created, token: "SOL", amount: "0.025", signed_message: smsg, signature: ME.sign(smsg), paid: "0.05", pending: "0.025", refundable: "0.025",
    id: refundIdFor({ requestId: ID, payer: PAYER, token: "SOL", amountAtomic: 25_000_000n, reference: created.reference }) };
  const sol = { ...solRefund, memo: `owed-refund:${solRefund.id}` };
  const { deps: ds } = deps({ [POST]: () => json(201, sol) });
  const stx = proposal(await refundPayment(second(smsg), ds));
  const transfer = stx.instructions.at(-1)!;
  assert.ok(transfer.programId.equals(SystemProgram.programId));
  assert.equal(transfer.keys[1]!.pubkey.toBase58(), PAYER);
  assert.equal(transfer.data.readBigUInt64LE(4), 25_000_000n);
  assert.deepEqual(transfer.keys.slice(2).map((k) => k.pubkey.toBase58()), [created.reference]);
});

test("second call refuses locally (no server call): another wallet's signature, a stale or altered message, an amount that differs", async () => {
  const { deps: d, rec } = deps({ [POST]: () => json(201, created) });
  assert.match(refused(await refundPayment(second(created.signed_message, MALLORY.sign(created.signed_message)), d)), /isn't from wallet 39mH/);
  const stale = refundMessage("0.25", "USDC", ID, PAYER, ME.address, NOW - 6 * 60_000);
  assert.match(refused(await refundPayment(second(stale), d)), /more than 5 minutes old/);
  const otherRequest = created.signed_message.replace(ID, "Ab3dEf6hJk9m");
  assert.match(refused(await refundPayment(second(otherRequest), d)), /must be exactly the message_to_sign/);
  assert.match(refused(await refundPayment(second(created.signed_message, ME.sign(created.signed_message), { amount: "0.3" }), d)), /differs from the 0\.25 USDC/);
  assert.match(refused(await refundPayment(first({ signed_message: created.signed_message }), d)), /both signed_message and signature/);
  assert.equal(rec.calls.length, 0);
});

test("second call: a short balance stops it before the signature is spent; a server that answers different terms is refused", async () => {
  const { deps: d, rec } = deps({ [POST]: () => json(201, created) }, { payerReadiness: async () => ({ ok: false, reason: "Your wallet has 0.1 USDC; this request is 0.25 USDC.", recipientAtaExists: true }) });
  const text = refused(await refundPayment(second(), d));
  assert.match(text, /^This wallet can't send the refund right now: Your wallet has 0\.1 USDC; the refund is 0\.25 USDC\. Nothing was recorded/);
  assert.equal(rec.calls.length, 0);
  for (const bad of [{ payer: MALLORY.address }, { amount: "0.5" }, { recipient: MALLORY.address }, { memo: "owed-refund:Ab3dEf6hJk9m" }, { reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e" }]) {
    const { deps: dd } = deps({ [POST]: () => json(201, { ...created, ...bad }) });
    assert.match(refused(await refundPayment(second(), dd)), /doesn't match what was signed/, JSON.stringify(bad));
  }
  const { deps: over } = deps({ [POST]: () => json(400, { error: { code: "invalid_input", message: "refunds can't add up to more than was paid (1 USDC)" } }) });
  assert.equal(refused(await refundPayment(second(), over)), "Owed refused the refund: refunds can't add up to more than was paid (1 USDC). Nothing was refunded.");
});

test("refund_id: the transfer again for a pending refund; a confirmed or lapsed one isn't proposed", async () => {
  const route = `GET /api/v1/refunds/${created.id}`;
  const { paid: _p, refunded: _r, pending: _q, refundable: _f, ...pending } = created;
  const { deps: d } = deps({ [route]: () => json(200, pending) });
  const tx = proposal(await refundPayment(first({ refund_id: created.id }), d));
  assert.equal(tx.instructions.at(-1)!.data.readBigUInt64LE(1), 250_000n);
  const { deps: done } = deps({ [route]: () => json(200, { ...pending, status: "confirmed", confirmed: { signature: PAID_SIG, amount: "0.25", at: created.created_at } }) });
  assert.match(refused(await refundPayment(first({ refund_id: created.id }), done)), /already landed/);
  const { deps: lapsed } = deps({ [route]: () => json(200, { ...pending, status: "lapsed" }) });
  assert.match(refused(await refundPayment(first({ refund_id: created.id }), lapsed)), /refundable again/);
  const { deps: forged } = deps({ [route]: () => json(200, { ...pending, payer: MALLORY.address }) });
  assert.match(refused(await refundPayment(first({ refund_id: created.id }), forged)), /signed message doesn't match/);
});
