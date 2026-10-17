// Re-capture the Base fixtures from mainnet (read-only), through the real lib/evm code with a
// recording fetch, so tests replay exactly the calls the code makes:
//   cd web && node --import ./test/setup.mjs test/fixtures/evm/capture.ts [recipient]
// scan.json: a real recipient's incoming USDC transfers over the recent window (publicnode) and
//   three older 1,000-block chunks (tenderly), the head, one start-block header and one receipt.
// x402-settlement.json: a recent USDC transferWithAuthorization submitted by one of PayAI's
//   Base signers (an x402 `exact` settlement), with its receipt and the transaction.
import { writeFileSync } from "node:fs";
import { getBlock, getReceipt, scanTransfersTo, TENDERLY_URL, PUBLICNODE_URL, type BaseRpcOptions } from "../../../lib/evm/rpc.ts";

const dir = new URL("./", import.meta.url);
type Exchange = { url: string; request: { method: string; params: unknown[] }; response: unknown };

function recorder() {
  const exchanges: Exchange[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init);
    const text = await res.text();
    const body = JSON.parse(String(init?.body));
    exchanges.push({ url: String(input), request: { method: body.method, params: body.params }, response: { status: res.status, body: JSON.parse(text) } });
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { exchanges, o: { fetch: doFetch, timeoutMs: 15000 } as BaseRpcOptions };
}

async function raw(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ---- scan.json
const recipient = process.argv[2] ?? "0xc1d8b41C92Cd33B96B636cf1E4496335421Bd916";
{
  const { exchanges, o } = recorder();
  const head = await getBlock("latest", o);
  const recent = await scanTransfersTo(recipient, head.number - 8000, head.number, o);
  const archive = await scanTransfersTo(recipient, head.number - 12000, head.number, o);
  const startTime = await getBlock(head.number - 8000, o);
  const receipt = recent.logs.length ? await getReceipt(recent.logs[0].txHash, o) : null;
  writeFileSync(new URL("scan.json", dir), JSON.stringify({
    _about: "Real Base mainnet JSON-RPC exchanges recorded by test/fixtures/evm/capture.ts through lib/evm/rpc.ts.",
    captured_at: new Date().toISOString(), recipient, head,
    recent_from: head.number - 8000, archive_from: head.number - 12000, start_block_time: startTime.timestamp,
    transfers: recent.logs.map((l) => ({ ...l, value: l.value.toString() })),
    archive_transfers: archive.logs.length, receipt_status: receipt?.status ?? null,
    exchanges,
  }, null, 1) + "\n");
  console.log(`scan.json: head ${head.number}, ${recent.logs.length} recent transfers, ${archive.logs.length} incl. archive, ${exchanges.length} exchanges`);
}

// ---- x402-settlement.json
{
  const supported = (await (await fetch("https://facilitator.payai.network/supported")).json()) as { signers?: Record<string, string[]> };
  const signers = new Set((supported.signers?.["eip155:*"] ?? []).map((s) => s.toLowerCase()));
  const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"; // AuthorizationUsed(address,bytes32)
  const head = Number.parseInt(String(await raw(PUBLICNODE_URL, "eth_blockNumber", [])), 16);
  let found: { hash: string } | null = null;
  for (let back = 0; back < 9000 && !found; back += 500) {
    const logs = (await raw(PUBLICNODE_URL, "eth_getLogs", [{
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", topics: [AUTHORIZATION_USED],
      fromBlock: `0x${(head - back - 499).toString(16)}`, toBlock: `0x${(head - back).toString(16)}`,
    }])) as Array<{ transactionHash: string }>;
    for (const l of logs.slice(0, 60)) {
      const tx = (await raw(PUBLICNODE_URL, "eth_getTransactionByHash", [l.transactionHash])) as { from: string; to: string } | null;
      if (tx && signers.has(tx.from.toLowerCase())) { found = { hash: l.transactionHash }; break; }
    }
  }
  if (!found) throw new Error("no PayAI Base settlement found in the recent window");
  const { exchanges, o } = recorder();
  const receipt = await getReceipt(found.hash, o);
  const tx = await raw(PUBLICNODE_URL, "eth_getTransactionByHash", [found.hash]);
  writeFileSync(new URL("x402-settlement.json", dir), JSON.stringify({
    _about: "A real x402 `exact` settlement on Base: USDC transferWithAuthorization submitted by a PayAI signer. Recorded by capture.ts.",
    captured_at: new Date().toISOString(), hash: found.hash, transaction: tx,
    transfers: receipt?.logs.map((l) => ({ ...l, value: l.value.toString() })) ?? [], exchanges,
  }, null, 1) + "\n");
  console.log(`x402-settlement.json: ${found.hash}, ${receipt?.logs.length ?? 0} USDC transfers, tenderly ${TENDERLY_URL}`);
}
