// Captures real DNS-over-HTTPS answers into test/fixtures/doh/*.json.
//
//   cd plugin && node test/fixtures/capture-doh.mjs              # every case
//   cd plugin && node test/fixtures/capture-doh.mjs <name>...    # selected cases
//   OWED_CAPTURE_DOMAIN=<domain> node test/fixtures/capture-doh.mjs published-record
//
// Each fixture holds both resolvers' replies to exactly the request src/payee.ts sends
// (same URL, same accept header), stored verbatim as text with the HTTP status. Tests replay
// them through verifyPayee and fail on any request that was not recorded. Nothing is edited by hand.
// The "published-record" case is captured only from a domain that really publishes an
// owed-pay= record (Raj's demo domain, once its _owed TXT record exists); it is never written by hand.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "doh");
// Must match src/payee.ts.
const RESOLVERS = [
  { host: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { host: "dns.google", url: "https://dns.google/resolve" },
];
const dohUrl = (resolver, qname) => `${resolver}?name=${encodeURIComponent(qname)}&type=TXT`;

const CASES = {
  // The domain answers NOERROR with no TXT record at _owed (NODATA), and the zone is DNSSEC-signed.
  "nodata-signed": { note: "example.com publishes nothing at _owed; DNSSEC-signed zone (AD true).", domain: "example.com" },
  // Owed's own host: NOERROR, no record, unsigned. A request claiming it must not verify.
  "nodata-unsigned": { note: "owed-omega.vercel.app publishes nothing at _owed; unsigned zone (AD false).", domain: "owed-omega.vercel.app" },
  // A name that does not exist at all.
  "nxdomain": { note: "An unregistered .com: NXDOMAIN.", domain: "owed-omega-nxdomain-w2h-probe.com" },
  // A non-ASCII domain (münchen.de), queried by its punycode name as src/payee.ts does.
  "idn-nxdomain": { note: "münchen.de (xn--mnchen-3ya.de) has no _owed name: NXDOMAIN.", domain: "xn--mnchen-3ya.de" },
  // dnssec-failed.org is deliberately mis-signed; validating resolvers answer SERVFAIL.
  "servfail-dnssec-bogus": { note: "Broken DNSSEC: both resolvers answer SERVFAIL (Status 2), so the record can't be read.", domain: "dnssec-failed.org" },
  // A domain that publishes owed-pay= records. Only captured from the real record.
  "published-record": {
    note: "A domain whose _owed TXT record publishes an Owed wallet, captured from the live record.",
    domain: () => process.env.OWED_CAPTURE_DOMAIN,
  },
  // Not _owed queries: real TXT answer shapes for the parser (multi-string, CNAME chain, many records).
  "txt-multi-string": { note: "A 2048-bit DKIM key: Cloudflare splits it into quoted strings, dns.google joins it.", qname: "google._domainkey.github.com" },
  "txt-cname-chain": { note: "A CNAME followed by the TXT record at its target.", qname: "k1._domainkey.mailchimp.com" },
  "txt-many-records": { note: "Many TXT records on one name.", qname: "google.com" },
};

async function ask(resolver, qname) {
  const url = dohUrl(resolver.url, qname);
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
  return { resolver: resolver.host, url, status: res.status, content_type: res.headers.get("content-type"), body: await res.text() };
}

async function capture(name, c) {
  const domain = typeof c.domain === "function" ? c.domain() : c.domain;
  if (c.domain && !domain) {
    console.log(`${name}: skipped (set OWED_CAPTURE_DOMAIN to a domain that publishes an _owed record)`);
    return;
  }
  const qname = domain ? `_owed.${domain}` : c.qname;
  const responses = [];
  for (const resolver of RESOLVERS) responses.push(await ask(resolver, qname));
  if (name === "published-record" && !responses.every((r) => r.status === 200 && /owed-pay=/i.test(r.body))) {
    throw new Error(`${name}: _owed.${domain} does not publish an owed-pay= record on both resolvers; nothing written`);
  }
  const fixture = { name, note: c.note, captured_at: new Date().toISOString(), query: { ...(domain && { domain }), qname, type: "TXT" }, responses };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${name}: ${responses.map((r) => `${r.resolver} ${r.status} Status=${safeStatus(r.body)}`).join(", ")}`);
}

function safeStatus(body) {
  try {
    return JSON.parse(body).Status;
  } catch {
    return "?";
  }
}

const wanted = process.argv.slice(2);
for (const [name, c] of Object.entries(CASES)) {
  if (wanted.length ? !wanted.includes(name) : name === "published-record" && !process.env.OWED_CAPTURE_DOMAIN) continue;
  await capture(name, c);
}
