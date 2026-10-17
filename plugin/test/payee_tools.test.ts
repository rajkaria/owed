// W2-H verified payee through the tools: pay_link's marked hunk, ask_for_money's from_domain and verify_payee.
// DNS answers are real captures (test/fixtures/doh); "verified" answers are those captures with a
// TXT record added by withTxt() until published-record.json is captured from the live record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaOutputSchema } from "../src/paybox.ts";
import { requestIdFor } from "../src/request-id.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { inputSchema as payInput, payLink } from "../src/tools/pay_link.ts";
import { inputSchema as verifyInput, outputSchema as verifyOutput, verifyPayeeTool } from "../src/tools/verify_payee.ts";
import { fixture, json, makeDeps, RECIPIENT, REFERENCE, SENDER, textOf, type Route } from "./helpers.ts";
import { dohFixture, dohRoutes, withTxt } from "./payee-helpers.ts";

const KEY = "io.paybox/transactionProposal";
const openRequest = { ...fixture("get-request.res.json"), status: "open", paid: null };
const ID = openRequest.id as string;
const created = fixture("create-request.res.json");

const verifiedExample = () => dohRoutes(withTxt(dohFixture("nodata-signed"), [`owed-pay=${RECIPIENT}`]));
const noRecordExample = () => dohRoutes(dohFixture("nodata-signed"));
const noRecordOwedHost = () => dohRoutes(dohFixture("nodata-unsigned"));
const dnsDown = () => dohRoutes(dohFixture("servfail-dnssec-bogus"));
const owed = (body: unknown): Record<string, Route> => ({ [`GET /api/v1/requests/${ID}`]: () => json(200, body) });

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
const isRefusal = (r: Result) => r.isError === true;
function refusalText(r: Result): string {
  assert.ok(isRefusal(r), `expected a refusal, got: ${textOf(r)}`);
  assert.equal(r.structuredContent, undefined);
  return textOf(r);
}
function lines(r: Result): string[] {
  assert.ok(!isRefusal(r), `unexpected refusal: ${textOf(r)}`);
  return textOf(r).split("\n");
}
const dohCalls = (calls: Array<{ url: string }>) => calls.filter((c) => /cloudflare-dns\.com|dns\.google/.test(c.url)).map((c) => c.url);

// ---------------------------------------------------------------- pay_link

const pay = (extra: Record<string, unknown> = {}) => payInput.parse({ link: `https://owed.link/r/${ID}`, sender: SENDER, ...extra });

test("pay_link: a verified from_domain leads the preview and the proposal is built", async () => {
  const { deps, rec } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "example.com", from_domain_verified_at: "2026-10-17T05:00:00Z" }), ...verifiedExample() } });
  const result = await payLink(pay(), deps);
  const out = lines(result);
  assert.equal(out[0], 'Pay 15 USDC to example.com (verified by DNS, DNSSEC). Requester\'s note, unverified: "dinner", "Thanks for coming!". Requester\'s name, unverified: "Raj". Approve in PayBox to send.');
  assert.equal(out[1], `Recipient: ${RECIPIENT}`);
  assert.equal(out[2], "Verified: example.com publishes this wallet in its DNS. That proves who controls the domain, not what the request is for.");
  assert.equal(solanaOutputSchema.parse(result.structuredContent)[KEY].kind, "solana");
  assert.equal(rec.built.length, 1);
  assert.deepEqual(dohCalls(rec.calls), ["https://cloudflare-dns.com/dns-query?name=_owed.example.com&type=TXT"]);
});

test("pay_link: a swapped from_domain that doesn't publish the wallet is refused before any proposal", async () => {
  // The server (or anyone who controls its reply) puts Owed's own host on the request: its DNS has no record.
  const { deps, rec } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "owed-omega.vercel.app" }), ...noRecordOwedHost() } });
  assert.equal(refusalText(await payLink(pay(), deps)),
    "This request claims to be from owed-omega.vercel.app, but owed-omega.vercel.app does not publish this wallet. Not paying.");
  assert.equal(rec.built.length, 0);
});

test("pay_link: a domain publishing a different wallet is refused; allow_unverified doesn't override it", async () => {
  const other = dohRoutes(withTxt(dohFixture("nodata-signed"), [`owed-pay=${SENDER}`]));
  for (const allow of [false, true]) {
    const { deps, rec } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "example.com" }), ...other } });
    assert.match(refusalText(await payLink(pay({ allow_unverified: allow }), deps)), /does not publish this wallet\. Not paying\.$/);
    assert.equal(rec.built.length, 0);
  }
});

test("pay_link: no from_domain → preview unchanged plus 'Payee not verified', and no DNS lookups", async () => {
  const { deps, rec } = makeDeps({ routes: owed(openRequest) });
  const out = lines(await payLink(pay(), deps));
  assert.match(out[0]!, /^Pay 15 USDC to FN6G…cbvs\. /);
  assert.equal(out[1], `Recipient: ${RECIPIENT}`);
  assert.equal(out.at(-1), "Payee not verified: no domain on this request.");
  assert.deepEqual(dohCalls(rec.calls), []);
});

test("pay_link: raw Solana Pay links carry no domain and say so", async () => {
  const { deps, rec } = makeDeps();
  const link = `solana:${RECIPIENT}?amount=0.5&reference=${REFERENCE}`;
  assert.equal(lines(await payLink(pay({ link }), deps)).at(-1), "Payee not verified: no domain on this request.");
  assert.deepEqual(dohCalls(rec.calls), []);
});

test("pay_link: Cloudflare down → dns.google verifies (row 6, first half)", async () => {
  const doh = dohRoutes(withTxt(dohFixture("nodata-signed"), [`owed-pay=${RECIPIENT}`]), { "cloudflare-dns.com": () => "network_error" });
  const { deps, rec } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "example.com" }), ...doh } });
  assert.match(lines(await payLink(pay(), deps))[0]!, /^Pay 15 USDC to example\.com \(verified by DNS, DNSSEC\)\./);
  assert.equal(dohCalls(rec.calls).length, 2);
});

test("pay_link: both resolvers down → refused unless allow_unverified (row 6, second half)", async () => {
  const request = { ...openRequest, from_domain: "dnssec-failed.org" };
  const refused = makeDeps({ routes: { ...owed(request), ...dnsDown() } });
  const text = refusalText(await payLink(pay(), refused.deps));
  assert.match(text, /^This request claims to be from dnssec-failed\.org, but DNS couldn't be checked right now/);
  assert.equal(refused.rec.built.length, 0);

  const allowed = makeDeps({ routes: { ...owed(request), ...dnsDown() } });
  const out = lines(await payLink(pay({ allow_unverified: true }), allowed.deps));
  assert.match(out[0]!, /^Pay 15 USDC to FN6G…cbvs\./, "an unchecked domain never leads the preview");
  assert.ok(out.includes("Payee not verified: the request claims dnssec-failed.org, but DNS couldn't be checked; paying anyway because allow_unverified is set."));
  assert.equal(allowed.rec.built.length, 1);
});

test("pay_link: DNS runs alongside the balance check, and a payee refusal wins over a balance refusal", async () => {
  const { deps } = makeDeps({
    routes: { ...owed({ ...openRequest, from_domain: "example.com" }), ...noRecordExample() },
    payerReadiness: async () => ({ ok: false, recipientAtaExists: true, reason: "Your wallet has 1 USDC; this request is 15 USDC." }),
  });
  assert.match(refusalText(await payLink(pay(), deps)), /does not publish this wallet/);
});

test("pay_link: allow_unverified is an optional boolean in the strict input", () => {
  assert.equal(payInput.safeParse({ link: ID, sender: SENDER, allow_unverified: "yes" }).success, false);
  assert.equal(payInput.parse({ link: ID, sender: SENDER }).allow_unverified, undefined);
});

// ---------------------------------------------------------------- ask_for_money

const ask = (extra: Record<string, unknown> = {}) => askInput.parse({ recipient: RECIPIENT, amount: "15", payer_name: "Priya", for: "dinner", note: "Thanks for coming!", requester_name: "Raj", ...extra });

test("ask_for_money: a verified from_domain is sent, echoed by the server and shown", async () => {
  const { deps, rec } = makeDeps({ routes: { ...verifiedExample(), "POST /api/v1/requests": () => json(201, { ...created, from_domain: "example.com" }) } });
  const result = await askForMoney(ask({ from_domain: "Example.com" }), deps);
  const out = askOutput.parse(result.structuredContent);
  assert.equal(out.from_domain, "example.com");
  const post = rec.calls.find((c) => c.method === "POST")!;
  assert.equal((post.body as { from_domain: string }).from_domain, "example.com");
  assert.ok(lines(result).includes("From example.com: verified, example.com publishes this wallet in its DNS (DNSSEC-signed)."));
  assert.ok(rec.calls.findIndex((c) => c.method === "POST") > rec.calls.findIndex((c) => /cloudflare/.test(c.url)), "DNS is checked before the request is created");
});

test("ask_for_money: an unverified from_domain refuses with the TXT record to add and creates nothing", async () => {
  const { deps, rec } = makeDeps({ routes: { ...noRecordExample(), "POST /api/v1/requests": () => json(201, created) } });
  const text = refusalText(await askForMoney(ask({ from_domain: "example.com" }), deps));
  assert.match(text, new RegExp(`add a DNS TXT record named _owed\\.example\\.com with the value owed-pay=${RECIPIENT}`));
  assert.equal(rec.calls.filter((c) => c.method === "POST").length, 0);
});

test("ask_for_money: DNS down or an invalid domain refuses before the API", async () => {
  const down = makeDeps({ routes: dnsDown() });
  assert.match(refusalText(await askForMoney(ask({ from_domain: "dnssec-failed.org" }), down.deps)), /^DNS couldn't be checked right now/);
  const bad = makeDeps();
  assert.match(refusalText(await askForMoney(ask({ from_domain: "https://example.com" }), bad.deps)), /isn't a domain name Owed can check/);
  for (const r of [down.rec, bad.rec]) assert.equal(r.calls.filter((c) => c.method === "POST").length, 0);
});

test("ask_for_money: a server that drops from_domain doesn't get its link handed out", async () => {
  const { deps } = makeDeps({ routes: { ...verifiedExample(), "POST /api/v1/requests": () => json(201, created) } });
  assert.equal(refusalText(await askForMoney(ask({ from_domain: "example.com" }), deps)),
    "Owed's server didn't attach example.com to the request, so the link wasn't used. Try again, or ask without from_domain.");
});

test("ask_for_money: offline links can't carry the domain and say so", async () => {
  const { deps } = makeDeps({ routes: { ...verifiedExample(), "POST /api/v1/requests": () => "network_error" } });
  const result = await askForMoney(ask({ from_domain: "example.com" }), deps);
  const out = askOutput.parse(result.structuredContent);
  assert.equal(out.mode, "offline");
  assert.equal(out.from_domain, undefined);
  assert.equal(lines(result).at(-1), "Offline links can't carry a domain, so payers will see this one as unverified, not as from example.com.");
});

test("ask_for_money: without from_domain nothing changes and DNS isn't touched", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, created) } });
  const result = await askForMoney(ask(), deps);
  assert.equal(askOutput.parse(result.structuredContent).from_domain, undefined);
  assert.equal("from_domain" in (rec.calls[0]!.body as object), false);
  assert.deepEqual(dohCalls(rec.calls), []);
});

// ---------------------------------------------------------------- verify_payee

function verified(result: Result) {
  assert.ok(!isRefusal(result), `unexpected refusal: ${textOf(result)}`);
  return verifyOutput.parse(result.structuredContent);
}

test("verify_payee: address + domain that publishes it → verified with DNSSEC and the record it found", async () => {
  const { deps } = makeDeps({ routes: verifiedExample() });
  const result = await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT, domain: "example.com" }), deps);
  assert.deepEqual(verified(result), {
    status: "verified", domain: "example.com", display_domain: "example.com", dnssec: true, records: 1, warnings: [],
    address: RECIPIENT, record_name: "_owed.example.com", expected_record: `owed-pay=${RECIPIENT}`,
  });
  assert.deepEqual(lines(result), [
    "Verified: example.com publishes this wallet (FN6G…cbvs) in its DNS, DNSSEC-signed.",
    "That proves who controls example.com, not that the request is fair: still check the amount and what it's for.",
  ]);
});

test("verify_payee: a real domain without the record → not verified, with what's missing", async () => {
  const { deps } = makeDeps({ routes: noRecordExample() });
  const result = await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT, domain: "example.com" }), deps);
  assert.equal(verified(result).status, "unverified");
  assert.deepEqual(lines(result), [
    "Not verified: example.com does not publish this wallet (FN6G…cbvs). Don't treat this request as coming from example.com.",
    "_owed.example.com has no Owed record.",
  ]);
});

test("verify_payee: an Owed link checks the domain it claims and reports amount and token", async () => {
  const { deps } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "example.com" }), ...verifiedExample() } });
  const result = await verifyPayeeTool(verifyInput.parse({ link: `https://owed.link/r/${ID}` }), deps);
  const out = verified(result);
  assert.equal(out.status, "verified");
  assert.equal(out.request_id, ID);
  assert.equal(out.claimed_domain, "example.com");
  assert.equal(out.amount, "15");
  assert.equal(out.token, "USDC");
  assert.equal(out.request_status, "open");
  assert.ok(lines(result).includes("Request: 15 USDC (open)."));
});

test("verify_payee: the user's expected domain differs from the claimed one → said first, then checked", async () => {
  const { deps } = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "owed-omega.vercel.app" }), ...noRecordExample() } });
  const result = await verifyPayeeTool(verifyInput.parse({ link: ID, domain: "example.com" }), deps);
  assert.equal(lines(result)[0], "This request claims to be from owed-omega.vercel.app, not example.com.");
  assert.equal(verified(result).status, "unverified");
});

test("verify_payee: a request without a domain → no_domain, no DNS", async () => {
  const { deps, rec } = makeDeps({ routes: owed(openRequest) });
  const result = await verifyPayeeTool(verifyInput.parse({ link: ID }), deps);
  const out = verified(result);
  assert.equal(out.status, "no_domain");
  assert.equal(out.address, RECIPIENT);
  assert.equal(out.record_name, null);
  assert.match(lines(result)[0]!, /doesn't name a domain/);
  assert.deepEqual(dohCalls(rec.calls), []);
});

test("verify_payee: a raw Solana Pay link with a domain checks the link's recipient", async () => {
  const { deps } = makeDeps({ routes: verifiedExample() });
  const link = `solana:${RECIPIENT}?amount=1&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${REFERENCE}`;
  const out = verified(await verifyPayeeTool(verifyInput.parse({ link, domain: "example.com" }), deps));
  assert.equal(out.status, "verified");
  assert.equal(out.token, "USDC");
  assert.equal(out.amount, "1");
  assert.equal(out.request_id, null);
});

test("verify_payee: a lookalike domain carries its warnings even when nothing answers", async () => {
  const { deps } = makeDeps({ routes: {} }); // no recorded DNS for this name: both resolvers fail
  const result = await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT, domain: "g0towed.xyz" }), deps);
  const out = verified(result);
  assert.equal(out.status, "dns_unavailable");
  assert.deepEqual(out.warnings, ["g0towed.xyz has characters that can pass for others: \"0\" (zero) for \"o\".", "Check the spelling letter by letter."]);
  assert.ok(lines(result).includes("Check the spelling letter by letter."));
});

test("verify_payee: a request whose terms don't hash to its id is refused", async () => {
  const swapped = { ...openRequest, recipient: SENDER, solana_pay_url: String(openRequest.solana_pay_url).replace(RECIPIENT, SENDER) };
  assert.notEqual(requestIdFor({ recipient: SENDER, token: "USDC", amountAtomic: 15_000_000n, reference: REFERENCE }), ID);
  const { deps } = makeDeps({ routes: owed(swapped) });
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ link: ID }), deps)), /don't match its id/);
});

test("verify_payee: argument combinations, checkout links and old ids are refused plainly", async () => {
  const { deps } = makeDeps();
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ domain: "example.com" }), deps)), /^Pass link/);
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT }), deps)), /^Pass link/);
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ link: ID, address: RECIPIENT }), deps)), /not both/);
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ link: "solana:https://checkout.example.com/api" }), deps)), /checkout link/);
  assert.match(refusalText(await verifyPayeeTool(verifyInput.parse({ link: "https://owed.link/r/1RRer81ufk" }), deps)), /older Owed link/);
  assert.equal(verifyInput.safeParse({ address: RECIPIENT, domain: "example.com", extra: 1 }).success, false);
});

// ---------------------------------------------------------------- the live demo record (captured, not constructed)

test("real record: _owed.getowed.xyz publishes the team wallet → verify_payee verified, pay_link leads with it", async () => {
  const live = dohRoutes(dohFixture("published-record"));
  const v = makeDeps({ routes: live });
  const result = await verifyPayeeTool(verifyInput.parse({ address: RECIPIENT, domain: "getowed.xyz" }), v.deps);
  const out = verified(result);
  assert.equal(out.status, "verified");
  assert.equal(out.dnssec, false);
  assert.equal(out.records, 1);
  assert.equal(lines(result)[0], "Verified: getowed.xyz publishes this wallet (FN6G…cbvs) in its DNS (not DNSSEC-signed).");

  const p = makeDeps({ routes: { ...owed({ ...openRequest, from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T10:53:00Z" }), ...dohRoutes(dohFixture("published-record")) } });
  const paid = await payLink(pay(), p.deps);
  assert.match(lines(paid)[0]!, /^Pay 15 USDC to getowed\.xyz \(verified by DNS\)\. /);
  assert.equal(p.rec.built.length, 1);

  const other = makeDeps({ routes: dohRoutes(dohFixture("published-record")) });
  assert.equal(verified(await verifyPayeeTool(verifyInput.parse({ address: SENDER, domain: "getowed.xyz" }), other.deps)).status, "unverified");
});
