import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { AUTOPAY_NOTE, inputSchema, outputSchema, whatDoIOwe } from "../src/tools/what_do_i_owe.ts";
import { AUTOPAY_CALLS_MAX, autopayMessage } from "../src/autopay.ts";
import { fixture, json, makeDeps, textOf, USDC_MINT } from "./helpers.ts";

// F5 what_do_i_owe with an autopay rule: the server's verdicts (contract/fixtures/autopay.inbox.res.json, made by
// contract/autopay-fixtures.mjs) and, for the eligible line, the exact PayBox pay_x402 call, attached only when the
// payer's own signed rule allows it, the request's terms hash to its id, and the live 402 challenge pays exactly that.

const inboxReq = fixture("autopay.inbox.req.json");
const inboxRes = fixture("autopay.inbox.res.json");
const bulk = fixture("autopay.requests.bulk.res.json");
const PAYER = inboxReq.payer as string;
const [october, november, snacks] = inboxRes.owed as Array<{ id: string; recipient: string; amount: string; link: string }>;
const LANDLORD = october!.recipient;
const PUBLIC_BASE = "https://www.getowed.xyz"; // what the server names as the resource
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const at = (iso: string) => () => Date.parse(iso);
const seed = createHash("sha256").update("owed contract fixture signer: F5 autopay payer", "utf8").digest();
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const signHex = (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("hex");

/** The 402 the server's /x/<id> answers (web/lib/x402/wire.ts paymentRequired), both generations. */
function challenge(id: string, { payTo = LANDLORD, amount = "1000000000", v2 = true, v1 = true, resourceUrl = `${PUBLIC_BASE}/x/${id}` } = {}) {
  const description = `Owed request ${id}: 1000 USDC to ${payTo}`;
  const accepts2 = [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount, asset: USDC_MINT, payTo, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } }];
  const doc2 = { x402Version: 2, error: "PAYMENT-SIGNATURE or X-PAYMENT header is required", resource: { url: resourceUrl, description, mimeType: "application/json", serviceName: "Owed" }, accepts: accepts2 };
  const body1 = {
    x402Version: 1, error: "PAYMENT-SIGNATURE or X-PAYMENT header is required",
    accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: amount, asset: USDC_MINT, payTo, resource: resourceUrl, description, mimeType: "application/json", maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } }],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (v2) headers["PAYMENT-REQUIRED"] = Buffer.from(JSON.stringify(doc2)).toString("base64");
  return { response: () => new Response(JSON.stringify(v1 ? body1 : { x402Version: 1, error: "x" }), { status: 402, headers }), doc2, body1 };
}

const signed = inputSchema.parse({ payer: PAYER, signed_message: inboxReq.signed_message, signature: inboxReq.signature });
function routes(over: Record<string, () => Response | "network_error"> = {}) {
  return {
    "POST /api/v1/inbox": () => json(200, inboxRes),
    [`GET /api/v1/requests?ids=${october!.id}`]: () => json(200, bulk),
    [`GET /x/${october!.id}`]: challenge(october!.id).response,
    ...over,
  };
}
async function run(over: Record<string, () => Response | "network_error"> = {}, inbox = inboxRes, extra: Parameters<typeof makeDeps>[0] = {}) {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:31:00Z"), routes: { ...routes(over), "POST /api/v1/inbox": () => json(200, inbox) }, ...extra });
  const r = await whatDoIOwe(signed, deps);
  assert.notEqual((r as { isError?: boolean }).isError, true, textOf(r));
  return { r, out: outputSchema.parse(r.structuredContent), rec };
}

test("eligible: the exact pay_x402 call, accepts verbatim from the live 402 (v2 with its resource block), and the pay_link fallback", async () => {
  const { r, out, rec } = await run();
  const line = out.owed![0]!;
  assert.equal(line.autopay!.status, "eligible");
  assert.equal(line.autopay!.rule_id, "Rk7mPq2xLw9a");
  const { doc2 } = challenge(october!.id);
  assert.deepEqual(line.autopay!.pay_x402, {
    via: "paybox", tool: "pay_x402", credential_of: PAYER,
    args: { accepts: doc2.accepts, resource_url: `https://owed-omega.vercel.app/x/${october!.id}`, x402_version: 2, resource: doc2.resource },
  });
  assert.deepEqual(line.autopay!.fallback, { tool: "pay_link", args: { link: october!.link, sender: PAYER, rail: "x402" } });
  assert.match(line.autopay!.then!, /retry GET https:\/\/owed-omega\.vercel\.app\/x\/\S+ with the header in output\.value\.x_payment\. Only that response \(paid: true\) proves the payment/);
  // Over the monthly cap and not covered: verdict and reason only, never a call.
  assert.deepEqual(out.owed![1]!.autopay, { status: "over_limit", rule_id: "Rk7mPq2xLw9a", reason: inboxRes.owed[1].autopay.reason });
  assert.deepEqual(out.owed![2]!.autopay, { status: "not_covered", reason: "No autopay rule covers this requester's wallet." });
  assert.equal(out.autopay_note, AUTOPAY_NOTE);
  assert.deepEqual(out.autopay_rules, [{ id: "Rk7mPq2xLw9a", requester: { wallet: LANDLORD, handle: "landlord_bob", sns: null }, max_per_request: "1500", max_per_month: "1500", ends: "2027-10-18", status: "active", month: "2026-10", used_this_month: "0" }]);
  const text = textOf(r);
  assert.match(text, /Owed never pays anything itself/);
  assert.match(text, /only inside the user's PayBox autonomous limits/);
  assert.match(text, /if PayBox asks for approval, it's one tap a month/);
  assert.match(text, /Over-limit requests are never paid automatically/);
  assert.match(text, /Autopay over limit: Paying it would make 2000 USDC this month/);
  assert.ok(text.includes(`pay_x402 for ${october!.id} (1000 USDC): PayBox pay_x402 {"credential_id":"<this wallet's credential_id>","accepts":${JSON.stringify(doc2.accepts)}`));
  // One inbox read, one terms read, one challenge: the over-limit and uncovered lines cost nothing.
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, "")}`), ["POST /api/v1/inbox", `GET /api/v1/requests?ids=${october!.id}`, `GET /x/${october!.id}`]);
  assert.ok(!rec.calls.some((c) => c.url.includes(november!.id) || c.url.includes(snacks!.id)));
});

test("a v1-only challenge gives x402_version 1 and no resource block", async () => {
  const { out } = await run({ [`GET /x/${october!.id}`]: challenge(october!.id, { v2: false }).response });
  const call = out.owed![0]!.autopay!.pay_x402!;
  assert.equal(call.args.x402_version, 1);
  assert.equal(call.args.resource, undefined);
  assert.deepEqual(call.args.accepts, challenge(october!.id).body1.accepts);
});

test("a challenge that pays anyone or anything else drops the call", async () => {
  const cases: Array<[Record<string, () => Response | "network_error">, RegExp]> = [
    [{ [`GET /x/${october!.id}`]: challenge(october!.id, { payTo: "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD" }).response }, /asks for a different payment than the request itself/],
    [{ [`GET /x/${october!.id}`]: challenge(october!.id, { amount: "1000000001" }).response }, /asks for a different payment/],
    [{ [`GET /x/${october!.id}`]: challenge(october!.id, { resourceUrl: "https://evil.example/x/abc" }).response }, /names a different resource/],
    [{ [`GET /x/${october!.id}`]: () => json(200, { paid: true }) }, /already paid/],
    [{ [`GET /x/${october!.id}`]: () => "network_error" }, /couldn't be reached/],
  ];
  for (const [over, why] of cases) {
    const { out } = await run(over);
    const a = out.owed![0]!.autopay!;
    assert.equal(a.status, "eligible", why.source);
    assert.equal(a.pay_x402, undefined, why.source);
    assert.equal(a.fallback, undefined, why.source);
    assert.match(a.not_ready!, why);
  }
});

test("terms that don't hash to the id, or don't match the line, drop the call", async () => {
  const tampered = { ...bulk, requests: [{ ...bulk.requests[0], recipient: "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD" }] };
  const { out } = await run({ [`GET /api/v1/requests?ids=${october!.id}`]: () => json(200, tampered) });
  assert.equal(out.owed![0]!.autopay!.pay_x402, undefined);
  assert.match(out.owed![0]!.autopay!.not_ready!, /doesn't match|don't match/);
  const { out: down } = await run({ [`GET /api/v1/requests?ids=${october!.id}`]: () => "network_error" });
  assert.match(down.owed![0]!.autopay!.not_ready!, /couldn't be read to check this request's terms/);
});

test("the payer's own signed rule is the limit: a server verdict it doesn't back gets no call", async () => {
  // The server says eligible for 1600 USDC, but the payer signed 1500 per request.
  const above = structuredClone(inboxRes);
  above.owed[0].amount = "1600";
  above.owed[0].amount_due = "1600";
  above.totals[0].amount_due = "2605";
  const { out } = await run({}, above);
  assert.equal(out.owed![0]!.autopay!.pay_x402, undefined);
  assert.match(out.owed![0]!.autopay!.not_ready!, /above the signed rule's maximum per request/);
  // A rule whose text was changed after signing.
  const forged = structuredClone(inboxRes);
  const text = autopayMessage({ payer: PAYER, requester: LANDLORD, maxPerRequestAtomic: 15_000_000_000n, maxPerMonthAtomic: 15_000_000_000n, ends: "2027-10-18" }, Date.parse("2026-10-18T10:15:00Z"));
  forged.autopay_rules[0].signed_message = text;
  const { out: f } = await run({}, forged);
  assert.match(f.owed![0]!.autopay!.not_ready!, /signature isn't this wallet's/);
  // Signed by the payer, but for another requester's wallet.
  const other = structuredClone(inboxRes);
  const otherText = autopayMessage({ payer: PAYER, requester: "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD", maxPerRequestAtomic: 1_500_000_000n, maxPerMonthAtomic: 1_500_000_000n, ends: "2027-10-18" }, Date.parse("2026-10-18T10:15:00Z"));
  other.autopay_rules[0] = { ...other.autopay_rules[0], signed_message: otherText, signature: signHex(otherText) };
  const { out: o } = await run({}, other);
  assert.match(o.owed![0]!.autopay!.not_ready!, /names a different wallet/);
});

test("a sanctioned recipient never gets a call", async () => {
  const { out, rec } = await run({}, inboxRes, { screenRecipient: async () => ({ ok: false as const, message: "This recipient is on the U.S. Treasury's OFAC sanctions list." }) });
  assert.match(out.owed![0]!.autopay!.not_ready!, /OFAC sanctions list/);
  assert.equal(rec.calls.length, 1);
});

test(`at most ${AUTOPAY_CALLS_MAX} eligible lines get a call per read`, async () => {
  const many = structuredClone(inboxRes);
  const base = many.owed[0];
  many.owed = Array.from({ length: AUTOPAY_CALLS_MAX + 1 }, (_, i) => ({ ...base, id: `${base.id.slice(0, 11)}${"abcdefghij"[i]}` }));
  many.totals = [{ token: "USDC", chain: "solana", amount_due: String(1000 * many.owed.length), count: many.owed.length }];
  const { deps } = makeDeps({ now: at("2026-10-18T10:31:00Z"), routes: { "POST /api/v1/inbox": () => json(200, many), "GET *": () => json(200, { requests: [], not_found: [] }) } });
  const out = outputSchema.parse((await whatDoIOwe(signed, deps)).structuredContent);
  assert.match(out.owed![AUTOPAY_CALLS_MAX]!.autopay!.not_ready!, new RegExp(`Only the first ${AUTOPAY_CALLS_MAX} eligible requests get a payment call`));
});

test("a slow inbox leaves no time for the challenge: the call is left out, inside the 8.5 s budget", async () => {
  let calls = 0;
  const start = Date.parse("2026-10-18T10:31:00Z");
  // The first clock read starts the budget; every later one is 8 s on (the inbox answered slowly).
  const { out, rec } = await run({}, inboxRes, { now: () => (calls++ === 0 ? start : start + 8000) });
  assert.match(out.owed![0]!.autopay!.not_ready!, /wasn't time left to fetch its x402 challenge/);
  assert.equal(rec.calls.length, 1);
});

test("a payer without rules sees the inbox exactly as before", async () => {
  const plain = fixture("inbox.res.json");
  const req = fixture("inbox.req.json");
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/inbox": () => json(200, plain) } });
  const r = await whatDoIOwe(inputSchema.parse({ payer: req.payer, signed_message: req.signed_message, signature: req.signature }), deps);
  const out = outputSchema.parse(r.structuredContent);
  assert.equal(out.autopay_rules, undefined);
  assert.equal(out.autopay_note, undefined);
  assert.ok(out.owed!.every((e) => e.autopay === undefined));
  assert.doesNotMatch(textOf(r), /Autopay/);
  assert.equal(rec.calls.length, 1);
});
