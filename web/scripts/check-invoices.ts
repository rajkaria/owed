// Live check of the invoice routes and the printable page on a running deployment, validated against
// lib/contract.ts and contract/shapes.mjs (which also re-derives the id and multiplies out every line).
//
//   node --import ./test/setup.mjs scripts/check-invoices.ts <base-url> --create            # new 3-line, 1 USDC invoice to the team wallet
//   node --import ./test/setup.mjs scripts/check-invoices.ts <base-url> --invoice <id>      # read-only: an existing invoice
//   VERCEL_SHARE_URL=<https://<preview>/?_vercel_share=…> or VERCEL_BYPASS=<secret> for protected previews.
//
// --create writes one real invoice (one open request) to the target's database, so it refuses
// production hosts unless --allow-production is passed. Nothing here signs or sends funds.
import assert from "node:assert/strict";
import type { ZodType } from "zod";
import { check as checkShape, shapes } from "../../contract/shapes.mjs";
import { ErrorResponse, GetRequestResponse, InvoiceResponse, StatusResponse } from "../lib/contract";

const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
const invoiceFlag = args.indexOf("--invoice");
const existing = invoiceFlag === -1 ? null : args[invoiceFlag + 1];
const create = args.includes("--create");
if (!/^https?:\/\//.test(base) || create === (existing !== null)) {
  console.error("usage: scripts/check-invoices.ts <base-url> (--create | --invoice <id>) [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["owed-omega.vercel.app", "owed.link", "www.owed.link"];
if (create && PRODUCTION_HOSTS.includes(new URL(base).hostname) && !args.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production to create a real invoice there`);
  process.exit(2);
}

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
// Invoice shapes are added to contract/shapes.mjs with Object.assign, so TypeScript can't see them on `shapes`.
const invoiceShape = (shapes as unknown as Record<"invoiceRes", Parameters<typeof checkShape>[0]>).invoiceRes;

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

/** The zod contract and the dependency-free shapes (id re-derived, lines multiplied out) must both accept it. */
function invoice(data: unknown) {
  const inv = shape(InvoiceResponse, data);
  const { errors } = checkShape(invoiceShape, data);
  assert.deepEqual(errors, [], errors.join("\n"));
  return inv;
}

async function expectError(path: string, method: "GET" | "POST", body: unknown, status: number, code: string) {
  const r = await call(method, path, body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(shape(ErrorResponse, r.data).error.code, code);
}

const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
let inv: ReturnType<typeof InvoiceResponse.parse> | undefined;

if (create) {
  await check("POST /api/v1/invoices creates a 3-line, 1 USDC invoice (201, contract shape, derived id)", async () => {
    const r = await call("POST", "/api/v1/invoices", {
      recipient: TEAM,
      token: "USDC",
      business_name: "Owed invoice check",
      client_name: "Check client",
      invoice_number: "CHECK-1",
      items: [
        { description: "Line one", quantity: "1", unit_price: "0.5" },
        { description: "Line two (hours)", quantity: "1.5", unit_price: "0.2" },
        { description: "Line three", quantity: "2", unit_price: "0.1" },
      ],
      due_date: inAWeek,
      notes: "Created by scripts/check-invoices.ts. Not meant to be paid.",
      source: "web",
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    inv = invoice(r.data);
    assert.equal(inv.link, `${base}/i/${inv.id}`);
    assert.equal(inv.total, "1");
    assert.deepEqual(inv.items.map((i) => i.amount), ["0.5", "0.3", "0.2"]);
    assert.equal(inv.status, "open");
  });
} else {
  await check(`GET /api/v1/invoices/${existing}`, async () => {
    const r = await call("GET", `/api/v1/invoices/${existing}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    inv = invoice(r.data);
  });
}

await check("GET /api/v1/invoices/:id round-trips the same terms and lines", async () => {
  assert.ok(inv, "no invoice");
  const r = await call("GET", `/api/v1/invoices/${inv.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const again = invoice(r.data);
  assert.deepEqual([again.reference, again.solana_pay_url, again.total, again.items], [inv.reference, inv.solana_pay_url, inv.total, inv.items]);
  inv = again;
});

await check("POST /api/v1/status takes the invoice id (what check_payments sends)", async () => {
  assert.ok(inv, "no invoice");
  const r = await call("POST", "/api/v1/status", { ids: [inv.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [result] = shape(StatusResponse, r.data).results;
  assert.equal(result.id, inv.id);
  assert.equal(result.status, inv.status);
  assert.equal(result.amount_requested, inv.total);
});

await check("GET /api/v1/requests/:id is the invoice's payment request (kind invoice, same terms)", async () => {
  assert.ok(inv, "no invoice");
  const r = await call("GET", `/api/v1/requests/${inv.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = shape(GetRequestResponse, r.data);
  assert.equal(got.kind, "invoice");
  assert.equal(got.recipient, inv.recipient);
  assert.equal(got.amount, inv.total);
  assert.equal(got.solana_pay_url, inv.solana_pay_url);
  assert.ok((got.requester_name ?? "").length <= 40 && (got.payer_name ?? "").length <= 40, "request caps hold");
});

await check("GET /i/:id renders the printable invoice", async () => {
  assert.ok(inv, "no invoice");
  const r = await call("GET", `/i/${inv.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith("text/html"), r.type);
  const html = r.data as string;
  assert.match(html, /noindex/);
  assert.match(html, new RegExp(`<title>Invoice for ${inv.total.replace(".", "\\.")} ${inv.token}</title>`));
  assert.match(html, /@page/, "print CSS");
  assert.ok(html.includes(inv.solana_pay_url.replace(/&/g, "&amp;")), "wallet button carries the solana: URL");
  if (inv.invoice_number) assert.ok(html.includes(inv.invoice_number), "invoice number");
  if (inv.status === "paid" && inv.paid) assert.ok(html.includes(`tx ${inv.paid.signature.slice(0, 4)}`), "Paid stamp names the transaction");
});

await check("GET /i/:id/opengraph-image is a PNG", async () => {
  assert.ok(inv, "no invoice");
  const r = await call("GET", `/i/${inv.id}/opengraph-image`);
  assert.equal(r.status, 200);
  assert.equal(r.type, "image/png");
  assert.deepEqual([...(r.data as Uint8Array).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

await check("errors use the contract shape and codes", async () => {
  const body = { recipient: TEAM, business_name: "x", client_name: "y", due_date: inAWeek, items: [{ description: "z", unit_price: "1" }] };
  await expectError("/api/v1/invoices", "POST", { ...body, items: [] }, 400, "invalid_input");
  await expectError("/api/v1/invoices", "POST", { ...body, items: [{ description: "z", quantity: "1.5", unit_price: "0.000001" }] }, 400, "invalid_input");
  await expectError("/api/v1/invoices", "POST", { ...body, due_date: "2020-01-01" }, 400, "invalid_input");
  await expectError("/api/v1/invoices/HHHHHHHHHHHH", "GET", undefined, 404, "not_found");
  await expectError("/api/v1/invoices/bad", "GET", undefined, 400, "invalid_input");
});

if (inv) {
  console.log(`\ninvoice ${inv.id} · ${inv.status} · ${inv.total} ${inv.token} · due ${inv.due_date} · ${inv.items.length} lines`);
  console.log(`page    ${inv.link}`);
  console.log(`pay     ${inv.solana_pay_url}`);
  if (inv.paid) console.log(`paid    ${inv.paid.amount} ${inv.token} from ${inv.paid.payer} at ${inv.paid.at}\n        https://solscan.io/tx/${inv.paid.signature}`);
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
