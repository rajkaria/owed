import { test } from "node:test";
import assert from "node:assert/strict";
import { x402OutputSchema } from "../src/paybox.ts";
import {
  checkX402Challenge, inputSchema, outputSchema, payLink, REFUSE_ALREADY_PAID, REFUSE_TAMPERED, REFUSE_X402_MISMATCH,
  REFUSE_X402_NO_ACCOUNT, REFUSE_X402_NOT_OWED, REFUSE_X402_NOT_USDC,
} from "../src/tools/pay_link.ts";
import { requestIdFor } from "../src/request-id.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT, type Route } from "./helpers.ts";

// pay_link rail "x402" (SPEC §5.2 T2.2): same resolution and id check as the Solana Pay rail, then the
// live /x/<id> challenge must pay exactly the request before the tool proposes an x402 payment.

const KEY = "io.paybox/transactionProposal";
const ID = "JArQ6g9JvoWr";
const AMOUNT = "15000000"; // the fixture's 15 USDC
const paidRequest = fixture("get-request.res.json");
const openRequest = { ...paidRequest, status: "open", paid: null };
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const v2Entry = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: NETWORK, amount: AMOUNT, asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER }, ...over,
});
const v1Entry = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: "solana", maxAmountRequired: AMOUNT, asset: USDC_MINT, payTo: RECIPIENT,
  resource: `https://owed-omega.vercel.app/x/${ID}`, description: "Owed request", mimeType: "application/json", maxTimeoutSeconds: 300,
  extra: { feePayer: FEE_PAYER }, ...over,
});

function challenge({ v2 = [v2Entry()], v1 = [v1Entry()], header = true }: { v2?: unknown[]; v1?: unknown[]; header?: boolean } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header) headers["payment-required"] = Buffer.from(JSON.stringify({ x402Version: 2, error: "required", resource: { url: "x" }, accepts: v2 })).toString("base64");
  return new Response(JSON.stringify({ x402Version: 1, error: "required", accepts: v1 }), { status: 402, headers });
}

const routes = (x: Route = () => challenge(), request: unknown = openRequest): Record<string, Route> => ({
  [`GET /api/v1/requests/${ID}`]: () => json(200, request),
  [`GET /x/${ID}`]: x,
});
const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({ link: `https://owed.link/r/${ID}`, sender: SENDER, rail: "x402", ...extra });

type Result = Awaited<ReturnType<typeof payLink>>;
function refusalText(r: Result): string {
  assert.ok("isError" in r && r.isError === true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
}

test("rail x402 proposes an x402 payment to the request's /x/<id> URL for exactly its amount", async () => {
  const { deps, rec } = makeDeps({ routes: routes() });
  const result = await payLink(input(), deps);
  assert.ok(!("isError" in result), textOf(result));
  const sc = (result as { structuredContent: unknown }).structuredContent;
  assert.deepEqual(outputSchema.parse(sc), sc);
  const p = x402OutputSchema.parse(sc)[KEY];
  assert.equal(p.kind, "x402");
  assert.equal(p.chain, "solana:mainnet");
  assert.deepEqual(p.request, { url: `https://owed-omega.vercel.app/x/${ID}`, method: "GET" });
  assert.deepEqual(p.payment, { asset: USDC_MINT, maxAmount: AMOUNT });
  const expires = Date.parse(p.expiresAt);
  assert.ok(expires > Date.now() && expires <= Date.now() + 300_000);
  assert.equal(rec.built.length, 0, "no Solana transaction is built on the x402 rail");
  assert.deepEqual(rec.readiness, [{ sender: SENDER, recipient: RECIPIENT, token: "USDC", amountAtomic: 15_000_000n }]);
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url}`), [
    `GET https://owed-omega.vercel.app/api/v1/requests/${ID}`,
    `GET https://owed-omega.vercel.app/x/${ID}`,
  ]);
  assert.equal(textOf(result).split("\n")[0],
    'Pay 15 USDC to FN6G…cbvs over x402. Requester\'s note, unverified: "dinner", "Thanks for coming!". Requester\'s name, unverified: "Raj". The x402 facilitator pays the network fee. Approve in PayBox to send.');
});

test("the x402 URL is on the configured Owed host, whatever host the link used", async () => {
  const { deps, rec } = makeDeps({ routes: routes(), env: { OWED_BASE_URL: "https://getowed.example" } });
  const result = await payLink(input({ link: `https://owed-omega.vercel.app/r/${ID}` }), deps);
  const p = x402OutputSchema.parse((result as { structuredContent: unknown }).structuredContent)[KEY];
  assert.equal(p.request.url, `https://getowed.example/x/${ID}`);
  assert.ok(rec.calls.every((c) => c.url.startsWith("https://getowed.example/")));
});

test("rail x402 refuses raw Solana Pay links before any network call", async () => {
  const { deps, rec } = makeDeps();
  const link = `solana:${RECIPIENT}?amount=1&spl-token=${USDC_MINT}`;
  assert.equal(refusalText(await payLink(input({ link }), deps)), REFUSE_X402_NOT_OWED);
  assert.equal(rec.calls.length + rec.readiness.length, 0);
});

test("rail x402 refuses SOL requests by name", async () => {
  const solId = requestIdFor({ recipient: RECIPIENT, token: "SOL", amountAtomic: 15_000_000_000n, reference: openRequest.reference });
  const sol = { ...openRequest, id: solId, token: "SOL", amount: "15", solana_pay_url: `solana:${RECIPIENT}?amount=15&reference=${openRequest.reference}&memo=owed%3A${solId}` };
  const { deps, rec } = makeDeps({ routes: { [`GET /api/v1/requests/${solId}`]: () => json(200, sol) } });
  assert.equal(refusalText(await payLink(input({ link: `https://owed.link/r/${solId}` }), deps)), REFUSE_X402_NOT_USDC);
  assert.equal(rec.calls.some((c) => c.url.includes("/x/")), false);
});

test("rail x402 keeps the id check: a tampered request is refused without fetching the challenge", async () => {
  const swapped = { ...openRequest, recipient: OTHER, solana_pay_url: openRequest.solana_pay_url.replace(RECIPIENT, OTHER) };
  const { deps, rec } = makeDeps({ routes: routes(undefined, swapped) });
  assert.equal(refusalText(await payLink(input(), deps)), REFUSE_TAMPERED);
  assert.equal(rec.calls.some((c) => c.url.includes("/x/")), false);
});

test("a challenge that pays someone else, or a different amount, is refused before any proposal", async () => {
  const cases: Array<[string, () => Response]> = [
    ["v2 payTo", () => challenge({ v2: [v2Entry({ payTo: OTHER })] })],
    ["v2 amount", () => challenge({ v2: [v2Entry({ amount: "15000001" })] })],
    ["v2 asset", () => challenge({ v2: [v2Entry({ asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })] })],
    ["v2 network", () => challenge({ v2: [v2Entry({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })] })],
    ["v2 payTo case", () => challenge({ v2: [v2Entry({ payTo: RECIPIENT.toLowerCase() })] })],
    ["v2 second option", () => challenge({ v2: [v2Entry(), v2Entry({ payTo: OTHER })] })],
    ["v1 payTo", () => challenge({ v1: [v1Entry({ payTo: OTHER })] })],
    ["v1 amount", () => challenge({ v1: [v1Entry({ maxAmountRequired: "1" })] })],
    ["v1 only, wrong", () => challenge({ header: false, v1: [v1Entry({ payTo: OTHER })] })],
  ];
  for (const [label, x] of cases) {
    const { deps, rec } = makeDeps({ routes: routes(x) });
    assert.equal(refusalText(await payLink(input(), deps)), REFUSE_X402_MISMATCH, label);
    assert.equal(rec.built.length, 0, label);
  }
});

test("challenge states: paid -> already paid; errors and unreadable challenges -> refused", async () => {
  const paid = () => json(200, { paid: true, status: "paid", id: ID });
  let r = await payLink(input(), makeDeps({ routes: routes(paid) }).deps);
  assert.equal(refusalText(r), REFUSE_ALREADY_PAID);

  r = await payLink(input(), makeDeps({ routes: routes(() => json(503, { error: { code: "upstream_unavailable", message: "the x402 facilitator is unavailable" } })) }).deps);
  assert.equal(refusalText(r), "Owed's x402 endpoint can't take this payment (HTTP 503: the x402 facilitator is unavailable). Nothing was sent.");

  r = await payLink(input(), makeDeps({ routes: routes(() => new Response("{}", { status: 402 })) }).deps);
  assert.match(refusalText(r), /can't read/);

  r = await payLink(input(), makeDeps({ routes: routes(() => "network_error") }).deps);
  assert.match(refusalText(r), /couldn't be reached/);
});

test("v1-only and v2-only challenges that match are accepted", async () => {
  for (const x of [() => challenge({ header: false }), () => challenge({ v1: [] as unknown[] })]) {
    const { deps } = makeDeps({ routes: routes(x) });
    const r = await payLink(input(), deps);
    assert.ok(!("isError" in r), textOf(r));
  }
});

test("x402 needs no SOL: a fee-only shortfall still proposes, Solana Pay still refuses", async () => {
  const fees = async () => ({ ok: false, reason: "Your wallet needs about 0.003 SOL for fees; it has 0 SOL.", recipientAtaExists: true });
  const x = await payLink(input(), makeDeps({ routes: routes(), payerReadiness: fees }).deps);
  assert.ok(!("isError" in x), textOf(x));
  const sp = await payLink(input({ rail: "solana_pay" }), makeDeps({ routes: routes(), payerReadiness: fees }).deps);
  assert.equal(refusalText(sp), "Your wallet needs about 0.003 SOL for fees; it has 0 SOL.");
  const broke = async () => ({ ok: false, reason: "Your wallet has 1 USDC; this request is 15 USDC.", recipientAtaExists: true });
  assert.equal(refusalText(await payLink(input(), makeDeps({ routes: routes(), payerReadiness: broke }).deps)), "Your wallet has 1 USDC; this request is 15 USDC.");
});

test("x402 can't open the recipient's USDC account: refused with the Solana Pay alternative", async () => {
  const noAta = async () => ({ ok: true, recipientAtaExists: false });
  assert.equal(refusalText(await payLink(input(), makeDeps({ routes: routes(), payerReadiness: noAta }).deps)), REFUSE_X402_NO_ACCOUNT);
});

test("max_amount still applies on the x402 rail", async () => {
  const { deps, rec } = makeDeps({ routes: routes() });
  assert.equal(refusalText(await payLink(input({ max_amount: "10" }), deps)), "This request is for 15 USDC, above your limit of 10 USDC. Nothing was sent.");
  assert.equal(rec.calls.some((c) => c.url.includes("/x/")), false);
});

test("default rail is unchanged: a Solana transaction proposal", async () => {
  const { deps, rec } = makeDeps({ routes: routes() });
  const r = await payLink(inputSchema.parse({ link: `https://owed.link/r/${ID}`, sender: SENDER }), deps);
  const sc = (r as { structuredContent: Record<string, { kind: string }> }).structuredContent;
  assert.equal(sc[KEY]!.kind, "solana");
  assert.equal(rec.calls.some((c) => c.url.includes("/x/")), false);
});

test("checkX402Challenge reads the real Owed preview challenge shape", async () => {
  // Captured from GET /x/4tHguZSCqHmE on the w2b-x402 preview (2026-10-17 07:26Z), host shortened.
  const v2 = { x402Version: 2, error: "PAYMENT-SIGNATURE or X-PAYMENT header is required",
    resource: { url: "https://owed.example/x/4tHguZSCqHmE", description: "Owed request 4tHguZSCqHmE: 0.01 USDC to FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", mimeType: "application/json", serviceName: "Owed" },
    accepts: [{ scheme: "exact", network: NETWORK, amount: "10000", asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } }] };
  const v1 = { x402Version: 1, error: v2.error, accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: "10000", asset: USDC_MINT, payTo: RECIPIENT,
    resource: v2.resource.url, description: v2.resource.description, mimeType: "application/json", maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } }] };
  const fetch = (async () => new Response(JSON.stringify(v1), { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(v2)).toString("base64") } })) as typeof globalThis.fetch;
  assert.equal(await checkX402Challenge(v2.resource.url, { recipient: RECIPIENT, amountAtomic: 10_000n }, { fetch }, 1000), true);
  assert.equal(await checkX402Challenge(v2.resource.url, { recipient: RECIPIENT, amountAtomic: 10_001n }, { fetch }, 1000), REFUSE_X402_MISMATCH);
});

test("the fee-only exemption matches the real payerReadiness wording, and nothing else", async () => {
  // A payer with the USDC but no SOL at all, read through the real chain.ts against an RPC double.
  const usdc = (amount: string) => ({ lamports: 2_039_280, data: { parsed: { info: { mint: USDC_MINT, owner: SENDER, state: "initialized", tokenAmount: { amount } } } } });
  const rpcFor = (senderLamports: number, senderUsdc: string) => ({
    call: async <T>(method: string) => {
      assert.equal(method, "getMultipleAccounts");
      return { value: [senderLamports ? { lamports: senderLamports, data: ["", "base64"] } : null, usdc(senderUsdc), usdc("0")] } as T;
    },
  });
  const { payerReadiness } = await import("../src/chain.ts");
  const noSol = await payLink(input(), makeDeps({ routes: routes(), rpc: () => rpcFor(0, AMOUNT), payerReadiness }).deps);
  assert.ok(!("isError" in noSol), textOf(noSol));
  const short = await payLink(input(), makeDeps({ routes: routes(), rpc: () => rpcFor(0, "14999999"), payerReadiness }).deps);
  assert.equal(refusalText(short), "Your wallet has 14.999999 USDC; this request is 15 USDC.");
});
