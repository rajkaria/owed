// W2-E sanctions screen: src/screen.ts and its call in every tool that creates or pays a request.
// Chainalysis answers are real captures (test/fixtures/chainalysis, capture-chainalysis.mjs). A few
// branch tests use constructed replies (labelled below) for shapes no real address returns on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solanaOutputSchema, x402OutputSchema } from "../src/paybox.ts";
import { parseScreening, SCREEN_TIMEOUT_MS, screeningUrl, screenRecipient, type Screening } from "../src/screen.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { createInvoice, inputSchema as invoiceInput } from "../src/tools/create_invoice.ts";
import { inputSchema as payInput, payLink } from "../src/tools/pay_link.ts";
import { inputSchema as splitInput, splitBill } from "../src/tools/split_bill.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, type Route } from "./helpers.ts";
import { dohFixture, dohRoutes } from "./payee-helpers.ts";

interface Capture {
  name: string;
  request: { method: "GET"; url: string; address: string };
  response: { status: number; content_type: string | null; body: string };
}
const dir = fileURLToPath(new URL("./fixtures/chainalysis/", import.meta.url));
const has = (name: string) => existsSync(`${dir}${name}.json`);
const capture = (name: string) => JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as Capture;
const replay = (c: Capture) => new Response(c.response.body, { status: c.response.status, headers: { "content-type": c.response.content_type ?? "" } });
const SANCTIONED = ["sanctioned", "sanctioned-2", "sanctioned-3", "sanctioned-4"].filter(has);
const itCaptured = (names: string[]) => (names.every(has) ? test : test.skip);

/** Answers exactly the recorded Chainalysis requests; any other Chainalysis URL fails the test. */
function chainalysisRoutes(...captures: Capture[]): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const c of captures) routes[`GET ${c.request.url.replace(/^https:\/\/[^/]+/, "")}`] = () => replay(c);
  return routes;
}
/** A fetch that answers one recorded capture and records what the plugin sent. */
function recordedFetch(c: Capture, seen: Array<{ url: string; init?: RequestInit }> = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    assert.equal(String(input), c.request.url, "only the recorded request is answered");
    return replay(c);
  }) as typeof fetch;
}
/** Constructed (not captured): Chainalysis's documented listed shape with the given names. */
const listedBody = (...names: unknown[]) => JSON.stringify({ identifications: names.map((name) => ({ category: "sanctions", name, description: "constructed", url: null })) });

// ---------------------------------------------------------------- screen.ts

test("the request is exactly GET https://public.chainalysis.com/api/v1/address/<address>, JSON, no key from the plugin", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const c = capture("bad-key");
  await screenRecipient(c.request.address, { fetch: recordedFetch(c, seen) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `https://public.chainalysis.com/api/v1/address/${RECIPIENT}`);
  assert.equal(screeningUrl(RECIPIENT), seen[0]!.url);
  const headers = new Headers(seen[0]!.init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("x-api-key"), null, "PayBox brokers X-API-Key; the plugin never sends or holds it");
  assert.equal(seen[0]!.init?.redirect, "error");
  assert.ok(seen[0]!.init?.signal instanceof AbortSignal);
});

test("real 401 (bad key) and 403 (no key: Cloudflare's block page) are 'unavailable', never 'clear'", async () => {
  for (const name of ["bad-key", "no-key"]) {
    const c = capture(name);
    assert.deepEqual(await screenRecipient(c.request.address, { fetch: recordedFetch(c) }), { ok: true, screening: "unavailable" }, name);
  }
  assert.equal(capture("bad-key").response.status, 401);
  assert.equal(capture("no-key").response.status, 403);
});

itCaptured(["clean"])("real answer for an address on no list (the team wallet): clear", async () => {
  const c = capture("clean");
  assert.deepEqual(await screenRecipient(c.request.address, { fetch: recordedFetch(c) }), { ok: true, screening: "clear" });
});

itCaptured(["sanctioned"])("real answers for every OFAC SDN Solana address: blocked, naming the list, no link", async () => {
  for (const name of SANCTIONED) {
    const c = capture(name);
    const result = await screenRecipient(c.request.address, { fetch: recordedFetch(c) });
    assert.equal(result.ok, false, name);
    const message = (result as { message: string }).message;
    assert.match(message, new RegExp(`^The address ${c.request.address.slice(0, 4)}…${c.request.address.slice(-4)} is on a sanctions list \\(Chainalysis reports it as "`), name);
    assert.match(message, /OFAC|SDN/, `${name}: names the list`);
    assert.match(message, /Owed doesn't create or pay requests for sanctioned addresses\.$/);
    assert.doesNotMatch(message, /https?:|www\.|solana:/i, "no link");
    assert.doesNotMatch(message, /[0-9a-f]{32,}/i, "Chainalysis's trailing hash is dropped");
  }
});

test("anything short of a clean answer is 'unavailable': 5xx, 429, not JSON, wrong shape, too big", () => {
  const unavailable = { ok: true, screening: "unavailable" };
  assert.deepEqual(parseScreening(RECIPIENT, 500, '{"identifications":[]}'), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 429, '{"message":"Too Many Requests"}'), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, "<html>"), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, "{}"), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, "null"), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, '{"identifications":"none"}'), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, '{"identifications":[null]}'), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, '{"identifications":[["x"]]}'), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, `{"identifications":[],"pad":"${"x".repeat(70_000)}"}`), unavailable);
  assert.deepEqual(parseScreening(RECIPIENT, 200, '{"identifications":[]}'), { ok: true, screening: "clear" });
});

test("listed labels are cleaned like any outside text (constructed replies)", () => {
  const msg = (body: string) => (parseScreening(RECIPIENT, 200, body) as { ok: false; message: string }).message;
  assert.equal(msg(listedBody("SANCTIONS: OFAC SDN Example Entity 2024-01-02 1da5821544e25c636c1417ba96ade4cf6d2f9b5a")),
    'The address FN6G…cbvs is on a sanctions list (Chainalysis reports it as "OFAC SDN Example Entity 2024-01-02"). Owed doesn\'t create or pay requests for sanctioned addresses.');
  const hostile = msg(listedBody("SANCTIONS: OFAC SDN see https://evil.example/x ‮evil\u0000 \"quoted\""));
  assert.doesNotMatch(hostile, /https?:|evil\.example|‮|\u0000/);
  assert.match(hostile, /\[link removed\]/);
  assert.doesNotMatch(hostile.replace(/^[^"]*"|"\)[^"]*$/g, ""), /"/, "no stray double quotes inside the label");
  assert.match(msg(listedBody("SANCTIONS: OFAC SDN A 2020-01-01", "SANCTIONS: OFAC SDN B 2021-01-01")), /"OFAC SDN A 2020-01-01" and 1 more\)/);
  assert.match(msg(listedBody(null)), /\(Chainalysis reports it on a sanctions list\)/);
  assert.ok(msg(listedBody(`SANCTIONS: ${"W".repeat(500)}`)).length < 300, "label capped");
});

test("network errors and a hang are 'unavailable' within 2.5 s, even if fetch ignores its signal", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.deepEqual(await screenRecipient(RECIPIENT, { fetch: down }), { ok: true, screening: "unavailable" });
  const started = Date.now();
  const deaf = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  assert.deepEqual(await screenRecipient(RECIPIENT, { fetch: deaf }), { ok: true, screening: "unavailable" });
  const took = Date.now() - started;
  assert.ok(took >= SCREEN_TIMEOUT_MS - 50 && took < SCREEN_TIMEOUT_MS + 500, `took ${took} ms`);
});

// ---------------------------------------------------------------- tools

const created = fixture("create-request.res.json");
const listed = (): Record<string, Route> => (has("sanctioned")
  ? { ...chainalysisRoutes(capture("sanctioned")), [`GET /api/v1/address/${RECIPIENT}`]: () => replay(capture("sanctioned")) }
  : { [`GET /api/v1/address/${RECIPIENT}`]: () => new Response(listedBody("SANCTIONS: OFAC SDN Constructed 2024-01-02"), { status: 200 }) });
const unreachable = (): Record<string, Route> => ({ [`GET /api/v1/address/${RECIPIENT}`]: () => replay(capture("no-key")) });
const isChainalysis = (url: string) => url.startsWith("https://public.chainalysis.com/");

test("ask_for_money: a listed recipient is refused before anything is created", async () => {
  const { deps, rec } = makeDeps({ screenRecipient, routes: { ...listed(), "POST /api/v1/requests": () => json(201, created) } });
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "1" }), deps);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^The address FN6G…cbvs is on a sanctions list \(Chainalysis reports it as ".+"\)\. Owed doesn't create or pay requests for sanctioned addresses\.$/);
  assert.equal("structuredContent" in result, false);
  assert.deepEqual(rec.calls.map((c) => c.url), [`https://public.chainalysis.com/api/v1/address/${RECIPIENT}`], "no POST to Owed");
});

test("ask_for_money: Chainalysis unreachable → the request is still made, screening:'unavailable', said in the text", async () => {
  const { deps, rec } = makeDeps({ screenRecipient, routes: { ...unreachable(), "POST /api/v1/requests": () => json(201, created) } });
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15" }), deps);
  const out = askOutput.parse((result as { structuredContent: unknown }).structuredContent);
  assert.equal(out.screening, "unavailable");
  assert.equal(out.mode, "hosted");
  assert.equal(textOf(result).split("\n").at(-1), "Recipient screening was unavailable, so this address wasn't screened.");
  assert.equal(rec.calls.filter((c) => c.method === "POST").length, 1);
});

itCaptured(["clean"])("ask_for_money: a clean recipient → screening:'clear', nothing extra in the text", async () => {
  const { deps } = makeDeps({ screenRecipient, routes: { ...chainalysisRoutes(capture("clean")), "POST /api/v1/requests": () => json(201, created) } });
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15" }), deps);
  assert.equal(askOutput.parse((result as { structuredContent: unknown }).structuredContent).screening, "clear");
  assert.doesNotMatch(textOf(result), /screen/i);
});

test("ask_for_money: the screen runs beside the DNS check, so both hanging still fits PayBox's 10 s", async () => {
  // DNS gets 4 s (both resolvers hang), the screen 2.5 s (hangs), the API answers at once: ≈4 s, not 6.5 s.
  const hang: Route = () => "hang";
  const { deps, rec } = makeDeps({
    screenRecipient, now: () => Date.now(), // a real clock, so the DNS budget runs down
    routes: { ...dohRoutes(dohFixture("nodata-signed"), { "cloudflare-dns.com": hang, "dns.google": hang }), [`GET /api/v1/address/${RECIPIENT}`]: hang, "POST /api/v1/requests": () => json(201, created) },
  });
  const started = Date.now();
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15", from_domain: "example.com" }), deps);
  const took = Date.now() - started;
  assert.match(textOf(result), /DNS couldn't be checked/);
  assert.ok(took < 4600, `took ${took} ms`);
  const order = rec.calls.map((c) => (isChainalysis(c.url) ? "screen" : /cloudflare/.test(c.url) ? "dns" : c.url));
  assert.deepEqual(order.slice(0, 2), ["screen", "dns"], "both start together");
});

test("ask_for_money: a listed recipient is refused even when from_domain would verify (sanctions first)", async () => {
  const { deps, rec } = makeDeps({ screenRecipient, routes: { ...listed(), ...dohRoutes(dohFixture("nodata-signed")) } });
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "1", from_domain: "example.com" }), deps);
  assert.match(textOf(result), /sanctions list/);
  assert.equal(rec.calls.filter((c) => c.method === "POST").length, 0);
});

const owedOpen = { ...fixture("get-request.res.json"), status: "open", paid: null };
const payRoutes = (extra: Record<string, Route>): Record<string, Route> => ({ [`GET /api/v1/requests/${owedOpen.id}`]: () => json(200, owedOpen), ...extra });
const pay = (extra: Record<string, unknown> = {}) => payInput.parse({ link: `https://owed.link/r/${owedOpen.id}`, sender: SENDER, ...extra });

test("pay_link: a listed recipient is refused before any proposal (both rails, Owed and raw links)", async () => {
  for (const args of [pay(), pay({ rail: "x402" }), pay({ link: owedOpen.solana_pay_url })]) {
    const { deps, rec } = makeDeps({ screenRecipient, routes: payRoutes(listed()) });
    const result = await payLink(args, deps);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal("structuredContent" in result, false);
    assert.match(textOf(result), /^The address FN6G…cbvs is on a sanctions list \(.+\)\. Owed doesn't create or pay requests for sanctioned addresses\. Nothing was sent\.$/);
    assert.equal(rec.built.length, 0);
    assert.equal(rec.calls.filter((c) => c.url.includes("/x/")).length <= 1, true);
  }
});

test("pay_link: Chainalysis unreachable → still proposes, and says the address wasn't screened", async () => {
  const { deps } = makeDeps({ screenRecipient, routes: payRoutes(unreachable()) });
  const result = await payLink(pay(), deps);
  assert.equal(solanaOutputSchema.parse((result as { structuredContent: unknown }).structuredContent)["io.paybox/transactionProposal"].kind, "solana");
  assert.equal(textOf(result).split("\n").at(-1), "Recipient screening was unavailable, so this address wasn't screened.");
});

test("pay_link: clear → the preview is unchanged (no screening line)", async () => {
  const { deps } = makeDeps({ routes: payRoutes({}) }); // the helper's default screen answers clear
  const result = await payLink(pay(), deps);
  assert.ok(solanaOutputSchema.safeParse((result as { structuredContent: unknown }).structuredContent).success);
  assert.doesNotMatch(textOf(result), /screen/i);
  // x402 rail too: the screen runs before the rail split.
  const x402 = makeDeps({ routes: payRoutes({}) });
  const r2 = await payLink(pay({ rail: "x402" }), x402.deps);
  assert.ok(!r2.isError || !/sanctions/.test(textOf(r2)));
  if (!r2.isError) x402OutputSchema.parse((r2 as { structuredContent: unknown }).structuredContent);
});

test("split_bill and create_invoice screen through Deps by default, beside the DNS check", async () => {
  const screened: string[] = [];
  const blocked = async (addr: string): Promise<Screening> => { screened.push(addr); return { ok: false, message: "listed" }; };
  const split = makeDeps({ screenRecipient: blocked, routes: {} });
  const s = await splitBill(splitInput.parse({ recipient: RECIPIENT, total: "2", token: "USDC", title: "Pizza", people: [{ name: "A" }, { name: "B" }] }), split.deps);
  assert.equal(textOf(s), "listed");
  const inv = makeDeps({ screenRecipient: blocked, routes: {} });
  const i = await createInvoice(invoiceInput.parse({
    recipient: RECIPIENT, token: "USDC", business_name: "B", client_name: "C", items: [{ description: "x", quantity: "1", unit_price: "1" }], due_date: "2026-11-01",
  }), inv.deps);
  assert.equal(textOf(i), "listed");
  assert.deepEqual(screened, [RECIPIENT, RECIPIENT]);
  assert.equal(split.rec.calls.length + inv.rec.calls.length, 0);

  // split_bill: the screen no longer waits in front of DNS (both hang → ≈ the DNS budget, not screen + DNS).
  const hang: Route = () => "hang";
  const slow = makeDeps({ screenRecipient, now: () => Date.now(), routes: { ...dohRoutes(dohFixture("nodata-signed"), { "cloudflare-dns.com": hang, "dns.google": hang }), [`GET /api/v1/address/${RECIPIENT}`]: hang } });
  const started = Date.now();
  await splitBill(splitInput.parse({ recipient: RECIPIENT, total: "2", token: "USDC", title: "Pizza", people: [{ name: "A" }, { name: "B" }], from_domain: "example.com" }), slow.deps);
  assert.ok(Date.now() - started < 5600, `took ${Date.now() - started} ms`); // DNS budget 5.5 s, screen 2.5 s beside it
  const first = slow.rec.calls.slice(0, 2).map((c) => (isChainalysis(c.url) ? "screen" : "dns"));
  assert.deepEqual(first.sort(), ["dns", "screen"]);
});
