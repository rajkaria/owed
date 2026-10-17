// DNS-over-HTTPS doubles for tests: replays answers captured by test/fixtures/capture-doh.mjs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Route } from "./helpers.ts";

export interface DohFixture {
  name: string;
  note: string;
  query: { domain?: string; qname: string; type: "TXT" };
  responses: Array<{ resolver: string; url: string; status: number; content_type: string | null; body: string }>;
}

const dir = fileURLToPath(new URL("./fixtures/doh/", import.meta.url));

export function dohFixture(name: string): DohFixture {
  return JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as DohFixture;
}

export function hasDohFixture(name: string): boolean {
  return existsSync(`${dir}${name}.json`);
}

export const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/payee-vectors.json", import.meta.url)), "utf8")) as {
  domains: Array<{ input: string; ascii: string; unicode: string; warnings: string[]; flags: string[] }>;
  invalid: string[];
};

export type ResolverHost = "cloudflare-dns.com" | "dns.google";
export type DohOverride = Route;

/** The fakeFetch route key for a recorded DoH request (fakeFetch strips the host). */
export function routeKey(url: string): string {
  return `GET ${url.replace(/^https:\/\/[^/]+/, "")}`;
}

/**
 * Routes that answer exactly the recorded requests of a fixture. `override` replaces one resolver's
 * reply (an outage, a hang, a 500) while the other keeps its recorded answer.
 */
export function dohRoutes(fixture: DohFixture, override: Partial<Record<ResolverHost, DohOverride>> = {}): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const r of fixture.responses) {
    const replace = override[r.resolver as ResolverHost];
    routes[routeKey(r.url)] = replace ?? (() => new Response(r.body, { status: r.status, headers: { "content-type": r.content_type ?? "application/json" } }));
  }
  return routes;
}

/**
 * A copy of a real NOERROR fixture whose answers carry the given TXT values, in each resolver's own
 * format (Cloudflare quotes, dns.google doesn't). For branch tests until published-record.json is
 * captured from the live record; it is never written to disk as a fixture.
 */
export function withTxt(fixture: DohFixture, values: string[]): DohFixture {
  return {
    ...fixture,
    name: `${fixture.name} + constructed TXT`,
    responses: fixture.responses.map((r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const quoted = r.resolver === "cloudflare-dns.com";
      const name = quoted ? fixture.query.qname : `${fixture.query.qname}.`;
      body.Answer = values.map((v) => ({ name, type: 16, TTL: 300, data: quoted ? `"${v}"` : v }));
      delete body.Authority;
      return { ...r, body: JSON.stringify(body) };
    }),
  };
}

/**
 * The real example.com NODATA capture re-addressed to `domain` and carrying these TXT values: what an attacker who
 * owns `domain` (and so its DNS) would publish. For tests of names no real fixture can cover (QA-02).
 */
export function dohFor(domain: string, values: string[]): Record<string, Route> {
  const base = dohFixture("nodata-signed");
  const qname = `_owed.${domain}`;
  const moved: DohFixture = {
    ...base,
    query: { domain, qname, type: "TXT" },
    responses: base.responses.map((r) => ({ ...r, url: r.url.replace("_owed.example.com", qname), body: r.body.replaceAll("_owed.example.com", qname) })),
  };
  return dohRoutes(withTxt(moved, values));
}
