import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autopayMessage, autopayPrefix, autopayVerdicts, candidateRecipients, endsAtFor, latestEnds, limitProblem, monthOf, revokePrefix,
  type UsdcAccount, type VerdictLine, type VerdictRule,
} from "@/lib/autopay-core";

// F5 autopay: the pure rules. The message grammar the server rebuilds, the end-date window, the limits, and every
// verdict and reason: eligible, over_limit (per request; per month across two lines and across a payment made earlier
// this month) and not_covered (no rule, revoked, ended, SOL, Base, underpaid, brand caution, no USDC account, unknown).

const PAYER = "Edah8cvCZDBBpQdj7UaP8EreFAwL6ZURjdGtZSj2DDJK";
const LANDLORD = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";
const NOW = Date.parse("2026-10-18T10:15:00Z");
const USDC = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

test("the create message: exact grammar, amounts as fromAtomic writes them, the time in parentheses", () => {
  const t = { payer: PAYER, requester: LANDLORD, maxPerRequestAtomic: 1_500_000_000n, maxPerMonthAtomic: 1_500_000_000n, ends: "2027-10-18" };
  assert.equal(autopayPrefix(t), `Owed autopay for ${PAYER}: pay ${LANDLORD} up to 1500 USDC per request and 1500 USDC per month until 2027-10-18`);
  assert.equal(autopayMessage(t, NOW + 999), `${autopayPrefix(t)} (at 2026-10-18T10:15:00Z)`);
  assert.equal(autopayPrefix({ ...t, maxPerRequestAtomic: 500_000n, maxPerMonthAtomic: 2_500_000n }).includes("up to 0.5 USDC per request and 2.5 USDC per month"), true);
  // The longest realistic message (44-character wallets, six-decimal amounts) still fits 300 characters.
  const long = autopayMessage({ ...t, maxPerRequestAtomic: 999_999_999_999n, maxPerMonthAtomic: 999_999_999_999n }, NOW);
  assert.ok(long.length <= 300, String(long.length));
  assert.equal(revokePrefix("Ab3dEf6hJk9m", PAYER), `Owed autopay revoke Ab3dEf6hJk9m for ${PAYER}`);
});

test("ends: today through the same date next year; the rule stops at the start of the next UTC day", () => {
  assert.deepEqual(endsAtFor("2026-10-18", NOW), { ok: true, endsAtMs: Date.parse("2026-10-19T00:00:00Z") });
  assert.deepEqual(endsAtFor("2027-10-18", NOW), { ok: true, endsAtMs: Date.parse("2027-10-19T00:00:00Z") });
  assert.equal(latestEnds(NOW), "2027-10-18");
  assert.equal(latestEnds(Date.parse("2028-02-29T12:00:00Z")), "2029-03-01");
  for (const [ends, why] of [["2026-10-17", /in the past/], ["2027-10-19", /at most a year away \(2027-10-18/], ["2026-02-30", /YYYY-MM-DD/], ["18/10/2027", /YYYY-MM-DD/]] as const) {
    const r = endsAtFor(ends, NOW);
    assert.equal(r.ok, false, ends);
    assert.match((r as { message: string }).message, why);
  }
});

test("limits: positive, at most 1,000,000 USDC, and the month at least the request", () => {
  assert.equal(limitProblem(USDC(1500), USDC(1500)), null);
  assert.match(limitProblem(USDC(1500), USDC(1000))!, /max_per_month must be at least max_per_request/);
  assert.match(limitProblem(0n, USDC(1))!, /more than 0/);
  assert.match(limitProblem(USDC(1_000_001), USDC(1_000_001))!, /at most 1000000/);
  assert.deepEqual(monthOf(NOW), { label: "2026-10", startMs: Date.parse("2026-10-01T00:00:00Z") });
});

const rule = (over: Partial<VerdictRule> = {}): VerdictRule => ({
  id: "Rule1aaaaaaa", requester: LANDLORD, maxPerRequestAtomic: USDC(1500), maxPerMonthAtomic: USDC(1500),
  endsAtMs: Date.parse("2027-10-19T00:00:00Z"), revokedAtMs: null, usedThisMonthAtomic: 0n, ...over,
});
let seq = 0;
const line = (over: Partial<VerdictLine> = {}): VerdictLine => ({
  id: `line${++seq}`, chain: "solana", token: "USDC", status: "open", recipient: LANDLORD, amountAtomic: USDC(1000), flags: [], ...over,
});
const rules = (...list: VerdictRule[]) => new Map(list.map((r) => [r.requester, r]));
const exists = (): UsdcAccount => "exists";

test("eligible: USDC on Solana, open, to the rule's wallet, within both limits", () => {
  const [v] = autopayVerdicts([line({ amountAtomic: USDC(1200) })], rules(rule()), exists, NOW);
  assert.deepEqual(v, { status: "eligible", rule_id: "Rule1aaaaaaa", reason: "Within the rule: 1200 USDC of 1500 USDC per request, 1200 USDC of 1500 USDC this month (UTC)." });
});

test("over_limit: above the per-request maximum is never eligible", () => {
  const [v] = autopayVerdicts([line({ amountAtomic: USDC(1500.000001) })], rules(rule()), exists, NOW);
  assert.equal(v!.status, "over_limit");
  assert.equal(v!.reason, "1500.000001 USDC is above the rule's 1500 USDC per request.");
  // Exactly the maximum is fine.
  assert.equal(autopayVerdicts([line({ amountAtomic: USDC(1500) })], rules(rule()), exists, NOW)[0]!.status, "eligible");
});

test("the month cap across two lines: two 1,000 USDC requests under 1,500 a month give eligible, then over_limit", () => {
  const [a, b] = autopayVerdicts([line(), line()], rules(rule()), exists, NOW);
  assert.equal(a!.status, "eligible");
  assert.equal(b!.status, "over_limit");
  assert.equal(b!.reason, "Paying it would make 2000 USDC this month (UTC), above the rule's 1500 USDC per month (1000 USDC already counted).");
  // A smaller third line still fits beside the first.
  const three = autopayVerdicts([line(), line(), line({ amountAtomic: USDC(500) })], rules(rule()), exists, NOW);
  assert.deepEqual(three.map((v) => v.status), ["eligible", "over_limit", "eligible"]);
});

test("the month cap across a payment made earlier this month", () => {
  const [v] = autopayVerdicts([line()], rules(rule({ usedThisMonthAtomic: USDC(600) })), exists, NOW);
  assert.equal(v!.status, "over_limit");
  assert.match(v!.reason, /1600 USDC this month \(UTC\), above the rule's 1500 USDC per month \(600 USDC already counted\)/);
  assert.equal(autopayVerdicts([line({ amountAtomic: USDC(900) })], rules(rule({ usedThisMonthAtomic: USDC(600) })), exists, NOW)[0]!.status, "eligible");
});

test("not_covered, with the reason: no rule, revoked, ended, SOL, Base, partly paid, brand caution", () => {
  const cases: Array<[VerdictLine, VerdictRule | null, RegExp]> = [
    [line({ recipient: OTHER }), rule(), /^No autopay rule covers this requester's wallet\.$/],
    [line(), rule({ revokedAtMs: Date.parse("2026-10-17T09:00:00Z") }), /revoked on 2026-10-17/],
    [line(), rule({ endsAtMs: Date.parse("2026-10-18T00:00:00Z") }), /ended on 2026-10-17/],
    [line({ token: "SOL", amountAtomic: 1_000_000_000n }), rule(), /USDC requests on Solana only/],
    [line({ chain: "base", recipient: LANDLORD }), rule(), /USDC requests on Solana only/],
    [line({ status: "underpaid" }), rule(), /partly paid already/],
    [line({ flags: ["brand_word:paybox"] }), rule(), /brand word scams use, so it is never paid automatically/],
  ];
  for (const [l, r, why] of cases) {
    const [v] = autopayVerdicts([l], r ? rules(r) : rules(), exists, NOW);
    assert.equal(v!.status, "not_covered", why.source);
    assert.match(v!.reason, why);
    if (l.recipient === LANDLORD && r) assert.equal(v!.rule_id, r.id);
  }
});

test("not_covered: no USDC account for the requester (x402 can't open one), or Solana couldn't be read", () => {
  const [missing] = autopayVerdicts([line()], rules(rule()), () => "missing", NOW);
  assert.equal(missing!.status, "not_covered");
  assert.match(missing!.reason, /no USDC account yet, and an x402 payment can't open one; pay it by hand with pay_link \(rail solana_pay\)/);
  const [unknown] = autopayVerdicts([line()], rules(rule()), () => "unknown", NOW);
  assert.match(unknown!.reason, /couldn't be read to check the requester's USDC account/);
  // A line that isn't eligible doesn't use up the month: after a missing-account line, nothing was counted.
  const both = autopayVerdicts([line(), line({ recipient: OTHER })], rules(rule(), rule({ id: "Rule2bbbbbbb", requester: OTHER })), (r) => (r === LANDLORD ? "missing" : "exists"), NOW);
  assert.deepEqual(both.map((v) => v.status), ["not_covered", "eligible"]);
});

test("the chain is read only for requesters with a would-be eligible line", () => {
  const list = [line(), line({ recipient: OTHER, amountAtomic: USDC(5000) }), line({ flags: ["brand_word:irs"] })];
  assert.deepEqual(candidateRecipients(list, rules(rule(), rule({ id: "Rule2bbbbbbb", requester: OTHER })), NOW), [LANDLORD]);
  assert.deepEqual(candidateRecipients([line({ amountAtomic: USDC(2000) })], rules(rule()), NOW), []);
});
