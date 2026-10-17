// Live check of the split-bill routes and board on a running deployment, validated against
// lib/contract.ts and contract/shapes.mjs (which also re-derives every share and group id).
//
//   node --import ./test/setup.mjs scripts/check-groups.ts <base-url> --create        # new 3 × 0.5 USDC group to the team wallet
//   node --import ./test/setup.mjs scripts/check-groups.ts <base-url> --group <id>    # read-only: an existing group
//   VERCEL_SHARE_URL=<https://<preview>/?_vercel_share=…> or VERCEL_BYPASS=<secret> for protected previews.
//
// --create writes one real group (3 open requests) to the target's database, so it refuses
// production hosts unless --allow-production is passed. Nothing here signs or sends funds.
import assert from "node:assert/strict";
import type { ZodType } from "zod";
import { check as checkShape, shapes } from "../../contract/shapes.mjs";
import { ErrorResponse, GetRequestResponse, GroupResponse, StatusResponse } from "../lib/contract";

const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
const groupFlag = args.indexOf("--group");
const existing = groupFlag === -1 ? null : args[groupFlag + 1];
const create = args.includes("--create");
if (!/^https?:\/\//.test(base) || create === (existing !== null)) {
  console.error("usage: scripts/check-groups.ts <base-url> (--create | --group <id>) [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["owed-omega.vercel.app", "owed.link", "www.owed.link"];
if (create && PRODUCTION_HOSTS.includes(new URL(base).hostname) && !args.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production to create a real group there`);
  process.exit(2);
}

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

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
  const data = type.includes("json") ? await res.json() : type.startsWith("text/") ? await res.text() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type, data };
}

function shape<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`shape mismatch: ${JSON.stringify(parsed.error.issues)} in ${JSON.stringify(data)}`);
  return parsed.data;
}

/** The zod contract and the dependency-free shapes (ids re-derived from the terms) must both accept it. */
function group(data: unknown) {
  const g = shape(GroupResponse, data);
  const { errors } = checkShape(shapes.groupRes, data);
  assert.deepEqual(errors, [], errors.join("\n"));
  return g;
}

async function expectError(path: string, method: "GET" | "POST", body: unknown, status: number, code: string) {
  const r = await call(method, path, body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(shape(ErrorResponse, r.data).error.code, code);
}

let g: ReturnType<typeof GroupResponse.parse> | undefined;

if (create) {
  await check("POST /api/v1/groups creates 3 × 0.5 USDC (201, contract shape, derived ids)", async () => {
    const r = await call("POST", "/api/v1/groups", {
      recipient: TEAM,
      total: "1.5",
      token: "USDC",
      title: "Split check",
      people: [{ name: "Payer one" }, { name: "Payer two" }, { name: "Payer three" }],
      requester_name: "Owed",
      source: "web",
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    g = group(r.data);
    assert.equal(g.link, `${base}/g/${g.id}`);
    assert.deepEqual(g.shares.map((s) => [s.name, s.amount, s.status]), [
      ["Payer one", "0.5", "open"], ["Payer two", "0.5", "open"], ["Payer three", "0.5", "open"],
    ]);
    assert.equal(g.paid_count, 0);
  });
} else {
  await check(`GET /api/v1/groups/${existing}`, async () => {
    const r = await call("GET", `/api/v1/groups/${existing}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    g = group(r.data);
  });
}

await check("GET /api/v1/groups/:id round-trips the same shares in board order", async () => {
  assert.ok(g, "no group");
  const r = await call("GET", `/api/v1/groups/${g.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const again = group(r.data);
  assert.deepEqual(again.shares.map((s) => [s.id, s.reference, s.solana_pay_url]), g.shares.map((s) => [s.id, s.reference, s.solana_pay_url]));
  g = again;
});

await check("POST /api/v1/status takes the share ids (what check_payments sends)", async () => {
  assert.ok(g, "no group");
  const r = await call("POST", "/api/v1/status", { ids: g.shares.map((s) => s.id) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { results } = shape(StatusResponse, r.data);
  assert.deepEqual(results.map((x) => x.id), g.shares.map((s) => s.id));
  assert.deepEqual(results.map((x) => x.status), g.shares.map((s) => s.status));
});

await check("GET /api/v1/requests/:share is a split_share with the group's terms", async () => {
  assert.ok(g, "no group");
  const share = g.shares[0];
  const r = await call("GET", `/api/v1/requests/${share.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = shape(GetRequestResponse, r.data);
  assert.equal(got.kind, "split_share");
  assert.equal(got.recipient, g.recipient);
  assert.equal(got.amount, share.amount);
  assert.equal(got.solana_pay_url, share.solana_pay_url);
});

await check("GET /g/:id renders the board with the live count", async () => {
  assert.ok(g, "no group");
  const r = await call("GET", `/g/${g.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith("text/html"), r.type);
  const html = r.data as string;
  assert.match(html, new RegExp(`${g.paid_count} of ${g.share_count} paid`));
  assert.match(html, /noindex/);
  for (const share of g.shares) assert.ok(html.includes(`/r/${share.id}`), `board links /r/${share.id}`);
});

await check("GET /g/:id/opengraph-image is a PNG", async () => {
  assert.ok(g, "no group");
  const r = await call("GET", `/g/${g.id}/opengraph-image`);
  assert.equal(r.status, 200);
  assert.equal(r.type, "image/png");
  assert.deepEqual([...(r.data as Uint8Array).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

await check("errors use the contract shape and codes", async () => {
  await expectError("/api/v1/groups", "POST", { recipient: TEAM, total: "1", title: "x", people: [{ name: "Solo" }] }, 400, "invalid_input");
  await expectError("/api/v1/groups", "POST", { recipient: TEAM, total: "1", title: "x", people: [{ name: "A", amount: "2" }, { name: "B" }] }, 400, "invalid_input");
  await expectError("/api/v1/groups", "POST", { recipient: TEAM, total: "1", title: "x", people: [{ name: "A" }, { name: "B" }], from_domain: "example.com" }, 400, "invalid_input");
  await expectError("/api/v1/groups/HHHHHHHHHHHH", "GET", undefined, 404, "not_found");
  await expectError("/api/v1/groups/bad", "GET", undefined, 400, "invalid_input");
});

if (g) {
  console.log(`\ngroup ${g.id} · ${g.paid_count} of ${g.share_count} paid · ${g.amount_received} of ${g.total} ${g.token} received`);
  console.log(`board  ${g.link}`);
  for (const s of g.shares) console.log(`share  ${s.id} ${s.status.padEnd(9)} ${s.amount} ${g.token}  ${s.link}\n       ${s.solana_pay_url}`);
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
