import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_CAUTION, inputSchema, outputSchema, whatDoIOwe } from "../src/tools/what_do_i_owe.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// F1 what_do_i_owe: two calls like who_owes_me. The signed messages and the server's replies are the contract
// fixtures (contract/inbox-fixtures.mjs): a real ed25519 signature by the fixtures' payer wallet.

const inboxReq = fixture("inbox.req.json");
const inboxRes = fixture("inbox.res.json");
const blockReq = fixture("inbox.block.req.json");
const blockRes = fixture("inbox.block.res.json");
const SAM = inboxReq.payer as string;
const at = (iso: string) => () => Date.parse(iso);
const parse = (args: Record<string, unknown>) => inputSchema.parse({ payer: SAM, ...args });
type Out = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
const refused = (r: Out) => {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r)}`);
  return textOf(r);
};

test("first call: the exact message to sign, how to sign it with PayBox, and nothing sent to Owed", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:15:00Z") });
  const r = await whatDoIOwe(parse({}), deps);
  const out = outputSchema.parse(r.structuredContent);
  assert.equal(out.step, "sign");
  assert.equal(out.message_to_sign, inboxReq.signed_message);
  assert.equal(out.expires_at, "2026-10-18T10:20:00Z");
  assert.match(textOf(r), /request_wallet_sign with this wallet's credential_id and intent \{"op":"solanaMessage"/);
  assert.equal(rec.calls.length, 0);
});

test("second call: the server's inbox once, with unverified labels, first-time marks, Base apart and a pay_all hint", async () => {
  const { deps, rec } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/inbox": () => json(200, inboxRes) } });
  const r = await whatDoIOwe(parse({ signed_message: inboxReq.signed_message, signature: inboxReq.signature }), deps);
  assert.notEqual(r.isError, true, textOf(r));
  assert.deepEqual(rec.calls[0]!.body, inboxReq);
  const out = outputSchema.parse(r.structuredContent);
  assert.equal(out.step, "inbox");
  assert.equal(out.caution, INBOX_CAUTION);
  assert.equal(INBOX_CAUTION, inboxRes.caution, "the plugin and the server say the same");
  assert.equal(out.owed!.length, 3);
  assert.equal(out.base!.length, 1);
  assert.equal(out.outstanding_total, "13.35 USDC on Solana + 5 USDC on Base");
  assert.deepEqual(out.pay_all_ids, inboxRes.owed.map((e: { id: string }) => e.id));
  assert.equal(out.blocked_hidden, 1);
  const [ticket, share, invoice] = out.owed!;
  assert.deepEqual([ticket!.requester_handle, ticket!.addressed_as, ticket!.first_time], ["rajkaria", "@sam_ok", false]);
  assert.equal(share!.group_title, "Climbing gym");
  assert.deepEqual([invoice!.kind, invoice!.due_date, invoice!.invoice_number, invoice!.first_time], ["invoice", "2026-10-31", "LS-31", true]);
  const text = textOf(r);
  assert.match(text, /^4 open requests addressed to this wallet: 13\.35 USDC on Solana \+ 5 USDC on Base\./);
  assert.match(text, /Owe: 12 USDC to "Raj" \(@rajkaria on X, not verified by Owed\) for "concert tickets" \(the requester's words, unverified\)/);
  assert.match(text, /invoice "LS-31", due 31 Oct 2026 \(the requester's words, unverified\).*First request from this wallet: the user has never paid it through Owed\./);
  assert.match(text, /On Base \(pay each with pay_link/);
  assert.match(text, /1 open request from blocked wallets is hidden\./);
  assert.match(text, /pay_all with sender \(this wallet\), ids and max_total/);
});

test("a brand-word caution is shown and kept out of pay_all_ids", async () => {
  const cautioned = { ...inboxRes, owed: inboxRes.owed.map((e: Record<string, unknown>, i: number) => (i === 0 ? { ...e, flags: ["brand_word:paybox"] } : e)) };
  const { deps } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/inbox": () => json(200, cautioned) } });
  const out = outputSchema.parse((await whatDoIOwe(parse({ signed_message: inboxReq.signed_message, signature: inboxReq.signature }), deps)).structuredContent);
  assert.match(out.owed![0]!.caution!, /"PayBox", a word scams use/);
  assert.ok(!out.pay_all_ids!.includes(inboxRes.owed[0].id));
});

test("local checks: stale, future, wrong wording, wrong signer, and half a pair are refused without a call", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["2026-10-18T10:21:00Z", { signed_message: inboxReq.signed_message, signature: inboxReq.signature }, /more than 5 minutes old/],
    ["2026-10-18T10:13:00Z", { signed_message: inboxReq.signed_message, signature: inboxReq.signature }, /dated in the future/],
    ["2026-10-18T10:16:00Z", { signed_message: inboxReq.signed_message.replace("inbox access", "ledger access"), signature: inboxReq.signature }, /must be exactly the message_to_sign/],
    ["2026-10-18T10:16:00Z", { signed_message: inboxReq.signed_message, signature: `${"0".repeat(127)}1` }, /isn't from wallet/],
    ["2026-10-18T10:16:00Z", { signed_message: inboxReq.signed_message }, /Pass both signed_message and signature/],
  ];
  for (const [now, args, why] of cases) {
    const { deps, rec } = makeDeps({ now: at(now), routes: { "POST /api/v1/inbox": () => json(200, inboxRes) } });
    assert.match(refused(await whatDoIOwe(parse(args), deps)), why, now);
    assert.equal(rec.calls.length, 0);
  }
});

test("the server refusing the signature or answering for another wallet is a refusal", async () => {
  const { deps } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/inbox": () => json(400, { error: { code: "invalid_input", message: "this signature was already used; sign a fresh message to try again" } }) } });
  assert.match(refused(await whatDoIOwe(parse({ signed_message: inboxReq.signed_message, signature: inboxReq.signature }), deps)), /Owed refused the signature: this signature was already used/);
  const { deps: other } = makeDeps({ now: at("2026-10-18T10:16:00Z"), routes: { "POST /api/v1/inbox": () => json(200, { ...inboxRes, payer: blockReq.requester }) } });
  assert.match(refused(await whatDoIOwe(parse({ signed_message: inboxReq.signed_message, signature: inboxReq.signature }), other)), /different wallet/);
});

test("block: the message names the requester; the reply blocks it and shows the inbox after", async () => {
  const { deps } = makeDeps({ now: at("2026-10-18T10:16:30Z") });
  const first = outputSchema.parse((await whatDoIOwe(parse({ block: blockReq.requester }), deps)).structuredContent);
  assert.equal(first.message_to_sign, blockReq.signed_message);
  const { deps: d2, rec } = makeDeps({ now: at("2026-10-18T10:17:00Z"), routes: { "POST /api/v1/inbox/block": () => json(200, blockRes) } });
  const r = await whatDoIOwe(parse({ block: blockReq.requester, signed_message: blockReq.signed_message, signature: blockReq.signature }), d2);
  assert.notEqual(r.isError, true, textOf(r));
  assert.deepEqual(rec.calls[0]!.body, blockReq);
  const out = outputSchema.parse(r.structuredContent);
  assert.deepEqual(out.blocked, { requester: blockReq.requester, blocked: true, changed: true });
  assert.match(textOf(r), /^Blocked \S+: its requests are hidden from this inbox\. They aren't cancelled; anyone can still pay them\./);
  // An inbox signature can't be used to block, and block + unblock together are refused.
  const { deps: d3 } = makeDeps({ now: at("2026-10-18T10:16:00Z") });
  assert.match(refused(await whatDoIOwe(parse({ block: blockReq.requester, signed_message: inboxReq.signed_message, signature: inboxReq.signature }), d3)), /must be exactly the message_to_sign/);
  assert.match(refused(await whatDoIOwe(parse({ block: blockReq.requester, unblock: blockReq.requester }), d3)), /not both/);
});
