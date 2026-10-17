import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatFiat, quoteProblem, usdcAtomicFor } from "@/lib/fiat";
import {
  FALLBACK_MAX_AGE_MS, FX_CACHE_MS, FX_HOSTS, fiatAsk, lockRate, numberLiteralToDecimal, parseCoinbase, parseErApi, quoteAt, resetFxCache,
} from "@/lib/fx";
import { ApiError } from "@/lib/http";
import { fiatView } from "@/lib/view/request-view";

// Local-currency asks, server side: the shared math is one file in two places, rates are read exactly from
// real captured replies (test/fixtures/fx, 2026-10-17T21:06:41Z), and lockRate locks, cross-checks or refuses.

const fx = (name: string) => readFileSync(new URL(`fixtures/fx/${name}`, import.meta.url), "utf8");
const COINBASE = fx("coinbase-usd.json");
const ER_API = fx("er-api-usd.json");
const CAPTURED = Date.parse("2026-10-17T21:06:41Z");

type Reply = string | number | "down";
/** A fetch for the two rate hosts only; anything else is a test bug. Counts calls per host. */
function fxFetch(coinbase: Reply, erApi: Reply) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    const host = new URL(url).host;
    assert.ok((FX_HOSTS as readonly string[]).includes(host), `unexpected fetch ${url}`);
    calls.push(host);
    const reply = host === "api.coinbase.com" ? coinbase : erApi;
    if (reply === "down") throw new TypeError("fetch failed");
    if (typeof reply === "number") return new Response("{}", { status: reply });
    return new Response(reply, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}
/** The Coinbase capture with one rate changed. */
const coinbaseWith = (code: string, value: string) => COINBASE.replace(new RegExp(`"${code}":"[^"]*"`), `"${code}":"${value}"`);
const erApiAt = (unix: number) => ER_API.replace(/"time_last_update_unix":\d+/, `"time_last_update_unix":${unix}`);

test("plugin/src/fiat.ts and web/lib/fiat.ts are the same file", () => {
  const web = readFileSync(new URL("../lib/fiat.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../../plugin/src/fiat.ts", import.meta.url), "utf8");
  assert.equal(web, plugin);
});

test("JSON number literals become exact decimals (no float on the way)", () => {
  assert.equal(numberLiteralToDecimal("95.111965"), "95.111965");
  assert.equal(numberLiteralToDecimal("3.6725"), "3.6725");
  assert.equal(numberLiteralToDecimal("1"), "1");
  assert.equal(numberLiteralToDecimal("1.2e-5"), "0.000012");
  assert.equal(numberLiteralToDecimal("1.25E3"), "1250");
  assert.equal(numberLiteralToDecimal("0.1000"), "0.1");
  assert.equal(numberLiteralToDecimal("4131.8058255"), "4131.8058255");
  for (const bad of ["-1", "NaN", "1e999", "abc", ""]) assert.equal(numberLiteralToDecimal(bad), null, bad);
});

test("real replies parse to exact strings: Coinbase's decimals as sent, open.er-api.com's from the source text", () => {
  const cb = parseCoinbase(COINBASE, CAPTURED);
  assert.equal(cb.rates.get("INR"), "94.95975");
  assert.equal(cb.rates.get("USDC"), "1");
  assert.equal(cb.asOf, CAPTURED);
  const er = parseErApi(ER_API, CAPTURED);
  assert.equal(er.rates.get("INR"), "95.111965");
  assert.equal(er.rates.get("USD"), "1");
  assert.equal(er.asOf, Date.parse("2026-10-17T00:02:32Z"));
  assert.ok(er.rates.size > 150);
  assert.throws(() => parseErApi(ER_API.replace('"base_code":"USD"', '"base_code":"EUR"'), CAPTURED), /unexpected/);
  assert.throws(() => parseCoinbase('{"data":{"currency":"USDC","rates":{}}}', CAPTURED), /unexpected/);
});

test("lockRate: both sources up and within 2% → Coinbase's live rate, labelled as cross-checked", async () => {
  resetFxCache();
  const { fetch, calls } = fxFetch(COINBASE, ER_API);
  const locked = await lockRate("INR", { fetch, now: () => CAPTURED });
  assert.deepEqual(locked, { rate: "94.95975", rate_source: "api.coinbase.com, checked against open.er-api.com", quoted_at: "2026-10-17T21:06:41Z" });
  assert.deepEqual(calls.sort(), ["api.coinbase.com", "open.er-api.com"]);
  // One fetch per source per minute per instance, whatever the currency.
  const eur = await lockRate("EUR", { fetch, now: () => CAPTURED + FX_CACHE_MS - 1 });
  assert.equal(eur.rate, "0.889913");
  assert.equal(calls.length, 2);
  await lockRate("EUR", { fetch, now: () => CAPTURED + FX_CACHE_MS });
  assert.equal(calls.length, 4);
});

test("lockRate: Coinbase's USD table divided by its USDC price, so a depeg moves the rate", async () => {
  resetFxCache();
  const { fetch } = fxFetch(coinbaseWith("USDC", "1.01"), ER_API);
  const locked = await lockRate("INR", { fetch, now: () => CAPTURED });
  assert.equal(locked.rate, "94.019554455445"); // 94.95975 / 1.01, 12 places
});

test("lockRate refuses when the sources disagree by more than 2%, and says by how much", async () => {
  resetFxCache();
  // Coinbase's own USDC->INR market price on 2026-10-17 (101.377) against the mid-market rate.
  const { fetch } = fxFetch(coinbaseWith("INR", "101.377"), ER_API);
  await assert.rejects(lockRate("INR", { fetch, now: () => CAPTURED }), (e: unknown) =>
    e instanceof ApiError && e.code === "upstream_unavailable" && /disagree on INR by 6\.6% \(more than 2%\)/.test(e.message));
  resetFxCache();
  const near = fxFetch(coinbaseWith("INR", "97.0"), ER_API); // 1.98% above open.er-api.com's 95.111965
  assert.equal((await lockRate("INR", { fetch: near.fetch, now: () => CAPTURED })).rate, "97");
});

test("lockRate falls back to whichever source answers; open.er-api.com only while fresh", async () => {
  resetFxCache();
  const cbDown = fxFetch("down", ER_API);
  assert.deepEqual(await lockRate("NGN", { fetch: cbDown.fetch, now: () => CAPTURED }),
    { rate: "1332.43205", rate_source: "open.er-api.com (USD rate)", quoted_at: "2026-10-17T21:06:41Z" });
  resetFxCache();
  const erDown = fxFetch(COINBASE, 500);
  assert.equal((await lockRate("NGN", { fetch: erDown.fetch, now: () => CAPTURED })).rate_source, "api.coinbase.com");
  resetFxCache();
  const stale = fxFetch("down", erApiAt(Math.floor((CAPTURED - FALLBACK_MAX_AGE_MS) / 1000) - 1));
  await assert.rejects(lockRate("NGN", { fetch: stale.fetch, now: () => CAPTURED }), /open\.er-api\.com's rates are stale and api\.coinbase\.com didn't answer/);
  resetFxCache();
  // A stale cross-check is ignored, not trusted: Coinbase alone.
  const staleCheck = fxFetch(COINBASE, erApiAt(1));
  assert.equal((await lockRate("NGN", { fetch: staleCheck.fetch, now: () => CAPTURED })).rate_source, "api.coinbase.com");
  resetFxCache();
  const both = fxFetch("down", "not json");
  await assert.rejects(lockRate("NGN", { fetch: both.fetch, now: () => CAPTURED }), /neither rate source answered/);
});

test("fiatAsk and quoteAt: validation messages, then the USDC rounded up", () => {
  assert.deepEqual(fiatAsk("inr", "1200.50"), { code: "INR", amount: "1200.5", minor: 120_050n });
  assert.throws(() => fiatAsk("USD", "10"), (e: unknown) => e instanceof ApiError && e.code === "invalid_input" && /^currency: USD needs no conversion/.test(e.message));
  assert.throws(() => fiatAsk("JPY", "10.5", "total"), (e: unknown) => e instanceof ApiError && e.message === "total: JPY amounts are whole numbers (no decimals).");
  const q = quoteAt("INR", "1200", { rate: "94.95975", rate_source: "api.coinbase.com", quoted_at: "2026-10-17T21:06:41Z" });
  assert.equal(q.usdcAtomic, 12_636_934n);
  assert.deepEqual(q.fiat, { currency: "INR", amount: "1200", rate: "94.95975", rate_source: "api.coinbase.com", quoted_at: "2026-10-17T21:06:41Z" });
  assert.equal(usdcAtomicFor("60000", "JPY", "158.0085"), 379_726_408n);
});

test("pay-page view: shows a quote only when it produces the USDC amount", () => {
  const fiat = { currency: "INR", amount: "1200", rate: "94.95975", rate_source: "api.coinbase.com, checked against open.er-api.com", quoted_at: "2026-10-17T21:04:31Z" };
  assert.deepEqual(fiatView(fiat, "12.636934"), {
    amount: "₹1,200", usdc: "12.636934 USDC", rate: "1 USDC = ₹94.96", lockedAt: "2026-10-17 21:04 UTC",
    source: "api.coinbase.com, checked against open.er-api.com", currencyName: "Indian rupee",
  });
  assert.equal(fiatView(fiat, "12.636933"), null);
  assert.equal(fiatView({ ...fiat, currency: "XXX" }, "12.636934"), null);
  assert.equal(fiatView({ ...fiat, rate_source: "see https://evil.example" }, "12.636934")?.source, ""); // never shown as a link
  assert.equal(fiatView(undefined, "12.636934"), null);
  assert.equal(quoteProblem(fiat, 12_636_934n), null);
  assert.equal(formatFiat("1200", "NGN"), "₦1,200");
});
