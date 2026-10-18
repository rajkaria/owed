#!/usr/bin/env node
// W2-G: every Owed HTTP route with wrong methods and fuzzed bodies, against a live deployment.
// Nothing here creates a row: every write is malformed on purpose (the few that could pass use the
// QA wallet, which nobody pays). Generic checks on every answer: no 5xx, API errors are the contract's
// {error:{code,message}}, no stack traces or server paths leak, API answers are not cacheable.
//
//   command node e2e/qa/hostile/api-fuzz.mjs [base-url] [--json] [--only substring]
//   base-url defaults to https://www.getowed.xyz
const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("https://")) ?? "https://www.getowed.xyz").replace(/\/+$/, "");
const asJson = args.includes("--json");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const QA = "B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp"; // QA wallet, no funds
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const TEAM_USDC_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // the team wallet's USDC account: off-curve
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OPEN_ID = "3sUaVYuB3nzV"; // LEAD's production request (0.01 USDC, verified getowed.xyz)
const GROUP_ID = "GuRPADHGLGiu";
const INVOICE_ID = "SuVNtmmeBt9b";
const REF = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";

const deep = (n) => "[".repeat(n) + "]".repeat(n);
const req = (o) => JSON.stringify({ recipient: QA, amount: "0.01", source: "web", ...o });
const group = (o) => JSON.stringify({ recipient: QA, total: "1", token: "USDC", title: "QA", people: [{ name: "A" }, { name: "B" }], source: "web", ...o });
const inv = (o) => JSON.stringify({
  recipient: QA, token: "USDC", business_name: "QA", client_name: "QA", due_date: "2026-11-01",
  items: [{ description: "x", quantity: "1", unit_price: "0.01" }], source: "web", ...o,
});
const item = (q, p) => ({ description: "line", quantity: q, unit_price: p });

/** [name, method, path, body?, expectStatus (number | number[]), expectCode?, headers?] */
const CASES = [
  // --- wrong methods
  ...["GET", "PUT", "DELETE", "PATCH"].map((m) => [`requests ${m}`, m, "/api/v1/requests", undefined, 405]),
  ...["POST", "PUT", "DELETE"].map((m) => [`requests/:id ${m}`, m, `/api/v1/requests/${OPEN_ID}`, m === "POST" ? "{}" : undefined, 405]),
  ...["GET", "PUT"].map((m) => [`status ${m}`, m, "/api/v1/status", undefined, 405]),
  ["status-raw GET", "GET", "/api/v1/status-raw", undefined, 405],
  ["stats POST", "POST", "/api/v1/stats", "{}", 405],
  ["groups GET", "GET", "/api/v1/groups", undefined, 405],
  ["groups/:id POST", "POST", `/api/v1/groups/${GROUP_ID}`, "{}", 405],
  ["invoices GET", "GET", "/api/v1/invoices", undefined, 405],
  ["invoices/:id DELETE", "DELETE", `/api/v1/invoices/${INVOICE_ID}`, undefined, 405],
  ["qr POST", "POST", `/api/qr/${OPEN_ID}.png`, "{}", 405],
  ["x402 PUT", "PUT", `/x/${OPEN_ID}`, "{}", 405],
  ["x402 DELETE", "DELETE", `/x/${OPEN_ID}`, undefined, 405],

  // --- body shape (POST /requests)
  ["requests: not JSON", "POST", "/api/v1/requests", "hello", 400, "invalid_input"],
  ["requests: empty body", "POST", "/api/v1/requests", "", 400, "invalid_input"],
  ["requests: null", "POST", "/api/v1/requests", "null", 400, "invalid_input"],
  ["requests: array", "POST", "/api/v1/requests", "[]", 400, "invalid_input"],
  ["requests: number", "POST", "/api/v1/requests", "1", 400, "invalid_input"],
  ["requests: {}", "POST", "/api/v1/requests", "{}", 400, "invalid_input"],
  ["requests: 17 KB", "POST", "/api/v1/requests", req({ note: "x".repeat(17_000) }), 400, "invalid_input"],
  ["requests: 1 MB", "POST", "/api/v1/requests", "x".repeat(1_000_000), [400, 413], undefined],
  ["requests: nesting 5000", "POST", "/api/v1/requests", deep(5000), 400, "invalid_input"],
  ["requests: __proto__", "POST", "/api/v1/requests", `{"__proto__":{"recipient":"${QA}"},"constructor":{"prototype":{"x":1}}}`, 400, "invalid_input"],
  ["requests: lone surrogate in text", "POST", "/api/v1/requests", req({ amount: "x", for: "\ud800" }), 400, "invalid_input"],
  // --- recipient
  ["requests: recipient not base58", "POST", "/api/v1/requests", req({ recipient: "0OIl" + QA.slice(4) }), 400, "invalid_input"],
  ["requests: recipient 31 bytes", "POST", "/api/v1/requests", req({ recipient: "1111111111111111111111111111111" }), 400, "invalid_input"],
  ["requests: recipient 64 chars", "POST", "/api/v1/requests", req({ recipient: QA + QA.slice(0, 20) }), 400, "invalid_input"],
  ["requests: recipient a token account (off-curve)", "POST", "/api/v1/requests", req({ recipient: TEAM_USDC_ATA }), 400, "invalid_input"],
  ["requests: recipient number", "POST", "/api/v1/requests", req({ recipient: 12 }), 400, "invalid_input"],
  // --- amount
  ...["0", "-1", "1e3", "0x10", " 1", "1 ", "01", "1.", ".5", "١", "１", "0.0000001", "18446744073709.551616", "NaN", "Infinity", "1,5", "9".repeat(41)]
    .map((a) => [`requests: amount ${JSON.stringify(a).slice(0, 30)}`, "POST", "/api/v1/requests", req({ amount: a }), 400, "invalid_input"]),
  ["requests: amount number", "POST", "/api/v1/requests", req({ amount: 1 }), 400, "invalid_input"],
  ["requests: SOL 10 decimals", "POST", "/api/v1/requests", req({ amount: "0.0000000001", token: "SOL" }), 400, "invalid_input"],
  // --- token / enums
  ...["usdc", "BONK", "", null, 1].map((t) => [`requests: token ${JSON.stringify(t)}`, "POST", "/api/v1/requests", req({ token: t, amount: "x" }), 400, "invalid_input"]),
  ["requests: kind invoice", "POST", "/api/v1/requests", req({ kind: "invoice", amount: "x" }), 400, "invalid_input"],
  ["requests: source evil", "POST", "/api/v1/requests", req({ source: "evil", amount: "x" }), 400, "invalid_input"],
  ["requests: for 321 chars", "POST", "/api/v1/requests", req({ for: "x".repeat(321) }), 400, "invalid_input"],
  ["requests: for object", "POST", "/api/v1/requests", req({ for: { toString: "x" } }), 400, "invalid_input"],
  ["requests: from_domain 254", "POST", "/api/v1/requests", req({ from_domain: "a".repeat(250) + ".com" }), 400, "invalid_input"],
  ["requests: from_domain IP", "POST", "/api/v1/requests", req({ from_domain: "169.254.169.254" }), 400, "invalid_input"],
  ["requests: from_domain URL", "POST", "/api/v1/requests", req({ from_domain: "https://getowed.xyz/x" }), 400, "invalid_input"],
  ["requests: from_domain unpublished", "POST", "/api/v1/requests", req({ from_domain: "getowed.xyz" }), 400, "invalid_input"],
  ["requests: from_domain localhost", "POST", "/api/v1/requests", req({ from_domain: "localhost" }), 400, "invalid_input"],
  ["requests: from_domain NUL", "POST", "/api/v1/requests", req({ from_domain: "getowed.xyz\u0000.evil.com" }), 400, "invalid_input"],

  // --- GET /requests/:id
  ...["", "abc", "3sUaVYuB3nz", "3sUaVYuB3nzVV", "3sUaVYuB3nz0", "..%2F..%2Fetc", "%00", "x".repeat(1000), "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ", "3sUaVYuB3nzV%20"]
    .map((id) => [`requests/:id ${JSON.stringify(id).slice(0, 24)}`, "GET", `/api/v1/requests/${id}`, undefined, id === "" ? [404, 405] : [400, 404], undefined]),
  ["requests/:id unknown valid", "GET", "/api/v1/requests/111111111111", undefined, 404, "not_found"],

  // --- POST /status
  ["status: ids empty", "POST", "/api/v1/status", JSON.stringify({ ids: [] }), 400, "invalid_input"],
  ["status: 21 ids", "POST", "/api/v1/status", JSON.stringify({ ids: Array(21).fill(OPEN_ID) }), 400, "invalid_input"],
  ["status: id 65 chars", "POST", "/api/v1/status", JSON.stringify({ ids: ["x".repeat(65)] }), 400, "invalid_input"],
  ["status: ids not strings", "POST", "/api/v1/status", JSON.stringify({ ids: [1, null] }), 400, "invalid_input"],
  ["status: ids string", "POST", "/api/v1/status", JSON.stringify({ ids: OPEN_ID }), 400, "invalid_input"],
  ["status: 20× same id", "POST", "/api/v1/status", JSON.stringify({ ids: Array(20).fill(OPEN_ID) }), 200],
  ["status: invalid + unknown", "POST", "/api/v1/status", JSON.stringify({ ids: ["bad", "111111111111"] }), 200],

  // --- POST /status-raw
  ["status-raw: transaction request", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: "solana:https://evil.example/tx" }), 400, "invalid_input"],
  ["status-raw: no reference", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?amount=1` }), 400, "invalid_input"],
  ["status-raw: other mint", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?amount=1&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB&reference=${REF}` }), 400, "invalid_input"],
  ["status-raw: 7 decimals", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?amount=0.0000001&spl-token=${USDC}&reference=${REF}` }), 400, "invalid_input"],
  ["status-raw: 2049 chars", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?message=${"x".repeat(2000)}` }), 400, "invalid_input"],
  ["status-raw: javascript:", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: "javascript:alert(1)" }), 400, "invalid_input"],
  ["status-raw: 6 references", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?amount=1` + `&reference=${REF}`.repeat(6) }), [200, 400]],
  ["status-raw: valid unused", "POST", "/api/v1/status-raw", JSON.stringify({ solana_pay_url: `solana:${QA}?amount=0.01&spl-token=${USDC}&reference=${REF}` }), 200],

  // --- groups
  ["groups: 1 person", "POST", "/api/v1/groups", group({ people: [{ name: "A" }] }), 400, "invalid_input"],
  ["groups: 21 people", "POST", "/api/v1/groups", group({ people: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` })) }), 400, "invalid_input"],
  ["groups: total 0", "POST", "/api/v1/groups", group({ total: "0" }), 400, "invalid_input"],
  ["groups: amounts exceed total", "POST", "/api/v1/groups", group({ people: [{ name: "A", amount: "2" }, { name: "B" }] }), 400, "invalid_input"],
  ["groups: amounts != total", "POST", "/api/v1/groups", group({ people: [{ name: "A", amount: "0.3" }, { name: "B", amount: "0.3" }] }), 400, "invalid_input"],
  ["groups: total too small for 20", "POST", "/api/v1/groups", group({ total: "0.000019", people: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}` })) }), 400, "invalid_input"],
  ["groups: name empty", "POST", "/api/v1/groups", group({ people: [{ name: "" }, { name: "B" }] }), 400, "invalid_input"],
  ["groups: people not array", "POST", "/api/v1/groups", group({ people: "A,B" }), 400, "invalid_input"],
  ["groups/:id bad", "GET", "/api/v1/groups/../../x", undefined, [400, 404]],
  ["groups/:id unknown", "GET", "/api/v1/groups/111111111111", undefined, 404, "not_found"],

  // --- invoices
  ["invoices: 0 items", "POST", "/api/v1/invoices", inv({ items: [] }), 400, "invalid_input"],
  ["invoices: 21 items", "POST", "/api/v1/invoices", inv({ items: Array(21).fill(item("1", "0.01")) }), 400, "invalid_input"],
  ["invoices: due in the past", "POST", "/api/v1/invoices", inv({ due_date: "2020-01-01" }), 400, "invalid_input"],
  ["invoices: due 2026-02-30", "POST", "/api/v1/invoices", inv({ due_date: "2026-02-30" }), 400, "invalid_input"],
  ["invoices: due 2099", "POST", "/api/v1/invoices", inv({ due_date: "2099-01-01" }), 400, "invalid_input"],
  ["invoices: due not ISO", "POST", "/api/v1/invoices", inv({ due_date: "11/01/2026" }), 400, "invalid_input"],
  ["invoices: quantity 5 decimals", "POST", "/api/v1/invoices", inv({ items: [item("1.23456", "1")] }), 400, "invalid_input"],
  ["invoices: quantity 0", "POST", "/api/v1/invoices", inv({ items: [item("0", "1")] }), 400, "invalid_input"],
  ["invoices: quantity -1", "POST", "/api/v1/invoices", inv({ items: [item("-1", "1")] }), 400, "invalid_input"],
  ["invoices: quantity 1000001", "POST", "/api/v1/invoices", inv({ items: [item("1000001", "1")] }), 400, "invalid_input"],
  ["invoices: inexact q×p", "POST", "/api/v1/invoices", inv({ items: [item("1.5", "0.000001")] }), 400, "invalid_input"],
  ["invoices: total > u64", "POST", "/api/v1/invoices", inv({ items: Array(20).fill(item("1000000", "18446744073709.551615")) }), 400, "invalid_input"],
  ["invoices: unit price 0", "POST", "/api/v1/invoices", inv({ items: [item("1", "0")] }), 400, "invalid_input"],
  ["invoices: number 21 chars", "POST", "/api/v1/invoices", inv({ invoice_number: "x".repeat(21) }), 400, "invalid_input"],
  ["invoices/:id unknown", "GET", "/api/v1/invoices/111111111111", undefined, 404, "not_found"],
  ["invoices/:id bad", "GET", "/api/v1/invoices/abc", undefined, [400, 404]],

  // --- qr
  ["qr: gif", "GET", `/api/qr/${OPEN_ID}.gif`, undefined, 404],
  ["qr: no ext", "GET", `/api/qr/${OPEN_ID}`, undefined, 404],
  ["qr: unknown id", "GET", "/api/qr/111111111111.png", undefined, 404, "not_found"],
  ["qr: size 99999", "GET", `/api/qr/${OPEN_ID}.png?size=99999`, undefined, 200],
  ["qr: size -5", "GET", `/api/qr/${OPEN_ID}.svg?size=-5`, undefined, 200],
  ["qr: size abc", "GET", `/api/qr/${OPEN_ID}.svg?size=abc`, undefined, 200],

  // --- x402
  ["x402: bad id", "GET", "/x/abc", undefined, 400, "invalid_input"],
  ["x402: unknown id", "GET", "/x/111111111111", undefined, 404, "not_found"],
  ["x402: open → 402", "GET", `/x/${OPEN_ID}`, undefined, 402],
  ["x402: garbage PAYMENT-SIGNATURE", "POST", `/x/${OPEN_ID}`, "", 402, undefined, { "PAYMENT-SIGNATURE": "not-base64!!" }],
  ["x402: base64 non-JSON X-PAYMENT", "POST", `/x/${OPEN_ID}`, "", 402, undefined, { "X-PAYMENT": Buffer.from("hello").toString("base64") }],
  ["x402: wrong amount payload", "POST", `/x/${OPEN_ID}`, "", 402, undefined, {
    "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: USDC, payTo: QA, amount: "1" }, payload: { transaction: "AAAA" } })).toString("base64"),
  }],
  ["x402: 70 KB body", "POST", `/x/${OPEN_ID}`, "x".repeat(70_000), 400, "invalid_input"],
  ["x402: OPTIONS", "OPTIONS", `/x/${OPEN_ID}`, undefined, 204],
];

const LEAKS = [/\bat [\w.<>]+ \(/, /node_modules/, /\/var\/task/, /\.next\/server/, /TypeError|ReferenceError|SyntaxError/, /DATABASE_URL|postgres:\/\//i, /api-key=/i];

async function run([name, method, path, body, expect, code, headers = {}]) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method, body, redirect: "manual",
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { name, method, path, ok: false, problems: [`fetch failed: ${e.message}`], ms: Date.now() - started };
  }
  const text = await res.text();
  const ms = Date.now() - started;
  const problems = [];
  const want = Array.isArray(expect) ? expect : [expect];
  if (!want.includes(res.status)) problems.push(`status ${res.status}, expected ${want.join("|")}`);
  if (res.status >= 500) problems.push(`5xx ${res.status}`);
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const isApi = path.startsWith("/api/") || path.startsWith("/x/");
  if (isApi && res.status >= 400 && res.status !== 405 && res.status !== 413 && res.status !== 402) {
    if (!json?.error || typeof json.error.code !== "string" || typeof json.error.message !== "string") problems.push(`error body off contract: ${text.slice(0, 120)}`);
    else if (code && json.error.code !== code) problems.push(`code ${json.error.code}, expected ${code}`);
  }
  for (const re of LEAKS) if (re.test(text)) problems.push(`leak ${re}: ${text.match(re)?.[0]}`);
  const cc = res.headers.get("cache-control") ?? "";
  if (isApi && !path.startsWith("/api/qr/") && res.status !== 405 && !/no-store|private/.test(cc)) problems.push(`cacheable: cache-control "${cc}"`);
  return { name, method, path: path.slice(0, 80), status: res.status, ms, ok: problems.length === 0, problems, message: json?.error?.message?.slice(0, 140), allow: res.headers.get("allow") };
}

const cases = CASES.filter((c) => !only || c[0].includes(only));
const results = [];
for (const c of cases) results.push(await run(c));
if (asJson) console.log(JSON.stringify({ base, results }, null, 1));
else {
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${String(r.status ?? "-").padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.name}${r.ok ? "" : `  ← ${r.problems.join("; ")}`}${r.message ? `  [${r.message}]` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} as expected on ${base}`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
