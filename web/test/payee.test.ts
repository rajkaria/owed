import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { CreateRequestBody, CreateRequestResponse, GetRequestResponse } from "@/lib/contract";
import { ApiError } from "@/lib/http";
import {
  domainWarnings,
  normalizeDomain,
  owedPayValues,
  parseTxtAnswer,
  payeeDisplay,
  requireVerifiedDomain,
  txtValue,
  verifiedAgo,
  verifyDomain,
} from "@/lib/payee";
import { toPublic, type RequestRow } from "@/lib/requests";

// The plugin and the server must agree on every rule, so this suite runs the plugin's fixtures:
// real DoH answers (plugin/test/fixtures/doh, captured by capture-doh.mjs) and the domain vectors.
const pluginFixtures = new URL("../../plugin/test/fixtures/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("payee-vectors.json", pluginFixtures), "utf8")) as {
  domains: Array<{ input: string; ascii: string; unicode: string; warnings: string[] }>;
  invalid: string[];
};

interface DohFixture {
  name: string;
  query: { domain?: string; qname: string };
  responses: Array<{ resolver: string; url: string; status: number; body: string }>;
}
const doh = (name: string) => JSON.parse(readFileSync(new URL(`doh/${name}.json`, pluginFixtures), "utf8")) as DohFixture;

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Replays a fixture; `override` replaces one resolver's reply. Records every URL asked for. */
function replay(f: DohFixture, override: Record<string, () => Response | Promise<Response>> = {}) {
  const urls: string[] = [];
  const fetchDouble = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = f.responses.find((x) => x.url === url);
    if (!r) throw new TypeError(`unrecorded request ${url}`);
    const replace = override[r.resolver];
    return replace ? replace() : new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return { fetch: fetchDouble, urls };
}

/** A real NOERROR answer with TXT records added (until the live demo record is captured). */
function withTxt(f: DohFixture, values: string[]): DohFixture {
  return {
    ...f,
    responses: f.responses.map((r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const quoted = r.resolver === "cloudflare-dns.com";
      body.Answer = values.map((v) => ({ name: f.query.qname, type: 16, TTL: 300, data: quoted ? `"${v}"` : v }));
      delete body.Authority;
      return { ...r, body: JSON.stringify(body) };
    }),
  };
}

test("domain vectors match the plugin word for word", () => {
  for (const v of vectors.domains) {
    const d = normalizeDomain(v.input);
    assert.ok(d, v.input);
    assert.equal(d.ascii, v.ascii, v.input);
    assert.equal(d.unicode, v.unicode, v.input);
    assert.deepEqual(domainWarnings(d), v.warnings, v.input);
  }
  for (const input of vectors.invalid) assert.equal(normalizeDomain(input), null, JSON.stringify(input));
});

test("payeeDisplay: full domain, Unicode with punycode for IDN, warnings for the badge", () => {
  assert.deepEqual(payeeDisplay("getowed.xyz"), { domain: "getowed.xyz", displayDomain: "getowed.xyz", label: "getowed.xyz", warnings: [] });
  const idn = payeeDisplay("xn--pypal-4ve.com")!;
  assert.equal(idn.label, "pаypal.com (xn--pypal-4ve.com)");
  assert.match(idn.warnings.join(" "), /can pass for paypal\.com/);
  assert.equal(payeeDisplay("not a domain"), null);
});

test("every captured answer parses the same as in the plugin; Cloudflare and dns.google agree", () => {
  const dir = new URL("doh/", pluginFixtures);
  const names = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, ""));
  assert.ok(names.length >= 8);
  for (const name of names) {
    const f = doh(name);
    const [a, b] = f.responses.map((r) => parseTxtAnswer(JSON.parse(r.body), f.query.qname));
    if (name === "servfail-dnssec-bogus") {
      assert.equal(a, null);
      assert.equal(b, null);
      continue;
    }
    assert.ok(a && b, name);
    assert.equal(a.rcode, b.rcode, name);
    assert.equal(a.ad, b.ad, name);
    assert.deepEqual([...a.txt].sort(), [...b.txt].sort(), name);
  }
  assert.equal(txtValue('"owed-pay=" "abc"'), "owed-pay=abc");
  assert.deepEqual(owedPayValues([`OWED-PAY=${RECIPIENT}`, "v=spf1 -all"]), [RECIPIENT]);
});

test("verifyDomain on real answers: no record, NXDOMAIN, IDN, SERVFAIL", async () => {
  const signed = replay(doh("nodata-signed"));
  assert.deepEqual(await verifyDomain("example.com", RECIPIENT, { fetch: signed.fetch }), {
    status: "unverified", domain: "example.com", display_domain: "example.com", dnssec: true, records: 0,
  });
  assert.deepEqual(signed.urls, ["https://cloudflare-dns.com/dns-query?name=_owed.example.com&type=TXT"]);
  const nx = doh("nxdomain");
  assert.equal((await verifyDomain(nx.query.domain!, RECIPIENT, { fetch: replay(nx).fetch })).status, "unverified");
  const idn = await verifyDomain("münchen.de", RECIPIENT, { fetch: replay(doh("idn-nxdomain")).fetch });
  assert.equal(idn.domain, "xn--mnchen-3ya.de");
  assert.equal(idn.display_domain, "münchen.de");
  const bogus = replay(doh("servfail-dnssec-bogus"));
  assert.equal((await verifyDomain("dnssec-failed.org", RECIPIENT, { fetch: bogus.fetch })).status, "dns_unavailable");
  assert.equal(bogus.urls.length, 2);
});

test("verifyDomain falls back to dns.google when Cloudflare fails", async () => {
  const f = withTxt(doh("nodata-signed"), [`owed-pay=${RECIPIENT}`]);
  const r = replay(f, { "cloudflare-dns.com": () => new Response("busy", { status: 503 }) });
  assert.deepEqual(await verifyDomain("example.com", RECIPIENT, { fetch: r.fetch }), {
    status: "verified", domain: "example.com", display_domain: "example.com", dnssec: true, records: 1,
  });
  assert.match(r.urls[1], /^https:\/\/dns\.google\/resolve\?name=_owed\.example\.com&type=TXT$/);
});

test("requireVerifiedDomain: returns the stored form, or an API error that says how to fix it", async () => {
  const ok = replay(withTxt(doh("nodata-signed"), [`owed-pay=${OTHER}`, `owed-pay=${RECIPIENT}`]));
  assert.equal(await requireVerifiedDomain("Example.COM", RECIPIENT, { fetch: ok.fetch }), "example.com");

  await assert.rejects(requireVerifiedDomain("example.com", RECIPIENT, { fetch: replay(doh("nodata-signed")).fetch }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "invalid_input");
    assert.equal(e.message, `from_domain: example.com does not publish this recipient. To verify it, add a DNS TXT record named _owed.example.com with the value owed-pay=${RECIPIENT}, then try again`);
    return true;
  });
  await assert.rejects(requireVerifiedDomain("dnssec-failed.org", RECIPIENT, { fetch: replay(doh("servfail-dnssec-bogus")).fetch }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "upstream_unavailable");
    return true;
  });
  await assert.rejects(requireVerifiedDomain("https://example.com", RECIPIENT, { fetch: replay(doh("nodata-signed")).fetch }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "invalid_input");
    return true;
  });
});

test("verifiedAgo", () => {
  const now = Date.parse("2026-10-17T10:00:00Z");
  assert.equal(verifiedAgo("2026-10-17T09:59:30Z", now), "just now");
  assert.equal(verifiedAgo("2026-10-17T09:48:00Z", now), "12 min ago");
  assert.equal(verifiedAgo("2026-10-17T07:00:00Z", now), "3 h ago");
  assert.equal(verifiedAgo("2026-10-14T10:00:00Z", now), "3 days ago");
  assert.equal(verifiedAgo("2026-10-18T10:00:00Z", now), null);
  assert.equal(verifiedAgo("nope", now), null);
});

test("contract: from_domain is optional on create and get, and nullable", () => {
  assert.equal(CreateRequestBody.parse({ recipient: RECIPIENT, amount: "1", from_domain: "example.com" }).from_domain, "example.com");
  assert.equal(CreateRequestBody.parse({ recipient: RECIPIENT, amount: "1" }).from_domain, undefined);
  assert.equal(CreateRequestBody.safeParse({ recipient: RECIPIENT, amount: "1", from_domain: "a".repeat(254) }).success, false);
  const created = JSON.parse(readFileSync(new URL("../../contract/fixtures/create-request.res.json", import.meta.url), "utf8"));
  assert.ok(CreateRequestResponse.safeParse({ ...created, from_domain: "example.com" }).success);
  const got = JSON.parse(readFileSync(new URL("../../contract/fixtures/get-request.res.json", import.meta.url), "utf8"));
  assert.ok(GetRequestResponse.safeParse({ ...got, from_domain: "example.com", from_domain_verified_at: "2026-10-17T05:00:00Z" }).success);
  assert.ok(GetRequestResponse.safeParse({ ...got, from_domain: null, from_domain_verified_at: null }).success);
  assert.ok(GetRequestResponse.safeParse(got).success);
});

test("toPublic returns from_domain and its verified time", () => {
  const row: RequestRow = {
    id: "JArQ6g9JvoWr", kind: "single", recipient: RECIPIENT, token: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6, amountAtomic: 15_000_000n, reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e", payerName: null,
    forText: null, note: null, requesterName: null, flags: [], status: "open", paidSignature: null, paidPayer: null,
    paidAmountAtomic: null, paidAt: null, paidRail: null, source: "plugin", createdAt: "2026-10-17T05:00:00Z",
    fromDomain: "example.com", fromDomainVerifiedAt: "2026-10-17T05:00:00Z",
  };
  const pub = toPublic(row);
  assert.equal(pub.from_domain, "example.com");
  assert.equal(pub.from_domain_verified_at, "2026-10-17T05:00:00Z");
  assert.ok(GetRequestResponse.safeParse(pub).success);
  const none = toPublic({ ...row, fromDomain: null, fromDomainVerifiedAt: null });
  assert.equal(none.from_domain, null);
});

test("migration 0009's domain check accepts every normalized vector and nothing upper-case", () => {
  const sql = readFileSync(new URL("../db/migrations/0009_payee_domain.sql", import.meta.url), "utf8");
  const pattern = /from_domain ~ '([^']+)'/.exec(sql)?.[1];
  assert.ok(pattern);
  const re = new RegExp(pattern);
  for (const v of vectors.domains) assert.ok(re.test(v.ascii), v.ascii);
  for (const bad of ["Example.com", "example", "-a.com", "a..b", "_owed.example.com", "münchen.de"]) assert.equal(re.test(bad), false, bad);
});
