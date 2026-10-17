import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { incomingTransfers, readTransfer, type Rpc } from "../src/chain.ts";
import { USDC_MINT } from "../src/money.ts";
import { MATCHED_LABEL } from "../src/text.ts";
import { checkPayments } from "../src/tools/check_payments.ts";
import { inputSchema, matchMessage, matchPayments, outputSchema, type MatchOutput } from "../src/tools/match_payments.ts";
import { ledgerMessage, whoOwesMe, inputSchema as whoInput } from "../src/tools/who_owes_me.ts";
import { fixture, json, makeDeps, textOf, type Route } from "./helpers.ts";

// match_payments against the recorded mainnet history of the team wallet's USDC account
// (fixtures/chain/team-usdc-unreferenced.json, captured with the exact calls chain.ts makes): four transfers from
// Raj's Phantom (GSWh…8dcD) that carry no Solana Pay reference, Phantom's referenced payment mBef… for request
// qNaosx73zzt3, the team wallet's own outgoing x402 payment and the account's first deposit. API replies are doubles
// shaped like contract/fixtures. Where the recipient must sign, the recording is replayed with the team wallet (and
// its USDC account) swapped for a throwaway key's: "constructed", amounts, payers, signatures and times unchanged.

interface Call { method: string; params: unknown[]; result: unknown }
const RECORDING = readFileSync(new URL("./fixtures/chain/team-usdc-unreferenced.json", import.meta.url), "utf8");
function replay(calls: Call[]): Rpc & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded call ${method} ${JSON.stringify(params)}`);
      log.push(`${method} ${String(params[0]).slice(0, 8)}`);
      return structuredClone(hit.result) as T;
    },
  };
}
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const TEAM_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const TEAM_CALLS = (JSON.parse(RECORDING) as { calls: Call[] }).calls;
const GSWH = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";
const TX = {
  a: "5w8NvDDoTWKEWjVABR78bwTXbbiutvvgXqe9WAegotZq2s4awqXf5oHKLg8zpnUZ9aE2pCxA3s9e4zASndGS5cTp", // 0.01, 17:14:15Z
  b: "3V3GyHymd4d1wT8RDmoSLcXLo5BvRyCNrqaoT6tMxyMX81TEc41rqhAvbCpcXbLYMGaPB641obfxu4kV6tgUSyXW", // 0.01, 17:22:33Z
  c: "SRF8XFt4Ugo2xEJvbuY9xHDyM26F9ZFaxS6ubBcJPugZotMw4dDLq67Yit3MVeTkjSEGavXAjTVEiw1fP5SGcvo", // 0.01, 18:31:14Z
  one: "5LPHMNke5nYHpnBiR65JUF9Bhp5WQqSbWaB38dwDBtZdevKU6y4abqdM53oajiVnCyrCEV42hc8Bani28XnqSuHA", // 1, 15:32:04Z
  five: "44rMqgCKXeZbvpKQTFDDpVdVQ9zJimEgjDvUPsZ2pjmpRu5wjSo4dQ1uvGZgkN6xsxXi5Q1YbNwA3HwFR2iJ8Gbo", // 5, 04:46:13Z, account created
  referenced: "mBefU4x5vN7nfLZhPkJbsEsmXuTaWYZrkGrBiHBEUXJE7BySYXqNYDYJ7ePmRETCBWoBYGNsWDeJosVHGmuf3i9", // 0.01, 18:37:27Z, ref + memo
  outgoing: "2ycZFaKx86Jhm91qXUgcMY6NkoDdH7qk6GE6zanDuKQBXy4AhrcPE1E11Qxwf8z2WgGuhtXfGdFmTEyvhZk21DVA", // the team wallet paying x402
};
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}
// The throwaway key that signed contract/fixtures/match.*.json (contract/match-fixtures.mjs).
const ME = signer("owed contract fixture signer: 0012 matched payments");
const MALLORY = signer("owed test signer: match_payments.test.ts, someone else");
const ME_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(ME.address), true).toBase58();
const ME_CALLS = (JSON.parse(RECORDING.replaceAll(TEAM, ME.address).replaceAll(TEAM_ATA, ME_ATA)) as { calls: Call[] }).calls;

const NOW = Date.parse("2026-10-17T19:00:00Z");
const API = "https://owed-omega.vercel.app";

/** A GET /api/v1/requests/:id body for a USDC request to `recipient`. */
function rq(id: string, o: { recipient?: string; amount?: string; created_at?: string; status?: string; paid?: unknown; matched?: unknown; rest_request?: unknown } = {}) {
  const recipient = o.recipient ?? TEAM;
  const amount = o.amount ?? "0.01";
  return {
    id, kind: "single", recipient, amount, token: "USDC", payer_name: "Priya", for: "dinner", note: null, requester_name: "Raj",
    status: o.status ?? "open", solana_pay_url: `solana:${recipient}?amount=${amount}&spl-token=${USDC_MINT}`,
    reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e", x402_url: null, created_at: o.created_at ?? "2026-10-17T17:00:00Z",
    paid: o.paid ?? null, flags: [], ...(o.matched !== undefined && { matched: o.matched }), ...(o.rest_request !== undefined && { rest_request: o.rest_request }),
  };
}
const getRoutes = (...bodies: Array<ReturnType<typeof rq>>): Record<string, Route> =>
  Object.fromEntries(bodies.map((b) => [`GET /api/v1/requests/${b.id}`, () => json(200, b)]));
const ATTRIBUTED_NONE: Route = () => json(200, { attributed: [], references: [] });
const QNAOS = "qNaosx73zzt3";
const ATTRIBUTED_QNAOS: Route = () => json(200, { attributed: [{ signature: TX.referenced, request_id: QNAOS, how: "reference" }], references: [] });

function deps(routes: Record<string, Route>, calls: Call[] = TEAM_CALLS, now = NOW) {
  const rpc = replay(calls);
  const made = makeDeps({ now: () => now, routes, rpc: () => rpc });
  return { ...made, rpc };
}
type Result = Awaited<ReturnType<typeof matchPayments>>;
function out(result: Result): MatchOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  return outputSchema.parse((result as { structuredContent: MatchOutput }).structuredContent);
}
function refused(result: Result): string {
  assert.equal((result as { isError?: boolean }).isError, true, `expected a refusal, got ${textOf(result)}`);
  return textOf(result);
}
const input = (o: Record<string, unknown>) => inputSchema.parse({ recipient: TEAM, ...o });

// ---------------------------------------------------------------------------------------------------- chain

test("incomingTransfers reads the recorded USDC history: incoming only, newest first, payer, memo and keys", async () => {
  const rpc = replay(TEAM_CALLS);
  const scan = await incomingTransfers(rpc, { recipient: TEAM, token: "USDC", sinceUnix: 0 });
  assert.equal(scan.account, TEAM_ATA);
  assert.equal(scan.complete, true);
  assert.equal(scan.read, 7);
  assert.equal(scan.unread, 0);
  // The outgoing x402 payment (signed by the team wallet) isn't a transfer in.
  assert.deepEqual(scan.transfers.map((t) => [t.signature.slice(0, 8), t.amountAtomic, t.payer, t.at]), [
    ["mBefU4x5", 10_000n, GSWH, "2026-10-17T18:37:27Z"],
    ["SRF8XFt4", 10_000n, GSWH, "2026-10-17T18:31:14Z"],
    ["3V3GyHym", 10_000n, GSWH, "2026-10-17T17:22:33Z"],
    ["5w8NvDDo", 10_000n, GSWH, "2026-10-17T17:14:15Z"],
    ["5LPHMNke", 1_000_000n, GSWH, "2026-10-17T15:32:04Z"],
    ["44rMqgCK", 5_000_000n, GSWH, "2026-10-17T04:46:13Z"],
  ]);
  assert.equal(scan.transfers[0]!.memo, "owed:qNaosx73zzt3");
  assert.ok(scan.transfers[0]!.keys.includes("31hpKQLhjpJjmKdpW2chHTW67szXVMFdytsDqoBvpdHq"), "the referenced payment names qNaosx73zzt3's reference");
  assert.equal(scan.transfers[3]!.memo, undefined);
});

test("incomingTransfers keeps to the window, skips known signatures, and reads nothing it doesn't need", async () => {
  const rpc = replay(TEAM_CALLS);
  const scan = await incomingTransfers(rpc, { recipient: TEAM, token: "USDC", sinceUnix: unix("2026-10-17T17:00:00Z"), skip: new Set([TX.referenced]) });
  assert.deepEqual(scan.transfers.map((t) => t.signature), [TX.c, TX.b, TX.a]);
  assert.equal(rpc.log.filter((l) => l.startsWith("getTransaction")).length, 4); // c, outgoing, b, a
  assert.equal(scan.complete, true);
});

test("readTransfer: what one transaction credited this wallet, or why it doesn't count", async () => {
  const rpc = replay(TEAM_CALLS);
  const ok = await readTransfer(rpc, { signature: TX.a, recipient: TEAM, token: "USDC" });
  assert.ok(ok.ok && ok.transfer.amountAtomic === 10_000n && ok.transfer.payer === GSWH);
  assert.deepEqual(await readTransfer(rpc, { signature: TX.outgoing, recipient: TEAM, token: "USDC" }), { ok: false, reason: "own" });
  assert.deepEqual(await readTransfer(rpc, { signature: TX.a, recipient: GSWH, token: "USDC" }), { ok: false, reason: "own" }); // GSWh signed it
  assert.deepEqual(await readTransfer(rpc, { signature: TX.a, recipient: TEAM, token: "SOL" }), { ok: false, reason: "no_credit" });
  const none = replay([{ method: "getTransaction", params: [TX.a.replace("5w", "6w"), { maxSupportedTransactionVersion: 1, commitment: "confirmed", encoding: "jsonParsed" }], result: null }]);
  assert.deepEqual(await readTransfer(none, { signature: TX.a.replace("5w", "6w"), recipient: TEAM, token: "USDC" }), { ok: false, reason: "not_found" });
});

// ---------------------------------------------------------------------------------------------------- find

test("find by link: the exact-amount transfers after the request, already-counted ones dropped, ambiguity said plainly", async () => {
  const { deps: d, rec } = deps({ ...getRoutes(rq("reqAAAAAAAAA")), "POST /api/v1/attributed": ATTRIBUTED_QNAOS });
  const result = await matchPayments(input({ requests: [`${API}/r/reqAAAAAAAAA`] }), d);
  const o = out(result);
  assert.equal(o.step, "candidates");
  assert.equal(o.requests_checked, 1);
  // mBef… already counts for qNaosx73zzt3: not offered. The three plain sends after 17:00 all fit.
  assert.deepEqual(o.candidates!.map((c) => c.transaction), [TX.a, TX.b, TX.c]);
  for (const c of o.candidates!) {
    assert.equal(c.confidence, "ambiguous");
    assert.equal(c.covers, "full");
    assert.equal(c.expected, "0.01");
    assert.equal(c.payer, GSWH);
    assert.match(c.reasons[0]!, /^Exactly 0\.01 USDC, the amount this request asks for\.$/);
    assert.match(c.reasons.join(" "), /no Solana Pay reference and no Owed memo/);
    assert.deepEqual(c.warnings, ["3 transfers fit this request; only one can pay it. Ask the user which one they recognise."]);
  }
  assert.match(o.candidates![0]!.reasons[1]!, /^Arrived 14 min after the request was made\.$/);
  assert.ok(o.notes!.some((n) => n === "Transfer mBef…f3i9 already counts for request qNaosx73zzt3; not offered."));
  assert.deepEqual(o.scanned, [{ token: "USDC", account: TEAM_ATA, since: "2026-10-17T16:59:00Z", transfers_read: 5, unread: 0, complete: true }]);
  // /attributed is asked about every candidate and its keys.
  const asked = rec.calls.find((c) => c.url.endsWith("/api/v1/attributed"))!.body as { signatures: string[]; keys: string[] };
  assert.deepEqual(new Set(asked.signatures), new Set([TX.a, TX.b, TX.c, TX.referenced]));
  assert.ok(asked.keys.includes("31hpKQLhjpJjmKdpW2chHTW67szXVMFdytsDqoBvpdHq"));
  const text = textOf(result);
  assert.match(text, /^3 possible payments that arrived without the request's reference, for 1 open request \(read 5 USDC incoming transactions\)\. None is counted until the user confirms it\./);
  assert.match(text, /\[ambiguous\] 0\.01 USDC at 2026-10-17T17:14:15Z from GSWh…8dcD → request reqAAAAAAAAA \(0\.01 USDC from "Priya" for "dinner"\)/);
  assert.match(text, /action confirm, link \(the request\), transaction and recipient/);
});

test("find: two open requests of the same amount — Owed can't tell which one a transfer pays, and says so", async () => {
  const { deps: d } = deps({ ...getRoutes(rq("reqAAAAAAAAA"), rq("reqBBBBBBBBB")), "POST /api/v1/attributed": ATTRIBUTED_QNAOS });
  const o = out(await matchPayments(input({ requests: ["reqAAAAAAAAA", "reqBBBBBBBBB"] }), d));
  assert.equal(o.candidates!.length, 6);
  const first = o.candidates!.find((c) => c.request_id === "reqAAAAAAAAA" && c.transaction === TX.a)!;
  assert.equal(first.confidence, "ambiguous");
  assert.ok(first.warnings.includes("It also fits request reqBBBBBBBBB (same amount), so Owed can't tell which one it pays. Ask the user before confirming."));
});

test("find: one transfer, one request, a payer seen before — high confidence, with every reason", async () => {
  const paidBefore = rq("reqPPPPPPPPP", { status: "paid", paid: { signature: TX.five, payer: GSWH, amount: "5", at: "2026-10-17T04:46:13Z", rail: "solana_pay" }, created_at: "2026-10-17T04:40:00Z", amount: "5" });
  const { deps: d } = deps({ ...getRoutes(rq("reqCCCCCCCCC", { amount: "1", created_at: "2026-10-17T15:30:00Z" }), paidBefore), "POST /api/v1/attributed": ATTRIBUTED_NONE });
  const result = await matchPayments(input({ requests: ["reqCCCCCCCCC", "reqPPPPPPPPP"] }), d);
  const o = out(result);
  assert.deepEqual(o.candidates!.map((c) => [c.transaction, c.confidence, c.score]), [[TX.one, "high", 75]]);
  assert.deepEqual(o.candidates![0]!.reasons, [
    "Exactly 1 USDC, the amount this request asks for.",
    "Arrived 2 min after the request was made.",
    "This wallet (GSWh…8dcD) has paid you through Owed before (request reqPPPPPPPPP).",
    "It carries no Solana Pay reference and no Owed memo, as exchange withdrawals and plain wallet sends often don't.",
  ]);
  assert.deepEqual(o.candidates![0]!.warnings, []);
  assert.ok(o.notes!.includes("Request reqPPPPPPPPP is already paid."));
  assert.match(textOf(result), /\[high\] 1 USDC at 2026-10-17T15:32:04Z/);
});

test("find: an underpaid request looks for exactly the rest, credits the partial payer, and offers ask_for_rest", async () => {
  const under = rq("reqUUUUUUUUU", { amount: "1.01", status: "underpaid", created_at: "2026-10-17T15:00:00Z",
    paid: { signature: TX.one, payer: GSWH, amount: "1", at: "2026-10-17T15:32:04Z", rail: "solana_pay" } });
  const { deps: d } = deps({ ...getRoutes(under), "POST /api/v1/attributed": ATTRIBUTED_QNAOS });
  const result = await matchPayments(input({ requests: ["reqUUUUUUUUU"] }), d);
  const o = out(result);
  assert.deepEqual(o.candidates!.map((c) => c.transaction), [TX.a, TX.b, TX.c]);
  for (const c of o.candidates!) {
    assert.equal(c.covers, "rest");
    assert.equal(c.expected, "0.01");
    assert.equal(c.reasons[0], "Exactly the 0.01 USDC still owed after the partial payment of 1 USDC.");
    assert.ok(c.reasons.includes("Sent by the same wallet that made the partial payment (GSWh…8dcD)."));
  }
  assert.deepEqual(o.underpaid, [{ request_id: "reqUUUUUUUUU", request_link: `${API}/r/reqUUUUUUUUU`, token: "USDC", amount: "1.01", amount_paid: "1", remaining: "0.01" }]);
  assert.match(textOf(result), /Underpaid: request reqUUUUUUUUU, 1 of 1\.01 USDC, 0\.01 USDC still owed\. To ask for exactly that, call match_payments with action ask_for_rest/);
});

test("find: a wallet that kept Owed's memo but dropped the reference is the strongest reason; a memo for another request warns", async () => {
  const { deps: d } = deps({ ...getRoutes(rq(QNAOS, { created_at: "2026-10-17T18:30:00Z" }), rq("reqAAAAAAAAA")), "POST /api/v1/attributed": ATTRIBUTED_NONE });
  const o = out(await matchPayments(input({ requests: [QNAOS, "reqAAAAAAAAA"] }), d));
  const memoHit = o.candidates!.find((c) => c.request_id === QNAOS && c.transaction === TX.referenced)!;
  assert.ok(memoHit.reasons.includes(`Its memo names this request (owed:${QNAOS}): the wallet kept Owed's memo but dropped the reference.`));
  assert.equal(memoHit.score, 40 + 20 + 50);
  const elsewhere = o.candidates!.find((c) => c.request_id === "reqAAAAAAAAA" && c.transaction === TX.referenced)!;
  assert.ok(elsewhere.warnings.includes(`Its memo names a different Owed request (owed:${QNAOS}), so it was probably meant for that one.`));
});

test("find: a transfer carrying a request's reference is never offered; nothing found says so; Base, foreign and paid links are skipped", async () => {
  const refs: Route = () => json(200, { attributed: [], references: [{ key: "31hpKQLhjpJjmKdpW2chHTW67szXVMFdytsDqoBvpdHq", request_id: QNAOS }] });
  const { deps: d } = deps({
    ...getRoutes(rq("reqAAAAAAAAA", { created_at: "2026-10-17T18:35:00Z" }), rq("reqXXXXXXXXX", { recipient: GSWH }), { ...rq("reqZZZZZZZZZ"), chain: "base" } as never),
    "POST /api/v1/attributed": refs,
  });
  const result = await matchPayments(input({ requests: ["reqAAAAAAAAA", "reqXXXXXXXXX", "reqZZZZZZZZZ", "https://example.com/nope"] }), d);
  const o = out(result);
  assert.deepEqual(o.candidates, []);
  assert.ok(o.notes!.includes("Transfer mBef…f3i9 carries request qNaosx73zzt3's reference, so it pays that one; not offered."));
  assert.ok(o.notes!.includes("Request reqXXXXXXXXX pays GSWh…8dcD, not this wallet; skipped."));
  assert.ok(o.notes!.includes("Request reqZZZZZZZZZ is on Base, where payments are found by amount already; nothing to match."));
  assert.ok(o.notes!.some((n) => n.startsWith("Skipped https://example.com/nope:")));
  assert.match(textOf(result), /^No uncounted payment of the right amount found for 1 open request \(read 1 USDC incoming transactions\)\./);
});

test("find without links: the ledger's signed message first, then every open request, skipping what is already paid", async () => {
  const { deps: d0 } = deps({}, ME_CALLS);
  const signStep = out(await matchPayments(input({ recipient: ME.address }), d0));
  assert.equal(signStep.step, "sign");
  assert.equal(signStep.message_to_sign, ledgerMessage(ME.address, NOW));
  assert.equal(signStep.sign_by, "2026-10-17T19:05:00Z");

  const entry = (id: string, o: Record<string, unknown>) => ({
    id, kind: "single", link: `https://www.getowed.xyz/r/${id}`, token: "USDC", payer_name: "Sam", for: "taxi", group_id: null, from_domain: null, flags: [], ...o,
  });
  const ledger = {
    recipient: ME.address, caution: "Anyone can create a request that pays your wallet; Owed can't tell which ones you made. Check names and amounts before chasing anyone.",
    generated_at: "2026-10-17T19:00:00Z", chain_checked: true, truncated: false,
    open: [entry("reqLLLLLLLLL", { amount: "1", status: "open", created_at: "2026-10-17T15:00:00Z", amount_due: "1" })],
    paid_recently: [entry("reqPPPPPPPPP", { amount: "5", status: "paid", created_at: "2026-10-17T04:40:00Z", amount_paid: "5", payer: GSWH, signature: TX.five, paid_at: "2026-10-17T04:46:13Z" })],
    totals: [{ token: "USDC", outstanding: "1", received_30d: "5", open_count: 1, paid_count: 1 }],
  };
  const message = ledgerMessage(ME.address, NOW);
  const { deps: d, rec } = deps({ "POST /api/v1/ledger": () => json(200, ledger), "POST /api/v1/attributed": ATTRIBUTED_NONE }, ME_CALLS);
  const o = out(await matchPayments(input({ recipient: ME.address, signed_message: message, signature: ME.sign(message) }), d));
  assert.deepEqual(rec.calls.find((c) => c.url.endsWith("/api/v1/ledger"))!.body, { recipient: ME.address, signed_message: message, signature: ME.sign(message) });
  assert.deepEqual(o.candidates!.map((c) => [c.request_id, c.transaction, c.confidence]), [["reqLLLLLLLLL", TX.one, "high"]]);
  assert.ok(o.candidates![0]!.reasons.some((r) => r.includes("has paid you through Owed before (request reqPPPPPPPPP)")));

  const bad = await matchPayments(input({ recipient: ME.address, signed_message: message, signature: MALLORY.sign(message) }), d);
  assert.match(refused(bad), /isn't from wallet/);
});

test("find: Solana down is reported, not shown as 'nothing found'", async () => {
  const down: Rpc = { call: async () => { throw new Error("unreachable"); } };
  const d = makeDeps({ now: () => NOW, routes: getRoutes(rq("reqAAAAAAAAA")), rpc: () => down }).deps;
  const o = out(await matchPayments(input({ requests: ["reqAAAAAAAAA"] }), d));
  assert.deepEqual(o.candidates, []);
  assert.ok(o.notes!.some((n) => /^USDC transfers couldn't be read \(unreachable\); try again shortly\.$/.test(n)));
});

// ---------------------------------------------------------------------------------------------------- confirm

test("confirm, first call: checks the transaction on chain, then hands back the exact message to sign", async () => {
  const { deps: d } = deps(getRoutes(rq("reqAAAAAAAAA")));
  const result = await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.a }), d);
  const o = out(result);
  assert.equal(o.step, "sign");
  assert.equal(o.message_to_sign, `Owed match ${TX.a} to reqAAAAAAAAA for ${TEAM} at 2026-10-17T19:00:00Z`);
  assert.equal(o.message_to_sign, matchMessage(TX.a, "reqAAAAAAAAA", TEAM, NOW));
  assert.ok(o.message_to_sign!.length <= 200);
  assert.deepEqual([o.amount, o.token, o.covers, o.sign_by], ["0.01", "USDC", "full", "2026-10-17T19:05:00Z"]);
  const text = textOf(result);
  assert.match(text, /^Checked on chain: 0\.01 USDC from GSWh…8dcD at 2026-10-17T17:14:15Z, exactly what request reqAAAAAAAAA still needs\./);
  assert.ok(text.includes(`{"op":"solanaMessage","address":"${TEAM}","message":"${o.message_to_sign}"}`));
  assert.match(text, /moves no money/);
});

test("confirm, first call refuses before anything is signed: wrong amount, too early, own transfer, paid, someone else's request", async () => {
  const { deps: d1 } = deps(getRoutes(rq("reqAAAAAAAAA", { amount: "0.02" })));
  assert.equal(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.a }), d1)),
    "That transaction credits 0.01 USDC, but request reqAAAAAAAAA needs exactly 0.02 USDC. Only an exact match can be confirmed.");
  const { deps: d2 } = deps(getRoutes(rq("reqAAAAAAAAA", { created_at: "2026-10-17T18:00:00Z" })));
  assert.match(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.a }), d2)), /landed at 2026-10-17T17:14:15Z, before request reqAAAAAAAAA was made/);
  const { deps: d3 } = deps(getRoutes(rq("reqAAAAAAAAA")));
  assert.match(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.outgoing }), d3)), /was signed by this wallet itself/);
  const { deps: d4 } = deps(getRoutes(rq("reqAAAAAAAAA", { status: "paid", paid: { signature: TX.b, payer: GSWH, amount: "0.01", at: "2026-10-17T17:22:33Z", rail: "solana_pay" } })));
  assert.match(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.a }), d4)), /already paid, so nothing can be matched/);
  const { deps: d5 } = deps(getRoutes(rq("reqAAAAAAAAA", { recipient: GSWH })));
  assert.match(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA", transaction: TX.a }), d5)), /^This request pays GSWh…8dcD, not this wallet/);
  const { deps: d6 } = deps({});
  assert.match(refused(await matchPayments(input({ action: "confirm", link: "reqAAAAAAAAA" }), d6)), /confirm needs link/);
});

test("confirm, second call: the signed message goes to POST /requests/:id/match once and the request comes back matched", async () => {
  const res = fixture("match.res.json");
  const req = fixture("match.req.json");
  const now = Date.parse("2026-10-17T15:03:00Z");
  const { deps: d, rec } = deps({ [`POST /api/v1/requests/${res.id}/match`]: () => json(200, res) }, ME_CALLS, now);
  const result = await matchPayments(inputSchema.parse({
    recipient: ME.address, action: "confirm", link: `https://www.getowed.xyz/r/${res.id}`, transaction: req.transaction,
    signed_message: req.signed_message, signature: req.signature,
  }), d);
  const o = out(result);
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url}`), [`POST ${API}/api/v1/requests/${res.id}/match`]);
  assert.deepEqual(rec.calls[0]!.body, req);
  assert.deepEqual([o.step, o.status, o.amount, o.covers, o.label, o.already_matched], ["matched", "paid", "15", "full", MATCHED_LABEL, false]);
  assert.match(textOf(result), /^Matched: 15 USDC \(https:\/\/solscan\.io\/tx\/.+\) now counts for request .+\. The request is paid\./);
  assert.match(textOf(result), /"matched by the recipient \(no reference on the payment\)"/);
});

test("confirm, second call: checked locally first — someone else's signature or a stale message never reaches Owed", async () => {
  const req = fixture("match.req.json");
  const res = fixture("match.res.json");
  const now = Date.parse("2026-10-17T15:03:00Z");
  const { deps: d, rec } = deps({}, ME_CALLS, now);
  const base = { recipient: ME.address, action: "confirm", link: res.id, transaction: req.transaction, signed_message: req.signed_message };
  assert.match(refused(await matchPayments(inputSchema.parse({ ...base, signature: MALLORY.sign(req.signed_message) }), d)), /isn't from wallet/);
  const { deps: late } = deps({}, ME_CALLS, now + 10 * 60_000);
  assert.match(refused(await matchPayments(inputSchema.parse({ ...base, signature: req.signature }), late)), /more than 5 minutes old/);
  assert.match(refused(await matchPayments(inputSchema.parse({ ...base, transaction: TX.a, signature: req.signature }), d)), /must be exactly the message_to_sign/);
  assert.equal(rec.calls.length, 0);
  const { deps: d2 } = deps({ [`POST /api/v1/requests/${res.id}/match`]: () => json(400, { error: { code: "invalid_input", message: "that transaction already settles Owed request X" } }) }, ME_CALLS, now);
  assert.equal(refused(await matchPayments(inputSchema.parse({ ...base, signature: req.signature }), d2)),
    "Owed refused the match: that transaction already settles Owed request X. Nothing was recorded.");
});

// ---------------------------------------------------------------------------------------------------- ask_for_rest

test("ask_for_rest: the linked request for exactly the remainder, its id checked against its terms", async () => {
  const res = fixture("rest.res.json");
  const { deps: d, rec } = deps({ [`POST /api/v1/requests/${res.rest_of}/rest`]: () => json(201, res) });
  const result = await matchPayments(inputSchema.parse({ recipient: ME.address, action: "ask_for_rest", link: res.rest_of }), d);
  const o = out(result);
  assert.deepEqual(rec.calls[0]!.body, { source: "plugin" });
  assert.deepEqual([o.step, o.rest_id, o.rest_link, o.rest_of, o.amount, o.already_asked], ["rest_asked", res.id, res.link, res.rest_of, "7.5", false]);
  assert.match(textOf(result), /^Asked for the rest: a new request for exactly 7\.5 USDC/);

  const { deps: tampered } = deps({ [`POST /api/v1/requests/${res.rest_of}/rest`]: () => json(201, { ...res, amount: "75" }) });
  assert.match(refused(await matchPayments(inputSchema.parse({ recipient: ME.address, action: "ask_for_rest", link: res.rest_of }), tampered)), /doesn't pay this wallet the stated amount/);
  const { deps: other } = deps({ [`POST /api/v1/requests/${res.rest_of}/rest`]: () => json(201, res) });
  assert.match(refused(await matchPayments(inputSchema.parse({ recipient: TEAM, action: "ask_for_rest", link: res.rest_of }), other)), /doesn't pay this wallet/);
  const { deps: open } = deps({ [`POST /api/v1/requests/${res.rest_of}/rest`]: () => json(400, { error: { code: "invalid_input", message: "only an underpaid request has a rest to ask for, and this one is open" } }) });
  assert.match(refused(await matchPayments(inputSchema.parse({ recipient: ME.address, action: "ask_for_rest", link: res.rest_of }), open)), /only an underpaid request/);
});

// ---------------------------------------------------------------------------------------------------- labels elsewhere

test("check_payments labels a matched payment and points an underpaid request at its rest", async () => {
  const status = fixture("status.matched.res.json");
  const ids = status.results.map((r: { id: string }) => r.id);
  const d = makeDeps({ now: () => NOW, routes: { "POST /api/v1/status": () => json(200, status) } }).deps;
  const result = await checkPayments({ requests: ids }, d);
  const r = (result as { structuredContent: { results: Array<Record<string, unknown>> } }).structuredContent.results;
  assert.equal(r[0]!.matched, MATCHED_LABEL);
  assert.equal(r[1]!.rest_request, ids[2]);
  assert.equal(r[2]!.rest_of, ids[1]);
  const text = textOf(result);
  assert.ok(text.includes(`Paid, request ${ids[0]}: 15 USDC from `) && text.includes(`, ${MATCHED_LABEL}: https://solscan.io/tx/`));
  assert.ok(text.includes(`The rest is asked in request ${ids[2]}.`));
});

test("who_owes_me labels a matched payment and the rest it asks for", async () => {
  const message = ledgerMessage(ME.address, NOW);
  const ledger = {
    recipient: ME.address, caution: "Anyone can create a request that pays your wallet; Owed can't tell which ones you made. Check names and amounts before chasing anyone.",
    generated_at: "2026-10-17T19:00:00Z", chain_checked: true, truncated: false,
    open: [{ id: "reqRRRRRRRRR", kind: "single", link: "https://www.getowed.xyz/r/reqRRRRRRRRR", amount: "0.25", token: "USDC", status: "open", payer_name: null, for: null,
      created_at: "2026-10-17T18:00:00Z", amount_due: "0.25", group_id: null, from_domain: null, flags: [], rest_of: "reqUUUUUUUUU" }],
    paid_recently: [{ id: "reqMMMMMMMMM", kind: "single", link: "https://www.getowed.xyz/r/reqMMMMMMMMM", amount: "0.01", token: "USDC", status: "paid", payer_name: null, for: null,
      created_at: "2026-10-17T17:00:00Z", amount_paid: "0.01", payer: GSWH, signature: TX.a, paid_at: "2026-10-17T17:14:15Z", group_id: null, from_domain: null, flags: [],
      rail: "matched", matched: { signature: TX.a, covers: "full", amount: "0.01", confirmed_at: "2026-10-17T18:50:00Z" } }],
    totals: [{ token: "USDC", outstanding: "0.25", received_30d: "0.01", open_count: 1, paid_count: 1 }],
  };
  const d = makeDeps({ now: () => NOW, routes: { "POST /api/v1/ledger": () => json(200, ledger) } }).deps;
  const result = await whoOwesMe(whoInput.parse({ recipient: ME.address, signed_message: message, signature: ME.sign(message) }), d);
  const text = textOf(result);
  assert.ok(text.includes(`Paid: 0.01 USDC by GSWh…8dcD, ${MATCHED_LABEL}: https://solscan.io/tx/${TX.a}`), text);
  assert.ok(text.includes("Owed: 0.25 USDC (the rest of request reqUUUUUUUUU)"), text);
  assert.ok(text.includes("match_payments looks for a payment that arrived without the request's reference"));
});
