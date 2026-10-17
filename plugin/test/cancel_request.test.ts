import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { cancelMessage, cancelRequest, inputSchema, outputSchema, type CancelOutput } from "../src/tools/cancel_request.ts";
import { cancelResSchema } from "../src/contract.ts";
import { fixture, html, json, makeDeps, RECIPIENT, textOf, type Route } from "./helpers.ts";

// cancel_request's two calls against doubles of GET /api/v1/requests/:id and POST /api/v1/requests/:id/cancel,
// answered from contract/fixtures/cancel.res.json. Signatures are real ed25519 from throwaway keys (fixed seeds,
// they hold nothing), made exactly the way PayBox's request_wallet_sign {op:"solanaMessage"} makes them.

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}
// The same throwaway key that signed contract/fixtures/cancel.*.json.
const ME = signer("owed contract fixture signer: cancel (holds nothing)");
const MALLORY = signer("owed test signer: cancel_request.test.ts, someone else");
const NOW = Date.parse("2026-10-17T14:02:00Z");
const cancelled = fixture("cancel.res.json");
const ID: string = cancelled.id;
const LINK = `https://owed-omega.vercel.app/r/${ID}`;
const { already_cancelled: _drop, ...get } = cancelled;
const openReq = { ...get, status: "open", cancelled: null };
const GET = `GET /api/v1/requests/${ID}`;
const POST = `POST /api/v1/requests/${ID}/cancel`;

type Result = Awaited<ReturnType<typeof cancelRequest>>;
function out(result: Result): CancelOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  return outputSchema.parse((result as { structuredContent: CancelOutput }).structuredContent);
}
function refused(result: Result): string {
  assert.equal((result as { isError?: boolean }).isError, true, `expected a refusal, got ${textOf(result)}`);
  return textOf(result);
}
const deps = (routes: Record<string, Route>, now = NOW) => makeDeps({ now: () => now, routes });
const first = (extra: Record<string, unknown> = {}) => inputSchema.parse({ link: LINK, recipient: ME.address, ...extra });
const second = (message = cancelMessage(ID, ME.address, NOW), signature = ME.sign(message)) =>
  first({ signed_message: message, signature });

test("first call: reads the request, then returns the exact message to sign and how to sign it", async () => {
  const { deps: d, rec } = deps({ [GET]: () => json(200, openReq) });
  const result = await cancelRequest(first(), d);
  const o = out(result);
  assert.deepEqual(o, {
    step: "sign", id: ID, link: LINK, recipient: ME.address, amount: "15", token: "USDC", status: "open",
    payer_name: "Priya", for: "dinner",
    message_to_sign: `Owed cancel ${ID} for ${ME.address} at 2026-10-17T14:02:00Z`,
    sign_by: "2026-10-17T14:07:00Z",
  });
  const text = textOf(result);
  assert.ok(text.includes(`{"op":"solanaMessage","address":"${ME.address}","message":"${o.message_to_sign}"}`));
  assert.match(text, /moves no money/);
  assert.match(text, /15 USDC from "Priya" for "dinner"/);
  assert.deepEqual(rec.calls.map((c) => `${c.method} ${c.url}`), [`GET https://owed-omega.vercel.app/api/v1/requests/${ID}`]);
});

test("first call takes an id or an invoice link too, and an expired request can still be cancelled", async () => {
  for (const link of [ID, `https://www.getowed.xyz/i/${ID}`]) {
    const { deps: d } = deps({ [GET]: () => json(200, { ...openReq, status: "expired" }) });
    const result = await cancelRequest(first({ link }), d);
    assert.equal(out(result).status, "expired");
    assert.match(textOf(result), /already expired; cancelling makes that final/);
  }
});

test("first call refuses: another wallet's request, paid, partly paid; already cancelled is a no-op success", async () => {
  const { deps: d1 } = deps({ [GET]: () => json(200, openReq) });
  assert.match(refused(await cancelRequest(first({ recipient: RECIPIENT }), d1)),
    /^This request pays 2yLq…6Wvn, not this wallet \(FN6G…cbvs\)\. Only the wallet a request pays can cancel it/);

  const paid = { ...openReq, status: "paid", paid: { signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", payer: RECIPIENT, amount: "15", at: "2026-10-17T13:50:00Z", rail: "solana_pay" } };
  const { deps: d2 } = deps({ [GET]: () => json(200, paid) });
  assert.equal(refused(await cancelRequest(first(), d2)),
    "This request is already paid (https://solscan.io/tx/5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv), so it can't be cancelled. Nothing changed.");
  const { deps: d3 } = deps({ [GET]: () => json(200, { ...paid, status: "underpaid", paid: { ...paid.paid, amount: "5" } }) });
  assert.match(refused(await cancelRequest(first(), d3)), /^This request already received a partial payment \(5 of 15 USDC\)/);

  const { deps: d4 } = deps({ [GET]: () => json(200, get) });
  const o = out(await cancelRequest(first(), d4));
  assert.deepEqual([o.step, o.status, o.already_cancelled, o.cancelled_at], ["cancelled", "cancelled", true, "2026-10-17T14:02:13Z"]);
});

test("first call refuses what isn't a cancellable Owed request, and says so when Owed can't be reached", async () => {
  const solanaUrl: string = cancelled.solana_pay_url;
  const cases: Array<[string, Record<string, Route>, RegExp]> = [
    [solanaUrl, {}, /^Only Owed requests .* can be cancelled\. A plain Solana Pay link isn't stored anywhere/],
    ["https://www.getowed.xyz/g/nmPSzN1D1KEn", {}, /^That is a split bill's board\. A board can't be cancelled as a whole/],
    ["https://example.com/r/cQqPpjrF8ttm", {}, /isn't an Owed link/],
    [LINK, { [GET]: () => json(404, { error: { code: "not_found", message: "no request with this id" } }) }, /^No Owed request has the id cQqPpjrF8ttm\. Check the link\.$/],
    [LINK, { [GET]: () => "network_error" }, /^Owed's server couldn't be reached, so the request couldn't be checked and nothing was cancelled/],
    [LINK, { [GET]: () => html(404) }, /^Owed's server couldn't be reached/],
  ];
  for (const [link, routes, expected] of cases) {
    const { deps: d } = deps(routes);
    assert.match(refused(await cancelRequest(first({ link }), d)), expected, link);
  }
});

test("second call: posts the signed message once; the request comes back cancelled with its proof", async () => {
  const message = cancelMessage(ID, ME.address, NOW);
  const signature = ME.sign(message);
  const answer = { ...cancelled, cancelled: { at: "2026-10-17T14:02:13Z", signed_message: message, signature } };
  assert.ok(cancelResSchema.safeParse(answer).success);
  const { deps: d, rec } = deps({ [POST]: () => json(200, answer) }, NOW + 60_000);
  const result = await cancelRequest(second(message, signature), d);
  const o = out(result);
  assert.deepEqual(o, {
    step: "cancelled", id: ID, link: LINK, recipient: ME.address, amount: "15", token: "USDC", status: "cancelled",
    payer_name: "Priya", for: "dinner", cancelled_at: "2026-10-17T14:02:13Z", already_cancelled: false,
  });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, `https://owed-omega.vercel.app/api/v1/requests/${ID}/cancel`);
  assert.deepEqual(rec.calls[0]!.body, { recipient: ME.address, signed_message: message, signature });
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], `Cancelled: 15 USDC from "Priya" for "dinner", request ${ID}, at 2026-10-17T14:02:13Z.`);
  assert.match(lines[1]!, /now says Cancelled with no pay buttons, pay_link refuses it/);
});

test("second call: the server's already_cancelled is reported as a no-op", async () => {
  const { deps: d } = deps({ [POST]: () => json(200, { ...cancelled, already_cancelled: true }) });
  const o = out(await cancelRequest(second(), d));
  assert.deepEqual([o.step, o.already_cancelled], ["cancelled", true]);
});

test("second call: wrong wording, wrong request, stale, future or someone else's signature never reach the server", async () => {
  const other = "fNJ73eyNeWKZ";
  const stale = cancelMessage(ID, ME.address, NOW - 6 * 60_000);
  const future = cancelMessage(ID, ME.address, NOW + 3 * 60_000);
  const mine = cancelMessage(ID, ME.address, NOW);
  const cases: Array<[string, string, RegExp]> = [
    [`Owed ledger access for ${ME.address} at 2026-10-17T14:02:00Z`, "", /^signed_message must be exactly the message_to_sign cancel_request gave/],
    [cancelMessage(other, ME.address, NOW), "", /^signed_message must be exactly/],
    [stale, ME.sign(stale), /more than 5 minutes old/],
    [future, ME.sign(future), /dated in the future/],
    [mine, MALLORY.sign(mine), /^That signature isn't from wallet /],
  ];
  for (const [message, signature, expected] of cases) {
    const { deps: d, rec } = deps({});
    assert.match(refused(await cancelRequest(second(message, signature || ME.sign(message)), d)), expected, message);
    assert.equal(rec.calls.length, 0);
  }
  const { deps: d } = deps({});
  assert.match(refused(await cancelRequest(first({ signed_message: mine }), d)), /^Pass both signed_message and signature/);
});

test("second call: the server's refusals and outages are passed on plainly", async () => {
  const cases: Array<[Route, RegExp]> = [
    [() => json(400, { error: { code: "invalid_input", message: "this signature was already used; sign a fresh message to try again" } }),
      /^Owed refused the cancellation: this signature was already used; sign a fresh message to try again\. Nothing changed\.$/],
    [() => json(400, { error: { code: "invalid_input", message: "this request is already paid, so it can't be cancelled" } }), /already paid, so it can't be cancelled/],
    [() => json(429, { error: { code: "rate_limited", message: "an x402 payment for this request is being settled right now; wait a minute, then check the request before cancelling" } }),
      /^Owed refused the cancellation: an x402 payment for this request is being settled right now/],
    [() => json(404, { error: { code: "not_found", message: "no request with this id" } }), /^No Owed request has the id/],
    [() => json(503, { error: { code: "upstream_unavailable", message: "Solana couldn't be read" } }), /^Owed couldn't confirm the cancellation .* check_payments/],
    [() => "network_error", /^Owed couldn't confirm the cancellation/],
    [() => json(200, { ...cancelled, status: "open" }), /answered about a different request or state \(open\)/],
    [() => json(200, { ...cancelled, recipient: RECIPIENT }), /answered about a different request or state/],
  ];
  for (const [route, expected] of cases) {
    const { deps: d } = deps({ [POST]: route });
    assert.match(refused(await cancelRequest(second(), d)), expected);
  }
});

test("a hung server can't push the call past PayBox's 10 s: it gives up inside the budget", async () => {
  let clock = NOW;
  const { deps: d } = makeDeps({ now: () => clock, routes: { [POST]: () => "hang" } });
  const started = Date.now();
  const pending = cancelRequest(second(), d);
  clock = NOW + 2000;
  const result = await pending;
  assert.match(refused(result), /didn't answer in time|couldn't confirm/);
  assert.ok(Date.now() - started < 9000);
});
