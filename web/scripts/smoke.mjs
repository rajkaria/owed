#!/usr/bin/env node
// Smoke test for a deployed Owed web app. Dependency-free (Node 24 fetch).
//
//   node web/scripts/smoke.mjs <baseUrl> [--strict] [--create] [--id <id>] [--page <path|url>]... [--json] [--timeout-ms N]
//
// Checks every Tier-1 route in SPEC §5.3 plus the pages: status codes, content types and JSON shapes from
// contract/shapes.mjs (which must accept every file in contract/fixtures/ before anything runs).
// A route that is not deployed yet (Vercel answers 404 with x-matched-path: /404) is PENDING, not a failure,
// unless --strict is passed. Nothing is written unless --create is passed: then exactly one real request for
// 0.01 USDC to the team wallet is created (source "web", requester "Owed smoke"), and its id, QR, pay page and preview image are
// checked end to end. --id <id> runs the same read-only checks against an existing request.
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { check, fixtureShapes, parseSolanaPayUrl, shapes, TEAM_WALLET, USDC_MINT } from "../../contract/shapes.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../contract/fixtures");
const UNKNOWN_ID = "1111111111"; // valid 10-char base58 that random ids never produce in practice
const UNKNOWN_LEDGER_ID = "1111111111ab"; // valid 12-char base58 (ledger and refund ids), never produced in practice
const TOKEN_ACCOUNT = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // off the ed25519 curve: no wallet can sign for it
const UNKNOWN_POT_ID = "11111111111111"; // F7: valid 14-char base58 pot id, never produced in practice
const SMOKE_AMOUNT = "0.01";
const SMOKE_REQUEST = {
  recipient: TEAM_WALLET, amount: SMOKE_AMOUNT, token: "USDC",
  payer_name: "Smoke test", requester_name: "Owed smoke",
  // Untrusted-text probes (SPEC §6): the API must strip the URL and the control character and flag "PayBox".
  for: "smoke check https://example.com/x", note: "Owed smoke run, mentions PayBox\u0007",
  source: "web",
};

export async function loadFixtures(dir = FIXTURES) {
  const fixtures = {};
  for (const [file, shapeName] of Object.entries(fixtureShapes)) {
    const value = JSON.parse(await readFile(join(dir, file), "utf8"));
    const { errors } = check(shapes[shapeName], value);
    if (errors.length) throw new Error(`contract/shapes.mjs rejects contract/fixtures/${file}: ${errors.join("; ")}`);
    fixtures[file.replace(/\.json$/, "")] = value;
  }
  return fixtures;
}

export async function runSmoke({ base, strict = false, create = false, id = null, pages = [], timeoutMs = 10_000, log = () => {} }) {
  const origin = new URL(base).origin;
  const fixtures = await loadFixtures();
  const results = [];

  async function http(method, path, { json, body, headers = {} } = {}) {
    const url = /^https?:\/\//.test(path) ? path : origin + path;
    const started = performance.now();
    const init = { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "owed-smoke/1", ...headers } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers["content-type"] = "application/json";
    } else if (body !== undefined) {
      init.body = body;
      init.headers["content-type"] = "application/json";
    }
    try {
      const res = await fetch(url, init);
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      let parsed;
      if (type === "application/json") {
        try { parsed = JSON.parse(bytes.toString("utf8")); } catch { parsed = undefined; }
      }
      return { url, status: res.status, type, headers: res.headers, bytes, text: bytes.toString("utf8"), json: parsed, ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { url, status: 0, type: "", headers: new Headers(), bytes: Buffer.alloc(0), text: "", error: error.cause?.message ?? error.message, ms: Math.round(performance.now() - started) };
    }
  }

  // Vercel tags framework 404s with x-matched-path /404; without that header (local `next start`) an API 404 that
  // isn't JSON, or a 404 on a page that must exist, means the route isn't there yet.
  function missingRoute(r, { api, mustExist = false }) {
    if (r.status !== 404) return false;
    const matched = r.headers.get("x-matched-path");
    if (matched) return matched === "/404" || matched === "/_not-found";
    return api ? r.type !== "application/json" : mustExist;
  }

  function record(entry) {
    const result = { notes: [], ...entry };
    if (result.status === "pending" && strict) {
      result.status = "fail";
      result.detail = `${result.detail ?? "route not deployed"} (--strict)`;
    }
    results.push(result);
    log(result);
    return result;
  }

  function verdict(name, method, path, r, problems, { warnings = [] } = {}) {
    const base = { name, method, path, http: r.status, type: r.type, ms: r.ms };
    if (r.error) return record({ ...base, status: "fail", detail: `network error: ${r.error}` });
    if (problems.length) return record({ ...base, status: "fail", detail: problems.join("; "), notes: warnings });
    return record({ ...base, status: warnings.length ? "warn" : "pass", notes: warnings });
  }

  function shapeProblems(shapeName, value, problems, warnings) {
    if (value === undefined) return void problems.push("body is not JSON");
    const { errors, warnings: extra } = check(shapes[shapeName], value);
    problems.push(...errors);
    warnings.push(...extra);
  }

  /** JSON endpoint: expected status(es), shape, then a custom refine(json, problems, warnings). */
  async function api(name, method, path, { json, body, expect, shape, refine, mustExist = false }) {
    const r = await http(method, path, { json, body });
    if (missingRoute(r, { api: true, mustExist })) return record({ name, method, path, http: r.status, ms: r.ms, status: "pending", detail: "route not deployed" });
    const problems = [];
    const warnings = [];
    const expected = [expect].flat();
    if (!expected.includes(r.status)) problems.push(`status ${r.status}, expected ${expected.join(" or ")}${r.json?.error ? ` (${r.json.error.code}: ${r.json.error.message})` : ""}`);
    if (r.type !== "application/json") problems.push(`content-type ${r.type || "none"}, expected application/json`);
    else if (!problems.length) {
      const shapeName = typeof shape === "function" ? shape(r) : shape;
      shapeProblems(shapeName, r.json, problems, warnings);
      if (!problems.length && refine) refine(r.json, problems, warnings, r);
    }
    return { ...verdict(name, method, path, r, problems, { warnings }), response: r };
  }

  async function page(name, path, { expect = 200, contains = [], refine, mustExist = expect === 200, pendingIfMissing = true } = {}) {
    const r = await http("GET", path, { headers: { accept: "text/html" } });
    if (pendingIfMissing && missingRoute(r, { api: false, mustExist })) return record({ name, method: "GET", path, http: r.status, ms: r.ms, status: "pending", detail: "route not deployed" });
    const problems = [];
    const warnings = [];
    if (r.status !== expect) problems.push(`status ${r.status}, expected ${expect}`);
    if (r.status !== 0 && r.type !== "text/html") problems.push(`content-type ${r.type || "none"}, expected text/html`);
    if (!problems.length) {
      for (const needle of contains) if (!r.text.includes(needle)) problems.push(`page does not contain ${JSON.stringify(needle)}`);
      if (refine) refine(r, problems, warnings);
    }
    if (expect === 404 && pendingIfMissing && r.status === 404 && !r.headers.get("x-matched-path")) warnings.push("no x-matched-path header: can't tell a missing route from a handled 404");
    return { ...verdict(name, "GET", path, r, problems, { warnings }), response: r };
  }

  async function image(name, path, { type, magic, minBytes = 64, mustExist = true }) {
    const r = await http("GET", path);
    if (missingRoute(r, { api: true, mustExist })) return record({ name, method: "GET", path, http: r.status, ms: r.ms, status: "pending", detail: "route not deployed" });
    const problems = [];
    if (r.status !== 200) problems.push(`status ${r.status}, expected 200`);
    else {
      if (![type].flat().includes(r.type)) problems.push(`content-type ${r.type || "none"}, expected ${[type].flat().join(" or ")}`);
      if (r.bytes.length < minBytes) problems.push(`${r.bytes.length} bytes, expected ≥ ${minBytes}`);
      if (magic && !magic(r.bytes)) problems.push("body does not look like the declared image type");
    }
    return verdict(name, "GET", path, r, problems);
  }

  /** Any route that must answer 404 for an id that doesn't exist (body type is the route's choice). */
  async function expect404(name, path) {
    const r = await http("GET", path);
    if (missingRoute(r, { api: true })) return record({ name, method: "GET", path, http: r.status, ms: r.ms, status: "pending", detail: "route not deployed" });
    return verdict(name, "GET", path, r, r.status === 404 ? [] : [`status ${r.status}, expected 404`]);
  }

  const isPng = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isSvg = (bytes) => /<svg[\s>]/.test(bytes.subarray(0, 2048).toString("utf8"));
  const metaContent = (html, property) => html.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, "i"))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${property}"`, "i"))?.[1];
  const decodeEntities = (text) => text.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  // ------------------------------------------------------------------------------------------- pages

  await page("landing", "/", { contains: ["Owed"] });
  await page("unknown page is 404", `/smoke-missing-${Date.now().toString(36)}`, { expect: 404, pendingIfMissing: false });
  await page("pay page, unknown id", `/r/${UNKNOWN_ID}`, { expect: 404, mustExist: false });
  await page("ledger page, unknown id", `/l/${UNKNOWN_LEDGER_ID}`, { expect: 404, mustExist: false }); // F6 (0020)
  await page("pot page, unknown id", `/pot/${UNKNOWN_POT_ID}`, { expect: 404, mustExist: false }); // F7 (0019)
  await page("stateless pay page", `/p?u=${encodeURIComponent(fixtures["status-raw.req"].solana_pay_url)}`);

  // ------------------------------------------------------------------------------------------- API, read-only

  await api("stats", "GET", "/api/v1/stats", { expect: 200, shape: "statsRes" });
  await api("plans stats", "GET", "/api/v1/plans/stats", { expect: 200, shape: "planStatsRes" }); // F2 (0018)
  await api("get unknown id", "GET", `/api/v1/requests/${UNKNOWN_ID}`, {
    expect: 404, shape: "errorRes",
    refine: (json, problems) => { if (json.error.code !== "not_found") problems.push(`error code ${json.error.code}, expected not_found`); },
  });
  await api("get malformed id", "GET", "/api/v1/requests/bad_id-0OIl", {
    expect: [400, 404], shape: "errorRes",
    refine: (json, problems) => { if (!["invalid_input", "not_found"].includes(json.error.code)) problems.push(`error code ${json.error.code}`); },
  });
  const invalidCode = (json, problems) => { if (json.error.code !== "invalid_input") problems.push(`error code ${json.error.code}, expected invalid_input`); };
  await api("create rejects bad amount", "POST", "/api/v1/requests", {
    json: { ...fixtures["create-request.req"], amount: "1.2.3", source: "web" }, expect: 400, shape: "errorRes", refine: invalidCode,
  });
  await api("create rejects bad recipient", "POST", "/api/v1/requests", {
    json: { ...fixtures["create-request.req"], recipient: "0x3806c85df527e5336f05277ab8cc3932b9abe42a", source: "web" }, expect: 400, shape: "errorRes", refine: invalidCode,
  });
  await api("create rejects malformed JSON", "POST", "/api/v1/requests", { body: "{\"recipient\":", expect: 400, shape: "errorRes" });
  await api("status of unknown id", "POST", "/api/v1/status", {
    json: { ids: [UNKNOWN_ID] }, expect: 200, shape: "statusRes",
    refine: (json, problems) => {
      const item = json.results.find((entry) => entry.id === UNKNOWN_ID);
      if (!item) problems.push(`no result for ${UNKNOWN_ID}`);
      else if (item.status !== "not_found") problems.push(`status ${item.status}, expected not_found`);
    },
  });
  await api("status rejects 21 ids", "POST", "/api/v1/status", {
    json: { ids: Array.from({ length: 21 }, (_, index) => UNKNOWN_ID.slice(0, 9) + "123456789ABCDEFGHJKLMN"[index]) },
    expect: 400, shape: "errorRes", refine: invalidCode,
  });
  const raw = parseSolanaPayUrl(fixtures["status-raw.req"].solana_pay_url);
  await api("status-raw reads chain", "POST", "/api/v1/status-raw", {
    json: fixtures["status-raw.req"], expect: 200, shape: "statusRawRes",
    refine: (json, problems) => {
      if (!["open", "paid", "underpaid"].includes(json.status)) problems.push(`status ${json.status}, expected open|paid|underpaid`);
      if (json.amount_requested !== raw.amount) problems.push(`amount_requested ${json.amount_requested}, expected ${raw.amount}`);
      if (json.token !== raw.token) problems.push(`token ${json.token}, expected ${raw.token}`);
    },
  });
  await api("status-raw refuses transaction requests", "POST", "/api/v1/status-raw", {
    json: { solana_pay_url: "solana:https%3A%2F%2Fexample.com%2Fapi%2Fcheckout" }, expect: [200, 400],
    shape: (r) => (r.status === 200 ? "statusRawRes" : "errorRes"),
    refine: (json, problems, _warnings, r) => {
      if (r.status === 200 && json.status !== "invalid") problems.push(`status ${json.status}, expected invalid`);
      if (r.status === 400 && json.error.code !== "invalid_input") problems.push(`error code ${json.error.code}, expected invalid_input`);
    },
  });
  await expect404("QR, unknown id", `/api/qr/${UNKNOWN_ID}.png`);
  const notFoundCode = (json, problems) => { if (json.error.code !== "not_found") problems.push(`error code ${json.error.code}, expected not_found`); };
  await api("ledger, unknown id", "GET", `/api/v1/ledgers/${UNKNOWN_LEDGER_ID}`, { expect: 404, shape: "errorRes", refine: notFoundCode }); // F6 (0020)
  await api("ledger, malformed id", "GET", "/api/v1/ledgers/bad_id-0OIl", { expect: 400, shape: "errorRes", refine: invalidCode });
  await api("ledger create rejects a token account owner", "POST", "/api/v1/ledgers", {
    json: { ...fixtures["ledgers.create.req"], owner: TOKEN_ACCOUNT, source: "web" }, expect: 400, shape: "errorRes", refine: invalidCode,
  });
  await api("refund, unknown id", "GET", `/api/v1/refunds/${UNKNOWN_LEDGER_ID}`, { expect: 404, shape: "errorRes", refine: notFoundCode }); // F8 (0021)
  // F7 pots (0019): read-only and refused calls only; nothing is created.
  await api("pot, unknown id", "GET", `/api/v1/pots/${UNKNOWN_POT_ID}`, { expect: 404, shape: "errorRes", refine: notFoundCode });
  await api("pot, malformed id", "GET", "/api/v1/pots/bad_id-0OIl", { expect: 400, shape: "errorRes", refine: invalidCode });
  await api("pot create rejects a token account", "POST", "/api/v1/pots", {
    json: { ...fixtures["pots.create.req"], recipient: TOKEN_ACCOUNT, source: "web" }, expect: 400, shape: "errorRes", refine: invalidCode,
  });
  await api("pot x402 preset, unknown pot", "GET", `/x/pot/${UNKNOWN_POT_ID}/1`, { expect: 404, shape: "errorRes", refine: notFoundCode });

  // ------------------------------------------------------------------------------------------- one real request

  let target = id ? { id, created: null } : null;
  if (create) {
    const created = await api("create (real, 0.01 USDC to team wallet)", "POST", "/api/v1/requests", {
      json: SMOKE_REQUEST, expect: 201, shape: "createRequestRes",
      refine: (json, problems, warnings, r) => {
        const url = parseSolanaPayUrl(json.solana_pay_url);
        if (url.recipient !== TEAM_WALLET) problems.push(`solana_pay_url recipient ${url.recipient}, expected the team wallet`);
        if (url.amount !== SMOKE_AMOUNT) problems.push(`solana_pay_url amount ${url.amount}, expected ${SMOKE_AMOUNT}`);
        if (url.splToken !== USDC_MINT) problems.push("solana_pay_url spl-token is not the USDC mint");
        if (url.memo !== `owed:${json.id}`) problems.push(`solana_pay_url memo ${url.memo}, expected owed:${json.id}`);
        if (!json.flags.includes("brand_word:paybox")) problems.push(`flags ${JSON.stringify(json.flags)} lack brand_word:paybox`);
        if (r.ms > 3000) warnings.push(`took ${r.ms} ms; golden-path row 1 needs ≤ 3000 ms end to end`);
      },
    });
    if (created.status === "pass" || created.status === "warn") target = { id: created.response.json.id, created: created.response.json };
  }

  const pending = (name, why) => record({ name, method: "-", path: "-", status: "skip", detail: why });
  if (!target) {
    const why = create ? "create did not succeed" : "pass --create (writes one real request) or --id <id>";
    for (const name of ["get request", "status of request", "QR png", "QR svg", "pay page", "preview image"]) pending(name, why);
  } else {
    const { id: tid, created } = target;
    const got = await api("get request", "GET", `/api/v1/requests/${tid}`, {
      expect: 200, shape: "getRequestRes",
      refine: (json, problems) => {
        if (json.id !== tid) problems.push(`id ${json.id}, expected ${tid}`);
        if (!created) return;
        for (const [key, want] of [["recipient", TEAM_WALLET], ["amount", SMOKE_AMOUNT], ["token", "USDC"], ["status", "open"], ["reference", created.reference], ["solana_pay_url", created.solana_pay_url]]) {
          if (json[key] !== want) problems.push(`${key} ${JSON.stringify(json[key])}, expected ${JSON.stringify(want)}`);
        }
        if (json.for === null || !json.for.startsWith("smoke check")) problems.push(`for ${JSON.stringify(json.for)} lost the plain text`);
      },
    });
    const getStatus = got.response?.json?.status;
    await api("status of request", "POST", "/api/v1/status", {
      json: { ids: [tid] }, expect: 200, shape: "statusRes",
      refine: (json, problems) => {
        const item = json.results.find((entry) => entry.id === tid);
        if (!item) return void problems.push(`no result for ${tid}`);
        if (getStatus && item.status !== getStatus && !(getStatus === "open" && ["paid", "underpaid"].includes(item.status))) problems.push(`status ${item.status} disagrees with GET (${getStatus})`);
        if (got.response?.json && item.amount_requested !== got.response.json.amount) problems.push(`amount_requested ${item.amount_requested} disagrees with GET (${got.response.json.amount})`);
      },
    });
    const qrPath = created ? new URL(created.qr_url).pathname : `/api/qr/${tid}.png`;
    await image("QR png", qrPath, { type: "image/png", magic: isPng, minBytes: 200 });
    await image("QR png ?size=512", `${qrPath}?size=512`, { type: "image/png", magic: isPng, minBytes: 200 });
    await image("QR svg", qrPath.replace(/\.png$/, ".svg"), { type: "image/svg+xml", magic: isSvg, minBytes: 200 });
    const request = got.response?.json;
    const pay = await page("pay page", `/r/${tid}`, {
      contains: request ? [request.amount, request.token] : [],
      refine: (r, problems) => {
        if (!metaContent(r.text, "og:image")) problems.push("no og:image meta tag");
        if (!metaContent(r.text, "og:title")) problems.push("no og:title meta tag");
        if (created && r.text.includes("example.com")) problems.push("requester-written URL reached the page");
      },
    });
    const ogImage = pay.response && metaContent(pay.response.text, "og:image");
    if (ogImage) await image("preview image", decodeEntities(ogImage), { type: ["image/png", "image/jpeg"], minBytes: 1000 });
    else pending("preview image", "pay page has no og:image");
  }

  for (const extra of pages) await page(`page ${extra.length > 40 ? `${extra.slice(0, 37)}...` : extra}`, extra);

  const summary = { pass: 0, warn: 0, fail: 0, pending: 0, skip: 0 };
  for (const result of results) summary[result.status] += 1;
  return { base: origin, strict, create, startedAt: new Date().toISOString(), results, summary, ok: summary.fail === 0 };
}

// ----------------------------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = { strict: false, create: false, id: null, pages: [], json: false, timeoutMs: 10_000 };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--create") options.create = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--id") options.id = argv[++index];
    else if (arg === "--page") options.pages.push(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  options.base = rest[0] ?? process.env.OWED_BASE_URL;
  return options;
}

const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL", pending: "PEND", skip: "SKIP" };
function line(result) {
  const http = result.http === undefined ? "" : `${result.http || "ERR"} ${result.type ?? ""}`.trim();
  const timing = result.ms === undefined ? "" : `${result.ms}ms`;
  const where = result.method === "-" ? result.name : `${result.method.padEnd(4)} ${result.path.length > 48 ? `${result.path.slice(0, 45)}...` : result.path}`;
  const head = `${LABEL[result.status]}  ${where}`;
  const tail = [result.method === "-" ? "" : result.name, http, timing].filter(Boolean).join(" · ");
  const notes = [result.detail, ...(result.notes ?? [])].filter(Boolean).map((note) => `\n        ${note}`).join("");
  return `${head.padEnd(62)} ${tail}${notes}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help || !options.base) {
      console.log("usage: node web/scripts/smoke.mjs <baseUrl> [--strict] [--create] [--id <id>] [--page <path|url>]... [--json] [--timeout-ms N]");
      process.exit(options.help ? 0 : 2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (!options.json) console.log(`Owed smoke · ${new URL(options.base).origin} · ${options.strict ? "strict" : "pending allowed"}${options.create ? " · creates 1 real request" : ""}\n`);
  try {
    const report = await runSmoke({ ...options, log: options.json ? () => {} : (result) => console.log(line(result)) });
    if (options.json) console.log(JSON.stringify(report));
    else {
      const { pass, warn, fail, pending, skip } = report.summary;
      console.log(`\n${pass} pass · ${warn} warn · ${fail} fail · ${pending} pending · ${skip} skip → ${report.ok ? "OK" : "FAILED"}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`smoke could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
