import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import type { Rpc } from "../src/chain.ts";
import { inputSchema, ONE_TAP_COPY, outputSchema, setAutopay } from "../src/tools/set_autopay.ts";
import { autopayMessage, endsAfterMonths, endsProblem, latestEnds, parseSignedRule, revokeMessage, signedRuleProblem } from "../src/autopay.ts";
import { fixture, json, makeDeps, RECIPIENT, textOf } from "./helpers.ts";

// F5 set_autopay: two calls like who_owes_me. The signed messages and the server's replies are the contract fixtures
// (contract/autopay-fixtures.mjs): a real ed25519 signature by the fixtures' payer wallet, rebuilt here from its seed.

const createReq = fixture("autopay.create.req.json");
const createRes = fixture("autopay.create.res.json");
const revokeReq = fixture("autopay.revoke.req.json");
const revokeRes = fixture("autopay.revoke.res.json");
const seed = createHash("sha256").update("owed contract fixture signer: F5 autopay payer", "utf8").digest();
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const PAYER = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
const signHex = (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("hex");
const LANDLORD = RECIPIENT; // the fixtures' requester (on curve)
const at = (iso: string) => () => Date.parse(iso);
type Out = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
const refused = (r: Out) => {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
};
const ok = (r: Out) => {
  assert.notEqual(r.isError, true, textOf(r));
  return outputSchema.parse(r.structuredContent);
};
const rule = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  payer: PAYER, requester: { wallet: LANDLORD, handle: "@Landlord_Bob" }, max_per_request: "1500", ends: "2027-10-18", ...extra,
});

test("the payer's fixture key is the fixtures' payer", () => assert.equal(PAYER, createReq.payer));

test("first call: the exact rule message, the request_wallet_sign call and the one-tap copy, with nothing sent", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:15:00Z") });
  const r = await setAutopay(rule(), deps);
  const out = ok(r);
  assert.equal(out.step, "sign");
  assert.equal(out.mode, "create");
  assert.equal(out.message_to_sign, createReq.signed_message);
  assert.equal(out.expires_at, "2026-10-18T10:20:00Z");
  assert.deepEqual(out.sign_call, { tool: "request_wallet_sign", credential_of: PAYER, args: { intent: { op: "solanaMessage", address: PAYER, message: createReq.signed_message } } });
  assert.deepEqual(out.draft, { requester: { wallet: LANDLORD, handle: "landlord_bob", sns: null }, max_per_request: "1500", max_per_month: "1500", ends: "2027-10-18" });
  const text = textOf(r);
  assert.match(text, /@landlord_bob \(wallet FN6G…cbvs, as PayBox resolved it; Owed doesn't verify handles\)/);
  assert.ok(text.includes(ONE_TAP_COPY));
  assert.match(text, /Owed never pays anything itself/);
  assert.match(text, /if PayBox asks for approval, it's one tap a month/);
  assert.match(text, /Requests above the rule are never paid automatically/);
  assert.equal(rec.calls.length, 0);
});

test("months instead of ends: counted from the day the message was signed", async () => {
  const { deps } = makeDeps({ now: at("2026-10-18T10:15:00Z") });
  assert.equal(ok(await setAutopay(rule({ ends: undefined, months: 12 }), deps)).message_to_sign, createReq.signed_message);
  assert.equal(endsAfterMonths(1, Date.parse("2026-01-31T12:00:00Z")), "2026-02-28");
  assert.equal(endsAfterMonths(12, Date.parse("2028-02-29T12:00:00Z")), "2029-02-28");
  // The second call a minute after midnight UTC still rebuilds the same ends from the signed time.
  const { deps: late, rec } = makeDeps({ now: at("2026-10-18T10:19:00Z"), routes: { "POST /api/v1/autopay": () => json(201, createRes) } });
  const out = ok(await setAutopay(rule({ ends: undefined, months: 12, signed_message: createReq.signed_message, signature: createReq.signature }), late));
  assert.equal(out.step, "saved");
  assert.equal((rec.calls[0]!.body as { ends: string }).ends, "2027-10-18");
});

test("second call: the signed rule goes to POST /api/v1/autopay once and the saved rule comes back", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/autopay": () => json(201, createRes) } });
  const r = await setAutopay(rule({ signed_message: createReq.signed_message, signature: createReq.signature }), deps);
  const out = ok(r);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, "https://owed-omega.vercel.app/api/v1/autopay");
  assert.deepEqual(rec.calls[0]!.body, createReq);
  assert.equal(out.step, "saved");
  assert.equal(out.rule!.id, "Rk7mPq2xLw9a");
  assert.equal(out.replaced, "Hn4cVb8tYs3e");
  const text = textOf(r);
  assert.match(text, /^Saved autopay rule Rk7mPq2xLw9a: @landlord_bob .* up to 1500 USDC per request and 1500 USDC per month \(UTC\) until 2027-10-18\. It replaces rule Hn4cVb8tYs3e\./);
  assert.match(text, /One-tap monthly pay within your rule/);
  assert.match(text, /To end it, call set_autopay with payer and revoke: "Rk7mPq2xLw9a"/);
});

test("local checks refuse before any call: stale, future, wrong signer, tampered fields, half a pair", async () => {
  const tampered = createReq.signed_message.replace("up to 1500 USDC per request", "up to 1600 USDC per request");
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["2026-10-18T10:21:00Z", { signed_message: createReq.signed_message, signature: createReq.signature }, /more than 5 minutes old/],
    ["2026-10-18T10:13:00Z", { signed_message: createReq.signed_message, signature: createReq.signature }, /dated in the future/],
    ["2026-10-18T10:16:00Z", { signed_message: createReq.signed_message, signature: `${"0".repeat(127)}1` }, /isn't from wallet/],
    ["2026-10-18T10:16:00Z", { max_per_request: "1600", signed_message: createReq.signed_message, signature: createReq.signature }, /doesn't match these arguments: it must read ".*up to 1600 USDC per request/],
    ["2026-10-18T10:16:00Z", { signed_message: tampered, signature: signHex(tampered) }, /doesn't match these arguments/],
    ["2026-10-18T10:16:00Z", { requester: { wallet: "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD" }, signed_message: createReq.signed_message, signature: createReq.signature }, /doesn't match these arguments/],
    ["2026-10-18T10:16:00Z", { signed_message: createReq.signed_message }, /Pass both signed_message and signature/],
    ["2026-10-18T10:16:00Z", { signed_message: createReq.signed_message.replace(" (at ", " at ").replace(/\)$/, ""), signature: createReq.signature }, /ending "\(at <time>\)"/],
  ];
  for (const [now, args, why] of cases) {
    const { deps, rec } = makeDeps({ now: at(now), routes: { "POST /api/v1/autopay": () => json(201, createRes) } });
    assert.match(refused(await setAutopay(rule(args), deps)), why, `${now} ${why.source}`);
    assert.equal(rec.calls.length, 0);
  }
});

test("field checks: handle without wallet, the payer's own wallet, a token account, limits and dates", async () => {
  const { deps } = makeDeps({ now: at("2026-10-18T10:15:00Z") });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ requester: { handle: "@landlord" } }, /first call PayBox resolve_username with "@landlord"/],
    [{ requester: { wallet: PAYER } }, /That is the user's own wallet/],
    [{ requester: { wallet: "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x" } }, /isn't a wallet requests can pay/],
    [{ requester: { sns: "landlord.sol" } }, /landlord\.sol is a \.sol name.*Nothing was saved\./],
    [{ requester: { sns: "landlord" } }, /isn't an SNS name/],
    [{ requester: {} }, /requester needs a wallet/],
    [{ requester: undefined }, /Whose requests should the rule pay/],
    [{ max_per_request: undefined }, /max_per_request/],
    [{ max_per_month: "1000" }, /max_per_month must be at least max_per_request/],
    [{ max_per_request: "1000001", max_per_month: "1000001" }, /at most 1000000 USDC/],
    [{ max_per_request: "1.0000001" }, /aren't valid USDC amounts/],
    [{ ends: "2027-10-19" }, /at most a year: ends 2027-10-18 at the latest/],
    [{ ends: "2026-10-17" }, /in the past/],
    [{ ends: undefined }, /pass ends .* or months/],
    [{ months: 3 }, /not both/],
    [{ revoke: "Rk7mPq2xLw9a" }, /To end a rule pass only payer and revoke/],
  ];
  for (const [patch, why] of cases) assert.match(refused(await setAutopay(inputSchema.parse({ ...rule(), ...patch }), deps)), why, why.source);
  assert.equal(inputSchema.safeParse({ ...rule(), extra: 1 }).success, false);
  assert.equal(inputSchema.safeParse({ ...rule(), months: 13 }).success, false);
  assert.equal(latestEnds(Date.parse("2028-02-29T12:00:00Z")), "2029-03-01");
  assert.equal(endsProblem("2026-10-18", Date.parse("2026-10-18T23:59:00Z")), null);
});

/** An RPC that answers the recorded mainnet calls of one test/fixtures/sns capture. */
function rpcFrom(name: string) {
  const calls = (JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sns/${name}.json`, import.meta.url)), "utf8")) as { calls: Array<{ method: string; params: unknown[]; result: unknown }> }).calls;
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded RPC call ${method}`);
      return structuredClone(hit.result) as T;
    },
  };
  return () => rpc;
}

test("an .sns requester is resolved on Solana here; the rule names the wallet and keeps the name as a label", async () => {
  const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v";
  const { deps } = makeDeps({ now: at("2026-10-18T10:15:00Z"), rpc: rpcFrom("bonfida") });
  const out = ok(await setAutopay(rule({ requester: { sns: "bonfida.sns" } }), deps));
  assert.deepEqual(out.draft!.requester, { wallet: BONFIDA, handle: null, sns: "bonfida.sns" });
  assert.match(out.message_to_sign!, new RegExp(`: pay ${BONFIDA} up to 1500 USDC`));
  // A wallet given beside the name must be the one it names.
  assert.match(refused(await setAutopay(rule({ requester: { sns: "bonfida.sns", wallet: LANDLORD } }), deps)), /bonfida\.sns points to Fw1E…Lb1v, not to the wallet given/);
});

test("the server refusing, being old, or answering with another rule is a refusal", async () => {
  const signed = { signed_message: createReq.signed_message, signature: createReq.signature };
  const routes = (res: () => Response) => makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/autopay": res } }).deps;
  assert.match(refused(await setAutopay(rule(signed), routes(() => json(400, { error: { code: "invalid_input", message: "this signature was already used; sign a fresh message to try again" } })))), /Owed refused it: this signature was already used/);
  assert.match(refused(await setAutopay(rule(signed), routes(() => new Response("<html>404</html>", { status: 404 })))), /couldn't be reached|doesn't take autopay rules/);
  const other = { ...createRes, rule: { ...createRes.rule, max_per_request: "15000", max_per_month: "15000" } };
  assert.match(refused(await setAutopay(rule(signed), routes(() => json(201, other)))), /answered with a different rule than the one signed/);
  assert.match(refused(await setAutopay(rule(signed), routes(() => "network_error"))), /couldn't be reached, so nothing was saved/);
});

test("revoke: the message names the rule; the reply says it ended (or already had)", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:20:00Z") });
  const first = ok(await setAutopay(inputSchema.parse({ payer: PAYER, revoke: "Rk7mPq2xLw9a" }), deps));
  assert.equal(first.mode, "revoke");
  assert.equal(first.message_to_sign, revokeReq.signed_message);
  assert.equal(first.message_to_sign, revokeMessage("Rk7mPq2xLw9a", PAYER, Date.parse("2026-10-18T10:20:00Z")));
  assert.equal(rec.calls.length, 0);
  const { deps: d2, rec: rec2 } = makeDeps({ now: at("2026-10-18T10:21:00Z"), routes: { "POST /api/v1/autopay/revoke": () => json(200, revokeRes) } });
  const r = await setAutopay(inputSchema.parse({ payer: PAYER, revoke: "Rk7mPq2xLw9a", signed_message: revokeReq.signed_message, signature: revokeReq.signature }), d2);
  const out = ok(r);
  assert.deepEqual(rec2.calls[0]!.body, revokeReq);
  assert.equal(out.step, "revoked");
  assert.equal(out.already_revoked, false);
  assert.match(textOf(r), /^Ended autopay rule Rk7mPq2xLw9a for @landlord_bob/);
  const { deps: d3 } = makeDeps({ now: at("2026-10-18T10:21:00Z"), routes: { "POST /api/v1/autopay/revoke": () => json(200, { ...revokeRes, already_revoked: true }) } });
  assert.match(textOf(await setAutopay(inputSchema.parse({ payer: PAYER, revoke: "Rk7mPq2xLw9a", signed_message: revokeReq.signed_message, signature: revokeReq.signature }), d3)), /was already ended/);
  // A create message can't revoke, and an unknown rule is the server's not_found.
  const { deps: d4 } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/autopay/revoke": () => json(404, { error: { code: "not_found", message: "no autopay rule with this id for this payer" } }) } });
  assert.match(refused(await setAutopay(inputSchema.parse({ payer: PAYER, revoke: "Rk7mPq2xLw9a", signed_message: createReq.signed_message, signature: createReq.signature }), d4)), /must be exactly the message_to_sign/);
  const fresh = revokeMessage("Rk7mPq2xLw9a", PAYER, Date.parse("2026-10-18T10:15:30Z"));
  assert.match(refused(await setAutopay(inputSchema.parse({ payer: PAYER, revoke: "Rk7mPq2xLw9a", signed_message: fresh, signature: signHex(fresh) }), d4)), /no autopay rule with that id/);
});

test("the signed rule read back: exact grammar, canonical amounts, and what an eligible line must fit", () => {
  const parsed = parseSignedRule(createReq.signed_message)!;
  assert.equal(parsed.payer, PAYER);
  assert.equal(parsed.requester, LANDLORD);
  assert.equal(parsed.maxPerRequestAtomic, 1_500_000_000n);
  assert.equal(parsed.endsAtMs, Date.parse("2027-10-19T00:00:00Z"));
  assert.equal(parseSignedRule(createReq.signed_message.replace("1500 USDC per request", "1500.00 USDC per request")), null);
  assert.equal(autopayMessage({ payer: PAYER, requester: LANDLORD, maxPerRequestAtomic: 1_500_000_000n, maxPerMonthAtomic: 1_500_000_000n, ends: "2027-10-18" }, Date.parse("2026-10-18T10:15:00Z")), createReq.signed_message);
  const now = Date.parse("2026-10-18T10:30:00Z");
  const r = createRes.rule;
  assert.equal(signedRuleProblem(r, PAYER, LANDLORD, 1_000_000_000n, now), null);
  assert.match(signedRuleProblem(r, PAYER, LANDLORD, 1_500_000_001n, now)!, /above the signed rule's maximum/);
  assert.match(signedRuleProblem(r, PAYER, "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD", 1n, now)!, /different wallet/);
  assert.match(signedRuleProblem({ ...r, signature: `${"0".repeat(127)}1` }, PAYER, LANDLORD, 1n, now)!, /signature isn't this wallet's/);
  assert.match(signedRuleProblem(r, PAYER, LANDLORD, 1n, Date.parse("2027-10-19T00:00:00Z"))!, /ended/);
  assert.match(signedRuleProblem(undefined, PAYER, LANDLORD, 1n, now)!, /didn't list/);
});
