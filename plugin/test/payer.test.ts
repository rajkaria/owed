import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Rpc } from "../src/chain.ts";
import { handleCheckLine, normalizeHandle, resolvePayer } from "../src/payer.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { inputSchema as splitInput, outputSchema as splitOutput, splitBill } from "../src/tools/split_bill.ts";
import { createInvoice, inputSchema as invoiceInput, outputSchema as invoiceOutput } from "../src/tools/create_invoice.ts";
import { askEveryMonth, inputSchema as monthInput, outputSchema as monthOutput } from "../src/tools/ask_every_month.ts";
import { fixture, json, makeDeps, RECIPIENT, textOf, type Call } from "./helpers.ts";

// F1: payer and requester_handle on every asking tool. API replies are the contract fixtures
// (contract/inbox-fixtures.mjs), so ids, terms and the stored payer line up the way the server makes them.
// The payer wallet is the fixtures' signer; .sns names resolve from real mainnet captures (test/fixtures/sns).

const SAM = fixture("inbox.req.json").payer as string;
const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v";
const OFF_CURVE = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // a USDC token account, not a wallet
const NOW = () => Date.parse("2026-10-18T08:00:00Z");

const snsCalls = (name: string) => (JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sns/${name}.json`, import.meta.url)), "utf8")) as {
  calls: Array<{ method: string; params: unknown[]; result: unknown }>;
}).calls;
function snsRpc(): Rpc {
  const calls = snsCalls("bonfida");
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded RPC call ${method}`);
      return structuredClone(hit.result) as T;
    },
  };
}
const sent = (calls: Call[], path: string) => calls.find((c) => c.method === "POST" && c.url.endsWith(path))?.body as Record<string, unknown> | undefined;
type Out = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
function ok(r: Out) {
  assert.ok(r.isError !== true, `unexpected refusal: ${textOf(r)}`);
  return r;
}
function refused(r: Out): string {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
}

// ---------------------------------------------------------------- resolvePayer

test("normalizeHandle: @ optional, lower case, 1 to 15 of letters, digits and _", () => {
  assert.equal(normalizeHandle("@Sam_OK"), "sam_ok");
  assert.equal(normalizeHandle("raj"), "raj");
  assert.equal(normalizeHandle("@sixteen_chars_xx"), null);
  assert.equal(normalizeHandle("sa-m"), null);
  assert.equal(normalizeHandle(""), null);
});

test("resolvePayer: {handle, wallet} is kept as a label; a handle alone says to call resolve_username first", async () => {
  const { deps } = makeDeps();
  const r = await resolvePayer({ handle: "@Sam_OK", wallet: SAM }, RECIPIENT, deps);
  assert.ok(r.ok);
  assert.deepEqual(r.body, { wallet: SAM, handle: "sam_ok" });
  assert.deepEqual(r.payer, { wallet: SAM, handle: "sam_ok", sns: null });
  assert.match(r.lines[0]!, /^Addressed to @sam_ok \(wallet \S+, as PayBox resolved it; Owed doesn't verify handles\)\.$/);
  const alone = await resolvePayer({ handle: "@sam" }, RECIPIENT, deps);
  assert.ok(!alone.ok);
  assert.match(alone.message, /first call PayBox resolve_username with "@sam", show the user which wallet it resolved to, then pass payer \{handle, wallet\}/);
});

test("resolvePayer: refuses the recipient itself, a token account, nothing at all and a bad handle", async () => {
  const { deps } = makeDeps();
  for (const [input, why] of [
    [{ wallet: RECIPIENT }, /the user's own wallet/],
    [{ wallet: OFF_CURVE }, /isn't a wallet that can sign/],
    [{}, /payer needs a wallet/],
    [{ handle: "sa-m", wallet: SAM }, /isn't an X handle/],
    [{ sns: "sam.sol" }, /SNS|\.sol/],
  ] as const) {
    const r = await resolvePayer(input, RECIPIENT, deps);
    assert.ok(!r.ok, JSON.stringify(input));
    assert.match(r.message, why, JSON.stringify(input));
  }
});

test("resolvePayer: {sns} resolves on Solana; a wallet the name doesn't point to is refused", async () => {
  const { deps } = makeDeps({ rpc: snsRpc });
  const r = await resolvePayer({ sns: "bonfida.sns" }, RECIPIENT, deps);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.deepEqual(r.payer, { wallet: BONFIDA, handle: null, sns: "bonfida.sns" });
  const mismatch = await resolvePayer({ sns: "bonfida.sns", wallet: SAM }, RECIPIENT, deps);
  assert.ok(!mismatch.ok);
  assert.match(mismatch.message, /bonfida\.sns points to Fw1E…Lb1v, not to the wallet given for the payer/);
});

test("handleCheckLine names the handle, the call to make and the wallet it must resolve to", () => {
  assert.equal(handleCheckLine("rajkaria", RECIPIENT),
    `Handle check: this request says it is from @rajkaria (not verified by Owed). Before approving, call PayBox resolve_username('@rajkaria'); if its Solana address isn't ${RECIPIENT}, tell the user and don't approve.`);
});

// ---------------------------------------------------------------- ask_for_money

const askRes = fixture("payer.create-request.res.json");
const ask = (extra: Record<string, unknown> = {}) => askInput.parse({
  recipient: RECIPIENT, amount: "12", payer_name: "Sam", for: "concert tickets", requester_name: "Raj",
  payer: { handle: "@Sam_OK", wallet: SAM }, requester_handle: "@RajKaria", ...extra,
});

test("ask_for_money with payer {handle, wallet}: sends both, checks the server stored them, says where it shows up", async () => {
  const { deps, rec } = makeDeps({ now: NOW, routes: { "POST /api/v1/requests": () => json(201, askRes) } });
  const result = ok(await askForMoney(ask(), deps));
  const body = sent(rec.calls, "/api/v1/requests")!;
  assert.deepEqual(body.payer, { wallet: SAM, handle: "sam_ok" });
  assert.equal(body.requester_handle, "rajkaria");
  const out = askOutput.parse(result.structuredContent);
  assert.deepEqual(out.payer, { wallet: SAM, handle: "sam_ok", sns: null });
  assert.equal(out.requester_handle, "rajkaria");
  const text = textOf(result);
  assert.match(text, /Addressed to @sam_ok \(wallet /);
  assert.match(text, /@sam_ok sees it in their own agent's inbox \(what_do_i_owe\)/);
  assert.match(text, /Payers see "@rajkaria" as your handle, marked not verified by Owed/);
});

test("ask_for_money: a server reply that doesn't carry the payer is not handed out", async () => {
  const { payer: _p, ...unaddressed } = askRes;
  const { deps } = makeDeps({ now: NOW, routes: { "POST /api/v1/requests": () => json(201, unaddressed) } });
  assert.match(refused(await askForMoney(ask(), deps)), /didn't address the request to @sam_ok as asked, so the link wasn't used/);
});

test("ask_for_money: a handle without its wallet is refused before anything is created", async () => {
  const { deps, rec } = makeDeps({ now: NOW, routes: { "POST /api/v1/requests": () => json(201, askRes) } });
  assert.match(refused(await askForMoney(ask({ payer: { handle: "@sam" } }), deps)), /resolve_username/);
  assert.equal(sent(rec.calls, "/api/v1/requests"), undefined);
});

test("ask_for_money offline: the link still works but says it isn't in the payer's inbox", async () => {
  const { deps } = makeDeps({ now: NOW, routes: { "POST /api/v1/requests": () => "network_error" } });
  const result = ok(await askForMoney(ask(), deps));
  const out = askOutput.parse(result.structuredContent);
  assert.equal(out.mode, "offline");
  assert.equal(out.payer, undefined);
  assert.match(textOf(result), /this offline link isn't addressed to @sam_ok: it won't show up in their inbox/);
});

test("ask_for_money with payer {sns}: the plugin resolves the name and sends wallet and name", async () => {
  const res = { ...askRes, payer: { wallet: BONFIDA, handle: null, sns: "bonfida.sns" } };
  const { deps, rec } = makeDeps({ now: NOW, rpc: snsRpc, routes: { "POST /api/v1/requests": () => json(201, res) } });
  const result = ok(await askForMoney(ask({ payer: { sns: "Bonfida.sns" } }), deps));
  assert.deepEqual(sent(rec.calls, "/api/v1/requests")!.payer, { wallet: BONFIDA, sns: "bonfida.sns" });
  assert.match(textOf(result), /Addressed to bonfida\.sns \(it points to Fw1E…Lb1v on Solana right now\)/);
});

test("ask_for_money on Base: the payer is still the Solana wallet of their inbox", async () => {
  const baseRes = { ...fixture("base.create-request.res.json"), payer: { wallet: SAM, handle: "sam_ok", sns: null } };
  const { deps, rec } = makeDeps({ now: NOW, routes: { "POST /api/v1/requests": () => json(201, baseRes) } });
  const baseReq = fixture("base.create-request.req.json");
  const result = ok(await askForMoney(askInput.parse({
    recipient: baseReq.recipient, amount: baseReq.amount, chain: "base", payer: { handle: "sam_ok", wallet: SAM },
  }), deps));
  assert.deepEqual(sent(rec.calls, "/api/v1/requests")!.payer, { wallet: SAM, handle: "sam_ok" });
  assert.match(textOf(result), /@sam_ok sees it in their own agent's inbox/);
});

// ---------------------------------------------------------------- split_bill

const groupRes = fixture("payer.groups.create.res.json");
const LEE = groupRes.shares[2].payer.wallet as string;
const split = (people?: unknown[]) => splitInput.parse({
  recipient: RECIPIENT, total: "0.3", title: "Climbing gym", requester_name: "Raj", requester_handle: "rajkaria",
  people: people ?? [{ name: "Sam", payer: { handle: "@sam_ok", wallet: SAM } }, { name: "Ana" }, { name: "Lee", payer: { wallet: LEE } }],
});

test("split_bill: a payer per person, each share checked to carry it; shares without one are unaddressed", async () => {
  const { deps, rec } = makeDeps({ now: NOW, routes: { "POST /api/v1/groups": () => json(201, groupRes) } });
  const result = ok(await splitBill(split(), deps));
  const body = sent(rec.calls, "/api/v1/groups")!;
  assert.deepEqual((body.people as Array<{ payer?: unknown }>).map((p) => p.payer ?? null), [{ wallet: SAM, handle: "sam_ok" }, null, { wallet: LEE }]);
  assert.equal(body.requester_handle, "rajkaria");
  const out = splitOutput.parse(result.structuredContent);
  assert.deepEqual(out.shares.map((s) => s.payer?.wallet ?? null), [SAM, null, LEE]);
  assert.equal(out.requester_handle, "rajkaria");
  assert.match(textOf(result), /In their own agent's inbox \(what_do_i_owe\): Sam as @sam_ok, Lee as /);
});

test("split_bill: a share the server didn't address as asked stops the whole split", async () => {
  const wrong = { ...groupRes, shares: groupRes.shares.map((s: Record<string, unknown>, i: number) => (i === 0 ? { ...s, payer: undefined } : s)) };
  const { deps } = makeDeps({ now: NOW, routes: { "POST /api/v1/groups": () => json(201, wrong) } });
  assert.match(refused(await splitBill(split(), deps)), /didn't address the request to @sam_ok as asked/);
});

test("split_bill: one person's bad payer refuses the split before anything is created", async () => {
  const { deps, rec } = makeDeps({ now: NOW, routes: { "POST /api/v1/groups": () => json(201, groupRes) } });
  assert.match(refused(await splitBill(split([{ name: "Sam", payer: { handle: "sam" } }, { name: "Ana" }]), deps)), /resolve_username/);
  assert.equal(sent(rec.calls, "/api/v1/groups"), undefined);
});

// ---------------------------------------------------------------- create_invoice and ask_every_month

test("create_invoice: the client as a payer by .sns name", async () => {
  const invoiceRes = fixture("payer.invoices.create.res.json");
  const req = fixture("payer.invoices.create.req.json");
  const { deps, rec } = makeDeps({ now: NOW, rpc: snsRpc, routes: { "POST /api/v1/invoices": () => json(201, invoiceRes) } });
  const result = ok(await createInvoice(invoiceInput.parse({
    recipient: req.recipient, business_name: req.business_name, client_name: req.client_name, items: req.items, due_date: req.due_date,
    invoice_number: req.invoice_number, payer: { sns: "bonfida.sns" }, requester_handle: "@LenaStudio",
  }), deps));
  const body = sent(rec.calls, "/api/v1/invoices")!;
  assert.deepEqual(body.payer, { wallet: BONFIDA, sns: "bonfida.sns" });
  assert.equal(body.requester_handle, "lenastudio");
  const out = invoiceOutput.parse(result.structuredContent);
  assert.deepEqual(out.payer, { wallet: BONFIDA, handle: null, sns: "bonfida.sns" });
  assert.match(textOf(result), /bonfida\.sns sees it in their own agent's inbox/);
});

test("ask_every_month: every month's request is addressed to the payer", async () => {
  const scheduleRes = fixture("payer.schedules.create.res.json");
  const { deps, rec } = makeDeps({ now: () => Date.parse("2026-10-18T09:30:00Z"), routes: { "POST /api/v1/schedules": () => json(201, scheduleRes) } });
  const result = ok(await askEveryMonth(monthInput.parse({
    recipient: RECIPIENT, amount: "450", payer_name: "Sam", for: "rent", requester_name: "Raj", day_of_month: 1,
    payer: { handle: "@sam_ok", wallet: SAM }, requester_handle: "rajkaria",
  }), deps, async () => ({ ok: true, screening: "clear" })));
  assert.deepEqual(sent(rec.calls, "/api/v1/schedules")!.payer, { wallet: SAM, handle: "sam_ok" });
  const out = monthOutput.parse(result.structuredContent);
  assert.deepEqual(out.payer, { wallet: SAM, handle: "sam_ok", sns: null });
  assert.match(textOf(result), /@sam_ok sees each month's request in their own agent's inbox/);
  const { payer: _p, ...unaddressed } = scheduleRes;
  const { deps: d2 } = makeDeps({ now: () => Date.parse("2026-10-18T09:30:00Z"), routes: { "POST /api/v1/schedules": () => json(201, unaddressed) } });
  assert.match(refused(await askEveryMonth(monthInput.parse({
    recipient: RECIPIENT, amount: "450", payer_name: "Sam", for: "rent", day_of_month: 1, payer: { handle: "@sam_ok", wallet: SAM },
  }), d2, async () => ({ ok: true, screening: "clear" }))), /without addressing it to @sam_ok/);
});
