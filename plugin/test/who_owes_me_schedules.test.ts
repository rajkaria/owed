import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { inputSchema, ledgerMessage, outputSchema, whoOwesMe, type WhoOutput } from "../src/tools/who_owes_me.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// W3-D in who_owes_me: monthly schedules (ask_every_month) and the 10-minute CSV link, against
// contract/fixtures/ledger.schedules.*. The fixture's wallet is a throwaway key from a fixed seed; it holds nothing.

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv) };
}
const ME = signer("owed contract fixture: ledger.schedules");
const res = fixture("ledger.schedules.res.json");
const req = fixture("ledger.schedules.req.json");
const NOW = Date.parse("2026-10-17T14:05:00Z");

function out(result: Awaited<ReturnType<typeof whoOwesMe>>): WhoOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  const o = (result as { structuredContent: WhoOutput }).structuredContent;
  outputSchema.parse(o);
  return o;
}
const signed = (extra: Record<string, unknown> = {}) => {
  const message = ledgerMessage(ME.address, NOW);
  return inputSchema.parse({ recipient: ME.address, signed_message: message, signature: ME.sign(message).toString("hex"), ...extra });
};

test("the fixture's request is signed by the fixture's wallet (the same throwaway key)", () => {
  assert.equal(req.recipient, ME.address);
  assert.equal(res.recipient, ME.address);
  assert.equal(ME.sign(req.signed_message).toString("hex"), req.signature);
});

test("csv: true is sent with the signed call; the link, the schedules and the monthly entries come back", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW + 2000, routes: { "POST /api/v1/ledger": () => json(200, res) } });
  const result = await whoOwesMe(signed({ csv: true }), deps);
  const o = out(result);
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0]!.body as { csv?: boolean }).csv, true);
  assert.equal(o.csv_url, res.csv.url);
  assert.equal(o.csv_expires_at, "2026-10-17T14:15:02Z");
  assert.deepEqual(o.schedules!.map((s) => [s.id, s.status, s.requests_opened, s.next_request_on, s.requests.map((r) => r.period)]), [
    ["S7mKq2RtVx9P", "active", 2, "2026-11-01", ["2026-10", "2026-09"]],
    ["Gm4ZkP8wQe2N", "ended", 1, null, []],
  ]);
  assert.deepEqual(o.open!.map((e) => [e.schedule_id ?? null, e.period ?? null]), [["S7mKq2RtVx9P", "2026-10"], [null, null]]);
  assert.equal(o.paid_recently![0]!.period, "2026-09");

  const text = textOf(result);
  const oct = res.schedules[0].requests[0];
  assert.ok(text.includes(`Monthly: 450 USDC from "Sam" for "rent" on the 1st (UTC); Oct 2026's request open: ${oct.link}; next opens 2026-11-01`), text);
  assert.ok(text.includes(`Monthly: 25 USDC from "Priya" for "phone plan" on the 28th (UTC); ended after 1 request`), text);
  assert.ok(text.includes(`, monthly request for Oct 2026, waiting`), text);
  assert.ok(text.includes(`CSV of every open and paid request (for accounting): ${res.csv.url} (works until 2026-10-17T14:15:02Z, 10 minutes).`), text);
});

test("without csv the call carries no csv flag and shows no link, even if one came back", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW + 2000, routes: { "POST /api/v1/ledger": () => json(200, res) } });
  const result = await whoOwesMe(signed(), deps);
  const o = out(result);
  assert.equal("csv" in (rec.calls[0]!.body as object), false);
  assert.equal(o.csv_url, undefined);
  assert.doesNotMatch(textOf(result), /CSV/);
  assert.equal(o.schedules!.length, 2); // schedules are always listed
});

test("csv asked on a server without the secret: says there is no link", async () => {
  const { deps } = makeDeps({ now: () => NOW + 2000, routes: { "POST /api/v1/ledger": () => json(200, { ...res, csv: null }) } });
  const result = await whoOwesMe(signed({ csv: true }), deps);
  assert.equal(out(result).csv_url, undefined);
  assert.match(textOf(result), /CSV export isn't set up on this Owed server/);
});

test("schedule text is the requester's: cleaned and quoted; a stuck month says why; a server without schedules still works", async () => {
  const schedules = [{
    ...res.schedules[0], for: "rent https://evil.example", payer_name: "Sam‮",
    last_error: "example.com: from_domain: example.com does not publish this recipient", from_domain: "example.com",
  }];
  const { deps } = makeDeps({ now: () => NOW + 2000, routes: { "POST /api/v1/ledger": () => json(200, { ...res, schedules }) } });
  const result = await whoOwesMe(signed(), deps);
  const o = out(result);
  assert.equal(o.schedules![0]!.for, "rent [link removed]");
  assert.equal(o.schedules![0]!.payer_name, "Sam");
  const text = textOf(result);
  assert.match(text, /Monthly: 450 USDC from "Sam" for "rent \[link removed\]" on the 1st \(UTC\), as example\.com;/);
  assert.match(text, /couldn't open this month's request yet \(retried daily\): example\.com: from_domain: example\.com does not publish this recipient/);

  // W2-D's ledger without the W3-D fields (an older server): no schedules key at all.
  const { schedules: _s, csv: _c, ...older } = res;
  const plain = makeDeps({ now: () => NOW + 2000, routes: { "POST /api/v1/ledger": () => json(200, older) } });
  const o2 = out(await whoOwesMe(signed(), plain.deps));
  assert.equal(o2.schedules, undefined);
});
