import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { payerReadiness, type Rpc } from "../src/chain.ts";
import { fundingPlanFromText } from "../src/funding.ts";
import { solanaOutputSchema, x402OutputSchema } from "../src/paybox.ts";
import { potIdFor } from "../src/request-id.ts";
import { screenRecipient } from "../src/screen.ts";
import { LinkError, parseLink } from "../src/solana-pay.ts";
import { checkPayments, inputSchema as checkInput, outputSchema as checkOutput } from "../src/tools/check_payments.ts";
import { inputSchema as payInput, outputSchema as payOutput, payLink } from "../src/tools/pay_link.ts";
import { payAll, inputSchema as payAllInput } from "../src/tools/pay_all.ts";
import { inputSchema as potInput, outputSchema as potOutput, startPot } from "../src/tools/start_pot.ts";
import { inputSchema as whoInput, outputSchema as whoOutput, whoOwesMe } from "../src/tools/who_owes_me.ts";
import { cancelRequest, inputSchema as cancelInput } from "../src/tools/cancel_request.ts";
import { writeReminder, inputSchema as reminderInput } from "../src/tools/write_reminder.ts";
import { verifyPayeeTool, inputSchema as verifyInput } from "../src/tools/verify_payee.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT, type Call, type Route } from "./helpers.ts";

// F7 chip-in pots in the plugin: parseLink's pot kind, start_pot (the pot id must commit to the wallet and token),
// pay_link on a pot (amount rules, ended or tampered pots, the funding plan minting nothing, the contribution minted
// right before the proposal and checked like any request, x402), check_payments and who_owes_me on pots, and the
// tools that refuse a pot. Owed's server is answered from the contract fixtures (contract/pot-fixtures.mjs).

const KEY = "io.paybox/transactionProposal";
const created = fixture("pots.create.res.json");
const board = fixture("pots.get.res.json");
const contribution = fixture("pots.contribution.res.json");
const POT = board.id as string;
const HOSTS = ["owed-omega.vercel.app", "www.getowed.xyz"];
const NOW = Date.parse("2026-10-18T09:30:00Z"); // after the fixture pot was made, before its deadline
const BOARD = `https://www.getowed.xyz/pot/${POT}`;
const QR10 = board.links.transaction_request[0].url as string;

type Result = Awaited<ReturnType<typeof payLink>>;
const refused = (r: { isError?: boolean; content: Array<{ type: string; text?: string }> }) => {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
};
const ok = (r: { isError?: boolean; content: Array<{ type: string; text?: string }> }) => {
  assert.ok(!r.isError, textOf(r));
  return r as { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> };
};

// ---------------------------------------------------------------------------------------------- parseLink

test("parseLink: a pot's board link, its bare id and Owed's own pot QR code (encoded or not) are pots", () => {
  assert.deepEqual(parseLink(POT, HOSTS), { kind: "pot", id: POT });
  assert.deepEqual(parseLink(BOARD, HOSTS), { kind: "pot", id: POT });
  assert.deepEqual(parseLink(`${BOARD}/`, HOSTS), { kind: "pot", id: POT });
  assert.deepEqual(parseLink(`owed-omega.vercel.app/pot/${POT}`, HOSTS), { kind: "pot", id: POT });
  assert.deepEqual(parseLink(QR10, HOSTS), { kind: "pot", id: POT, amount: "10" });
  assert.deepEqual(parseLink(`solana:https://www.getowed.xyz/api/v1/pay/${POT}?amount=2.5`, HOSTS), { kind: "pot", id: POT, amount: "2.5" });
  assert.deepEqual(parseLink(`solana:https://www.getowed.xyz/api/v1/pay/${POT}`, HOSTS), { kind: "pot", id: POT });
});

test("parseLink: every other transaction request stays one (Owed's request QR codes and other hosts' pot-looking paths)", () => {
  assert.equal(parseLink("solana:https://www.getowed.xyz/api/v1/pay/JArQ6g9JvoWr", HOSTS).kind, "transaction");
  assert.equal(parseLink(`solana:https://evil.example/api/v1/pay/${POT}?amount=10`, HOSTS).kind, "transaction");
  assert.equal(parseLink(`solana:${encodeURIComponent(`https://evil.example/api/v1/pay/${POT}?amount=10`)}`, HOSTS).kind, "transaction");
  assert.equal(parseLink("solana:https://shop.example/checkout?order=1", HOSTS).kind, "transaction");
});

test("parseLink: malformed pot links are refused, never guessed", () => {
  for (const bad of [
    `https://www.getowed.xyz/pot/${POT.slice(0, 13)}`, `https://www.getowed.xyz/pot/${POT}x`, "https://www.getowed.xyz/pot/",
    `solana:https://www.getowed.xyz/api/v1/pay/${POT}?amount=10&amount=20`, `solana:https://www.getowed.xyz/api/v1/pay/${POT}?amount=1e3`,
    `solana:https://www.getowed.xyz/api/v1/pay/${POT}?amount=10&label=x`,
  ]) assert.throws(() => parseLink(bad, HOSTS), LinkError, bad);
  assert.throws(() => parseLink(POT.slice(0, 13), HOSTS), LinkError); // 13 base58 chars is neither an id nor a pot
  assert.throws(() => parseLink(`${POT}x`, HOSTS), LinkError); // nor are 15
});

// ---------------------------------------------------------------------------------------------- start_pot

const startArgs = (extra: Record<string, unknown> = {}) => potInput.parse({
  recipient: RECIPIENT, title: "Farewell gift for Ana", target: "100", suggested_amount: "10", x402_presets: ["5", "10", "20"],
  note: "Card and flowers from the team", requester_name: "Raj", requester_handle: "@RajKaria", deadline_days: 30, ...extra,
});
function startDeps(reply: Route = () => json(201, created), now = Date.parse(created.created_at)) {
  return makeDeps({ routes: { "POST /api/v1/pots": reply }, now: () => now });
}

test("start_pot: posts exactly the pot, checks its id commits to the wallet and token, and returns the board, QR codes and presets", async () => {
  const { deps, rec } = startDeps();
  const r = ok(await startPot(startArgs(), deps));
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url}`), ["POST https://owed-omega.vercel.app/api/v1/pots"]);
  assert.deepEqual(rec.calls[0]!.body, fixture("pots.create.req.json"));
  const out = potOutput.parse(r.structuredContent);
  assert.deepEqual(out, r.structuredContent);
  assert.equal(out.pot_id, POT);
  assert.equal(out.link, BOARD);
  assert.deepEqual(out.qr_links.map((l) => l.amount), ["10", "5", "20"]);
  assert.deepEqual(out.x402_presets.map((l) => l.url), ["5", "10", "20"].map((a) => `https://www.getowed.xyz/x/pot/${POT}/${a}`));
  const text = textOf(r);
  assert.match(text, new RegExp(`Pot ready: the pot "Farewell gift for Ana" \\(the requester's words, unverified\\), collecting USDC into FN6G…cbvs, target 100 USDC\\. Board: ${BOARD}`));
  assert.match(text, /until 2026-11-17T09:00:00Z; suggested 10 USDC, any amount welcome/);
  assert.match(text, /Note shown on the board: "Card and flowers from the team"/);
  assert.match(text, /Contributors see "@rajkaria" as your handle, marked not verified by Owed/);
  assert.match(text, new RegExp(`Pot id ${POT}: it is the hash of this wallet, the token and nonce ${created.nonce}`));
});

test("start_pot: refuses a pot whose id doesn't commit to this wallet and token, or that holds something else", async () => {
  const otherNonce = bs58.encode(createHash("sha256").update("another nonce").digest());
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["tampered nonce", { nonce: otherNonce }, /doesn't match the wallet and token/],
    ["another wallet, re-hashed", { recipient: SENDER, id: potIdFor({ recipient: SENDER, token: "USDC", nonce: created.nonce }) }, /different wallet or token|different pot/],
    ["another amount", { suggested: "11" }, /different amounts/],
    ["fixed amounts only", { any_amount: false }, /different amounts/],
    ["a board on another host", { link: `https://evil.example/pot/${POT}` }, /don't point at this pot/],
    ["a QR code for another pot", { links: { ...created.links, transaction_request: [{ amount: "10", url: `solana:${encodeURIComponent(`https://www.getowed.xyz/api/v1/pay/11111111111111?amount=10`)}` }, ...created.links.transaction_request.slice(1)] } }, /don't point at this pot/],
    ["a later deadline", { deadline: "2026-12-30T09:00:00Z" }, /different deadline/],
  ];
  for (const [label, patch, why] of cases) {
    const { deps } = startDeps(() => json(201, { ...created, ...patch }));
    assert.match(refused(await startPot(startArgs(), deps)), why, label);
  }
});

test("start_pot: local refusals send nothing", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ token: "SOL" }, /x402 presets are USDC only/],
    [{ x402_presets: ["5", "5.0"] }, /different amount/],
    [{ any_amount: false, suggested_amount: undefined, x402_presets: undefined }, /needs suggested_amount or x402_presets/],
    [{ deadline: "2026-10-18T09:05:00Z", deadline_days: undefined }, /at least 10 minutes/],
    [{ deadline: "2027-03-01T00:00:00Z", deadline_days: undefined }, /at most 90 days/],
    [{ deadline: "soon", deadline_days: undefined }, /ISO time/],
    [{ deadline: "2026-11-01T00:00:00Z" }, /not both/],
    [{ target: "0" }, /target isn't a valid USDC amount/],
    [{ title: "https://only.example" }, /readable text/],
  ];
  for (const [patch, why] of cases) {
    const { deps, rec } = startDeps();
    const args = startArgs(patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete (args as Record<string, unknown>)[k];
    assert.match(refused(await startPot(args, deps)), why, JSON.stringify(patch));
    assert.equal(rec.calls.length, 0);
  }
  const listed = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"; // on the OFAC SDN list
  const { deps, rec } = makeDeps({ screenRecipient });
  assert.match(refused(await startPot(startArgs({ recipient: listed }), deps)), /OFAC sanctions list/);
  assert.equal(rec.calls.length, 0);
});

test("start_pot: the server's refusals are relayed (rate limited, invalid, no pots on this server)", async () => {
  const limited = startDeps(() => json(429, { error: { code: "rate_limited", message: "too many new pots for this recipient in the last hour, try again later" } }));
  assert.match(refused(await startPot(startArgs(), limited.deps)), /Owed is limiting new requests: too many new pots/);
  const bad = startDeps(() => json(400, { error: { code: "invalid_input", message: "deadline: can be at most 90 days from now" } }));
  assert.match(refused(await startPot(startArgs(), bad.deps)), /Owed refused the pot: deadline/);
  const old = startDeps(() => new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }));
  assert.match(refused(await startPot(startArgs(), old.deps)), /doesn't have chip-in pots yet/);
});

test("start_pot: a brand word in the requester's text adds the caution", async () => {
  const { deps } = startDeps(() => json(201, { ...created, title: "PayBox refund pool", flags: ["brand_word:paybox", "brand_word:refund"] }));
  const r = ok(await startPot(startArgs({ title: "PayBox refund pool" }), deps));
  assert.match(textOf(r).split("\n")[0]!, /^Caution: this request mentions "PayBox" and "refund"/);
  assert.ok((r.structuredContent as { caution?: string }).caution);
});

// ---------------------------------------------------------------------------------------------- pay_link on a pot

const potRoutes = (pot: unknown = board, mint: Route = () => json(201, contribution), extra: Record<string, Route> = {}): Record<string, Route> => ({
  [`GET /api/v1/pots/${POT}`]: () => json(200, pot),
  [`POST /api/v1/pots/${POT}/contributions`]: mint,
  ...extra,
});
const payArgs = (extra: Record<string, unknown> = {}) => payInput.parse({ link: BOARD, sender: SENDER, ...extra });
const mints = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/contributions"));

function decode(r: Result) {
  const sc = (ok(r).structuredContent);
  assert.deepEqual(payOutput.parse(sc), sc);
  const tx = Transaction.from(Buffer.from(solanaOutputSchema.parse(sc)[KEY].transaction.transactionBase64, "base64"));
  const transfer = tx.instructions.find((ix) => ix.programId.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")!;
  const memo = tx.instructions.find((ix) => ix.programId.toBase58().startsWith("Memo"));
  return {
    feePayer: tx.feePayer!.toBase58(),
    amount: Buffer.from(transfer.data.subarray(1, 9)).readBigUInt64LE(0),
    destination: transfer.keys[2]!.pubkey.toBase58(),
    references: transfer.keys.slice(4).map((k) => k.pubkey.toBase58()),
    memo: memo ? Buffer.from(memo.data).toString("utf8") : null,
  };
}

test("pay_link on a pot: checks the pot, mints one contribution right before proposing, and pays exactly it", async () => {
  const { deps, rec } = makeDeps({ routes: potRoutes(), now: () => NOW });
  const r = await payLink(payArgs({ amount: "10" }), deps);
  const d = decode(r);
  assert.deepEqual(d, {
    feePayer: SENDER, amount: 10_000_000n, destination: getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(RECIPIENT), true).toBase58(),
    references: [contribution.reference], memo: `owed:${contribution.id}`,
  });
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url.replace("https://owed-omega.vercel.app", "")}`), [`GET /api/v1/pots/${POT}`, `POST /api/v1/pots/${POT}/contributions`]);
  assert.deepEqual(mints(rec.calls)[0]!.body, { amount: "10", source: "plugin" });
  assert.deepEqual(rec.readiness, [{ sender: SENDER, recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000_000n }]);
  const text = textOf(r);
  assert.match(text, /^Pay 10 USDC to FN6G…cbvs\. A contribution to the pot "Farewell gift for Ana" \(the requester's words, unverified\), which takes contributions until 2026-11-17T09:00:00Z\./);
  assert.match(text, /Requester's note, unverified: "Card and flowers from the team"/);
  assert.match(text, /resolve_username/); // the pot's requester_handle gets the handle check
});

test("pay_link on a pot: the amount (suggested by default; a QR code's own amount; fixed amounts only)", async () => {
  const noAmount = makeDeps({ routes: potRoutes(), now: () => NOW });
  assert.equal(decode(await payLink(payArgs(), noAmount.deps)).amount, 10_000_000n); // the suggested amount
  const qr = makeDeps({ routes: potRoutes(), now: () => NOW });
  assert.equal(decode(await payLink(payArgs({ link: QR10 }), qr.deps)).amount, 10_000_000n);
  const clash = makeDeps({ routes: potRoutes(), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ link: QR10, amount: "5" }), clash.deps)), /This pot link asks for 10 USDC; it can't be changed/);
  assert.equal(mints(clash.rec.calls).length, 0);
  const bare = makeDeps({ routes: potRoutes({ ...board, suggested: null, links: { ...board.links, transaction_request: board.links.transaction_request.slice(1) } }), now: () => NOW });
  assert.match(refused(await payLink(payArgs(), bare.deps)), /How much USDC should go to the pot "Farewell gift for Ana".*pass it as amount/);
  assert.equal(mints(bare.rec.calls).length, 0);
  const fixed = makeDeps({ routes: potRoutes({ ...board, any_amount: false }), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "7" }), fixed.deps)), /This pot takes 10 USDC, 5 USDC, 20 USDC only, not 7 USDC/);
  assert.equal(mints(fixed.rec.calls).length, 0);
  const max = makeDeps({ routes: potRoutes(), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "25", max_amount: "20" }), max.deps)), /above your limit of 20 USDC/);
  assert.equal(mints(max.rec.calls).length, 0);
});

test("pay_link on a pot: an ended pot (server's word or the plugin's own clock) and a tampered pot id are refused before any mint", async () => {
  const ended = makeDeps({ routes: potRoutes({ ...board, status: "ended", links: { ...board.links, transaction_request: [], x402: [] } }), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), ended.deps)), /This pot ended at 2026-11-17T09:00:00Z and no longer takes contributions/);
  const late = makeDeps({ routes: potRoutes(), now: () => Date.parse("2026-11-17T09:00:01Z") });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), late.deps)), /This pot ended/);
  const nonce = bs58.encode(createHash("sha256").update("swapped").digest());
  const tampered = makeDeps({ routes: potRoutes({ ...board, nonce }), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), tampered.deps)), /doesn't match the wallet and token it pays/);
  const swapped = makeDeps({ routes: potRoutes({ ...board, recipient: SENDER }), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), swapped.deps)), /doesn't match the wallet and token it pays/);
  const unknown = makeDeps({ routes: { [`GET /api/v1/pots/${POT}`]: () => json(404, { error: { code: "not_found", message: "no pot with this id" } }) }, now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), unknown.deps)), /No Owed pot has the id/);
  for (const d of [ended, late, tampered, swapped, unknown]) assert.equal(mints(d.rec.calls).length, 0);
  for (const d of [ended, late, tampered, swapped]) assert.equal(d.rec.readiness.length, 0);
});

test("pay_link on a pot: a sanctioned recipient is refused before anything is minted", async () => {
  const listed = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi";
  const nonce = board.nonce as string;
  const pot = { ...board, recipient: listed, id: potIdFor({ recipient: listed, token: "USDC", nonce }) };
  const { deps, rec } = makeDeps({ routes: { [`GET /api/v1/pots/${pot.id}`]: () => json(200, pot) }, now: () => NOW, screenRecipient });
  assert.match(refused(await payLink(payArgs({ link: pot.id, amount: "10" }), deps)), /OFAC sanctions list/);
  assert.equal(mints(rec.calls).length, 0);
});

test("pay_link on a pot: a contribution that doesn't match the pot, the amount or its own id is never paid", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["another pot", { pot: { ...contribution.pot, id: "11111111111111" } }, /doesn't match this pot or amount/],
    ["another amount", { amount: "11", solana_pay_url: contribution.solana_pay_url.replace("amount=10&", "amount=11&"), pay_url: contribution.pay_url.replace("amount=10&", "amount=11&") }, /don't match its id|doesn't match this pot or amount/],
    ["an id that doesn't hash its terms", { reference: bs58.encode(createHash("sha256").update("other ref").digest()) }, /doesn't match|don't match/],
    ["already expired", { status: "expired" }, /expired/],
  ];
  for (const [label, patch, why] of cases) {
    const { deps, rec } = makeDeps({ routes: potRoutes(board, () => json(201, { ...contribution, ...patch })), now: () => NOW });
    const r = await payLink(payArgs({ amount: "10" }), deps);
    assert.match(refused(r), why, label);
    assert.equal(rec.built.length, 0, label);
  }
  const limited = makeDeps({ routes: potRoutes(board, () => json(429, { error: { code: "rate_limited", message: "this pot is taking too many new contributions right now" } })), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), limited.deps)), /limiting new contributions to this pot/);
  const ended = makeDeps({ routes: potRoutes(board, () => json(400, { error: { code: "invalid_input", message: "This pot ended at 2026-11-17T09:00:00Z and no longer takes contributions. Nothing was charged." } })), now: () => NOW });
  assert.match(refused(await payLink(payArgs({ amount: "10" }), ended.deps)), /Owed refused the contribution: This pot ended/);
});

// Recorded mainnet accounts: a wallet with 5.2 SOL and no USDC paying the team wallet (as in pay_link_f2.test.ts).
interface RpcCall { method: string; params: unknown[]; result: unknown }
const recorded = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RpcCall[] };
const replay = (calls: RpcCall[]): Rpc => ({
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    if (!hit) throw new Error(`unrecorded call ${method}`);
    return structuredClone(hit.result) as T;
  },
});
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";

test("pay_link on a pot, wallet short: the funding plan mints nothing, and its last step pays the same pot link and amount", async () => {
  const { deps, rec } = makeDeps({
    routes: potRoutes(board, () => json(201, contribution), { "POST /api/v1/plans": () => json(201, fixture("plans.create.res.json")) }),
    now: () => NOW, rpc: () => replay(recorded("readiness-usdc-sol-only-sender").calls), payerReadiness,
  });
  const r = await payLink(payArgs({ sender: SOL_PAYER, amount: "10" }), deps);
  const text = refused(r);
  const plan = fundingPlanFromText(text)!;
  assert.ok(plan, text);
  assert.deepEqual(plan.request_ids, []);
  const last = plan.options[0]!.then.at(-1)!;
  assert.deepEqual([last.tool, last.args], ["pay_link", { link: BOARD, sender: SOL_PAYER, amount: "10", plan_id: plan.plan_id }]);
  assert.equal(mints(rec.calls).length, 0, "no contribution while the wallet is short");
  assert.match(text, /A contribution to the pot "Farewell gift for Ana"/);
});

test("pay_link on a pot over x402: mints the contribution, checks its own /x/<id> challenge, proposes it", async () => {
  const AMOUNT = "10000000";
  const challenge = () => new Response(JSON.stringify({
    x402Version: 1, accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: AMOUNT, asset: USDC_MINT, payTo: RECIPIENT, resource: "x", description: "x", mimeType: "application/json", maxTimeoutSeconds: 300, extra: {} }],
  }), { status: 402, headers: { "content-type": "application/json" } });
  const { deps, rec } = makeDeps({ routes: potRoutes(board, () => json(201, contribution), { [`GET /x/${contribution.id}`]: challenge }), now: () => NOW });
  const r = ok(await payLink(payArgs({ amount: "10", rail: "x402" }), deps));
  const p = x402OutputSchema.parse(r.structuredContent)[KEY];
  assert.deepEqual(p.request, { url: `https://owed-omega.vercel.app/x/${contribution.id}`, method: "GET" });
  assert.deepEqual(p.payment, { asset: USDC_MINT, maxAmount: AMOUNT });
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url.replace("https://owed-omega.vercel.app", "")}`), [`GET /api/v1/pots/${POT}`, `POST /api/v1/pots/${POT}/contributions`, `GET /x/${contribution.id}`]);
  // A SOL pot can't be paid over x402.
  const nonce = board.nonce as string;
  const sol = { ...board, token: "SOL", presets: [], id: potIdFor({ recipient: RECIPIENT, token: "SOL", nonce }), links: { ...board.links, x402: [] } };
  const solDeps = makeDeps({ routes: { [`GET /api/v1/pots/${sol.id}`]: () => json(200, sol) }, now: () => NOW });
  assert.match(refused(await payLink(payArgs({ link: sol.id, amount: "1", rail: "x402" }), solDeps.deps)), /x402 pays USDC requests only/);
});

test("pay_link on a contribution's own link refuses it once it expired (the deadline holds on every rail)", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/requests/${contribution.id}`]: () => json(200, { ...contribution, status: "expired" }) }, now: () => NOW });
  assert.match(refused(await payLink(payArgs({ link: `https://www.getowed.xyz/r/${contribution.id}` }), deps)), /expired/);
  const later = makeDeps({ routes: { [`GET /api/v1/requests/${contribution.id}`]: () => json(200, contribution) }, now: () => Date.parse("2026-10-19T09:05:01Z") });
  assert.match(refused(await payLink(payArgs({ link: contribution.id }), later.deps)), /expired at 2026-10-19T09:05:00Z/);
});

// ---------------------------------------------------------------------------------------------- the other tools

test("pay_all skips a pot: pay a pot with pay_link, one contribution at a time", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW });
  const r = await payAll(payAllInput.parse({ ids: [BOARD], sender: SENDER, max_total: "50" }), deps);
  assert.match(refused(r), /a chip-in pot: pay a pot with pay_link, one contribution at a time/);
  assert.equal(rec.calls.length, 0);
});

test("check_payments on a pot: what it raised against its target, the latest contributions, never counted as owed", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/pots/${POT}`]: () => json(200, board) }, now: () => NOW });
  const r = ok(await checkPayments(checkInput.parse({ requests: [BOARD] }), deps));
  const out = checkOutput.parse(r.structuredContent);
  assert.deepEqual(out, r.structuredContent);
  const [res] = out.results;
  assert.deepEqual([res!.id, res!.status, res!.amount_requested, res!.amount_paid, res!.token, res!.expires_at], [POT, "open", "100", "42.5", "USDC", "2026-11-17T09:00:00Z"]);
  assert.equal(res!.pot!.count, 3);
  assert.equal(res!.pot!.latest.length, 3);
  assert.equal(out.summary, 'pot "Farewell gift for Ana": 42.5 of 100 USDC raised from 3 contributions');
  const text = textOf(r);
  assert.match(text, new RegExp(`Pot ${POT} "Farewell gift for Ana" \\(written by whoever started it; unverified\\): 42\\.5 of 100 USDC raised from 3 contributions, takes contributions until 2026-11-17T09:00:00Z\\. Board: ${BOARD}`));
  assert.match(text, /7\.5 USDC from .* at 2026-10-18T10:02:05Z: https:\/\/solscan\.io\/tx\//);
});

test("check_payments: a pot beside a request, an ended pot, a tampered pot, an unknown pot", async () => {
  const paidRequest = fixture("get-request.res.json");
  const status = fixture("status.res.json");
  const nonce = bs58.encode(createHash("sha256").update("x").digest());
  const { deps } = makeDeps({
    routes: {
      [`GET /api/v1/pots/${POT}`]: () => json(200, { ...board, status: "ended" }),
      "GET /api/v1/pots/11111111111111": () => json(404, { error: { code: "not_found", message: "no pot with this id" } }),
      "GET /api/v1/pots/22222222222222": () => json(200, { ...board, id: "22222222222222", nonce }),
      "POST /api/v1/status": () => json(200, status),
      "GET /api/v1/refunds?requests=JArQ6g9JvoWr": () => json(200, { requests: [], not_found: [], chain_checked: true }),
    },
    now: () => NOW,
  });
  const r = ok(await checkPayments(checkInput.parse({ requests: [paidRequest.id, POT, "11111111111111", "22222222222222"] }), deps));
  const out = checkOutput.parse(r.structuredContent);
  assert.deepEqual(out.results.map((x) => x.status), ["paid", "expired", "not_found", "invalid"]);
  assert.match(out.results[3]!.error!, /doesn't match the wallet and token/);
  assert.match(out.summary, /^1 of 3 paid .*· pot "Farewell gift for Ana": 42\.5 of 100 USDC raised from 3 contributions, ended$/);
  assert.match(textOf(r), /ended 2026-11-17T09:00:00Z; it takes no new contributions/);
});

// A throwaway signer from a fixed seed, as in who_owes_me.test.ts.
function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}

test("who_owes_me: open pots are listed with what they raised; their contributions are received, never owed", async () => {
  const me = signer("owed test signer: pots.test.ts");
  const at = Date.parse("2026-10-18T10:30:00Z");
  const message = `Owed ledger access for ${me.address} at 2026-10-18T10:30:00Z`;
  const ledger = { ...fixture("ledger.pots.res.json"), recipient: me.address };
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/ledger": () => json(200, ledger) }, now: () => at });
  const r = ok(await whoOwesMe(whoInput.parse({ recipient: me.address, signed_message: message, signature: me.sign(message) }), deps));
  const out = whoOutput.parse(r.structuredContent);
  assert.deepEqual(out, r.structuredContent);
  assert.deepEqual(out.open, []);
  assert.equal(out.paid_recently!.length, 3);
  assert.deepEqual(out.pots, [{ id: POT, link: BOARD, title: "Farewell gift for Ana", token: "USDC", raised: "42.5", count: 3, target: "100", deadline: "2026-11-17T09:00:00Z" }]);
  assert.match(textOf(r), new RegExp(`Pot "Farewell gift for Ana" \\(unverified\\): 42\\.5 of 100 USDC raised from 3 contributions, open until 2026-11-17T09:00:00Z: ${BOARD}`));
  assert.match(textOf(r), /^0 open requests · 0 USDC outstanding · 42\.5 USDC received in the last 30 days \(3 paid\)/);
  assert.equal(rec.calls.length, 1);
  // A ledger without pots has no pots field at all.
  const plain = makeDeps({ routes: { "POST /api/v1/ledger": () => json(200, { ...fixture("ledger.res.json"), recipient: me.address }) }, now: () => at });
  const r2 = ok(await whoOwesMe(whoInput.parse({ recipient: me.address, signed_message: message, signature: me.sign(message) }), plain.deps));
  assert.equal("pots" in r2.structuredContent, false);
});

test("cancel_request and write_reminder say what a pot is instead of treating it as a request", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW });
  const me = signer("owed test signer: pots cancel");
  assert.match(refused(await cancelRequest(cancelInput.parse({ link: BOARD, recipient: me.address }), deps)), /A pot can't be cancelled: it stops taking contributions at its deadline/);
  assert.match(refused(await writeReminder(reminderInput.parse({ request: BOARD }), deps)), /nobody owes a pot, so there is nothing to chase/);
  assert.equal(rec.calls.length, 0);
});

test("verify_payee on a pot reads the wallet its id commits to", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/pots/${POT}`]: () => json(200, board) }, now: () => NOW });
  const r = await verifyPayeeTool(verifyInput.parse({ link: BOARD }), deps);
  assert.match(textOf(r), /FN6G…cbvs|FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs/);
  const nonce = bs58.encode(createHash("sha256").update("y").digest());
  const tampered = makeDeps({ routes: { [`GET /api/v1/pots/${POT}`]: () => json(200, { ...board, nonce }) }, now: () => NOW });
  assert.match(refused(await verifyPayeeTool(verifyInput.parse({ link: BOARD }), tampered.deps)), /doesn't match the wallet and token/);
});
