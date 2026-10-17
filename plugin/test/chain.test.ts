import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { findPayment, makeRpc, payerReadiness, RpcError, type Rpc } from "../src/chain.ts";

// ---------------------------------------------------------------------------------------------
// Replay of real mainnet JSON-RPC exchanges captured by test/fixtures/capture.mjs.
// Any call that was not recorded (different method or params) throws, so these tests also pin
// the exact request shapes chain.ts sends.

interface Call { method: string; params: unknown[]; result: unknown }
interface Fixture { name: string; query: Record<string, unknown>; calls: Call[] }

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

function replay(...calls: Call[]): Rpc & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded call ${method} ${JSON.stringify(params)}`);
      log.push(`${method} ${typeof params[0] === "string" ? params[0].slice(0, 8) : ""}`.trim());
      return structuredClone(hit.result) as T;
    },
  };
}

const sigsCall = (f: Fixture) => f.calls.find((c) => c.method === "getSignaturesForAddress")!;
const txCall = (f: Fixture, sig: string) => f.calls.find((c) => c.method === "getTransaction" && c.params[0] === sig)!;

const SOL_PAY = fixture("sol-reference-payment");
const USDC_KEY = fixture("usdc-appended-key-transfers");
const FAILED = fixture("failed-usdc-transfer");
const UNUSED = fixture("unused-reference");

const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

const USDC_REF = "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg";
const OLDEST = "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK";
const MIDDLE = "3ZdwwA4rYiiXodsuZ7374PEahd9iXeiq1VSvVXz17acEcpv1XhV45hu2gPZCXgun4gbm3Sh7vS72NS59rzTsmD2a";
const ACTIVE_WALLET = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT";
const GAQ = "GAqbB5TDD6G6KSZwtuTMicuKiyZH9XwkanBkdDs2FLie"; // credited 387 (oldest), 141101 (middle), 155588 (newest)
const V83 = "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"; // credited 2719385 (middle)
const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

// ---------------------------------------------------------------------------------------------
// findPayment

test("SOL: a reference payment of the exact amount is paid, with payer, signature and time", async () => {
  const r = await findPayment(replay(...SOL_PAY.calls), { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_000n });
  assert.deepEqual(r, {
    status: "paid",
    signature: SOL_SIG,
    payer: SOL_PAYER,
    amountPaidAtomic: 3_027_000n,
    paidAt: "2026-10-17T04:39:36Z",
  });
});

test("amountAtomic 0n (a link without an amount): any credit is paid", async () => {
  const r = await findPayment(replay(...SOL_PAY.calls), { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 0n });
  assert.equal(r.status, "paid");
  assert.equal(r.amountPaidAtomic, 3_027_000n);
});

test("SOL: one lamport short is underpaid and reports what arrived", async () => {
  const r = await findPayment(replay(...SOL_PAY.calls), { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_001n });
  assert.equal(r.status, "underpaid");
  assert.equal(r.amountPaidAtomic, 3_027_000n);
  assert.equal(r.signature, SOL_SIG);
});

test("SOL: the reference on a transfer to someone else is ignored", async () => {
  const r = await findPayment(replay(...SOL_PAY.calls), { reference: SOL_REF, recipient: SOL_PAYER, token: "SOL", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("a SOL transfer does not satisfy a USDC request", async () => {
  const r = await findPayment(replay(...SOL_PAY.calls), { reference: SOL_REF, recipient: SOL_PAYEE, token: "USDC", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("USDC: credit is the recipient's net USDC change; oldest matching transaction wins", async () => {
  const rpc = replay(...USDC_KEY.calls);
  const r = await findPayment(rpc, { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 387n });
  assert.deepEqual(r, {
    status: "paid",
    signature: OLDEST,
    payer: ACTIVE_WALLET,
    amountPaidAtomic: 387n,
    paidAt: "2026-10-17T04:42:10Z",
  });
  // stops at the first payment: one signature list, one transaction
  assert.deepEqual(rpc.log, ["getSignaturesForAddress Ef4piUis", "getTransaction 2zsb1Wk1"]);
});

test("USDC: an earlier underpayment does not hide a later full payment", async () => {
  const r = await findPayment(replay(...USDC_KEY.calls), { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 141_101n });
  assert.equal(r.status, "paid");
  assert.equal(r.signature, MIDDLE);
  assert.equal(r.amountPaidAtomic, 141_101n);
});

test("USDC: no single transaction covers the amount -> underpaid, oldest partial payment reported", async () => {
  const r = await findPayment(replay(...USDC_KEY.calls), { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 200_000n });
  assert.equal(r.status, "underpaid");
  assert.equal(r.signature, OLDEST);
  assert.equal(r.amountPaidAtomic, 387n);
});

test("USDC: another owner credited in the same transactions", async () => {
  const r = await findPayment(replay(...USDC_KEY.calls), { reference: USDC_REF, recipient: V83, token: "USDC", amountAtomic: 2_719_385n });
  assert.equal(r.status, "paid");
  assert.equal(r.signature, MIDDLE);
});

test("USDC: references on transfers that never credit the recipient leave the request open", async () => {
  const rpc = replay(...USDC_KEY.calls);
  const r = await findPayment(rpc, { reference: USDC_REF, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
  assert.equal(rpc.log.length, 11); // the list plus all ten transactions
});

test("an unused reference is open after one call", async () => {
  const rpc = replay(...UNUSED.calls);
  const r = await findPayment(rpc, { reference: UNUSED.query.reference as string, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
  assert.equal(rpc.log.length, 1);
});

test("signatures the list marks as failed are never fetched", async () => {
  const list = structuredClone(sigsCall(SOL_PAY));
  (list.result as Array<{ err: unknown }>)[0]!.err = { InstructionError: [0, "Custom"] };
  const r = await findPayment(replay(list), { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("a fetched transaction with meta.err (real failed USDC transfer) is skipped", async () => {
  const failedSig = FAILED.query.signature as string;
  const list: Call = {
    method: "getSignaturesForAddress",
    params: [SOL_REF, { limit: 10, commitment: "confirmed" }],
    // The list can lag the transaction status; only meta.err is authoritative.
    result: [{ signature: failedSig, err: null, blockTime: 1792211975, slot: 0 }],
  };
  const tx = FAILED.calls[0]!;
  assert.ok((tx.result as { meta: { err: unknown } }).meta.err, "fixture is a failed transaction");
  const r = await findPayment(replay(list, tx), { reference: SOL_REF, recipient: SOL_PAYER, token: "USDC", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("a transaction the node cannot return yet (null) is skipped", async () => {
  const nullTx: Call = { ...txCall(SOL_PAY, SOL_SIG), result: null };
  const r = await findPayment(replay(sigsCall(SOL_PAY), nullTx), { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("a failed transaction fetch is not reported as open", async () => {
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === "getSignaturesForAddress") return structuredClone(sigsCall(SOL_PAY).result) as T;
      throw new RpcError(`getTransaction failed for ${String(params[0]).slice(0, 8)}`);
    },
  };
  await assert.rejects(findPayment(rpc, { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }), RpcError);
});

test("a payment found before a failed fetch is still paid", async () => {
  const list: Call = { ...sigsCall(USDC_KEY) };
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === "getSignaturesForAddress") return structuredClone(list.result) as T;
      if (params[0] === OLDEST) return structuredClone(txCall(USDC_KEY, OLDEST).result) as T;
      throw new RpcError("node unavailable");
    },
  };
  const r = await findPayment(rpc, { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 387n });
  assert.equal(r.status, "paid");
});

test("gives up with a plain error when RPC exceeds the time budget", async () => {
  const hang: Rpc = { call: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(
    findPayment(hang, { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }, 50),
    /Solana RPC did not answer in time/,
  );
  assert.ok(Date.now() - started < 1000);
});

test("refuses malformed addresses before any RPC call", async () => {
  const none = replay();
  await assert.rejects(findPayment(none, { reference: "nope", recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }), /reference/);
  await assert.rejects(findPayment(none, { reference: SOL_REF, recipient: "0OIl", token: "SOL", amountAtomic: 1n }), /recipient/);
  assert.equal(none.log.length, 0);
});

// ---------------------------------------------------------------------------------------------
// payerReadiness

function ready(name: string) {
  const f = fixture(name);
  const accounts = (f.calls[0]!.result as { value: Array<{ lamports: number; data: { parsed: { info: { state: string; tokenAmount: { uiAmountString: string } } } } } | null> }).value;
  return { rpc: replay(...f.calls), fresh: f.query.fresh as string, accounts, calls: f.calls };
}

test("USDC: an empty sender is told its balance and the request amount", async () => {
  const { rpc, fresh, accounts } = ready("readiness-usdc-empty-sender");
  assert.deepEqual([accounts[0], accounts[1]], [null, null]);
  const r = await payerReadiness(rpc, { sender: fresh, recipient: ACTIVE_WALLET, token: "USDC", amountAtomic: 15_000_000n });
  assert.deepEqual(r, { ok: false, reason: "Your wallet has 0 USDC; this request is 15 USDC.", recipientAtaExists: true });
  assert.equal(rpc.log.length, 1);
});

test("USDC: a funded sender paying a new address is ready and needs the account created", async () => {
  const { rpc, fresh, accounts } = ready("readiness-usdc-new-recipient");
  assert.equal(accounts[2], null);
  const r = await payerReadiness(rpc, { sender: ACTIVE_WALLET, recipient: fresh, token: "USDC", amountAtomic: 15_000_000n });
  assert.deepEqual(r, { ok: true, recipientAtaExists: false });
});

test("USDC: a funded sender paying an existing USDC account", async () => {
  const { rpc } = ready("readiness-usdc-existing-recipient");
  const r = await payerReadiness(rpc, { sender: ACTIVE_WALLET, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1_000_000n });
  assert.deepEqual(r, { ok: true, recipientAtaExists: true });
});

test("USDC: asking for more than the sender holds names both amounts", async () => {
  const { rpc, accounts } = ready("readiness-usdc-existing-recipient");
  // The RPC's own uiAmountString is the oracle for our bigint formatting.
  const held = accounts[1]!.data.parsed.info.tokenAmount.uiAmountString;
  const r = await payerReadiness(rpc, { sender: ACTIVE_WALLET, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 100_000_000_000n });
  assert.deepEqual(r, { ok: false, reason: `Your wallet has ${held} USDC; this request is 100000 USDC.`, recipientAtaExists: true });
});

test("USDC: enough USDC but under 0.003 SOL for fees", async () => {
  const { calls } = ready("readiness-usdc-existing-recipient");
  const call = structuredClone(calls[0]!);
  // Derived from the real capture: same accounts, sender lamports lowered to 0.002 SOL.
  (call.result as { value: Array<{ lamports: number }> }).value[0]!.lamports = 2_000_000;
  const r = await payerReadiness(replay(call), { sender: ACTIVE_WALLET, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1_000_000n });
  assert.deepEqual(r, { ok: false, reason: "Your wallet needs about 0.003 SOL for fees; it has 0.002 SOL.", recipientAtaExists: true });
});

test("USDC: a frozen sender account cannot send", async () => {
  const { calls } = ready("readiness-usdc-existing-recipient");
  const call = structuredClone(calls[0]!);
  // Derived from the real capture: the sender's token account state set to frozen.
  (call.result as { value: Array<{ data: { parsed: { info: { state: string } } } }> }).value[1]!.data.parsed.info.state = "frozen";
  const r = await payerReadiness(replay(call), { sender: ACTIVE_WALLET, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1_000_000n });
  assert.deepEqual(r, { ok: false, reason: "Your USDC account is frozen, so it cannot send.", recipientAtaExists: true });
});

test("USDC: a frozen recipient account cannot receive", async () => {
  const { calls } = ready("readiness-usdc-existing-recipient");
  const call = structuredClone(calls[0]!);
  // Derived from the real capture: the recipient's token account state set to frozen.
  (call.result as { value: Array<{ data: { parsed: { info: { state: string } } } }> }).value[2]!.data.parsed.info.state = "frozen";
  const r = await payerReadiness(replay(call), { sender: ACTIVE_WALLET, recipient: TEAM_WALLET, token: "USDC", amountAtomic: 1_000_000n });
  assert.deepEqual(r, { ok: false, reason: "The recipient's USDC account is frozen, so it cannot receive.", recipientAtaExists: true });
});

test("SOL: a funded sender paying an existing account is ready", async () => {
  const { rpc } = ready("readiness-sol-existing-recipient");
  const r = await payerReadiness(rpc, { sender: SOL_PAYER, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_000n });
  assert.deepEqual(r, { ok: true, recipientAtaExists: true });
  assert.equal(rpc.log.length, 1);
});

test("SOL: the amount plus the fee reserve must fit in the balance", async () => {
  const { accounts } = ready("readiness-sol-existing-recipient");
  assert.equal(accounts[0]!.lamports, 29_286_626_676, "re-captured: update the SOL amounts below");
  const r = await payerReadiness(ready("readiness-sol-existing-recipient").rpc, { sender: SOL_PAYER, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 30_000_000_000n });
  assert.deepEqual(r, { ok: false, reason: "Your wallet has 29.286626676 SOL; this request is 30 SOL.", recipientAtaExists: true });
  const r2 = await payerReadiness(ready("readiness-sol-existing-recipient").rpc, { sender: SOL_PAYER, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 29_285_000_000n });
  assert.deepEqual(r2, {
    ok: false,
    reason: "Your wallet needs about 0.003 SOL for fees on top of the 29.285 SOL request; it has 29.286626676 SOL.",
    recipientAtaExists: true,
  });
});

test("SOL: a new address must receive at least the cluster's rent-exempt minimum", async () => {
  const { rpc, fresh, calls } = ready("readiness-sol-new-recipient");
  assert.equal(calls[1]!.result, 650_240, "re-captured: update the rent amounts below");
  const low = await payerReadiness(rpc, { sender: SOL_PAYER, recipient: fresh, token: "SOL", amountAtomic: 650_239n });
  assert.deepEqual(low, {
    ok: false,
    reason: "This address has never been used, so the first payment must be at least 0.00065024 SOL.",
    recipientAtaExists: true,
  });
  const ok = await payerReadiness(ready("readiness-sol-new-recipient").rpc, { sender: SOL_PAYER, recipient: fresh, token: "SOL", amountAtomic: 650_240n });
  assert.deepEqual(ok, { ok: true, recipientAtaExists: true });
});

test("readiness gives up with a plain error when RPC exceeds the time budget", async () => {
  const hang: Rpc = { call: () => new Promise(() => {}) };
  await assert.rejects(
    payerReadiness(hang, { sender: SOL_PAYER, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }, 50),
    /Solana RPC did not answer in time/,
  );
});

// ---------------------------------------------------------------------------------------------
// makeRpc transport (local HTTP servers; no chain data involved)

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function serve(handler: (body: { method: string; id: number }, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(JSON.parse(raw), res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("makeRpc returns the result and sends a JSON-RPC 2.0 request", async () => {
  let seen: unknown;
  const url = await serve((b, res) => {
    seen = b;
    json(res, 200, { jsonrpc: "2.0", id: b.id, result: 457906798 });
  });
  assert.equal(await makeRpc([url]).call<number>("getSlot", [{ commitment: "confirmed" }]), 457906798);
  assert.deepEqual({ ...(seen as object), id: 0 }, { jsonrpc: "2.0", id: 0, method: "getSlot", params: [{ commitment: "confirmed" }] });
});

test("makeRpc falls through to the next url on timeout, HTTP error and node errors", async () => {
  const slow = await serve(() => {}); // never answers
  const http500 = await serve((_b, res) => json(res, 500, { error: "boom" }));
  const behind = await serve((b, res) => json(res, 200, { jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "Node is behind by 120 slots" } }));
  const good = await serve((b, res) => json(res, 200, { jsonrpc: "2.0", id: b.id, result: "ok" }));
  const started = Date.now();
  assert.equal(await makeRpc([slow, http500, behind, good], 200).call<string>("getHealth", []), "ok");
  assert.ok(Date.now() - started < 2000);
});

test("makeRpc surfaces request errors at once instead of retrying them elsewhere", async () => {
  let secondHit = false;
  const bad = await serve((b, res) => json(res, 200, { jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Invalid param: WrongSize" } }));
  const other = await serve((b, res) => {
    secondHit = true;
    json(res, 200, { jsonrpc: "2.0", id: b.id, result: [] });
  });
  await assert.rejects(makeRpc([bad, other]).call("getSignaturesForAddress", ["x"]), (e: unknown) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.code, -32602);
    assert.match(e.message, /Invalid param: WrongSize/);
    return true;
  });
  assert.equal(secondHit, false);
});

test("makeRpc reports the last failure when every url fails", async () => {
  const behind = await serve((b, res) => json(res, 200, { jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "Node is behind" } }));
  const garbage = await serve((_b, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>rate limited</html>");
  });
  await assert.rejects(makeRpc([behind, garbage], 500).call("getSlot", []), (e: unknown) => {
    assert.ok(e instanceof RpcError);
    assert.match(e.message, /not valid JSON-RPC/);
    return true;
  });
});

test("makeRpc needs at least one url", () => {
  assert.throws(() => makeRpc([]), /at least one/);
});
