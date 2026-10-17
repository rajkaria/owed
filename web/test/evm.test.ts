import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isChecksumAddress, parseEvmAddress, sameEvmAddress, toChecksumAddress } from "@/lib/evm/address";
import { BASE_USDC, basescanTx, eip681Transfer, isTxHash, parseEip681Transfer, TRANSFER_TOPIC } from "@/lib/evm/base";
import { keccak256Hex } from "@/lib/evm/keccak";
import { assignTransfers, CREATION_SLACK_SECONDS, estimateBlockTime, estimateStartBlock, type TimedTransfer } from "@/lib/evm/match";
import { BaseRpcError, decodeTransferLog, getBlock, getReceipt, scanTransfersTo } from "@/lib/evm/rpc";
import { isRequestId, requestIdFor } from "@/lib/ids";
import { replay, scanFixture, settlement } from "./evm-helpers.ts";

// W3-B Base requests: pure EVM helpers on the shared vectors, matching rules, and the Base RPC
// client replaying real mainnet exchanges (test/fixtures/evm/capture.ts).

const vectors = JSON.parse(readFileSync(new URL("../../plugin/test/fixtures/evm-vectors.json", import.meta.url), "utf8")) as {
  keccak256: Array<{ input_utf8: string; keccak256: string }>;
  eip55: { valid: string[]; normalize: Array<{ input: string; checksummed: string }>; invalid: string[] };
  request_ids: Array<{ chain: "solana" | "base" | null; recipient: string; token: "USDC" | "SOL"; amount_atomic: string; reference: string; id: string }>;
  eip681: Array<{ recipient: string; amount_atomic: string; url: string }>;
};

test("keccak256, EIP-55 and EIP-681 match the vectors the plugin runs", () => {
  for (const v of vectors.keccak256) assert.equal(keccak256Hex(v.input_utf8), v.keccak256);
  assert.equal(`0x${keccak256Hex("Transfer(address,address,uint256)")}`, TRANSFER_TOPIC);
  for (const a of vectors.eip55.valid) assert.equal(parseEvmAddress(a), toChecksumAddress(a));
  for (const v of vectors.eip55.normalize) assert.equal(parseEvmAddress(v.input), v.checksummed);
  for (const bad of vectors.eip55.invalid) assert.equal(parseEvmAddress(bad), null, bad);
  assert.ok(isChecksumAddress(BASE_USDC));
  assert.ok(sameEvmAddress(BASE_USDC, BASE_USDC.toUpperCase().replace("0X", "0x")));
  for (const v of vectors.eip681) {
    assert.equal(eip681Transfer(v.recipient, BigInt(v.amount_atomic)), v.url);
    assert.equal(parseEip681Transfer(v.url)?.amountAtomic, BigInt(v.amount_atomic));
  }
  assert.ok(isTxHash(settlement.hash));
  assert.equal(basescanTx(settlement.hash), `https://basescan.org/tx/${settlement.hash}`);
});

test("request ids: Solana ids unchanged (JArQ6g9JvoWr), Base ids commit to the chain", () => {
  for (const v of vectors.request_ids) {
    const id = requestIdFor({ recipient: v.recipient, token: v.token, amountAtomic: BigInt(v.amount_atomic), reference: v.reference, ...(v.chain ? { chain: v.chain } : {}) });
    assert.equal(id, v.id);
    assert.ok(isRequestId(id));
  }
  const b = vectors.request_ids.find((v) => v.chain === "base")!;
  assert.notEqual(requestIdFor({ recipient: b.recipient, token: "USDC", amountAtomic: BigInt(b.amount_atomic), reference: b.reference }), b.id);
});

test("decodeTransferLog keeps real USDC transfers and drops other tokens, removed logs and junk", () => {
  const raw = (scanFixture.exchanges.find((e) => e.request.method === "eth_getLogs" && e.url.includes("publicnode"))!.response.body as { result: unknown[] }).result;
  const decoded = raw.map(decodeTransferLog);
  assert.ok(decoded.length >= 3 && decoded.every((d) => d !== null));
  assert.deepEqual(decoded.map((d) => d!.value.toString()), scanFixture.transfers.map((t) => t.value));
  for (const d of decoded) assert.equal(d!.to, toChecksumAddress(scanFixture.recipient));
  const one = raw[0] as Record<string, unknown>;
  assert.equal(decodeTransferLog({ ...one, address: "0x4200000000000000000000000000000000000006" }), null, "another token");
  assert.equal(decodeTransferLog({ ...one, removed: true }), null, "reorged out");
  assert.equal(decodeTransferLog({ ...one, topics: (one.topics as string[]).slice(0, 2) }), null, "not a Transfer");
  assert.equal(decodeTransferLog({ ...one, data: "0x01" }), null, "bad amount word");
  assert.equal(decodeTransferLog(null), null);
});

const t = (value: bigint, at: number, block: number, tx: string, logIndex = 0, to = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"): TimedTransfer =>
  ({ blockNumber: block, blockTimestamp: at, at, txHash: tx, logIndex, from: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", to, value });
const R = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("assignTransfers: exact amount, after creation, oldest request first, one transaction per request", () => {
  const requests = [
    { id: "newer", recipient: R, amountAtomic: 500_000n, createdUnix: 2000 },
    { id: "older", recipient: R, amountAtomic: 500_000n, createdUnix: 1000 },
    { id: "other", recipient: R, amountAtomic: 700_000n, createdUnix: 1000 },
  ];
  const transfers = [
    t(500_001n, 1500, 10, hash(1)), // not exact: ignored
    t(499_999n, 1500, 11, hash(2)), // not exact: ignored
    t(500_000n, 900, 9, hash(3)), // before every request: ignored
    t(500_000n, 2500, 30, hash(5)),
    t(500_000n, 1500, 20, hash(4)),
  ];
  const got = assignTransfers(requests, transfers, new Set());
  assert.deepEqual(got.map((a) => [a.requestId, a.transfer.txHash]), [["older", hash(4)], ["newer", hash(5)]]);

  // A transaction that already settles a request (any rail) settles nothing else.
  assert.deepEqual(assignTransfers(requests, transfers, new Set([hash(4).toUpperCase().replace("0X", "0x")])).map((a) => [a.requestId, a.transfer.txHash]), [["older", hash(5)]]);
  // One transaction with two matching logs still settles only one request.
  const twoLogs = [t(500_000n, 2500, 30, hash(6), 1), t(500_000n, 2500, 30, hash(6), 2)];
  assert.equal(assignTransfers(requests, twoLogs, new Set()).length, 1);
  // A block may be stamped a few seconds before the request's own timestamp, no more.
  assert.equal(assignTransfers([requests[1]], [t(500_000n, 1000 - CREATION_SLACK_SECONDS, 5, hash(7))], new Set()).length, 1);
  assert.equal(assignTransfers([requests[1]], [t(500_000n, 1000 - CREATION_SLACK_SECONDS - 1, 5, hash(7))], new Set()).length, 0);
  // Another recipient's transfer never pays this request.
  assert.equal(assignTransfers([requests[1]], [t(500_000n, 1500, 5, hash(8), 0, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")], new Set()).length, 0);
});

test("block time and start-block estimates use 2-second Base blocks, starting a minute early", () => {
  const head = scanFixture.head;
  assert.equal(estimateBlockTime(head.number - 8000, head), head.timestamp - 16000);
  assert.equal(estimateBlockTime(head.number - 8000, head), scanFixture.start_block_time, "the recorded header agrees with the 2 s estimate");
  assert.equal(estimateStartBlock(head.timestamp - 16000 + 60, head), head.number - 8000);
  assert.equal(estimateStartBlock(head.timestamp + 999, head), head.number, "never past the head");
  assert.equal(estimateStartBlock(0, head), 0);
});

test("scanTransfersTo: recent blocks in one publicnode call, older ones from tenderly 1,000 at a time", async () => {
  const { head, recent_from, archive_from } = scanFixture;
  const calls: string[] = [];
  const recent = await scanTransfersTo(scanFixture.recipient, recent_from, head.number, replay(scanFixture.exchanges, { calls }));
  assert.equal(recent.scannedTo, head.number);
  assert.deepEqual(recent.logs.map((l) => l.txHash), scanFixture.transfers.map((x) => x.txHash));
  assert.deepEqual(calls, ["base-rpc.publicnode.com eth_getLogs"]);

  calls.length = 0;
  const all = await scanTransfersTo(scanFixture.recipient, archive_from, head.number, replay(scanFixture.exchanges, { calls }));
  assert.equal(all.scannedTo, head.number);
  assert.deepEqual(calls.sort(), [...Array(3).fill("base.gateway.tenderly.co eth_getLogs"), "base-rpc.publicnode.com eth_getLogs"].sort());
  assert.ok(all.logs.length >= recent.logs.length);
});

test("scanTransfersTo: archive down -> nothing read, so it throws; never claims blocks it didn't read", async () => {
  const { head, archive_from, recent_from } = scanFixture;
  await assert.rejects(scanTransfersTo(scanFixture.recipient, archive_from, head.number, replay(scanFixture.exchanges, { down: ["base.gateway.tenderly.co"] })), BaseRpcError);
  // publicnode down for the recent window: tenderly takes it in 1,000-block chunks (not recorded here, so they fail) -> throws.
  await assert.rejects(scanTransfersTo(scanFixture.recipient, recent_from, head.number, replay(scanFixture.exchanges, { down: ["base-rpc.publicnode.com"] })), BaseRpcError);
  // An empty range reads nothing and makes no call.
  const calls: string[] = [];
  assert.deepEqual(await scanTransfersTo(scanFixture.recipient, head.number + 1, head.number, replay([], { calls })), { logs: [], scannedTo: head.number });
  assert.equal(calls.length, 0);
});

test("getBlock and getReceipt: head from publicnode, an old receipt from tenderly after publicnode's 403", async () => {
  const o = replay(scanFixture.exchanges);
  assert.deepEqual(await getBlock("latest", o), scanFixture.head);
  assert.equal((await getBlock(scanFixture.recent_from, o)).timestamp, scanFixture.start_block_time);
  const first = scanFixture.transfers[0];
  const r = await getReceipt(first.txHash, o);
  assert.equal(r?.status, "success");
  assert.ok(r?.logs.some((l) => l.txHash === first.txHash && l.value === BigInt(first.value) && sameEvmAddress(l.to, scanFixture.recipient)));
  // The real PayAI settlement: a USDC transferWithAuthorization batched through Multicall3.
  const s = await getReceipt(settlement.hash, replay(settlement.exchanges));
  assert.equal(s?.status, "success");
  assert.deepEqual(s?.logs.map((l) => [l.from, l.to, l.value.toString()]), settlement.transfers.map((x) => [x.from, x.to, x.value]));
});
