import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Rpc } from "../src/chain.ts";
import { solanaOutputSchema } from "../src/paybox.ts";
import { snsBrandFlags, snsForPayment } from "../src/sns-payee.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { inputSchema as payInput, payLink, REFUSE_X402_NOT_OWED } from "../src/tools/pay_link.ts";
import { inputSchema as verifyInput, outputSchema as verifyOutput, verifyPayeeTool } from "../src/tools/verify_payee.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT } from "./helpers.ts";

// W3-S: ask_for_money, pay_link and verify_payee with SNS names. Solana answers come from the real mainnet
// captures in test/fixtures/sns; API replies are the contract fixtures captured from a local server
// (contract/fixtures/sns.*.json), so an id, its terms and its name all line up the way production makes them.

const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v"; // bonfida.sns's owner
const snsFixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sns/${name}.json`, import.meta.url)), "utf8")) as {
  calls: Array<{ method: string; params: unknown[]; result: unknown }>;
};

/** An RPC that answers the recorded calls of these fixtures and throws on anything else; counts calls. */
function rpcFrom(...names: string[]) {
  const calls = names.flatMap((n) => snsFixture(n).calls);
  const asked: string[] = [];
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      asked.push(method);
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded RPC call ${method}`);
      return structuredClone(hit.result) as T;
    },
  };
  return { rpc: () => rpc, asked };
}
const rpcDown = { rpc: (): Rpc => ({ call: async () => { throw new Error("timeout"); } }) };

const createdReq = fixture("sns.create-request.req.json");
const createdRes = fixture("sns.create-request.res.json");
const snsRequest = fixture("sns.get-request.res.json");
const ID = snsRequest.id as string;
type Out = { isError?: boolean; structuredContent?: unknown };
const isError = (r: Out) => r.isError === true;

// ---------------------------------------------------------------- ask_for_money

const ask = (extra: Record<string, unknown> = {}) => askInput.parse({ recipient: "Bonfida.SNS", amount: "5", payer_name: "Priya", for: "dinner", requester_name: "Raj", ...extra });

test("ask_for_money: a name as recipient resolves on Solana, goes to the API as sns_name, and leads the reply", async () => {
  const { rpc, asked } = rpcFrom("bonfida");
  const { deps, rec } = makeDeps({ rpc, routes: { "POST /api/v1/requests": () => json(201, createdRes) } });
  const result = await askForMoney(ask(), deps);
  assert.ok(!isError(result), textOf(result));
  assert.deepEqual(rec.calls[0]!.body, createdReq);
  const out = askOutput.parse((result as { structuredContent: unknown }).structuredContent);
  assert.equal(out.recipient, BONFIDA);
  assert.equal(out.sns_name, "bonfida.sns");
  assert.equal(out.sns_source, "owner");
  assert.deepEqual(asked, ["getMultipleAccounts"]);
  const lines = textOf(result).split("\n");
  assert.ok(lines.includes("Paid to bonfida.sns (verified on-chain: bonfida.sns points to Fw1E…Lb1v)."), textOf(result));
  assert.ok(lines.includes("Verified on-chain: bonfida.sns points to Fw1E…Lb1v (its owner), read from Solana just now. That proves who controls the name, not what the request is for."));
});

test("ask_for_money: refuses when the server didn't attach the name", async () => {
  const { deps } = makeDeps({ ...rpcFrom("bonfida"), routes: { "POST /api/v1/requests": () => json(201, { ...createdRes, sns_name: null, sns_source: null }) } });
  const result = await askForMoney(ask(), deps);
  assert.ok(isError(result));
  assert.match(textOf(result), /didn't attach bonfida\.sns/);
});

test("ask_for_money: .sol, tokenized, unregistered, lookalike and unreadable names are refused before the API", async () => {
  for (const [recipient, rpcSource, why] of [
    ["raj.sol", rpcDown, /\.sol name.*ask again with raj\.sns/],
    ["sns-ip-5-wallet-1.sns", rpcFrom("ip5-tokenized"), /tokenized/],
    ["owed-sns-fixture-unregistered-7f3a.sns", rpcFrom("unregistered"), /isn't registered on SNS/],
    ["bonfida.sns", rpcDown, /Solana couldn't be read to resolve bonfida\.sns/],
    ["sns-ip-5-wallet-3.sns", rpcFrom("ip5-unverified-roa"), /SOL record that isn't validated/],
  ] as const) {
    const { deps, rec } = makeDeps({ rpc: rpcSource.rpc, routes: { "POST /api/v1/requests": () => json(201, createdRes) } });
    const result = await askForMoney(askInput.parse({ recipient, amount: "5" }), deps);
    assert.ok(isError(result), recipient);
    assert.match(textOf(result), why, recipient);
    assert.match(textOf(result), /Nothing was created\.$/, recipient);
    assert.equal(rec.calls.length, 0, recipient);
  }
  // A lookalike isn't even a recipient the schema takes as a name, and never reaches the RPC.
  assert.throws(() => askInput.parse({ recipient: "bonfida.com", amount: "5" }));
  const { deps } = makeDeps(rpcDown);
  const lookalike = await askForMoney(askInput.parse({ recipient: "bоnfida.sns", amount: "5" }), deps);
  assert.match(textOf(lookalike), /can pass for others/);
});

test("ask_for_money: the resolved wallet is screened like any recipient", async () => {
  const { deps, rec } = makeDeps({
    ...rpcFrom("bonfida"),
    routes: { "POST /api/v1/requests": () => json(201, createdRes) },
    screenRecipient: async (a) => (a === BONFIDA ? { ok: false, message: "listed" } : { ok: true, screening: "clear" }),
  });
  const result = await askForMoney(ask(), deps);
  assert.ok(isError(result));
  assert.equal(textOf(result), "listed");
  assert.equal(rec.calls.length, 0);
});

test("ask_for_money: a name with chain base is refused; offline links say they can't carry the name", async () => {
  const base = await askForMoney(ask({ chain: "base" }), makeDeps(rpcFrom("bonfida")).deps);
  assert.match(textOf(base), /SNS names point to Solana wallets/);

  const { deps } = makeDeps({ ...rpcFrom("bonfida"), routes: { "POST /api/v1/requests": () => "network_error" } });
  const offline = await askForMoney(ask(), deps);
  assert.ok(!isError(offline), textOf(offline));
  const out = askOutput.parse((offline as { structuredContent: unknown }).structuredContent);
  assert.equal(out.mode, "offline");
  assert.equal(out.recipient, BONFIDA);
  assert.equal(out.sns_name, undefined);
  assert.match(textOf(offline), /Offline links can't carry a name, so payers see the wallet address, not bonfida\.sns\./);
});

// ---------------------------------------------------------------- pay_link

const KEY = "io.paybox/transactionProposal";
const pay = (extra: Record<string, unknown> = {}) => payInput.parse({ link: ID, sender: SENDER, ...extra });
const route = (body: unknown) => ({ [`GET /api/v1/requests/${body && typeof body === "object" ? (body as { id: string }).id : ""}`]: () => json(200, body) });
const proposed = (r: Out) => {
  assert.ok(!isError(r), textOf(r));
  return solanaOutputSchema.parse(r.structuredContent)[KEY];
};

test("pay_link: a request made for a name is paid only after the name still points to its wallet", async () => {
  const { rpc, asked } = rpcFrom("bonfida");
  const { deps, rec } = makeDeps({ rpc, routes: route(snsRequest) });
  const result = await payLink(pay(), deps);
  assert.equal(proposed(result).kind, "solana");
  assert.equal(rec.built[0]!.request.recipient, BONFIDA);
  assert.deepEqual(asked, ["getMultipleAccounts"]);
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], 'Pay 5 USDC to bonfida.sns (verified on-chain: bonfida.sns points to Fw1E…Lb1v). Requester\'s note, unverified: "dinner". Requester\'s name, unverified: "Raj". Approve in PayBox to send.');
  assert.equal(lines[1], `Recipient: ${BONFIDA}`);
  assert.ok(!textOf(result).includes("Payee not verified: no domain"));
  assert.ok(lines.includes("Verified on-chain: bonfida.sns points to Fw1E…Lb1v (its owner), read from Solana just now. That proves who controls the name, not what the request is for."));
});

test("pay_link: refuses when the name now points to a different wallet than when the request was made", async () => {
  // A real request paying the team wallet, claiming bonfida.sns (which points to Bonfida's wallet).
  const open = { ...fixture("get-request.res.json"), status: "open", paid: null, sns_name: "bonfida.sns", sns_source: "owner", sns_resolved_at: "2026-10-17T07:00:00Z" };
  const { deps, rec } = makeDeps({ ...rpcFrom("bonfida"), routes: route(open) });
  const result = await payLink(pay({ link: open.id }), deps);
  assert.ok(isError(result));
  assert.equal(textOf(result), `bonfida.sns now points to a different wallet than when this request was made (it points to Fw1E…Lb1v through its owner; the request pays ${RECIPIENT.slice(0, 4)}…${RECIPIENT.slice(-4)}). Nothing was sent. Ask the requester for a new link.`);
  assert.equal(rec.built.length, 0);
});

test("pay_link: Solana unreadable → refused, unless allow_unverified, and then never shown as verified", async () => {
  const { deps } = makeDeps({ ...rpcDown, routes: route(snsRequest) });
  const refused = await payLink(pay(), deps);
  assert.ok(isError(refused));
  assert.match(textOf(refused), /made for bonfida\.sns, but Solana couldn't be read.*allow_unverified/);

  const { deps: deps2 } = makeDeps({ ...rpcDown, routes: route(snsRequest) });
  const allowed = await payLink(pay({ allow_unverified: true }), deps2);
  proposed(allowed);
  assert.match(textOf(allowed).split("\n")[0]!, /^Pay 5 USDC to Fw1E…Lb1v\./);
  assert.ok(!textOf(allowed).includes("verified on-chain"));
  assert.match(textOf(allowed), /Name not verified: the request was made for bonfida\.sns/);
});

test("pay_link: \"pay bonfida.sns 2 USDC\" resolves the name and proposes a transfer to its wallet", async () => {
  const { deps, rec } = makeDeps(rpcFrom("bonfida"));
  const result = await payLink(pay({ link: "bonfida.sns", amount: "2" }), deps);
  proposed(result);
  const built = rec.built[0]!;
  assert.equal(built.request.recipient, BONFIDA);
  assert.equal(built.request.splToken, USDC_MINT);
  assert.equal(built.token, "USDC");
  assert.equal(built.amountAtomic, 2_000_000n);
  assert.equal(rec.calls.length, 0); // no Owed API involved
  assert.equal(textOf(result).split("\n")[0], "Pay 2 USDC to bonfida.sns (verified on-chain: bonfida.sns points to Fw1E…Lb1v). Approve in PayBox to send.");

  const { deps: deps2, rec: rec2 } = makeDeps(rpcFrom("bonfida"));
  proposed(await payLink(pay({ link: "bonfida.sns", amount: "0.1", token: "SOL" }), deps2));
  assert.equal(rec2.built[0]!.token, "SOL");
  assert.equal(rec2.built[0]!.request.splToken, undefined);
  assert.equal(rec2.built[0]!.amountAtomic, 100_000_000n);
});

test("pay_link: a bare name needs an amount; .sol, tokenized names, x402 and over-limit amounts are refused", async () => {
  const cases: Array<[Record<string, unknown>, ReturnType<typeof rpcFrom> | typeof rpcDown, RegExp]> = [
    [{ link: "bonfida.sns" }, rpcFrom("bonfida"), /How much USDC should go to bonfida\.sns\?/],
    [{ link: "raj.sol", amount: "1" }, rpcDown, /\.sol name.*Nothing was sent\.$/],
    [{ link: "sns-ip-5-wallet-1.sns", amount: "1" }, rpcFrom("ip5-tokenized"), /tokenized/],
    [{ link: "gamaedtech.sns", amount: "1" }, rpcFrom("record-off-curve"), /not a wallet/],
    [{ link: "bonfida.sns", amount: "1", rail: "x402" }, rpcDown, new RegExp(REFUSE_X402_NOT_OWED.replace(/[.()]/g, "\\$&"))],
    [{ link: "bonfida.sns", amount: "3", max_amount: "2" }, rpcFrom("bonfida"), /above your limit of 2 USDC/],
  ];
  for (const [args, source, why] of cases) {
    const { deps, rec } = makeDeps({ rpc: source.rpc });
    const result = await payLink(pay(args), deps);
    assert.ok(isError(result), JSON.stringify(args));
    assert.match(textOf(result), why, JSON.stringify(args));
    assert.equal(rec.built.length, 0);
  }
});

test("pay_link: token must agree with an Owed link's token", async () => {
  const { deps } = makeDeps({ ...rpcFrom("bonfida"), routes: route(snsRequest) });
  const result = await payLink(pay({ token: "SOL" }), deps);
  assert.ok(isError(result));
  assert.equal(textOf(result), "This link asks for USDC, not SOL. Nothing was sent.");
});

test("snsForPayment and snsBrandFlags: brand words in a name are cautions, nothing else is", async () => {
  assert.ok(snsBrandFlags("phantom.sns").includes("brand_word:phantom"));
  assert.ok(snsBrandFlags("ph4ntom.sns").includes("brand_word:phantom"));
  assert.ok(snsBrandFlags("paybox-support.sns").includes("brand_word:paybox"));
  assert.deepEqual(snsBrandFlags("bonfida.sns"), []);
  assert.deepEqual(await snsForPayment(null, BONFIDA, false, rpcDown), { ok: true, lead: null, lines: [] });
});

// ---------------------------------------------------------------- verify_payee

const verify = async (args: Record<string, unknown>, rpcSource: { rpc: () => Rpc }, routes = {}) => {
  const { deps } = makeDeps({ rpc: rpcSource.rpc, routes });
  const result = await verifyPayeeTool(verifyInput.parse(args), deps);
  return { result, out: verifyOutput.parse((result as { structuredContent: unknown }).structuredContent), text: textOf(result) };
};

test("verify_payee: a name alone says which wallet it points to and why", async () => {
  const { out, text } = await verify({ name: "bonfida.sns" }, rpcFrom("bonfida"));
  assert.deepEqual(out.sns, { name: "bonfida.sns", status: "resolved", wallet: BONFIDA, source: "owner", warnings: [] });
  assert.equal(out.address, BONFIDA);
  assert.equal(text, `bonfida.sns points to Fw1E…Lb1v (its owner): ${BONFIDA}. Read from Solana just now; it proves who controls the name, not that a request is fair.`);
});

test("verify_payee: a name with an address, or a link made for a name, is verified or a mismatch", async () => {
  const ok = await verify({ name: "bonfida.sns", address: BONFIDA }, rpcFrom("bonfida"));
  assert.equal(ok.out.sns?.status, "verified");

  const bad = await verify({ name: "bonfida.sns", address: RECIPIENT }, rpcFrom("bonfida"));
  assert.equal(bad.out.sns?.status, "mismatch");
  assert.match(bad.text, /^Not verified: bonfida\.sns points to Fw1E…Lb1v \(its owner\), not to FN6G…cbvs, the wallet this pays/);

  const link = await verify({ link: ID }, rpcFrom("bonfida"), route(snsRequest));
  assert.equal(link.out.sns?.status, "verified");
  assert.equal(link.out.request_id, ID);
  assert.match(link.text, /^Verified on-chain: bonfida\.sns points to Fw1E…Lb1v \(its owner\), the wallet this pays\./);
});

test("verify_payee: an unresolvable name is reported, not thrown", async () => {
  const sol = await verify({ name: "raj.sol" }, rpcDown);
  assert.equal(sol.out.sns?.status, "sol_tld");
  assert.match(sol.text, /^Couldn't resolve the name: raj\.sol is a \.sol name/);
  const tokenized = await verify({ name: "sns-ip-5-wallet-1.sns", address: BONFIDA }, rpcFrom("ip5-tokenized"));
  assert.equal(tokenized.out.sns?.status, "tokenized");
  assert.equal(tokenized.out.sns?.wallet, null);
});
