import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatAmount, fromAtomic, groupDigits, remainingAmount, toAtomic } from "./money.ts";
import { cleanText, truncate } from "./text.ts";
import { formatUtc, shortAddress, solscanTx } from "./format.ts";
import { parseTransferRequest } from "./pay-url.ts";
import {
  brandWordsFromFlags,
  detectBrandWords,
  headline,
  modelFromRequest,
  modelFromTransfer,
  pageTitle,
  pickStatusResult,
  stateFromStatus,
} from "./request-view.ts";
import type { PublicRequest } from "../public-api";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../contract/fixtures/${name}`, import.meta.url), "utf8")) as T;
}

const getRequest = fixture<PublicRequest>("get-request.res.json");
const created = fixture<{ solana_pay_url: string }>("create-request.res.json");
const statusRes = fixture<{ results: unknown[] }>("status.res.json");
const statusRawReq = fixture<{ solana_pay_url: string }>("status-raw.req.json");
const statusRawRes = fixture<unknown>("status-raw.res.json");

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";

// ---------- money ----------

test("toAtomic converts decimal strings exactly", () => {
  assert.equal(toAtomic("15", 6), BigInt(15_000_000));
  assert.equal(toAtomic("4.5", 6), BigInt(4_500_000));
  assert.equal(toAtomic("0.000001", 6), BigInt(1));
  assert.equal(toAtomic("0.000000001", 9), BigInt(1));
});

test("toAtomic rejects malformed or over-precise amounts", () => {
  for (const bad of ["0.0000001", "01", "1e3", "-1", "", " 1", "1.", ".5", "1,000"]) {
    assert.equal(toAtomic(bad, 6), null, bad);
  }
});

test("fromAtomic gives the shortest decimal", () => {
  assert.equal(fromAtomic(BigInt(4_500_000), 6), "4.5");
  assert.equal(fromAtomic(BigInt(0), 6), "0");
  assert.equal(fromAtomic(BigInt(1), 9), "0.000000001");
  assert.equal(fromAtomic(BigInt(15_000_000), 6), "15");
});

test("remainingAmount subtracts in atomic units and never goes negative", () => {
  assert.equal(remainingAmount("15", "10.5", "USDC"), "4.5");
  assert.equal(remainingAmount("0.3", "0.1", "SOL"), "0.2");
  assert.equal(remainingAmount("15", "20", "USDC"), "0");
  assert.equal(remainingAmount("15", "abc", "USDC"), null);
});

test("groupDigits and formatAmount", () => {
  assert.equal(groupDigits("1250000.25"), "1,250,000.25");
  assert.equal(groupDigits("999"), "999");
  assert.equal(formatAmount("15", "USDC"), "15 USDC");
  assert.equal(formatAmount("1000.5", "SOL"), "1,000.5 SOL");
});

// ---------- untrusted text ----------

test("cleanText strips URLs, bare domains and www links", () => {
  assert.equal(cleanText("dinner https://evil.example/x?y=1", 80), "dinner");
  assert.equal(cleanText("refund at moonpay-support.com/claim now", 80), "refund at now");
  assert.equal(cleanText("see www.scam.io", 80), "see");
  assert.equal(cleanText("pay solana:abc123 here", 80), "pay here");
  assert.equal(cleanText("t.me/fakehelp please", 80), "please");
});

test("cleanText removes control and bidi characters", () => {
  assert.equal(cleanText("abc‮def", 80), "abc def");
  assert.equal(cleanText("a\u0000b\nc\td", 80), "a b c d");
  assert.equal(cleanText("zero​width", 80), "zero width");
});

test("cleanText caps length and returns null when nothing is left", () => {
  const long = cleanText("a".repeat(200), 80);
  assert.equal(Array.from(long ?? "").length, 80);
  assert.ok(long?.endsWith("…"));
  assert.equal(cleanText("", 80), null);
  assert.equal(cleanText("   ", 80), null);
  assert.equal(cleanText("https://only.a.link", 80), null);
  assert.equal(cleanText("!!!", 80), null);
  assert.equal(cleanText(42, 80), null);
  assert.equal(cleanText(null, 80), null);
});

test("cleanText keeps ordinary text", () => {
  assert.equal(cleanText("dinner & drinks", 80), "dinner & drinks");
  assert.equal(cleanText("Raj", 40), "Raj");
  assert.equal(cleanText("Café Priyanka's 30th 🎂", 80), "Café Priyanka's 30th 🎂");
});

test("truncate never splits a surrogate pair", () => {
  assert.equal(truncate("😀😀😀", 2), "😀…");
  assert.equal(truncate("abc", 3), "abc");
});

// ---------- formatting ----------

test("shortAddress, solscan and UTC time", () => {
  assert.equal(shortAddress(RECIPIENT), "FN6G…cbvs");
  assert.equal(solscanTx("abc"), "https://solscan.io/tx/abc");
  assert.equal(formatUtc("2026-10-17T05:00:09Z"), "Oct 17, 2026, 05:00 UTC");
  assert.equal(formatUtc("not a date"), null);
});

// ---------- Solana Pay URL parsing ----------

test("parses the canonical Owed USDC transfer URL", () => {
  const r = parseTransferRequest(created.solana_pay_url);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.recipient, RECIPIENT);
  assert.equal(r.value.amount, "15");
  assert.equal(r.value.token, "USDC");
  assert.deepEqual(r.value.references, [REFERENCE]);
  assert.equal(r.value.label, "Raj");
  assert.equal(r.value.message, "dinner");
  assert.equal(r.value.memo, "owed:7Gh2kQpXa9");
});

test("parses a minimal USDC URL and a SOL URL", () => {
  const raw = parseTransferRequest(statusRawReq.solana_pay_url);
  assert.ok(raw.ok && raw.value.amount === "1" && raw.value.token === "USDC");
  const sol = parseTransferRequest(`solana:${RECIPIENT}?amount=0.25&reference=${REFERENCE}`);
  assert.ok(sol.ok && sol.value.token === "SOL" && sol.value.amount === "0.25");
  const open = parseTransferRequest(`solana:${RECIPIENT}`);
  assert.ok(open.ok && open.value.amount === null && open.value.references.length === 0);
});

test("refuses transaction requests and malformed links with a reason", () => {
  const cases: Array<[unknown, string]> = [
    ["solana:https://shop.example/api/pay", "transaction_request"],
    ["solana:https%3A%2F%2Fshop.example%2Fapi", "transaction_request"],
    ["https://owed.link/r/abc", "not_solana_pay"],
    ["solana:notakey?amount=1", "bad_recipient"],
    [`solana:${RECIPIENT}?amount=0`, "bad_amount"],
    [`solana:${RECIPIENT}?amount=1.0000001&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, "bad_amount"],
    [`solana:${RECIPIENT}?amount=abc`, "bad_amount"],
    [`solana:${RECIPIENT}?amount=1&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, "unsupported_token"],
    [`solana:${RECIPIENT}?amount=1&reference=xyz`, "bad_reference"],
    ["", "missing"],
    [undefined, "missing"],
    [`solana:${RECIPIENT}?message=${"a".repeat(3000)}`, "too_long"],
  ];
  for (const [input, error] of cases) {
    const r = parseTransferRequest(input);
    assert.equal(r.ok ? "ok" : r.error, error, String(input).slice(0, 60));
  }
});

// ---------- view model ----------

test("hosted model from the canonical paid request", () => {
  const m = modelFromRequest(getRequest, "https://owed.link");
  assert.equal(m.asker, "Raj");
  assert.equal(m.askerIsAddress, false);
  assert.equal(m.payerName, "Priya");
  assert.equal(m.forText, "dinner");
  assert.equal(m.note, "Thanks for coming!");
  assert.deepEqual(headline(m), { lead: "Raj is asking Priya for", amount: "15 USDC" });
  assert.equal(m.shareLink, "https://owed.link/r/7Gh2kQpXa9");
  assert.equal(m.agentPrompt, "Use the Owed plugin in PayBox to pay https://owed.link/r/7Gh2kQpXa9");
  assert.equal(pageTitle(m), "Raj is asking you for 15 USDC");
  assert.deepEqual(m.poll, { endpoint: "/api/v1/status", id: "7Gh2kQpXa9" });
  assert.deepEqual(m.initial, {
    status: "paid",
    amount: "15",
    payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: getRequest.paid?.signature,
    at: "2026-10-17T05:00:09Z",
    rail: "solana_pay",
  });
});

test("open, underpaid and cancelled requests map to live states", () => {
  const open = modelFromRequest({ ...getRequest, status: "open", paid: null }, "https://owed.link");
  assert.deepEqual(open.initial, { status: "open" });
  const under = modelFromRequest(
    { ...getRequest, status: "underpaid", paid: { ...getRequest.paid!, amount: "10" } },
    "https://owed.link",
  );
  assert.equal(under.initial.status, "underpaid");
  if (under.initial.status === "underpaid") {
    assert.equal(under.initial.amountPaid, "10");
    assert.equal(under.initial.remaining, "5");
  }
  const cancelled = modelFromRequest({ ...getRequest, status: "cancelled", paid: null }, "https://owed.link");
  assert.deepEqual(cancelled.initial, { status: "cancelled" });
});

test("no names falls back to the short recipient address and 'you'", () => {
  const m = modelFromRequest(
    { ...getRequest, requester_name: null, payer_name: null, for: null, note: null },
    "https://owed.link",
  );
  assert.equal(m.asker, "FN6G…cbvs");
  assert.equal(m.askerIsAddress, true);
  assert.equal(headline(m).lead, "FN6G…cbvs is asking you for");
  assert.equal(m.forText, null);
});

test("requester text is cleaned before it reaches the page", () => {
  const m = modelFromRequest(
    { ...getRequest, for: "dinner https://phish.example/x", requester_name: "Raj‮", note: "x".repeat(400) },
    "https://owed.link",
  );
  assert.equal(m.forText, "dinner");
  assert.equal(m.asker, "Raj");
  assert.equal(Array.from(m.note ?? "").length, 140);
});

test("brand words come from API flags and from the text itself", () => {
  assert.deepEqual(brandWordsFromFlags(["brand_word:moonpay", "other", 3]), ["MoonPay"]);
  assert.deepEqual(detectBrandWords(["MoonPay refund"]), ["MoonPay", "refund"]);
  assert.deepEqual(detectBrandWords(["dinner", null]), []);
  assert.deepEqual(detectBrandWords(["circles and first place"]), []);
  assert.deepEqual(detectBrandWords(["Solana   Foundation grant"]), ["Solana Foundation"]);
  const flagged = modelFromRequest(
    { ...getRequest, requester_name: "MoonPay Support", flags: ["brand_word:moonpay"] },
    "https://owed.link",
  );
  assert.deepEqual(flagged.brandWords, ["MoonPay"]);
  assert.equal(pageTitle(flagged), "Payment request for 15 USDC");
});

test("status results map to live states; unknown results change nothing", () => {
  const paid = stateFromStatus(pickStatusResult(statusRes, "7Gh2kQpXa9"), "15", "USDC");
  assert.deepEqual(paid, {
    status: "paid",
    amount: "15",
    payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
    at: "2026-10-17T05:00:09Z",
    rail: null,
  });
  assert.deepEqual(stateFromStatus(pickStatusResult(statusRes, "Bq3wL8mNc2"), "4.5", "USDC"), { status: "open" });
  assert.deepEqual(stateFromStatus(statusRawRes, "1", "USDC"), { status: "open" });
  assert.equal(pickStatusResult(statusRes, "missing"), null);
  assert.equal(stateFromStatus({ status: "not_found" }, "1", "USDC"), null);
  assert.equal(stateFromStatus({ status: "invalid" }, "1", "USDC"), null);
  assert.equal(stateFromStatus("garbage", "1", "USDC"), null);
  const under = stateFromStatus({ status: "underpaid", amount_paid: "1.5" }, "4.5", "USDC");
  assert.ok(under && under.status === "underpaid" && under.remaining === "3");
  const sneaky = stateFromStatus({ status: "paid", payer: "<script>", signature: "javascript:x" }, "1", "USDC");
  assert.ok(sneaky && sneaky.status === "paid" && sneaky.payer === null && sneaky.signature === null);
});

test("stateless model from a raw Solana Pay link", () => {
  const parsed = parseTransferRequest(created.solana_pay_url);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const m = modelFromTransfer(parsed.value, "https://owed.link");
  assert.equal(m.kind, "stateless");
  assert.equal(m.asker, "Raj");
  assert.equal(m.forText, "dinner");
  assert.equal(m.agentPrompt, `Use the Owed plugin in PayBox to pay ${created.solana_pay_url}`);
  assert.equal(m.shareLink, `https://owed.link/p?u=${encodeURIComponent(created.solana_pay_url)}`);
  assert.deepEqual(m.poll, { endpoint: "/api/v1/status-raw", solanaPayUrl: created.solana_pay_url });
  const bare = parseTransferRequest(`solana:${RECIPIENT}?amount=1`);
  assert.ok(bare.ok);
  if (bare.ok) {
    const b = modelFromTransfer(bare.value, "https://owed.link");
    assert.equal(b.poll, null);
    assert.equal(b.asker, "FN6G…cbvs");
  }
});
