import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayments, inputSchema, outputSchema, type CheckOutput } from "../src/tools/check_payments.ts";
import { fixture, json, makeDeps, RECIPIENT, REFERENCE, SENDER, SIGNATURE, textOf, USDC_MINT } from "./helpers.ts";

const statusFixture = fixture("status.res.json");
const rawUrl = fixture("status-raw.req.json").solana_pay_url as string; // 1 USDC to the team wallet with a reference
const PAID = statusFixture.results[0];

function out(result: Awaited<ReturnType<typeof checkPayments>>): CheckOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  const o = (result as { structuredContent: CheckOutput }).structuredContent;
  outputSchema.parse(o);
  return o;
}
const row = (id: string, status: string, amount: string, paid?: string, token = "USDC") => ({
  id, status, amount_requested: amount, token,
  ...(paid && { amount_paid: paid, payer: SENDER, signature: SIGNATURE, paid_at: "2026-10-17T05:00:09Z" }),
});

test("owed ids and links: one batched status call, SPEC-style summary and a line per payment", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, statusFixture) } });
  const result = await checkPayments({ requests: ["JArQ6g9JvoWr", " https://owed.link/r/Bq3wL8mNc2 ", "JArQ6g9JvoWr"] }, deps);
  const o = out(result);
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0]!.body, { ids: ["JArQ6g9JvoWr", "Bq3wL8mNc2"] });
  assert.deepEqual(o.results[0], {
    input: "JArQ6g9JvoWr", id: "JArQ6g9JvoWr", status: "paid", amount_requested: "15", token: "USDC",
    amount_paid: "15", payer: PAID.payer, signature: SIGNATURE, paid_at: PAID.paid_at, explorer_url: `https://solscan.io/tx/${SIGNATURE}`,
  });
  assert.deepEqual(o.results[1], { input: "https://owed.link/r/Bq3wL8mNc2", id: "Bq3wL8mNc2", status: "open", amount_requested: "4.5", token: "USDC" });
  assert.equal(o.results[2]!.status, "paid");
  // JArQ6g9JvoWr is listed twice: one result per input, but it counts once in the summary (QA-10).
  assert.equal(o.summary, "1 of 2 paid · 15 USDC received · 4.5 USDC outstanding");
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], o.summary);
  assert.equal(lines[1], `Paid, request JArQ6g9JvoWr: 15 USDC from 9WzD…AWWM: https://solscan.io/tx/${SIGNATURE}`);
});

test("summary matches the SPEC example", async () => {
  const body = { results: [row("JArQ6g9JvoWr", "paid", "15", "15"), row("Bq3wL8mNc2", "paid", "15", "15"), row("Cq3wL8mNc2", "open", "15")] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, body) } });
  const o = out(await checkPayments({ requests: ["JArQ6g9JvoWr", "Bq3wL8mNc2", "Cq3wL8mNc2"] }, deps));
  assert.equal(o.summary, "2 of 3 paid · 30 USDC received · 15 USDC outstanding");
});

test("underpaid, mixed tokens, cancelled and missing ids are all accounted for", async () => {
  const body = { results: [
    row("JArQ6g9JvoWr", "underpaid", "15", "10"),
    row("Bq3wL8mNc2", "paid", "0.5", "0.5", "SOL"),
    row("Cq3wL8mNc2", "open", "0.25", undefined, "SOL"),
    row("Dq3wL8mNc2", "cancelled", "3"),
  ] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, body) } });
  const result = await checkPayments({ requests: ["JArQ6g9JvoWr", "Bq3wL8mNc2", "Cq3wL8mNc2", "Dq3wL8mNc2", "Eq3wL8mNc2"] }, deps);
  const o = out(result);
  assert.equal(o.summary, "1 of 5 paid · 10 USDC + 0.5 SOL received · 5 USDC + 0.25 SOL outstanding · 1 underpaid · 1 cancelled · 1 not found");
  assert.deepEqual(o.results[4], { input: "Eq3wL8mNc2", id: "Eq3wL8mNc2", status: "not_found", amount_requested: null, token: null, error: "No Owed request has this id." });
  assert.match(textOf(result), /Underpaid, request JArQ6g9JvoWr: 10 of 15 USDC from 9WzD…AWWM: https:\/\/solscan\.io\/tx\//);
});

test("open requests report how long they have waited when the API sends created_at", async () => {
  const body = { results: [{ ...row("Bq3wL8mNc2", "open", "4.5"), created_at: "2026-10-17T05:00:00Z" }] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, body) } });
  const result = await checkPayments({ requests: ["Bq3wL8mNc2"] }, deps);
  assert.equal(out(result).results[0]!.waited, "2h 14m");
  assert.match(textOf(result), /Open, request Bq3wL8mNc2: 4\.5 USDC, waiting 2h 14m/);
});

test("raw Solana Pay URLs go to the API's status-raw first", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/status-raw": () => json(200, fixture("status-raw.res.json")) } });
  const o = out(await checkPayments({ requests: [rawUrl] }, deps));
  assert.deepEqual(o.results[0], { input: rawUrl, status: "open", amount_requested: "1", token: "USDC" });
  assert.equal(rec.findPayment.length, 0);
  const sent = (rec.calls[0]!.body as { solana_pay_url: string }).solana_pay_url;
  const reparsed = deps.parseLink(sent, []);
  assert.ok(reparsed.kind === "transfer" && reparsed.request.references[0] === REFERENCE && reparsed.request.recipient === RECIPIENT);
  assert.equal(o.summary, "0 of 1 paid · 1 USDC outstanding");
});

test("API down: raw URLs are checked on-chain directly; Owed ids report unknown", async () => {
  const { deps, rec } = makeDeps({
    routes: { "POST *": () => "network_error" },
    findPayment: async () => ({ status: "paid", signature: SIGNATURE, payer: SENDER, amountPaidAtomic: 1_000_000n, paidAt: "2026-10-17T05:00:09Z" }),
  });
  const result = await checkPayments({ requests: [rawUrl, "JArQ6g9JvoWr"] }, deps);
  const o = out(result);
  assert.deepEqual(rec.findPayment, [{ reference: REFERENCE, recipient: RECIPIENT, token: "USDC", amountAtomic: 1_000_000n }]);
  assert.deepEqual(o.results[0], {
    input: rawUrl, status: "paid", amount_requested: "1", token: "USDC", amount_paid: "1", payer: SENDER,
    signature: SIGNATURE, paid_at: "2026-10-17T05:00:09Z", explorer_url: `https://solscan.io/tx/${SIGNATURE}`,
  });
  assert.equal(o.results[1]!.status, "unknown");
  assert.match(o.results[1]!.error!, /unreachable/);
  assert.equal(o.summary, "1 of 2 paid · 1 USDC received · 1 couldn't be checked");
  assert.match(textOf(result), /Paid, Solana Pay link: 1 USDC from 9WzD…AWWM/);
  assert.match(textOf(result), /Not checked, JArQ6g9JvoWr: Owed's server is unreachable/);
});

test("offline /p?u= links are checked like the raw URL inside them", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST *": () => "network_error" } });
  const link = `https://owed-omega.vercel.app/p?u=${encodeURIComponent(rawUrl)}`;
  const o = out(await checkPayments({ requests: [link] }, deps));
  assert.equal(o.results[0]!.status, "open");
  assert.equal(rec.findPayment[0]!.reference, REFERENCE);
});

test("SOL links and links without an amount", async () => {
  const solUrl = `solana:${RECIPIENT}?amount=0.5&reference=${REFERENCE}`;
  const anyAmount = `solana:${RECIPIENT}?spl-token=${USDC_MINT}&reference=${REFERENCE}`;
  const { deps, rec } = makeDeps({
    routes: { "POST *": () => "network_error" },
    findPayment: async (_rpc, q) => (q.token === "SOL" ? { status: "open" } : { status: "underpaid", amountPaidAtomic: 2_500_000n, signature: SIGNATURE, payer: SENDER }),
  });
  const o = out(await checkPayments({ requests: [solUrl, anyAmount] }, deps));
  assert.deepEqual(rec.findPayment.map((q) => [q.token, q.amountAtomic]), [["SOL", 500_000_000n], ["USDC", 1n]]);
  assert.equal(o.results[0]!.status, "open");
  // No amount on the link: the payer chooses it, so any confirmed credit counts as paid.
  assert.equal(o.results[1]!.status, "paid");
  assert.equal(o.results[1]!.amount_requested, null);
  assert.equal(o.results[1]!.amount_paid, "2.5");
  assert.equal(o.summary, "1 of 2 paid · 2.5 USDC received · 0.5 SOL outstanding");
});

test("unreadable inputs are invalid with a reason, and don't stop the rest", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, statusFixture) } });
  const inputs = [
    "solana:https%3A%2F%2Fcheckout.example.com%2Fpay",
    `solana:${RECIPIENT}?amount=1`,
    "hello there",
    `solana:${RECIPIENT}?amount=1&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB&reference=${REFERENCE}`,
    "JArQ6g9JvoWr",
  ];
  const o = out(await checkPayments({ requests: inputs }, deps));
  assert.deepEqual(o.results.map((r) => r.status), ["invalid", "invalid", "invalid", "invalid", "paid"]);
  assert.equal(o.results[0]!.error, "This is a Solana Pay checkout link (transaction request). Owed checks transfer links only.");
  assert.equal(o.results[1]!.error, "This Solana Pay link has no reference, so its payment can't be found on-chain.");
  assert.ok(o.results[2]!.error && o.results[3]!.error);
  assert.equal(o.summary, "1 of 5 paid · 15 USDC received · 4 invalid");
});

test("status-raw contract errors mark the item invalid instead of retrying on-chain", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/status-raw": () => json(400, { error: { code: "invalid_input", message: "reference missing" } }) } });
  const o = out(await checkPayments({ requests: [rawUrl] }, deps));
  assert.equal(o.results[0]!.status, "invalid");
  assert.equal(o.results[0]!.error, "reference missing");
  assert.equal(rec.findPayment.length, 0);
});

test("RPC failures and the 10 s budget turn into 'unknown', never a hang", async () => {
  let t = Date.parse("2026-10-17T07:14:00Z");
  const { deps } = makeDeps({
    routes: { "POST *": () => "hang" },
    now: () => (t += 9000), // every reading is past the 8.5 s budget
    findPayment: () => new Promise(() => {}),
  });
  const started = Date.now();
  const o = out(await checkPayments({ requests: [rawUrl, "JArQ6g9JvoWr"] }, deps));
  assert.ok(Date.now() - started < 1000, "budget exhausted: must answer immediately");
  assert.deepEqual(o.results.map((r) => r.status), ["unknown", "unknown"]);

  const { deps: throwing } = makeDeps({ routes: { "POST *": () => "network_error" }, findPayment: async () => { throw new Error("429"); } });
  const o2 = out(await checkPayments({ requests: [rawUrl] }, throwing));
  assert.equal(o2.results[0]!.status, "unknown");
  assert.match(o2.results[0]!.error!, /Solana couldn't be reached/);
});

test("input schema: 1 to 20 bounded strings, strict", () => {
  const ok = (v: object) => inputSchema.safeParse(v).success;
  assert.equal(ok({ requests: ["JArQ6g9JvoWr"] }), true);
  assert.equal(ok({ requests: Array(20).fill("JArQ6g9JvoWr") }), true);
  assert.equal(ok({ requests: [] }), false);
  assert.equal(ok({ requests: Array(21).fill("JArQ6g9JvoWr") }), false);
  assert.equal(ok({ requests: [""] }), false);
  assert.equal(ok({ requests: ["x".repeat(2049)] }), false);
  assert.equal(ok({ requests: ["JArQ6g9JvoWr"], extra: 1 }), false);
  assert.equal(ok({ requests: "JArQ6g9JvoWr" }), false);
});

test("QA-05: the server's not_found result (id and status only) reads as not found; the rest of the batch still reports", async () => {
  const body = { results: [row("JArQ6g9JvoWr", "paid", "15", "15"), { id: "111111111111", status: "not_found" }] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, body) } });
  const result = await checkPayments({ requests: ["JArQ6g9JvoWr", "111111111111"] }, deps);
  const o = out(result);
  assert.deepEqual(o.results.map((r) => r.status), ["paid", "not_found"]);
  assert.deepEqual(o.results[1], { input: "111111111111", id: "111111111111", status: "not_found", amount_requested: null, token: null, error: "No Owed request has this id." });
  assert.equal(o.summary, "1 of 2 paid · 15 USDC received · 1 not found");
  assert.doesNotMatch(textOf(result), /unreachable/);
});

test("QA-05: an open result without its amount is still off-contract (only not_found and invalid may omit it)", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, { results: [{ id: "JArQ6g9JvoWr", status: "open" }] }) } });
  const o = out(await checkPayments({ requests: ["JArQ6g9JvoWr"] }, deps));
  assert.equal(o.results[0]!.status, "unknown");
});

test("QA-10: an id and its link count once; distinct requests still add up", async () => {
  const body = { results: [row("Bq3wL8mNc2", "open", "4.5"), row("Cq3wL8mNc2", "open", "15")] };
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, body) } });
  const o = out(await checkPayments({ requests: ["Bq3wL8mNc2", "https://owed.link/r/Bq3wL8mNc2", "Cq3wL8mNc2"] }, deps));
  assert.equal(o.results.length, 3);
  assert.equal(o.summary, "0 of 2 paid · 19.5 USDC outstanding");
});
