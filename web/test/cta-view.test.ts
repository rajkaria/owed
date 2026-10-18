import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ctaEnabled, ctaStatusShows, PAYBOX_APP_URL, PAYBOX_CTA_COPY, payboxCta } from "@/lib/cta";
import type { PublicRequest } from "@/lib/public-api";
import { modelFromRequest, modelFromTransfer } from "@/lib/view/request-view";
import { parseTransferRequest } from "@/lib/view/pay-url";

// SP1 "New to crypto? Pay with PayBox" on /r/<id>: when the section shows, what it says and that the prompt is
// exactly "Pay this: <share link>". Pure view model over the contract fixtures (get-request, base.get-request,
// cancel), with the status patched in, like expiry-view.test.ts.

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8")) as T;
const ORIGIN = "https://www.getowed.xyz";
const NOW = Date.parse("2026-10-18T12:00:00Z");

const paid = fixture<PublicRequest>("get-request.res.json"); // JArQ6g9JvoWr, 15 USDC on Solana, paid
const open: PublicRequest = { ...paid, status: "open", paid: null, from_domain: null, from_domain_verified_at: null, expires_at: null, cancelled: null };
const basePaid = fixture<PublicRequest>("base.get-request.res.json"); // BWPPcRxKPi21, 0.5 USDC on Base, paid
const baseOpen: PublicRequest = { ...basePaid, status: "open", paid: null, expires_at: null, cancelled: null };
const cta = (req: PublicRequest, origin = ORIGIN, now = NOW) => payboxCta(modelFromRequest(req, origin), now);

test("an open Solana USDC request shows the section: account link through the counter, what to buy, and the prompt", () => {
  const view = cta(open);
  assert.ok(view);
  assert.equal(view.requestId, "JArQ6g9JvoWr");
  assert.equal(view.heading, "New to crypto? Pay with PayBox");
  assert.equal(view.accountHref, "/api/v1/cta/paybox?r=JArQ6g9JvoWr");
  assert.equal(view.buy, "Buy at least 15 USDC on Solana in PayBox, and about 0.003 SOL for the network fee.");
  assert.equal(view.prompt, "Pay this: https://www.getowed.xyz/r/JArQ6g9JvoWr");
});

test("the prompt is exactly \"Pay this: \" and the request's share link, on any origin", () => {
  for (const origin of [ORIGIN, "https://owed-git-v2-rajkaria.vercel.app", "http://localhost:3123"]) {
    const model = modelFromRequest(open, origin);
    const view = payboxCta(model, NOW);
    assert.ok(view, origin);
    assert.equal(view.prompt, `Pay this: ${model.shareLink}`);
    assert.ok(view.prompt.endsWith(`${origin}/r/JArQ6g9JvoWr`), view.prompt);
    // The link the prompt carries is the one the page's own "Copy link" copies.
    assert.equal(view.prompt.slice("Pay this: ".length), model.shareLink);
  }
});

test("visibility: only an open request shows it (underpaid, paid, cancelled, expired and not found don't)", () => {
  const statuses: Array<[PublicRequest["status"], Partial<PublicRequest>, boolean]> = [
    ["open", {}, true],
    // pay_link refuses an underpaid request ("Ask the requester for a new link for the rest"), so the prompt
    // would fail; the page itself says paying the link again would send the full amount.
    ["underpaid", { paid: { ...paid.paid!, amount: "5" } }, false],
    ["paid", { paid: paid.paid }, false],
    ["cancelled", { cancelled: fixture<PublicRequest>("cancel.res.json").cancelled }, false],
    ["expired", { expires_at: "2026-10-17T09:00:00Z" }, false],
  ];
  for (const [status, patch, shows] of statuses) {
    const view = cta({ ...open, ...patch, status });
    assert.equal(view !== null, shows, status);
  }
  // Base follows the same rule.
  assert.ok(cta(baseOpen));
  assert.equal(cta(basePaid), null);
  assert.equal(cta({ ...baseOpen, status: "underpaid", paid: { ...basePaid.paid!, amount: "0.2" } }), null);
  // The rule itself, for every status the API can answer (a missing request 404s before any model exists;
  // /status answers not_found or invalid for ids it can't read).
  for (const s of ["open"]) assert.equal(ctaStatusShows(s), true, s);
  for (const s of ["underpaid", "paid", "cancelled", "expired", "not_found", "invalid", "", "OPEN", null, undefined, 1]) {
    assert.equal(ctaStatusShows(s), false, String(s));
  }
});

test("an open request past its expiry stops showing it, one that expires later still shows it", () => {
  assert.equal(cta({ ...open, expires_at: "2026-10-18T11:59:59Z" }), null);
  assert.ok(cta({ ...open, expires_at: "2026-10-25T12:00:00Z" }));
});

test("a Base request shows it with USDC on Base and no SOL fee", () => {
  const view = cta(baseOpen);
  assert.ok(view);
  assert.equal(view.buy, "Buy at least 0.5 USDC on Base in PayBox.");
  assert.equal(view.prompt, "Pay this: https://www.getowed.xyz/r/BWPPcRxKPi21");
  assert.equal(view.accountHref, "/api/v1/cta/paybox?r=BWPPcRxKPi21");
});

test("a SOL request asks for the amount plus the 0.003 SOL fee reserve, added exactly", () => {
  const sol: PublicRequest = { ...open, token: "SOL", amount: "0.5" };
  assert.equal(cta(sol)!.buy, "Buy at least 0.503 SOL in PayBox: 0.5 SOL for the request and about 0.003 SOL for the network fee.");
  assert.equal(cta({ ...sol, amount: "1.999999999" })!.buy, "Buy at least 2.002999999 SOL in PayBox: 1.999999999 SOL for the request and about 0.003 SOL for the network fee.");
  assert.equal(cta({ ...open, amount: "1250.5" })!.buy, "Buy at least 1,250.5 USDC on Solana in PayBox, and about 0.003 SOL for the network fee.");
});

test("hidden where the prompt can't work or shouldn't be offered", () => {
  // pay_link refuses older random 10-character ids (their terms can't be checked against the id).
  assert.equal(cta({ ...open, id: "1RRer81ufk" }), null);
  // A request with a brand word (caution banner): no "buy crypto to pay this" walkthrough for it.
  assert.equal(cta({ ...open, note: "PayBox support refund" }), null);
  assert.equal(cta({ ...open, flags: ["brand_word:moonpay"] }), null);
  // The stateless /p page has no request id to count or to pay through Owed.
  const parsed = parseTransferRequest(paid.solana_pay_url!);
  assert.ok(parsed.ok);
  assert.equal(payboxCta(modelFromTransfer(parsed.value, ORIGIN), NOW), null);
});

test("requester-written text never reaches the section", () => {
  const marked: PublicRequest = {
    ...open, requester_name: "Zq Requester", payer_name: "Zq Payer", for: "zq-for-text", note: "zq-note-text",
  };
  const view = cta(marked);
  assert.ok(view);
  const everything = JSON.stringify(view);
  for (const text of ["Zq Requester", "Zq Payer", "zq-for-text", "zq-note-text", "Zq", "zq"]) assert.ok(!everything.includes(text), text);
});

test("copy: plain and short, names PayBox and MoonPay, links app.paybox.sh only through the counter", () => {
  const view = cta(open)!;
  assert.equal(PAYBOX_APP_URL, "https://app.paybox.sh");
  assert.equal(view.account.linkText, "app.paybox.sh");
  assert.match(view.account.text, /^Create a PayBox account at$/);
  assert.match(view.account.after, /connect it to Claude/);
  assert.match(view.account.after, /turn on Owed/);
  assert.equal(view.account.note, "PayBox is MoonPay's wallet for AI agents.");
  assert.match(view.checkout, /MoonPay's checkout \(card or bank\)/);
  assert.equal(view.tell, "Tell Claude:");
  assert.match(view.approve, /Nothing is sent until you approve it in PayBox with your passkey\./);
  const strings = [view.heading, view.account.text, view.account.after, view.account.note, view.buy, view.checkout, view.tell, view.approve];
  for (const s of strings) {
    assert.ok(!s.includes("!"), s);
    assert.ok(s.length <= 130, `${s.length} chars: ${s}`);
    assert.ok(!/\b(instant(ly)?|easy|easily|seamless(ly)?|simply|just|free|revolutionary|magic)\b/i.test(s), `hype word in: ${s}`);
  }
  // The same static copy every request gets (only buy, prompt and the link's id change).
  assert.equal(PAYBOX_CTA_COPY.heading, view.heading);
  assert.equal(PAYBOX_CTA_COPY.checkout, view.checkout);
});

test("the section is off unless OWED_PAYBOX_CTA=1", () => {
  assert.equal(ctaEnabled({}), false);
  assert.equal(ctaEnabled({ OWED_PAYBOX_CTA: "0" }), false);
  assert.equal(ctaEnabled({ OWED_PAYBOX_CTA: "1" }), true);
});
