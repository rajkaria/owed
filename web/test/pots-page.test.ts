import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyPot, countLine, customAmount, mintedFrom, parsePot, potDescription, potTitle, potView, raisedLine } from "@/app/pot/[id]/model";
import { PotContributionResponse, PotResponse } from "@/lib/contract";

// F7: the /pot/<id> board's view model against the contract fixtures (the same JSON GET /api/v1/pots/:id serves).

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const ORIGIN = "https://www.getowed.xyz";
const got = PotResponse.parse(fixture("pots.get.res.json"));
const created = PotResponse.parse(fixture("pots.create.res.json"));
const contribution = PotContributionResponse.parse(fixture("pots.contribution.res.json"));

test("potView: totals, progress, fixed amounts with their QR transaction requests, contributions", () => {
  const v = potView(got, ORIGIN);
  assert.equal(v.link, `${ORIGIN}/pot/${got.id}`);
  assert.equal(v.raised, got.totals.raised);
  assert.equal(v.count, got.totals.count);
  assert.equal(v.target, got.target);
  assert.equal(v.progressBps, Number((BigInt(42_500_000) * BigInt(10000)) / BigInt(100_000_000)));
  assert.deepEqual(v.amounts, got.links.transaction_request.map((l) => ({ amount: l.amount, qr: l.url })));
  assert.equal(v.contributions.length, got.contributions.length);
  assert.equal(v.ended, false);
  assert.equal(raisedLine(v), "42.5 of 100 USDC raised");
  assert.equal(countLine(1), "1 contribution");
  assert.equal(potTitle(v), "Chip-in pot: 42.5 of 100 USDC raised");
  assert.match(potDescription(v), /for “Farewell gift for Ana” from 3 contributions\. Chip in with any Solana wallet/);
});

test("potView: progress caps at the target; no target means no bar", () => {
  const over = potView({ ...got, totals: { raised: "250", count: 9 } }, ORIGIN);
  assert.equal(over.progressBps, 10000);
  const none = potView({ ...got, target: null }, ORIGIN);
  assert.equal(none.progressBps, null);
  assert.equal(raisedLine(none), "42.5 USDC raised");
});

test("a pot that mentions a brand: no requester name, and the title never reaches the page title or preview", () => {
  const flagged = potView({ ...got, title: "PayBox refund", flags: ["brand_word:paybox"], requester_name: "Support" }, ORIGIN);
  assert.deepEqual(flagged.brandWords.sort(), ["PayBox", "refund"].sort());
  assert.equal(flagged.requester, null);
  assert.doesNotMatch(potTitle(flagged), /PayBox|refund/);
  assert.doesNotMatch(potDescription(flagged), /refund|“/); // Owed's own "your AI agent in PayBox" stays; the title never appears
});

test("requester text is cleaned again on render (links and invisible characters)", () => {
  const v = potView({ ...got, title: "Gift​ for www.evil.example Ana", note: "see https://x.example now" }, ORIGIN);
  assert.equal(v.title, "Gift for Ana");
  assert.equal(v.note, "see now");
});

test("an ended pot: no fixed amounts or presets to pay", () => {
  const ended = potView({ ...got, status: "ended", links: { ...got.links, transaction_request: [], x402: [] } }, ORIGIN);
  assert.equal(ended.ended, true);
  assert.deepEqual([ended.amounts, ended.x402], [[], []]);
  assert.match(potDescription(ended), /This pot has ended/);
});

test("parsePot accepts the API's reply and refuses anything off-shape", () => {
  assert.ok(parsePot(got));
  assert.ok(parsePot(created));
  for (const bad of [null, [], { ...got, id: "short" }, { ...got, totals: { raised: "1.2.3", count: 1 } }, { ...got, status: "maybe" },
    { ...got, contributions: [{ id: "x" }] }, { ...got, links: { board: "x", transaction_request: "no", x402: [] } }, { ...got, token: "BONK" }]) {
    assert.equal(parsePot(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test("applyPot: a fresh reply updates the board; one that shows less, or another pot, is ignored", () => {
  const start = potView(created, ORIGIN);
  const next = applyPot(start, got, ORIGIN);
  assert.equal(next.raised, "42.5");
  assert.equal(applyPot(next, created, ORIGIN), next); // less raised: ignored
  assert.equal(applyPot(next, { ...got, id: "11111111111111" }, ORIGIN), next);
  assert.equal(applyPot(next, { nope: true }, ORIGIN), next);
});

test("mintedFrom: the board shows a minted contribution only if it pays this pot's wallet, token and amount", () => {
  const v = potView(created, ORIGIN);
  const m = mintedFrom(contribution, v, contribution.amount, ORIGIN);
  assert.ok(m);
  assert.equal(m!.walletUrl, `solana:${ORIGIN}/api/v1/pay/${contribution.id}`);
  assert.equal(m!.qrSrc, `/api/qr/${contribution.id}.svg`);
  assert.equal(m!.page, `${ORIGIN}/r/${contribution.id}`);
  assert.equal(m!.transferUrl, contribution.solana_pay_url);
  assert.equal(mintedFrom(contribution, v, "999", ORIGIN), null);
  assert.equal(mintedFrom({ ...contribution, recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, v, contribution.amount, ORIGIN), null);
  assert.equal(mintedFrom({ ...contribution, pot: { ...contribution.pot, id: "11111111111111" } }, v, contribution.amount, ORIGIN), null);
  assert.equal(mintedFrom({ ...contribution, solana_pay_url: "solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=10" }, v, contribution.amount, ORIGIN), null);
});

test("customAmount: canonical decimals in the pot's token, nothing else", () => {
  assert.equal(customAmount(" 10.50 ", "USDC"), "10.5");
  assert.equal(customAmount("0.000001", "USDC"), "0.000001");
  for (const bad of ["0", "-1", "1e3", "0.0000001", "abc", ""]) assert.equal(customAmount(bad, "USDC"), null, bad);
  assert.equal(customAmount("0.000000001", "SOL"), "0.000000001");
});
