// End-to-end contract check of a running deployment: every Tier-1 route, validated
// against the zod contract (lib/contract.ts), plus one real mainnet payment.
//
//   node --import ./test/setup.mjs scripts/check-api.ts http://localhost:3000
//   VERCEL_BYPASS=<protection bypass secret> node --import ./test/setup.mjs scripts/check-api.ts https://<preview>.vercel.app
//   VERCEL_SHARE_URL=<https://<preview>/?_vercel_share=…> node --import ./test/setup.mjs scripts/check-api.ts https://<preview>.vercel.app
//
// It creates two real open requests to the team wallet on the target's database, so
// it refuses production hosts unless --allow-production is passed.
import assert from "node:assert/strict";
import type { ZodType } from "zod";
import {
  CreateRequestResponse,
  ErrorResponse,
  GetRequestResponse,
  StatsResponse,
  StatusRawResponse,
  StatusResponse,
} from "../lib/contract";
import { parseTransferUrl } from "../lib/solana-pay";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: scripts/check-api.ts <base-url> [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["owed-omega.vercel.app", "owed.link", "www.owed.link"];
if (PRODUCTION_HOSTS.includes(new URL(base).hostname) && !process.argv.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production to create real requests there`);
  process.exit(2);
}

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// A real mainnet payment: 5 USDC into the team wallet's USDC account, created by the
// same transaction (2026-10-17). That account stands in for the reference key; it works
// while it has fewer than 10 newer transactions. After the golden path, swap in a real
// Owed payment's signature and reference.
const PAID_SIGNATURE = "44rMqgCKXeZbvpKQTFDDpVdVQ9zJimEgjDvUPsZ2pjmpRu5wjSo4dQ1uvGZgkN6xsxXi5Q1YbNwA3HwFR2iJ8Gbo";
const PAID_REFERENCE = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const PAID_PAYER = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS;
if (process.env.VERCEL_SHARE_URL) {
  // A temporary share link (…?_vercel_share=…) answers with a redirect that sets the auth cookie.
  const res = await fetch(process.env.VERCEL_SHARE_URL, { redirect: "manual" });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (cookies.length === 0) throw new Error(`share link did not set a cookie (HTTP ${res.status})`);
  headers.Cookie = cookies.join("; ");
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type, data, headers: res.headers };
}

function shape<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`shape mismatch: ${JSON.stringify(parsed.error.issues)} in ${JSON.stringify(data)}`);
  return parsed.data;
}

async function expectError(path: string, method: "GET" | "POST", body: unknown, status: number, code: string) {
  const r = await call(method, path, body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(shape(ErrorResponse, r.data).error.code, code);
}

let created: ReturnType<typeof CreateRequestResponse.parse> | undefined;

await check("POST /api/v1/requests creates a request (201, contract shape)", async () => {
  const r = await call("POST", "/api/v1/requests", {
    recipient: TEAM,
    amount: "1",
    token: "USDC",
    payer_name: "Contract check",
    for: "API contract check",
    requester_name: "Owed",
    source: "web",
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created = shape(CreateRequestResponse, r.data);
  assert.equal(created.link, `${base}/r/${created.id}`);
  assert.equal(created.qr_url, `${base}/api/qr/${created.id}.png`);
  const link = parseTransferUrl(created.solana_pay_url);
  assert.deepEqual(
    { recipient: link.recipient, amount: link.amount, splToken: link.splToken, references: link.references, memo: link.memo },
    { recipient: TEAM, amount: "1", splToken: USDC, references: [created.reference], memo: `owed:${created.id}` },
  );
});

await check("GET /api/v1/requests/:id returns it, still open", async () => {
  assert.ok(created, "create failed");
  const r = await call("GET", `/api/v1/requests/${created.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = shape(GetRequestResponse, r.data);
  assert.equal(got.status, "open");
  assert.equal(got.amount, "1");
  assert.equal(got.solana_pay_url, created.solana_pay_url);
  assert.equal(got.for, "API contract check");
  assert.equal(got.paid, null);
});

await check("POST /api/v1/status: open, invalid and not_found", async () => {
  assert.ok(created, "create failed");
  const r = await call("POST", "/api/v1/status", { ids: [created.id, "not-an-id", "1111111111"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { results } = shape(StatusResponse, r.data);
  assert.deepEqual(
    results.map((x) => x.status),
    ["open", "invalid", "not_found"],
  );
  assert.equal(results[0].amount_requested, "1");
  assert.equal(results[0].token, "USDC");
});

await check("POST /api/v1/status-raw: an unpaid link is open", async () => {
  assert.ok(created, "create failed");
  const r = await call("POST", "/api/v1/status-raw", { solana_pay_url: created.solana_pay_url });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(shape(StatusRawResponse, r.data), { status: "open", amount_requested: "1", token: "USDC" });
});

await check("POST /api/v1/status-raw: a real mainnet payment is paid", async () => {
  const url = `solana:${TEAM}?amount=5&spl-token=${USDC}&reference=${PAID_REFERENCE}`;
  const r = await call("POST", "/api/v1/status-raw", { solana_pay_url: url });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = shape(StatusRawResponse, r.data);
  assert.equal(got.status, "paid");
  assert.equal(got.amount_paid, "5");
  assert.equal(got.payer, PAID_PAYER);
  assert.equal(got.signature, PAID_SIGNATURE);
});

await check("POST /api/v1/status-raw: asking for more than arrived is underpaid", async () => {
  const url = `solana:${TEAM}?amount=6&spl-token=${USDC}&reference=${PAID_REFERENCE}`;
  const r = await call("POST", "/api/v1/status-raw", { solana_pay_url: url });
  const got = shape(StatusRawResponse, r.data);
  assert.equal(got.status, "underpaid");
  assert.equal(got.amount_paid, "5");
});

await check("GET /api/v1/stats", async () => {
  const r = await call("GET", "/api/v1/stats");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  shape(StatsResponse, r.data);
});

await check("GET /api/qr/:id.png and .svg", async () => {
  assert.ok(created, "create failed");
  const png = await call("GET", `/api/qr/${created.id}.png?size=256`);
  assert.equal(png.status, 200);
  assert.equal(png.type, "image/png");
  assert.deepEqual([...(png.data as Uint8Array).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const svg = await call("GET", `/api/qr/${created.id}.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.type, "image/svg+xml");
  assert.match(new TextDecoder().decode(svg.data as Uint8Array), /^<svg/);
});

await check("brand words are flagged and links stripped from requester text", async () => {
  const r = await call("POST", "/api/v1/requests", {
    recipient: TEAM,
    amount: "2.5",
    token: "USDC",
    for: "MoonPay refund https://evil.example.com/claim",
    source: "web",
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const made = shape(CreateRequestResponse, r.data);
  assert.deepEqual(made.flags, ["brand_word:moonpay", "brand_word:refund"]);
  const got = shape(GetRequestResponse, (await call("GET", `/api/v1/requests/${made.id}`)).data);
  assert.equal(got.for, "MoonPay refund");
});

await check("errors use the contract shape and codes", async () => {
  await expectError("/api/v1/requests", "POST", { recipient: TEAM, amount: "1.0000001", token: "USDC" }, 400, "invalid_input");
  await expectError("/api/v1/requests", "POST", { recipient: "0xabc", amount: "1" }, 400, "invalid_input");
  // A USDC token account (off-curve) pasted as the recipient.
  await expectError("/api/v1/requests", "POST", { recipient: "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x", amount: "1" }, 400, "invalid_input");
  await expectError("/api/v1/requests/1111111111", "GET", undefined, 404, "not_found");
  await expectError("/api/v1/requests/bad", "GET", undefined, 400, "invalid_input");
  await expectError("/api/v1/status", "POST", { ids: [] }, 400, "invalid_input");
  await expectError("/api/v1/status-raw", "POST", { solana_pay_url: "solana:https://merchant.example/pay" }, 400, "invalid_input");
  await expectError("/api/qr/1111111111.png", "GET", undefined, 404, "not_found");
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
