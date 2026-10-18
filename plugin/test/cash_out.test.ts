import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import * as z from "zod/v4";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { cashOut, inputSchema, outputSchema, widgetProblem } from "../src/tools/cash_out.ts";
import { cashOutResSchema, type CashOutRes } from "../src/contract.ts";
import type { Rpc } from "../src/chain.ts";
import { fixture, html, json, makeDeps, textOf, USDC_MINT, type Call, type Route } from "./helpers.ts";

// cash_out's two calls against doubles of POST /api/v1/cash-out and GET /api/v1/cash-out/<id>, answered from
// contract/fixtures/cash-out.*.json (signed with the throwaway fixture key, fixed seed, holds nothing). Every proposal is
// decoded: exactly one USDC transfer of the cash-out's amount from the user's wallet to the deposit address's USDC account,
// nothing else. There is no input that takes an address, and every way the server's answer could point elsewhere is
// refused before a transaction is built.

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}
const ME = signer("owed contract fixture signer: cash-out (holds nothing)");
const MALLORY = signer("owed test signer: cash_out.test.ts, someone else");
const created: CashOutRes = cashOutResSchema.parse(fixture("cash-out.create.res.json"));
const waiting: CashOutRes = cashOutResSchema.parse(fixture("cash-out.status.res.json"));
const enterprise: CashOutRes = cashOutResSchema.parse(fixture("cash-out.enterprise.res.json"));
const WALLET = created.wallet;
const ID = created.id;
const DEPOSIT = waiting.deposit_address!;
assert.equal(ME.address, WALLET, "the fixtures were made with this key");

const CREATE = "POST /api/v1/cash-out";
const STATUS = (id = ID, wallet = WALLET) => `GET /api/v1/cash-out/${id}?wallet=${wallet}`;

/** Solana double: getAccountInfo answers `owner`, getSignaturesForAddress lists `history`, getTransaction answers from `txs`. */
function chain({ owner = "11111111111111111111111111111111" as string | null, history = [] as Array<{ signature: string; blockTime: number }>, txs = new Map<string, unknown>() } = {}): Rpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: async <T>(method: string, params: unknown[]) => {
      calls.push(method);
      if (method === "getAccountInfo") return { value: owner === null ? null : { owner, lamports: 1, data: ["", "base64"], executable: false } } as T;
      if (method === "getSignaturesForAddress") return history.map((h) => ({ ...h, err: null, slot: 1 })) as T;
      if (method === "getTransaction") return (txs.get(String(params[0])) ?? null) as T;
      throw new Error(`unexpected rpc ${method}`);
    },
  };
}

type Result = Awaited<ReturnType<typeof cashOut>>;
const refused = (r: Result) => {
  assert.equal((r as { isError?: boolean }).isError, true, `expected no proposal, got ${textOf(r)}`);
  return textOf(r);
};
function proposal(r: Result) {
  assert.ok(!("isError" in r) || !r.isError, `unexpected refusal: ${textOf(r)}`);
  const sc = outputSchema.parse((r as { structuredContent: unknown }).structuredContent);
  return Transaction.from(Buffer.from(sc["io.paybox/transactionProposal"].transaction.transactionBase64, "base64"));
}
const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(owner), true).toBase58();

/** The one USDC transfer a proposal makes: source, destination and amount, read from the transferChecked instruction. */
function transferOf(tx: Transaction) {
  const transfers = tx.instructions.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID));
  assert.equal(transfers.length, 1, "exactly one token instruction");
  const ix = transfers[0];
  assert.equal(ix.data[0], 12, "transferChecked");
  return {
    source: ix.keys[0].pubkey.toBase58(),
    mint: ix.keys[1].pubkey.toBase58(),
    destination: ix.keys[2].pubkey.toBase58(),
    owner: ix.keys[3].pubkey.toBase58(),
    amount: ix.data.readBigUInt64LE(1),
    decimals: ix.data[9],
  };
}

function deps(routes: Record<string, Route>, extra: Parameters<typeof makeDeps>[0] = {}) {
  return makeDeps({ rpc: () => chain(), routes, ...extra });
}

// ---------------------------------------------------------------- inputs

test("there is no input that takes an address other than the user's own wallet", () => {
  const schema = z.toJSONSchema(inputSchema, { io: "input" }) as { properties: Record<string, unknown>; additionalProperties: boolean; required: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["amount", "cash_out_id", "fiat_currency", "request_ids", "wallet"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["wallet"]);
  assert.equal(inputSchema.safeParse({ wallet: WALLET, deposit_address: DEPOSIT }).success, false);
});

// ---------------------------------------------------------------- first call

test("call 1 while MoonPay isn't configured: a clean refusal, nothing set up", async () => {
  const { deps: d } = deps({ [CREATE]: () => json(503, { error: { code: "upstream_unavailable", message: "cash-out isn't switched on yet on this Owed server (MoonPay's keys for selling USDC aren't configured), so nothing was set up" } }) });
  const text = refused(await cashOut({ wallet: WALLET, amount: "10" }, d));
  assert.match(text, /isn't switched on yet/);
  assert.match(text, /Nothing moved/);
});

test("call 1 against an Owed server without cash-out (an HTML 404) says so", async () => {
  const { deps: d } = deps({ [CREATE]: () => html(404) });
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, d)), /doesn't do cash-outs yet/);
});

test("call 1: the MoonPay link, the cash_out_id and the exact next call; nothing to approve yet", async () => {
  const calls: Call[] = [];
  const { deps: d, rec } = deps({ [CREATE]: (c) => { calls.push(c); return json(201, created); } });
  const r = await cashOut({ wallet: WALLET, amount: "10", fiat_currency: "eur" }, d);
  const text = refused(r);
  assert.deepEqual(calls[0].body, { wallet: WALLET, amount: "10", fiat_currency: "eur" });
  assert.ok(text.includes(created.widget_url!), "the signed link is shown as the server made it");
  assert.match(text, new RegExp(`cash_out_id "${ID}"`));
  assert.match(text, /Nothing has moved yet/);
  const plan = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]);
  assert.deepEqual(plan.then, { tool: "cash_out", args: { wallet: WALLET, cash_out_id: ID, amount: "10" } });
  assert.equal(rec.built.length, 0, "no transaction is built on the first call");
});

test("call 1 refuses a server answer that doesn't match what was asked", async () => {
  const swap = (over: Partial<CashOutRes>) => deps({ [CREATE]: () => json(201, { ...created, ...over }) }).deps;
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, swap({ amount: "100" }))), /doesn't match what was asked/);
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, swap({ wallet: MALLORY.address }))), /doesn't match what was asked/);
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, swap({ deposit_address: DEPOSIT }))), /doesn't match what was asked/);
  const evil = created.widget_url!.replace(`refundWalletAddress=${WALLET}`, `refundWalletAddress=${MALLORY.address}`);
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, swap({ widget_url: evil }))), /isn't right for this cash-out \(it refunds a different wallet\)/);
  const phish = created.widget_url!.replace("https://sell-sandbox.moonpay.com/", "https://sell.moonpay.example/");
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "10" }, swap({ widget_url: phish }))), /not MoonPay's sell widget/);
});

test("call 1 needs amount or request_ids; request_ids come back as asked, with what they brought in", async () => {
  const { deps: d } = deps({});
  assert.match(refused(await cashOut({ wallet: WALLET }, d)), /amount .* or request_ids/);
  assert.match(refused(await cashOut({ wallet: WALLET, amount: "1", request_ids: ["JArQ6g9JvoWr"] }, d)), /not both/);
  const fromRequests = { ...created, request_ids: ["JArQ6g9JvoWr"], requests_total: "10.004" };
  const { deps: d2 } = deps({ [CREATE]: () => json(201, fromRequests) });
  const text = refused(await cashOut({ wallet: WALLET, request_ids: ["JArQ6g9JvoWr"] }, d2));
  assert.match(text, /from 1 paid request \(they brought in 10.004 USDC/);
  const { deps: d3 } = deps({ [CREATE]: () => json(201, { ...fromRequests, request_ids: ["Zz3dEfGh2jKm"] }) });
  assert.match(refused(await cashOut({ wallet: WALLET, request_ids: ["JArQ6g9JvoWr"] }, d3)), /doesn't match/);
});

// ---------------------------------------------------------------- second call: the transfer

test("call 2: one USDC transfer of exactly the amount from the wallet to MoonPay's deposit address", async () => {
  const { deps: d, rec } = deps({ [STATUS()]: () => json(200, waiting) });
  const r = await cashOut({ wallet: WALLET, cash_out_id: ID, amount: "10" }, d);
  const t = transferOf(proposal(r));
  assert.deepEqual(t, { source: ata(WALLET), mint: USDC_MINT, destination: ata(DEPOSIT), owner: WALLET, amount: 10_000_000n, decimals: 6 });
  assert.match(textOf(r), /To your MoonPay cash-out address, paid out to your bank/);
  assert.equal(rec.readiness[0].recipient, DEPOSIT);
  assert.equal(rec.readiness[0].amountAtomic, 10_000_000n);
});

test("call 2 opens the deposit address's USDC account when it has none (idempotent create), nothing else", async () => {
  const { deps: d } = deps({ [STATUS()]: () => json(200, waiting) }, { payerReadiness: async () => ({ ok: true, recipientAtaExists: false }) });
  const tx = proposal(await cashOut({ wallet: WALLET, cash_out_id: ID }, d));
  const create = tx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(create.length, 1);
  assert.equal(create[0].keys[2].pubkey.toBase58(), DEPOSIT, "the account is opened for MoonPay's deposit address");
  assert.equal(transferOf(tx).destination, ata(DEPOSIT));
});

test("call 2 refuses before proposing: another amount, another wallet, a missing cash-out", async () => {
  const { deps: d } = deps({ [STATUS()]: () => json(200, waiting) });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID, amount: "20" }, d)), /is for 10 USDC, not 20 USDC/);
  const { deps: d2 } = deps({ [STATUS()]: () => json(200, { ...waiting, wallet: MALLORY.address }) });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d2)), /belongs to .*not this wallet/);
  const { deps: d3 } = deps({ [STATUS()]: () => json(404, { error: { code: "not_found", message: `this wallet has no cash-out ${ID}` } }) });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d3)), /This wallet has no cash-out/);
  const { deps: d4 } = deps({ [STATUS()]: () => json(200, { ...waiting, id: "Zz3dEfGh2jKm" }) });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d4)), /different cash-out/);
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID, request_ids: ["JArQ6g9JvoWr"] }, d)), /belong to the first call/);
});

test("call 2 refuses an address the server shouldn't have released", async () => {
  const bad = async (over: Partial<CashOutRes>, rpc?: Rpc) => {
    const { deps: d, rec } = deps({ [STATUS()]: () => json(200, { ...waiting, ...over }) }, rpc ? { rpc: () => rpc } : {});
    const text = refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d));
    assert.equal(rec.built.length, 0, "nothing was built");
    return text;
  };
  assert.match(await bad({ deposit_address: WALLET }), /this wallet itself/);
  assert.match(await bad({ deposit_address: USDC_MINT }), /isn't a Solana wallet/);
  assert.match(await bad({ moonpay_transaction_id: null }), /without naming MoonPay's sale/);
  assert.match(await bad({}, chain({ owner: TOKEN_PROGRAM_ID.toBase58() })), /token account, not a wallet/);
  // Not waiting for a deposit: never a transfer, whatever address comes along.
  for (const status of ["created", "pending", "completed", "failed", "requote_required"] as const) {
    const text = await bad({ status });
    assert.doesNotMatch(text, /Approve it in PayBox/);
  }
  assert.match(await bad({ deposit_address: null, problem: "MoonPay is waiting for the deposit but hasn't sent Owed its deposit address yet" }), /no transfer can be proposed yet/);
});

test("call 2 never proposes the same cash-out twice: a transfer from this wallet already on chain stops it", async () => {
  const sent = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
  const blockTime = Math.floor(Date.parse(waiting.created_at) / 1000) + 300;
  const keys = [WALLET, ata(WALLET), ata(DEPOSIT), USDC_MINT];
  const tx = {
    slot: 2, blockTime,
    meta: {
      err: null, preBalances: [1, 1, 1, 1], postBalances: [1, 1, 1, 1], innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: DEPOSIT, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: DEPOSIT, uiTokenAmount: { amount: "10000000" } }],
    },
    transaction: {
      signatures: [sent],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: keys[1], destination: keys[2], authority: WALLET, mint: USDC_MINT, tokenAmount: { amount: "10000000" } } } }],
      },
    },
  };
  const rpc = chain({ history: [{ signature: sent, blockTime }], txs: new Map([[sent, tx]]) });
  const { deps: d, rec } = deps({ [STATUS()]: () => json(200, waiting) }, { rpc: () => rpc });
  const text = refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d));
  assert.match(text, /already sent 10 USDC/);
  assert.ok(text.includes(sent));
  assert.equal(rec.built.length, 0);
});

test("call 2 refuses when the wallet can't cover it, or Solana can't be read", async () => {
  const { deps: d } = deps({ [STATUS()]: () => json(200, waiting) }, { payerReadiness: async () => ({ ok: false, reason: "Your wallet has 4 USDC; this request is 10 USDC.", recipientAtaExists: true }) });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d)), /Your wallet has 4 USDC; the cash-out is 10 USDC/);
  const { deps: d2 } = deps({ [STATUS()]: () => json(200, waiting) }, { payerReadiness: async () => { throw new Error("rpc down"); } });
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, d2)), /Solana couldn't be reached/);
});

test("call 2 reports the status when there is nothing to send", async () => {
  const at = (over: Partial<CashOutRes>) => deps({ [STATUS()]: () => json(200, { ...waiting, ...over }) }).deps;
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, at({ status: "pending", deposit_address: null, transfer_signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv" }))), /MoonPay received the 10 USDC .* paying the bank/);
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, at({ status: "completed", deposit_address: null, widget_url: null }))), /is done/);
  assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, at({ status: "failed", deposit_address: null, failure_reason: "Deposit timeout" }))), /"Deposit timeout"/);
  const createdText = refused(await cashOut({ wallet: WALLET, cash_out_id: ID }, at({ status: "created", deposit_address: null, moonpay_transaction_id: null, problem: "MoonPay has no sale for this cash-out yet" })));
  assert.match(createdText, /No transfer yet .*MoonPay has no sale/);
  assert.ok(createdText.includes(created.widget_url!), "the link again, after the same checks");
});

// ---------------------------------------------------------------- Enterprise: the wallet's own signed address

test("Enterprise: proposes only to the liquidation address this wallet signed for", async () => {
  const route = (over: Partial<CashOutRes> = {}) => deps({ [STATUS(enterprise.id)]: () => json(200, { ...enterprise, ...over }) }).deps;
  const t = transferOf(proposal(await cashOut({ wallet: WALLET, cash_out_id: enterprise.id, amount: "250" }, route())));
  assert.equal(t.destination, ata(enterprise.deposit_address!));
  assert.equal(t.amount, 250_000_000n);

  const other = signer("owed test signer: cash_out.test.ts, an attacker's liquidation address").address;
  const forged = `Owed cash-out account ${enterprise.account!.id} to ${other} for ${WALLET} at 2026-10-18T11:58:00Z`;
  const cases: Array<[Partial<CashOutRes>, RegExp]> = [
    [{ deposit_address: other, account: { ...enterprise.account!, liquidation_address: other } }, /doesn't name this route, address and wallet/],
    [{ deposit_address: other }, /isn't the one in the signed account/],
    [{ deposit_address: other, account: { ...enterprise.account!, liquidation_address: other, signed_message: forged, signature: MALLORY.sign(forged) } }, /isn't signed by this wallet/],
    [{ account: null }, /no signed cash-out account/],
  ];
  for (const [over, why] of cases) assert.match(refused(await cashOut({ wallet: WALLET, cash_out_id: enterprise.id }, route(over))), why);
  // The same record signed by the wallet itself for the other address would be the user's own choice: accepted.
  const own = `Owed cash-out account ${enterprise.account!.id} to ${other} for ${WALLET} at 2026-10-18T11:58:00Z`;
  const t2 = transferOf(proposal(await cashOut({ wallet: WALLET, cash_out_id: enterprise.id }, route({ deposit_address: other, account: { ...enterprise.account!, liquidation_address: other, signed_message: own, signature: ME.sign(own) } }))));
  assert.equal(t2.destination, ata(other));
});

test("widgetProblem accepts the fixture's signed link and nothing that points elsewhere", () => {
  assert.equal(widgetProblem(created), null);
  assert.equal(widgetProblem({ ...created, widget_url: created.widget_url!.replace("baseCurrencyAmount=10", "baseCurrencyAmount=100") }), "it doesn't sell exactly this amount");
  assert.equal(widgetProblem({ ...created, widget_url: created.widget_url!.replace(/&signature=.*$/, "") }), "it isn't signed");
  assert.equal(widgetProblem({ ...created, widget_url: created.widget_url!.replace("usdc_sol", "eth") }), "it doesn't sell USDC on Solana");
  assert.equal(widgetProblem({ ...created, widget_url: created.widget_url!.replace(`externalTransactionId=${ID}`, "externalTransactionId=Zz3dEfGh2jKm") }), "it belongs to a different cash-out");
});
