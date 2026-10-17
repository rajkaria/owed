// W2-G checks (not findings: these pass on main 13f0507 and pin the behaviour). Verified-payee attacks
// from the QA brief: oversized DoH answers, a TXT set naming several wallets, one record naming two,
// look-alike values, and an outage of either resolver. Answers are the real nodata-signed capture with
// constructed TXT data (dohFor), or oversized bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPayee } from "../../../plugin/src/payee.ts";
import { makeDeps, RECIPIENT, SENDER } from "../../../plugin/test/helpers.ts";
import { dohRoutes, dohFixture, routeKey } from "../../../plugin/test/payee-helpers.ts";
import { dohFor } from "./qa-helpers.ts";

const DOMAIN = "example.com";
const huge = () => new Response(JSON.stringify({ Status: 0, Question: [{ name: "_owed.example.com", type: 16 }], Answer: [{ name: "_owed.example.com", type: 16, data: `"owed-pay=${RECIPIENT}"` }], pad: "x".repeat(70 * 1024) }), { headers: { "content-type": "application/dns-json" } });

test("check: a 70 KiB answer from Cloudflare is ignored and dns.google decides", async () => {
  const routes = dohFor(DOMAIN, [`owed-pay=${RECIPIENT}`]);
  const cf = Object.keys(routes).find((k) => k.includes("/dns-query"))!;
  routes[cf] = () => huge();
  const { deps } = makeDeps({ routes });
  const r = await verifyPayee(DOMAIN, RECIPIENT, 5000, deps);
  assert.equal(r.status, "verified");
});

test("check: oversized answers from both resolvers → dns_unavailable, never verified", async () => {
  const routes = dohFor(DOMAIN, [`owed-pay=${RECIPIENT}`]);
  for (const k of Object.keys(routes)) routes[k] = () => huge();
  const { deps } = makeDeps({ routes });
  assert.equal((await verifyPayee(DOMAIN, RECIPIENT, 5000, deps)).status, "dns_unavailable");
});

test("check: 40 owed-pay records, the 40th is the wallet → verified, records counted", async () => {
  const values = [...Array.from({ length: 39 }, () => `owed-pay=${SENDER}`), `owed-pay=${RECIPIENT}`];
  const { deps } = makeDeps({ routes: dohFor(DOMAIN, values) });
  const r = await verifyPayee(DOMAIN, RECIPIENT, 5000, deps);
  assert.equal(r.status, "verified");
  assert.equal(r.records, 40);
});

for (const value of [
  `owed-pay=${SENDER} owed-pay=${RECIPIENT}`, `owed-pay=${SENDER},${RECIPIENT}`, `owed-pay=${RECIPIENT}​`,
  `owed-pay=${RECIPIENT.toLowerCase()}`, `owed-pay =${RECIPIENT}`, `x-owed-pay=${RECIPIENT}`, `owed-pay=${RECIPIENT.slice(0, -1)}`,
]) {
  test(`check: TXT ${JSON.stringify(value).slice(0, 60)} does not verify the wallet`, async () => {
    const { deps } = makeDeps({ routes: dohFor(DOMAIN, [value]) });
    assert.equal((await verifyPayee(DOMAIN, RECIPIENT, 5000, deps)).status, "unverified");
  });
}

test("check: Cloudflare 500 + dns.google NXDOMAIN → unverified (an outage can't be turned into verified)", async () => {
  const nx = dohRoutes(dohFixture("nxdomain"));
  const key = Object.keys(nx).find((k) => k.includes("/dns-query"))!;
  nx[key] = () => new Response("oops", { status: 500 });
  const { deps } = makeDeps({ routes: nx });
  const fixture = dohFixture("nxdomain");
  const r = await verifyPayee(fixture.query.domain!, RECIPIENT, 5000, deps);
  assert.equal(r.status, "unverified");
  assert.ok(routeKey(fixture.responses[0]!.url).startsWith("GET /"));
});
