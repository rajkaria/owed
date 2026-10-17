import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkFromDomain, DOH_HOSTS, DOH_RESOLVERS, DOH_TIMEOUT_MS, domainBrandFlags, domainLabel, domainWarnings, dohUrl, fromDomainSchema,
  normalizeDomain, owedPayValues, parseTxtAnswer, payeeForPayment, PAYEE_BUDGET_MS, txtValue, verifyPayee,
} from "../src/payee.ts";
import { makeDeps, RECIPIENT, SENDER } from "./helpers.ts";
import { dohFixture, dohRoutes, hasDohFixture, routeKey, vectors, withTxt, type DohFixture } from "./payee-helpers.ts";

const CAPTURED = ["nodata-signed", "nodata-unsigned", "nxdomain", "idn-nxdomain", "servfail-dnssec-bogus"];
const PARSER_ONLY = ["txt-multi-string", "txt-cname-chain", "txt-many-records"];

function replay(fixture: DohFixture, override: Parameters<typeof dohRoutes>[1] = {}) {
  // A real clock: verifyPayee's budget is measured with deps.now.
  const { deps, rec } = makeDeps({ routes: dohRoutes(fixture, override), now: () => Date.now() });
  const recorded = new Set(fixture.responses.map((r) => r.url));
  const urls = () => rec.calls.map((c) => c.url);
  const unrecorded = () => urls().filter((u) => !recorded.has(u));
  return { deps, rec, urls, unrecorded };
}

// ---------------------------------------------------------------- domains

test("domain vectors: lower-case ASCII, punycode for IDN, Unicode display, exact warnings", () => {
  for (const v of vectors.domains) {
    const d = normalizeDomain(v.input);
    assert.ok(d, `${JSON.stringify(v.input)} should be a domain`);
    assert.equal(d.ascii, v.ascii, v.input);
    assert.equal(d.unicode, v.unicode, v.input);
    assert.deepEqual(domainWarnings(d), v.warnings, v.input);
    assert.deepEqual(domainBrandFlags(v.input), v.flags, v.input);
  }
  for (const input of vectors.invalid) assert.equal(normalizeDomain(input), null, `${JSON.stringify(input)} should be refused`);
});

test("the vectors cover the named risks: IDN, mixed scripts, whole-script and digit-for-letter lookalikes", () => {
  const warn = (input: string) => vectors.domains.find((v) => v.input === input)!.warnings.join(" ");
  assert.match(warn("pаypal.com"), /xn--pypal-4ve\.com.*can pass for paypal\.com.*mixes Latin and Cyrillic/);
  assert.match(warn("раураl.com"), /can pass for paypal\.com/);
  assert.match(warn("αpple.com"), /mixes Greek and Latin/);
  assert.match(warn("ɡetowed.xyz"), /xn--etowed-h0c\.xyz.*can pass for getowed\.xyz/);
  assert.match(warn("g0towed.xyz"), /"0" \(zero\) for "o"/);
  assert.match(warn("paypa1.com"), /"1" \(one\) for "l"/);
  assert.match(warn("rnoonpay.com"), /"rn" for "m"/);
  for (const v of vectors.domains) {
    if (v.warnings.length) assert.equal(v.warnings.at(-1), "Check the spelling letter by letter.");
  }
  // Plain ASCII domains and CJK mixes that UTS #39 allows carry no lookalike line.
  assert.deepEqual(vectors.domains.find((v) => v.input === "owed-omega.vercel.app")!.warnings, []);
  assert.doesNotMatch(warn("日本語abc.jp"), /mixes/);
});

test("domainLabel shows Unicode and punycode for IDN, the plain name otherwise", () => {
  assert.equal(domainLabel({ domain: "xn--mnchen-3ya.de", display_domain: "münchen.de" }), "münchen.de (xn--mnchen-3ya.de)");
  assert.equal(domainLabel({ domain: "getowed.xyz", display_domain: "getowed.xyz" }), "getowed.xyz");
});

test("fromDomainSchema bounds the input at 253 characters", () => {
  assert.equal(fromDomainSchema.safeParse("a".repeat(254)).success, false);
  assert.equal(fromDomainSchema.safeParse("").success, false);
  assert.equal(fromDomainSchema.parse("getowed.xyz"), "getowed.xyz");
});

// ---------------------------------------------------------------- parsing real answers

test("txtValue joins Cloudflare's quoted strings and decodes escapes; dns.google's bare text passes through", () => {
  assert.equal(txtValue("\"owed-pay=abc\""), "owed-pay=abc");
  assert.equal(txtValue("\"owed-pay=\" \"abc\""), "owed-pay=abc");
  assert.equal(txtValue("\"a\\\"b\\\\c\\065\""), "a\"b\\cA");
  assert.equal(txtValue("owed-pay=abc"), "owed-pay=abc");
  assert.equal(txtValue("\"unterminated"), "\"unterminated");
  assert.equal(txtValue("\"a\" b"), "\"a\" b");
});

test("both resolvers' real answers parse to the same records, rcode and AD flag", () => {
  for (const name of [...CAPTURED, ...PARSER_ONLY]) {
    const f = dohFixture(name);
    const [cf, google] = f.responses.map((r) => parseTxtAnswer(JSON.parse(r.body), f.query.qname));
    if (name === "servfail-dnssec-bogus") {
      assert.equal(cf, null);
      assert.equal(google, null);
      continue;
    }
    assert.ok(cf && google, name);
    assert.equal(cf.rcode, google.rcode, name);
    assert.equal(cf.ad, google.ad, name);
    assert.deepEqual([...cf.txt].sort(), [...google.txt].sort(), name);
  }
  const multi = dohFixture("txt-multi-string");
  const key = parseTxtAnswer(JSON.parse(multi.responses[0]!.body), multi.query.qname)!.txt[0]!;
  assert.ok(key.length > 255 && !key.includes("\" \""), "a split DKIM key comes back as one string");
  const cname = dohFixture("txt-cname-chain");
  assert.equal(parseTxtAnswer(JSON.parse(cname.responses[0]!.body), cname.query.qname)!.txt.length, 1, "the CNAME answer is skipped, its target's TXT kept");
  const many = dohFixture("txt-many-records");
  assert.ok(parseTxtAnswer(JSON.parse(many.responses[1]!.body), many.query.qname)!.txt.length >= 5);
  assert.equal(parseTxtAnswer(JSON.parse(dohFixture("nodata-signed").responses[0]!.body), "_owed.example.com")!.ad, true);
  assert.equal(parseTxtAnswer(JSON.parse(dohFixture("nxdomain").responses[1]!.body), dohFixture("nxdomain").query.qname)!.rcode, "nxdomain");
});

test("an answer for another name, a truncated answer or an off-shape body is a failure", () => {
  const f = dohFixture("txt-many-records");
  const body = JSON.parse(f.responses[0]!.body);
  assert.equal(parseTxtAnswer(body, "_owed.google.com"), null);
  assert.equal(parseTxtAnswer({ ...body, TC: true }, f.query.qname), null);
  assert.equal(parseTxtAnswer({ ...body, Status: 5 }, f.query.qname), null);
  assert.equal(parseTxtAnswer({ ...body, Question: undefined }, f.query.qname), null);
  for (const junk of [null, "x", 1, [], {}]) assert.equal(parseTxtAnswer(junk, f.query.qname), null);
});

test("owedPayValues: prefix case-insensitive, value exact, other TXT ignored", () => {
  assert.deepEqual(owedPayValues(["v=spf1 -all", ` OWED-PAY=${RECIPIENT} `, `owed-pay= ${SENDER}`, "owed-pay"]), [RECIPIENT, SENDER]);
});

// ---------------------------------------------------------------- verifyPayee on real answers

test("sends exactly one Cloudflare request in DoH JSON form when it answers", async () => {
  const f = dohFixture("nodata-signed");
  const { deps, rec, unrecorded } = replay(f);
  await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.deepEqual(rec.calls.map((c) => c.url), ["https://cloudflare-dns.com/dns-query?name=_owed.example.com&type=TXT"]);
  assert.deepEqual(unrecorded(), []);
  const init = rec.calls[0]!.init!;
  assert.deepEqual(init.headers, { accept: "application/dns-json" });
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(DOH_HOSTS, ["cloudflare-dns.com", "dns.google"]);
  assert.equal(dohUrl(DOH_RESOLVERS[1].url, "_owed.example.com"), "https://dns.google/resolve?name=_owed.example.com&type=TXT");
});

test("no record (NODATA, signed zone) → unverified with DNSSEC from the AD flag", async () => {
  const { deps } = replay(dohFixture("nodata-signed"));
  assert.deepEqual(await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, deps), {
    status: "unverified", domain: "example.com", display_domain: "example.com", dnssec: true, records: 0, warnings: [],
  });
});

test("Owed's own host publishes nothing → unverified, unsigned", async () => {
  const { deps } = replay(dohFixture("nodata-unsigned"));
  const r = await verifyPayee("owed-omega.vercel.app", RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.equal(r.status, "unverified");
  assert.equal(r.dnssec, false);
});

test("NXDOMAIN → unverified, not a DNS failure", async () => {
  const f = dohFixture("nxdomain");
  const { deps, rec } = replay(f);
  const r = await verifyPayee(f.query.domain!, RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.equal(r.status, "unverified");
  assert.equal(r.records, 0);
  assert.equal(rec.calls.length, 1);
});

test("a Unicode domain is queried by its punycode name and shown both ways with the IDN warning", async () => {
  const { deps, unrecorded } = replay(dohFixture("idn-nxdomain"));
  const r = await verifyPayee("MÜNCHEN.de", RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.deepEqual(unrecorded(), []);
  assert.equal(r.status, "unverified");
  assert.equal(r.domain, "xn--mnchen-3ya.de");
  assert.equal(r.display_domain, "münchen.de");
  assert.equal(r.warnings[0], "münchen.de is an internationalized domain name; in DNS it is xn--mnchen-3ya.de.");
});

test("SERVFAIL on both resolvers (broken DNSSEC) → dns_unavailable after trying both", async () => {
  const f = dohFixture("servfail-dnssec-bogus");
  const { deps, urls, unrecorded } = replay(f);
  const r = await verifyPayee("dnssec-failed.org", RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.equal(r.status, "dns_unavailable");
  assert.deepEqual(urls(), f.responses.map((x) => x.url));
  assert.deepEqual(unrecorded(), []);
});

test("Cloudflare down, erroring or off-shape → dns.google's answer is used", async () => {
  const f = dohFixture("nodata-signed");
  const failures = {
    network: () => "network_error" as const,
    http500: () => new Response("oops", { status: 500 }),
    html: () => new Response("<!doctype html>", { status: 200 }),
    otherName: () => new Response(dohFixture("txt-many-records").responses[0]!.body, { status: 200 }),
  };
  for (const [label, failure] of Object.entries(failures)) {
    const { deps, urls } = replay(f, { "cloudflare-dns.com": failure });
    const r = await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, deps);
    assert.equal(r.status, "unverified", label);
    assert.equal(r.dnssec, true, label);
    assert.equal(urls().length, 2, label);
    assert.match(urls()[1]!, /^https:\/\/dns\.google\/resolve\?/, label);
  }
});

test("a hanging Cloudflare is abandoned after 2.5 s and dns.google answers", async () => {
  const { deps, urls } = replay(dohFixture("nodata-signed"), { "cloudflare-dns.com": () => "hang" });
  const t0 = performance.now();
  const r = await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, deps);
  const ms = performance.now() - t0;
  assert.equal(r.status, "unverified");
  assert.equal(urls().length, 2);
  assert.ok(ms >= DOH_TIMEOUT_MS - 50 && ms < DOH_TIMEOUT_MS + 1000, `took ${ms} ms`);
});

test("both resolvers down → dns_unavailable; the budget caps the wait", async () => {
  const down = { "cloudflare-dns.com": () => "network_error" as const, "dns.google": () => "network_error" as const };
  const { deps } = replay(dohFixture("nodata-signed"), down);
  const r = await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, deps);
  assert.deepEqual(r, { status: "dns_unavailable", domain: "example.com", display_domain: "example.com", dnssec: false, records: 0, warnings: [] });
  const hang = replay(dohFixture("nodata-signed"), { "cloudflare-dns.com": () => "hang", "dns.google": () => "hang" });
  const t0 = performance.now();
  assert.equal((await verifyPayee("example.com", RECIPIENT, 400, hang.deps)).status, "dns_unavailable");
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(hang.urls().length, 1, "no time left for the fallback");
});

test("an invalid domain is refused without any request", async () => {
  const { deps, rec } = makeDeps();
  for (const bad of ["localhost", "https://example.com", "ex/ample.com", "1.2.3.4"]) {
    assert.deepEqual(await verifyPayee(bad, RECIPIENT, PAYEE_BUDGET_MS, deps), {
      status: "invalid_domain", domain: "", display_domain: "", dnssec: false, records: 0, warnings: [],
    });
  }
  assert.equal(rec.calls.length, 0);
});

test("published records (constructed from a real answer): the right wallet verifies, others count but don't", async () => {
  const base = dohFixture("nodata-signed");
  const both = replay(withTxt(base, ["v=spf1 -all", `owed-pay=${SENDER}`, `owed-pay=${RECIPIENT}`]));
  assert.deepEqual(await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, both.deps), {
    status: "verified", domain: "example.com", display_domain: "example.com", dnssec: true, records: 2, warnings: [],
  });
  const other = replay(withTxt(base, [`owed-pay=${SENDER}`]));
  const r = await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, other.deps);
  assert.equal(r.status, "unverified");
  assert.equal(r.records, 1);
  // dns.google's bare format verifies the same way.
  const google = replay(withTxt(base, [`owed-pay=${RECIPIENT}`]), { "cloudflare-dns.com": () => "network_error" });
  assert.equal((await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, google.deps)).status, "verified");
  // A record must name the wallet exactly.
  const near = replay(withTxt(base, [`owed-pay=${RECIPIENT}x`, `owed-pay=${RECIPIENT.toLowerCase()}`]));
  assert.equal((await verifyPayee("example.com", RECIPIENT, PAYEE_BUDGET_MS, near.deps)).status, "unverified");
});

test("published-record.json (captured from the live demo record) verifies its wallet", { skip: !hasDohFixture("published-record") && "not captured yet: needs the _owed TXT record on Raj's domain" }, async () => {
  const f = dohFixture("published-record");
  const parsed = parseTxtAnswer(JSON.parse(f.responses[0]!.body), f.query.qname)!;
  const wallets = owedPayValues(parsed.txt);
  assert.ok(wallets.length > 0);
  const { deps, unrecorded } = replay(f);
  const r = await verifyPayee(f.query.domain!, wallets[0]!, PAYEE_BUDGET_MS, deps);
  assert.equal(r.status, "verified");
  assert.equal(r.records, wallets.length);
  assert.deepEqual(unrecorded(), []);
  const swapped = await verifyPayee(f.query.domain!, SENDER, PAYEE_BUDGET_MS, replay(f).deps);
  assert.equal(swapped.status, wallets.includes(SENDER) ? "verified" : "unverified");
});

// ---------------------------------------------------------------- checkFromDomain (ask_for_money, split_bill, create_invoice)

test("checkFromDomain: verified → the ASCII domain to send, plus text lines", async () => {
  const { deps } = replay(withTxt(dohFixture("nodata-signed"), [`owed-pay=${RECIPIENT}`]));
  const c = await checkFromDomain("Example.COM.", RECIPIENT, deps);
  assert.ok(c.ok);
  assert.equal(c.from_domain, "example.com");
  assert.deepEqual(c.lines, ["From example.com: verified, example.com publishes this wallet in its DNS (DNSSEC-signed)."]);
});

test("checkFromDomain: unverified → refusal with the exact TXT record to add", async () => {
  const { deps } = replay(dohFixture("nodata-signed"));
  const c = await checkFromDomain("example.com", RECIPIENT, deps);
  assert.equal(c.ok, false);
  assert.equal(!c.ok && c.message,
    `example.com doesn't publish this wallet, so the request wasn't created. To verify it, add a DNS TXT record named _owed.example.com with the value owed-pay=${RECIPIENT}, wait a few minutes for DNS, then ask again. Or ask without from_domain.`);
  const other = replay(withTxt(dohFixture("nodata-signed"), [`owed-pay=${SENDER}`]));
  const c2 = await checkFromDomain("example.com", RECIPIENT, other.deps);
  assert.match(!c2.ok ? c2.message : "", /It publishes another Owed wallet, not this one\./);
});

test("checkFromDomain: DNS down and invalid domains refuse with a next step", async () => {
  const down = replay(dohFixture("servfail-dnssec-bogus"));
  const c = await checkFromDomain("dnssec-failed.org", RECIPIENT, down.deps);
  assert.equal(!c.ok && c.message, "DNS couldn't be checked right now (cloudflare-dns.com and dns.google didn't answer), so the request wasn't created. Try again in a moment, or ask without from_domain.");
  const bad = await checkFromDomain("https://evil.example/\u0000", RECIPIENT, makeDeps().deps);
  assert.equal(!bad.ok && bad.message, "\"[link removed]\" isn't a domain name Owed can check. Give just the domain, like example.com. Nothing was created.");
});

// ---------------------------------------------------------------- payeeForPayment (pay_link)

test("payeeForPayment: no domain → unchanged lead plus the 'not verified' line, no DNS", async () => {
  const { deps, rec } = makeDeps();
  for (const none of [undefined, null, ""]) {
    assert.deepEqual(await payeeForPayment(none, RECIPIENT, false, deps), { ok: true, lead: null, lines: ["Payee not verified: no domain on this request."] });
  }
  assert.equal(rec.calls.length, 0);
});

test("payeeForPayment: verified → the domain leads, with DNSSEC when signed", async () => {
  const signed = replay(withTxt(dohFixture("nodata-signed"), [`owed-pay=${RECIPIENT}`]));
  assert.deepEqual(await payeeForPayment("example.com", RECIPIENT, false, signed.deps), {
    ok: true, lead: "example.com (verified by DNS, DNSSEC)",
    lines: ["Verified: example.com publishes this wallet in its DNS. That proves who controls the domain, not what the request is for."],
  });
  const unsigned = replay(withTxt(dohFixture("nodata-unsigned"), [`owed-pay=${RECIPIENT}`]));
  const p = await payeeForPayment("owed-omega.vercel.app", RECIPIENT, false, unsigned.deps);
  assert.equal(p.ok && p.lead, "owed-omega.vercel.app (verified by DNS)");
});

test("payeeForPayment: a domain that doesn't publish the wallet → the SPEC refusal", async () => {
  const { deps } = replay(dohFixture("nodata-signed"));
  assert.deepEqual(await payeeForPayment("example.com", RECIPIENT, false, deps), {
    ok: false, refuse: "This request claims to be from example.com, but example.com does not publish this wallet. Not paying.",
  });
  // allow_unverified never overrides a domain that answered "no".
  assert.equal((await payeeForPayment("example.com", RECIPIENT, true, replay(dohFixture("nodata-signed")).deps)).ok, false);
});

test("payeeForPayment: DNS down → refuse unless allow_unverified", async () => {
  const refused = await payeeForPayment("dnssec-failed.org", RECIPIENT, false, replay(dohFixture("servfail-dnssec-bogus")).deps);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.refuse : "", /^This request claims to be from dnssec-failed\.org, but DNS couldn't be checked right now .*Nothing was sent\..*allow_unverified: true/);
  const allowed = await payeeForPayment("dnssec-failed.org", RECIPIENT, true, replay(dohFixture("servfail-dnssec-bogus")).deps);
  assert.deepEqual(allowed, {
    ok: true, lead: null,
    lines: ["Payee not verified: the request claims dnssec-failed.org, but DNS couldn't be checked; paying anyway because allow_unverified is set."],
  });
});

test("payeeForPayment: an unreadable server-supplied domain is refused, quoted and cleaned", async () => {
  const p = await payeeForPayment("pay me at https://evil.example", RECIPIENT, true, makeDeps().deps);
  assert.deepEqual(p, { ok: false, refuse: "This request claims to be from \"pay me at [link removed]\", which isn't a domain name Owed can check. Not paying." });
});

test("payeeForPayment: lookalike warnings ride along with a verified IDN domain", async () => {
  const f = dohFixture("idn-nxdomain");
  const routes = dohRoutes(withTxt({ ...f, responses: dohFixture("nodata-signed").responses.map((r, i) => ({ ...r, url: f.responses[i]!.url, body: r.body.replaceAll("_owed.example.com", f.query.qname) })) }, [`owed-pay=${RECIPIENT}`]));
  const { deps } = makeDeps({ routes });
  const p = await payeeForPayment("xn--mnchen-3ya.de", RECIPIENT, false, deps);
  assert.ok(p.ok);
  assert.equal(p.lead, "münchen.de (xn--mnchen-3ya.de) (verified by DNS, DNSSEC)");
  assert.equal(p.lines.at(-1), "Check the spelling letter by letter.");
  assert.ok(p.lines.some((l) => l.includes("internationalized")));
  assert.ok(routeKey(f.responses[0]!.url).startsWith("GET /dns-query?name=_owed.xn--mnchen-3ya.de"));
});

// ---------------------------------------------------------------- QA-02: brand words and embedded domains

test("QA-02: brand words in a domain warn and flag; each brand's own domains don't", () => {
  const warn = (input: string) => vectors.domains.find((v) => v.input === input)!;
  assert.match(warn("paybox-support.com").warnings[0]!, /^paybox-support\.com looks like PayBox but isn't PayBox's domain \(paybox\.sh\)/);
  assert.deepEqual(warn("coinbase.refunds-desk.com").flags, ["brand_word:coinbase", "brand_word:refund"]);
  assert.deepEqual(warn("payb0x.com").flags, ["brand_word:paybox"], "digits read as letters");
  assert.deepEqual(warn("рaybox.com").flags, ["brand_word:paybox"], "other alphabets read as Latin");
  assert.match(warn("getowed-pay.com").warnings.join(" "), /isn't Owed's domain \(getowed\.xyz/);
  for (const own of ["paybox.sh", "www.paybox.sh", "app.phantom.app", "coinbase.com", "irs.gov", "getowed.xyz", "www.getowed.xyz", "owed-omega.vercel.app", "first.com", "owedmoney.com"]) {
    assert.deepEqual(warn(own).warnings, [], own);
    assert.deepEqual(warn(own).flags, [], own);
  }
});

test("QA-02: a name in front of another domain warns that it only starts with it", () => {
  const v = vectors.domains.find((x) => x.input === "getowed.xyz.example-attacker.com")!;
  assert.ok(v.warnings.includes("getowed.xyz.example-attacker.com only starts with \"getowed.xyz\": the end of a domain name decides who controls it, so this is not getowed.xyz."));
  for (const ok of ["example.co.uk", "shop.example.co.uk", "mail.google.com"]) {
    assert.ok(!vectors.domains.find((x) => x.input === ok)!.warnings.some((w) => w.includes("only starts with")), ok);
  }
});
