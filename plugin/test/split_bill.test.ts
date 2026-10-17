import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { CreateGroupReq, GroupRes } from "../src/contract.ts";
import * as money from "../src/money.ts";
import { requestIdFor } from "../src/request-id.ts";
import type { Screening } from "../src/screen.ts";
import * as solanaPay from "../src/solana-pay.ts";
import { groupIdFor, inputSchema, outputSchema, planShares, splitBill, type CheckFromDomain, type SplitOutput } from "../src/tools/split_bill.ts";
import { BASE, fixture, html, json, makeDeps, RECIPIENT, textOf, USDC_MINT, type Call, type Route } from "./helpers.ts";

const createdFixture: GroupRes = fixture("groups.create.res.json");
const PEOPLE = [{ name: "Priya" }, { name: "Sam" }, { name: "Alex" }];
const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  recipient: RECIPIENT, total: "1.5", title: "Pizza night", people: PEOPLE, requester_name: "Raj", ...extra,
});
const clear = async (): Promise<Screening> => ({ ok: true, screening: "skipped" });

/** A stand-in for POST /api/v1/groups that builds what the real server builds (lib/groups.ts) for any body. */
function server(tamper: (res: GroupRes) => void = () => {}): Route {
  return (call: Call) => {
    const body = call.body as CreateGroupReq;
    const token = body.token;
    const shares = body.people.map((p, i) => {
      const reference = bs58.encode(createHash("sha256").update(`test-reference-${i}`).digest());
      const amountAtomic = money.toAtomic(p.amount!, token);
      const id = requestIdFor({ recipient: body.recipient, token, amountAtomic, reference });
      const solana_pay_url = solanaPay.buildTransferUrl({
        recipient: body.recipient, amount: p.amount, references: [reference], memo: `owed:${id}`, message: body.title,
        ...(token === "USDC" && { splToken: USDC_MINT }), ...(body.requester_name && { label: body.requester_name }),
      });
      return { id, name: p.name, amount: p.amount!, status: "open", link: `https://owed.link/r/${id}`, solana_pay_url, reference, paid: null };
    });
    const totalAtomic = money.toAtomic(body.total, token);
    const id = groupIdFor({ recipient: body.recipient, token, totalAtomic, shareIds: shares.map((s) => s.id) });
    const res: GroupRes = {
      id, link: `https://owed.link/g/${id}`, title: body.title, recipient: body.recipient, token, total: body.total,
      requester_name: body.requester_name ?? null, created_at: "2026-10-17T07:30:00Z", flags: [],
      share_count: shares.length, paid_count: 0, amount_received: "0", shares,
    };
    tamper(res);
    return json(201, res);
  };
}

function structured(result: Awaited<ReturnType<typeof splitBill>>): SplitOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  const out = (result as { structuredContent: SplitOutput }).structuredContent;
  outputSchema.parse(out);
  return out;
}

function refused(result: Awaited<ReturnType<typeof splitBill>>): string {
  assert.equal("isError" in result && result.isError, true, "expected a refusal");
  return textOf(result);
}

test("hosted: sends the contract body, checks the reply and returns the board and one link per person", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": () => json(201, createdFixture) } });
  const result = await splitBill(input(), deps, clear);
  const out = structured(result);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, `${BASE}/api/v1/groups`);
  assert.deepEqual(rec.calls[0]!.body, fixture("groups.create.req.json"));
  assert.equal(out.mode, "hosted");
  assert.equal(out.group_id, createdFixture.id);
  assert.equal(out.group_link, createdFixture.link);
  assert.equal(out.total, "1.5");
  assert.equal(out.remainder_note, undefined);
  assert.deepEqual(out.shares.map((s) => [s.name, s.amount, s.id, s.link]), createdFixture.shares.map((s) => [s.name, "0.5", s.id, s.link]));
  assert.equal(
    out.shares[0]!.share_text,
    `Hey Priya, it's Raj. Your share for "Pizza night" is 0.5 USDC. Pay with any Solana wallet here: ${createdFixture.shares[0]!.link}`,
  );
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], `Split ready: "Pizza night", 1.5 USDC from 3 people. Live board: ${createdFixture.link}`);
  assert.equal(lines[1], `- Priya: 0.5 USDC ${createdFixture.shares[0]!.link}`);
  assert.match(textOf(result), /check_payments takes the share ids/);
});

test("the plugin and the server derive the same group id (fixture built by contract/shapes.mjs)", () => {
  const shareIds = createdFixture.shares.map((s) => s.id);
  assert.equal(groupIdFor({ recipient: RECIPIENT, token: "USDC", totalAtomic: 1_500_000n, shareIds }), createdFixture.id);
  assert.notEqual(groupIdFor({ recipient: RECIPIENT, token: "USDC", totalAtomic: 1_500_000n, shareIds: [...shareIds].reverse() }), createdFixture.id);
  assert.notEqual(groupIdFor({ recipient: RECIPIENT, token: "SOL", totalAtomic: 1_500_000n, shareIds }), createdFixture.id);
});

test("uneven totals: leftover atomic units go to the first people and the note says who", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const out = structured(await splitBill(input({ total: "10" }), deps, clear));
  assert.deepEqual(out.shares.map((s) => s.amount), ["3.333334", "3.333333", "3.333333"]);
  assert.deepEqual((rec.calls[0]!.body as CreateGroupReq).people.map((p) => p.amount), ["3.333334", "3.333333", "3.333333"]);
  assert.equal(out.remainder_note, "10 USDC doesn't split evenly 3 ways, so Priya pays 0.000001 USDC more.");

  const two = structured(await splitBill(input({ total: "0.000005" }), deps, clear));
  assert.deepEqual(two.shares.map((s) => s.amount), ["0.000002", "0.000002", "0.000001"]);
  assert.equal(two.remainder_note, "0.000005 USDC doesn't split evenly 3 ways, so Priya and Sam each pay 0.000001 USDC more.");
});

test("set amounts are kept and the rest is split evenly between everyone else", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const out = structured(await splitBill(input({
    total: "2.5", people: [{ name: "Priya" }, { name: "Sam", amount: "1" }, { name: "Alex" }, { name: "Jo" }],
  }), deps, clear));
  assert.deepEqual(out.shares.map((s) => [s.name, s.amount]), [["Priya", "0.5"], ["Sam", "1"], ["Alex", "0.5"], ["Jo", "0.5"]]);

  const all = structured(await splitBill(input({ total: "3", people: [{ name: "Priya", amount: "2" }, { name: "Sam", amount: "1" }] }), deps, clear));
  assert.deepEqual(all.shares.map((s) => s.amount), ["2", "1"]);
});

test("SOL splits use 9 decimals", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const out = structured(await splitBill(input({ total: "1", token: "SOL" }), deps, clear));
  assert.deepEqual(out.shares.map((s) => s.amount), ["0.333333334", "0.333333333", "0.333333333"]);
  assert.equal(out.token, "SOL");
  const parsed = solanaPay.parseLink(out.shares[0]!.solana_pay_url, ["owed.link"]);
  assert.equal(parsed.kind === "transfer" && parsed.request.splToken, undefined);
});

for (const [name, extra, expected] of [
  ["set amounts above the total", { total: "1", people: [{ name: "Priya", amount: "2" }, { name: "Sam" }] }, /already add up to 2 USDC of the 1 USDC total/],
  ["set amounts that miss the total", { total: "5", people: [{ name: "Priya", amount: "2" }, { name: "Sam", amount: "1" }] }, /add up to 3 USDC, but the total is 5 USDC/],
  ["a total too small to split", { total: "0.000002" }, /too small to split 3 ways/],
  ["a bad total", { total: "1.0000001" }, /isn't a valid total/],
  ["a bad set amount", { people: [{ name: "Priya", amount: "0" }, { name: "Sam" }] }, /isn't a valid amount for Priya/],
  ["a title with nothing readable", { title: "​​" }, /title needs some readable text/],
  ["a recipient that isn't a Solana address", { recipient: "0x3806c85df527e5336f05277ab8cc3932b9abe42a" }, /recipient must be a Solana wallet address/],
] as const) {
  test(`refuses ${name} before calling the API`, async () => {
    const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
    let args;
    try {
      args = input(extra as Record<string, unknown>);
    } catch {
      args = { ...input(), ...extra } as ReturnType<typeof input>; // schema-valid shape, tool-level check
    }
    assert.match(refused(await splitBill(args, deps, clear)), expected);
    assert.equal(rec.calls.length, 0);
  });
}

test("input is strict and takes 2 to 20 people", () => {
  assert.equal(inputSchema.safeParse({ ...input(), extra: 1 }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), people: [{ name: "Priya" }] }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), people: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` })) }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), people: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}` })) }).success, true);
  assert.equal(inputSchema.safeParse({ ...input(), people: [{ name: "Priya", tip: "1" }, { name: "Sam" }] }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), title: "x".repeat(61) }).success, false);
  assert.equal(inputSchema.parse({ recipient: RECIPIENT, total: "1", title: "t", people: PEOPLE }).token, "USDC");
});

test("untrusted text is cleaned before it is sent or shown", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const result = await splitBill(input({
    title: "pizza\u0000 at https://evil.example", people: [{ name: `Priya${String.fromCodePoint(0x202e)}` }, { name: "​" }],
  }), deps, clear);
  const out = structured(result);
  const body = rec.calls[0]!.body as CreateGroupReq;
  assert.equal(body.title, "pizza at [link removed]");
  assert.deepEqual(body.people.map((p) => p.name), ["Priya", "Person 2"]);
  assert.equal(out.title, "pizza at [link removed]");
  assert.deepEqual(out.shares.map((s) => s.name), ["Priya", "Person 2"]);
  assert.doesNotMatch(textOf(result), /evil/);
});

for (const [name, tamper] of [
  ["a share paying someone else", (r: GroupRes) => {
    r.shares[1]!.solana_pay_url = r.shares[1]!.solana_pay_url.replace(RECIPIENT, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  }],
  ["a share asking a different amount", (r: GroupRes) => { r.shares[0]!.solana_pay_url = r.shares[0]!.solana_pay_url.replace("amount=0.5", "amount=5"); }],
  ["a share whose amount field differs", (r: GroupRes) => { r.shares[2]!.amount = "0.4"; }],
  ["a share id that doesn't hash its terms", (r: GroupRes) => { r.shares[0]!.id = r.shares[1]!.id; }],
  ["a share link to another request", (r: GroupRes) => { r.shares[0]!.link = r.shares[1]!.link; }],
  ["a swapped reference", (r: GroupRes) => { r.shares[0]!.reference = r.shares[1]!.reference; }],
  ["a group id that doesn't hash the share ids", (r: GroupRes) => { r.shares.reverse(); }],
  ["a missing share", (r: GroupRes) => { r.shares.pop(); r.share_count = 2; }],
  ["another recipient", (r: GroupRes) => { r.recipient = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; }],
  ["another total", (r: GroupRes) => { r.total = "15"; }],
  ["a board link to another group", (r: GroupRes) => { r.link = r.link.replace(r.id, "HHHHHHHHHHHH"); }],
] as const) {
  test(`refuses a reply with ${name}`, async () => {
    const { deps } = makeDeps({ routes: { "POST /api/v1/groups": server(tamper) } });
    assert.match(refused(await splitBill(input(), deps, clear)), /doesn't match this bill, so it wasn't used/);
  });
}

for (const [name, route] of Object.entries({
  "the API is unreachable": () => "network_error" as const,
  "the API answers a plain-http board link (off-contract)": server((r) => { r.link = r.link.replace("https:", "http:"); }),
  "the API answers 503": () => json(503, { error: { code: "upstream_unavailable", message: "db" } }),
  "the API route is missing (HTML 404)": () => html(404),
  "the API answers off-contract": () => json(201, { id: 1 }),
})) {
  test(`offline: ${name} → one stateless /p?u= link per person, no board`, async () => {
    const { deps } = makeDeps({ routes: { "POST /api/v1/groups": route } });
    const result = await splitBill(input(), deps, clear);
    const out = structured(result);
    assert.equal(out.mode, "offline");
    assert.equal(out.group_id, null);
    assert.equal(out.group_link, null);
    for (const share of out.shares) {
      assert.equal(share.id, null);
      assert.ok(share.link.startsWith(`${BASE}/p?u=`));
      assert.equal(decodeURIComponent(share.link.slice(`${BASE}/p?u=`.length)), share.solana_pay_url);
      const parsed = solanaPay.parseLink(share.solana_pay_url, ["owed.link"]);
      assert.equal(parsed.kind, "transfer");
      if (parsed.kind !== "transfer") continue;
      assert.equal(parsed.request.recipient, RECIPIENT);
      assert.equal(parsed.request.amount, "0.5");
      assert.equal(parsed.request.splToken, USDC_MINT);
      assert.deepEqual(parsed.request.references, [share.reference]);
      assert.equal(parsed.request.message, "Pizza night");
    }
    assert.equal(new Set(out.shares.map((s) => s.reference)).size, 3, "every share needs its own reference");
    assert.match(textOf(result), /no board/);
  });
}

for (const [code, message, expected] of [
  ["rate_limited", "too many", /every share counts as one/],
  ["invalid_input", "recipient must be a wallet address, not a token account or program address", /rejected the split: recipient must be a wallet address/],
  ["blocked", "This address is on a sanctions list.", /can't create requests for this recipient\. This address is on a sanctions list\./],
] as const) {
  test(`API ${code} is refused with the server's reason, no offline links`, async () => {
    const status = code === "rate_limited" ? 429 : code === "blocked" ? 403 : 400;
    const { deps } = makeDeps({ routes: { "POST /api/v1/groups": () => json(status, { error: { code, message } }) } });
    assert.match(refused(await splitBill(input(), deps, clear)), expected);
  });
}

test("screening: a listed recipient is refused before anything is created; unavailable is said out loud", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const blocked = async (): Promise<Screening> => ({ ok: false, message: "This address is on a sanctions list, so Owed won't create requests for it." });
  assert.match(refused(await splitBill(input(), deps, blocked)), /sanctions list/);
  assert.equal(rec.calls.length, 0);

  const unavailable = async (): Promise<Screening> => ({ ok: true, screening: "unavailable" });
  assert.match(textOf(await splitBill(input(), deps, unavailable)), /screening was unavailable/);
  assert.doesNotMatch(textOf(await splitBill(input(), deps, clear)), /screening/);
});

test("from_domain is refused until verified payee is wired in (never silently ignored)", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  assert.match(refused(await splitBill(input({ from_domain: "getowed.xyz" }), deps, clear)), /can't verify from_domain yet/);
  assert.equal(rec.calls.length, 0);
});

test("from_domain: verified → sent on the split and said in the text; unverified → refused before anything is created", async () => {
  const seen: Array<{ domain: string; recipient: string; budget?: number }> = [];
  const verified: CheckFromDomain = async (domain, recipient, _deps, budget) => {
    seen.push({ domain, recipient, budget });
    return { ok: true, from_domain: "getowed.xyz", lines: ["Payee verified: getowed.xyz publishes this wallet (DNSSEC)."] };
  };
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  const result = await splitBill(input({ from_domain: "GetOwed.xyz" }), deps, clear, verified);
  const out = structured(result);
  assert.deepEqual(seen.map((s) => [s.domain, s.recipient]), [["GetOwed.xyz", RECIPIENT]]);
  assert.ok(seen[0]!.budget! <= 5500, "DNS, screening and the API call must fit in PayBox's 10 s");
  assert.equal((rec.calls[0]!.body as CreateGroupReq).from_domain, "getowed.xyz");
  assert.equal(out.from_domain, "getowed.xyz");
  assert.match(textOf(result), /Payee verified: getowed\.xyz/);

  const offline = makeDeps({ routes: { "POST /api/v1/groups": () => "network_error" } });
  const off = await splitBill(input({ from_domain: "getowed.xyz" }), offline.deps, clear, verified);
  assert.equal(structured(off).from_domain, undefined);
  assert.match(textOf(off), /can't carry the verified domain getowed\.xyz/);

  const unverified: CheckFromDomain = async () => ({ ok: false, message: "getowed.xyz does not publish this wallet. Add a TXT record at _owed.getowed.xyz." });
  const other = makeDeps({ routes: { "POST /api/v1/groups": server() } });
  assert.match(refused(await splitBill(input({ from_domain: "getowed.xyz" }), other.deps, clear, unverified)), /does not publish this wallet/);
  assert.equal(other.rec.calls.length, 0);
});

test("planShares uses splitEvenly for everyone without a set amount", () => {
  const plan = planShares(10_000_000n, [undefined, 4_000_000n, undefined, undefined], "USDC", money.fromAtomic);
  assert.deepEqual(plan.amounts, [2_000_000n, 4_000_000n, 2_000_000n, 2_000_000n]);
  assert.deepEqual(plan.even, [0, 2, 3]);
  assert.equal(plan.extra, 0);
  const uneven = planShares(10_000_000n, [undefined, undefined, undefined], "USDC", money.fromAtomic);
  assert.deepEqual(uneven.amounts, money.splitEvenly(10_000_000n, 3));
  assert.equal(uneven.extra, 1);
});
