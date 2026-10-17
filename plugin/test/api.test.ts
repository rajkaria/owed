import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, DEFAULT_BASE_URL, makeApi, owedHosts, resolveBaseUrl } from "../src/api.ts";
import { fakeFetch, fixture, html, json, type Call } from "./helpers.ts";

const BASE = "https://owed.link";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("base url: default, env override, trailing slash, rejects non-https and paths", () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ OWED_BASE_URL: "" }), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ OWED_BASE_URL: "https://owed.link/" }), "https://owed.link");
  assert.throws(() => resolveBaseUrl({ OWED_BASE_URL: "http://owed.link" }), /https origin/);
  assert.throws(() => resolveBaseUrl({ OWED_BASE_URL: "https://owed.link/api" }), /https origin/);
  assert.throws(() => resolveBaseUrl({ OWED_BASE_URL: "https://user:pw@owed.link" }), /https origin/);
  assert.throws(() => resolveBaseUrl({ OWED_BASE_URL: "not a url" }), /not a valid URL/);
});

test("owed hosts include the configured host and the known ones, once each", () => {
  assert.deepEqual(owedHosts("https://owed-omega.vercel.app"), ["owed-omega.vercel.app", "owed.link", "www.owed.link", "getowed.xyz", "www.getowed.xyz"]);
  assert.deepEqual(owedHosts("https://pay.example.org"), ["pay.example.org", "owed.link", "www.owed.link", "owed-omega.vercel.app", "getowed.xyz", "www.getowed.xyz"]);
  assert.deepEqual(owedHosts("https://www.getowed.xyz"), ["www.getowed.xyz", "owed.link", "www.owed.link", "owed-omega.vercel.app", "getowed.xyz"]);
});

test("createRequest posts JSON to /api/v1/requests with a timeout and no redirects", async () => {
  const calls: Call[] = [];
  const api = makeApi({ base: BASE, fetch: fakeFetch({ "POST /api/v1/requests": () => json(201, fixture("create-request.res.json")) }, calls) });
  const body = fixture("create-request.req.json");
  const res = await api.createRequest(body);
  assert.equal(res.id, "JArQ6g9JvoWr");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://owed.link/api/v1/requests");
  assert.deepEqual(calls[0]!.body, body);
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["content-type"], "application/json");
});

test("getRequest, status and statusRaw hit their routes and parse fixtures", async () => {
  const calls: Call[] = [];
  const api = makeApi({ base: BASE, fetch: fakeFetch({
    "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, fixture("get-request.res.json")),
    "POST /api/v1/status": () => json(200, fixture("status.res.json")),
    "POST /api/v1/status-raw": () => json(200, fixture("status-raw.res.json")),
  }, calls) });
  assert.equal((await api.getRequest("JArQ6g9JvoWr")).status, "paid");
  const status = await api.status(["JArQ6g9JvoWr", "Bq3wL8mNc2", "111111111111"]);
  assert.deepEqual(status.results.map((r) => r.status), ["paid", "open", "not_found"]); // not_found carries id + status only (QA-05)
  assert.deepEqual(calls[1]!.body, fixture("status.req.json"));
  const raw = fixture("status-raw.req.json");
  assert.equal((await api.statusRaw(raw.solana_pay_url)).status, "open");
  assert.deepEqual(calls[2]!.body, raw);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.init?.body, undefined);
});

test("contract errors keep their code and message", async () => {
  const api = makeApi({ base: BASE, fetch: fakeFetch({
    "POST /api/v1/requests": () => json(400, fixture("error.res.json")),
    "GET *": () => json(404, { error: { code: "not_found", message: "No request with that id." } }),
    "POST /api/v1/status": () => json(429, { error: { code: "rate_limited", message: "Slow down." } }),
  }) });
  await assert.rejects(api.createRequest(fixture("create-request.req.json")), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "invalid_input");
    assert.equal(e.message, "amount must be a positive decimal with at most 6 decimal places");
    assert.equal(e.httpStatus, 400);
    return true;
  });
  await rejectsWith(api.getRequest("Bq3wL8mNc2"), "not_found");
  await rejectsWith(api.status(["Bq3wL8mNc2"]), "rate_limited");
});

test("network errors, timeouts, 5xx and off-contract replies are upstream_unavailable", async () => {
  const cases: Record<string, Parameters<typeof fakeFetch>[0][string]> = {
    "network error": () => "network_error",
    "503": () => json(503, { error: { code: "upstream_unavailable", message: "db down" } }),
    "500 html": () => html(500),
    "html 404 (route missing)": () => html(404),
    "success with wrong shape": () => json(201, { id: 5 }),
    "success that isn't JSON": () => new Response("ok", { status: 200 }),
  };
  for (const [name, route] of Object.entries(cases)) {
    const api = makeApi({ base: BASE, fetch: fakeFetch({ "POST *": route }) });
    await rejectsWith(api.createRequest(fixture("create-request.req.json")), "upstream_unavailable").catch((e) => {
      throw new Error(`${name}: ${e}`);
    });
  }
  const slow = makeApi({ base: BASE, timeoutMs: 30, fetch: fakeFetch({ "POST *": () => "hang" }) });
  const started = Date.now();
  await rejectsWith(slow.status(["JArQ6g9JvoWr"]), "upstream_unavailable");
  assert.ok(Date.now() - started < 1000, "timeout must abort the request");
});

test("ids are path-encoded", async () => {
  const calls: Call[] = [];
  const api = makeApi({ base: BASE, fetch: fakeFetch({}, calls) });
  await rejectsWith(api.getRequest("../stats"), "not_found");
  assert.equal(calls[0]!.url, "https://owed.link/api/v1/requests/..%2Fstats");
});
