import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEPOSIT_LINK_WINDOW_MS, depositLinkEnabled, depositOffer, isDepositHost, parseDepositUrl } from "@/lib/deposit-link";
import { ApiError } from "@/lib/http";

// F3 PayBox Open Deposit link (decision D17): what deposit_url accepts (https on paybox.sh, 512 characters, no
// credentials or port, USDC on Solana asked in USDC), and when the pay page offers it (OWED_DEPOSIT_LINK=1, open,
// within 24 hours of being added). The routes and the stored column are tested on Postgres in autopay-db.test.ts.

const USDC_SOLANA = { token: "USDC", chain: "solana" } as const;
const LINK = "https://deposit.paybox.sh/d/7f3a9c2e?amount=12";
const refused = (input: unknown, ctx: Parameters<typeof parseDepositUrl>[1] = USDC_SOLANA) => {
  try {
    parseDepositUrl(input, ctx);
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "invalid_input");
    return e.message;
  }
  assert.fail(`accepted ${String(input)}`);
};

test("accepts paybox.sh and its subdomains over https, normalized", () => {
  assert.equal(parseDepositUrl(LINK, USDC_SOLANA), LINK);
  assert.equal(parseDepositUrl("https://PAYBOX.sh/deposit/abc", USDC_SOLANA), "https://paybox.sh/deposit/abc");
  assert.equal(parseDepositUrl("  https://app.paybox.sh/deposit?d=1  ", USDC_SOLANA), "https://app.paybox.sh/deposit?d=1");
  assert.equal(parseDepositUrl(null, USDC_SOLANA), null);
  assert.equal(parseDepositUrl(undefined, USDC_SOLANA), null);
});

test("refuses other hosts and lookalikes, http, credentials, ports and long URLs", () => {
  assert.match(refused("https://evil.example/d/1"), /PayBox Deposit link on paybox\.sh/);
  assert.match(refused("https://paybox.sh.evil.example/d/1"), /on paybox\.sh/);
  assert.match(refused("https://notpaybox.sh/d/1"), /on paybox\.sh/);
  assert.match(refused("https://paybox.shop/d/1"), /on paybox\.sh/);
  assert.match(refused("http://deposit.paybox.sh/d/1"), /must be an https URL/);
  assert.match(refused("javascript:alert(1)"), /must be an https URL/);
  assert.match(refused("https://user:pw@deposit.paybox.sh/d/1"), /user name or password/);
  assert.match(refused("https://deposit.paybox.sh:8443/d/1"), /port/);
  assert.match(refused(`https://deposit.paybox.sh/${"a".repeat(500)}`), /at most 512 characters/);
  assert.match(refused("not a url"), /https URL/);
  assert.match(refused(""), /deposit_url PayBox get_deposit_link returned/);
  assert.match(refused(42), /deposit_url PayBox get_deposit_link returned/);
  assert.equal(isDepositHost("paybox.sh"), true);
  assert.equal(isDepositHost("a.b.paybox.sh"), true);
  assert.equal(isDepositHost("paybox.sh.example"), false);
  assert.equal(isDepositHost("xpaybox.sh"), false);
});

test("USDC requests on Solana asked in USDC only: SOL, Base and local-currency asks are refused", () => {
  assert.match(refused(LINK, { token: "SOL", chain: "solana" }), /USDC requests on Solana only/);
  assert.match(refused(LINK, { token: "USDC", chain: "base" }), /USDC requests on Solana only/);
  assert.match(refused(LINK, { ...USDC_SOLANA, currency: "INR" }), /ask in USDC \(not a local currency\)/);
  assert.match(refused(LINK, { token: "SOL", chain: "solana", what: "invoice" }), /USDC invoices on Solana only/);
});

const ADDED = "2026-10-18T10:00:00Z";
const open = { status: "open", token: "USDC", chain: "solana", deposit_url: LINK, deposit_url_added_at: ADDED };
const ON = { OWED_DEPOSIT_LINK: "1" };
const AT = Date.parse(ADDED) + 3600_000;

test("pay page: off unless OWED_DEPOSIT_LINK=1", () => {
  assert.equal(depositLinkEnabled({}), false);
  assert.equal(depositLinkEnabled({ OWED_DEPOSIT_LINK: "true" }), false);
  assert.equal(depositLinkEnabled(ON), true);
  assert.equal(depositOffer(open, AT, {}), null);
  assert.deepEqual(depositOffer(open, AT, ON), { url: LINK, host: "deposit.paybox.sh", addedAt: ADDED, until: "2026-10-19T10:00:00Z" });
});

test("pay page: only while open, for 24 hours after the link was added", () => {
  assert.ok(depositOffer(open, Date.parse(ADDED), ON));
  assert.ok(depositOffer(open, Date.parse(ADDED) + DEPOSIT_LINK_WINDOW_MS - 1, ON));
  assert.equal(depositOffer(open, Date.parse(ADDED) + DEPOSIT_LINK_WINDOW_MS, ON), null);
  for (const status of ["paid", "underpaid", "cancelled", "expired"]) assert.equal(depositOffer({ ...open, status }, AT, ON), null, status);
  assert.equal(depositOffer({ ...open, deposit_url: undefined }, AT, ON), null);
  assert.equal(depositOffer({ ...open, token: "SOL" }, AT, ON), null);
  assert.equal(depositOffer({ ...open, chain: "base" }, AT, ON), null);
  // A stored value that isn't (any more) a paybox.sh https URL is never shown.
  assert.equal(depositOffer({ ...open, deposit_url: "https://evil.example/x" }, AT, ON), null);
});

test("the pay page wires the offer beside the card option, and the copy says Owed can't check where it pays", () => {
  const page = readFileSync(new URL("../app/r/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /depositOffer\(request as PublicRequestWithPayer\)/);
  assert.match(page, /<DepositPay offer=\{deposit\} \/>/);
  const component = readFileSync(new URL("../components/deposit-pay.tsx", import.meta.url), "utf8");
  assert.match(component, /The link goes to the requester's PayBox account, and Owed can't check where it pays\./);
  assert.match(component, /It counts as paid here only once the requester matches your payment to this request\./);
  assert.match(component, /rel="noopener noreferrer nofollow"/);
});
