import { test } from "node:test";
import assert from "node:assert/strict";
import { x402OutputSchema } from "../src/paybox.ts";
import { inputSchema, payLink } from "../src/tools/pay_link.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT } from "./helpers.ts";

// W2-B x W2-H: the payee check gates the x402 rail exactly as it gates Solana Pay.
const ID = "JArQ6g9JvoWr";
const open = { ...fixture("get-request.res.json"), status: "open", paid: null, from_domain: "example.com" };
const challenge = () => {
  const v2 = { x402Version: 2, accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "15000000", asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww" } }] };
  return new Response(JSON.stringify({ x402Version: 1, accepts: [] }), { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(v2)).toString("base64") } });
};
const doh = (txt: string[]) => () => json(200, { Status: 0, AD: true, Question: [{ name: "_owed.example.com.", type: 16 }], Answer: txt.map((t) => ({ name: "_owed.example.com.", type: 16, TTL: 300, data: `"${t}"` })) });
const input = inputSchema.parse({ link: `https://owed.link/r/${ID}`, sender: SENDER, rail: "x402" });

test("x402 rail: a domain that doesn't publish the wallet is refused, no proposal", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/requests/${ID}`]: () => json(200, open), [`GET /x/${ID}`]: challenge, "GET *": doh([]) } });
  const r = await payLink(input, deps);
  assert.ok("isError" in r && r.isError);
  assert.match(textOf(r), /does not publish this wallet\. Not paying\./);
});

test("x402 rail: a verified domain leads the x402 preview", async () => {
  const { deps } = makeDeps({ routes: { [`GET /api/v1/requests/${ID}`]: () => json(200, open), [`GET /x/${ID}`]: challenge, "GET *": doh([`owed-pay=${RECIPIENT}`]) } });
  const r = await payLink(input, deps);
  assert.ok(!("isError" in r), textOf(r));
  assert.equal(x402OutputSchema.parse((r as { structuredContent: unknown }).structuredContent)["io.paybox/transactionProposal"].kind, "x402");
  assert.match(textOf(r).split("\n")[0]!, /^Pay 15 USDC to example\.com \(verified by DNS, DNSSEC\) over x402\./);
});
