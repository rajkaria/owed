import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTransferUrl, isSolanaAddress, parseTransferUrl, SolanaPayError } from "@/lib/solana-pay";
import { USDC_MINT } from "@/lib/money";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";

test("builds the exact URL in the create-request fixture", () => {
  const url = buildTransferUrl({
    recipient: RECIPIENT,
    amount: "15",
    splToken: USDC_MINT,
    references: [REFERENCE],
    label: "Raj",
    message: "dinner",
    memo: "owed:7Gh2kQpXa9",
  });
  assert.equal(url, fixture("create-request.res.json").solana_pay_url);
});

test("SOL links omit spl-token; text is percent-encoded with %20, not +", () => {
  const url = buildTransferUrl({ recipient: RECIPIENT, amount: "0.05", references: [REFERENCE], message: "pizza & beer #2" });
  assert.equal(url, `solana:${RECIPIENT}?amount=0.05&reference=${REFERENCE}&message=pizza%20%26%20beer%20%232`);
});

test("parse round-trips build", () => {
  const request = {
    recipient: RECIPIENT,
    amount: "4.5",
    splToken: USDC_MINT,
    references: [REFERENCE],
    label: "Raj K",
    message: "tacos: Friday",
    memo: "owed:Bq3wL8mNc2",
  };
  assert.deepEqual(parseTransferUrl(buildTransferUrl(request)), request);
});

test("parses the status-raw fixture", () => {
  const parsed = parseTransferUrl(fixture("status-raw.req.json").solana_pay_url);
  assert.equal(parsed.recipient, RECIPIENT);
  assert.equal(parsed.amount, "1");
  assert.equal(parsed.splToken, USDC_MINT);
  assert.deepEqual(parsed.references, [REFERENCE]);
});

test("accepts + as space and several references, ignores unknown keys", () => {
  const parsed = parseTransferUrl(`solana:${RECIPIENT}?message=a+b&reference=${REFERENCE}&reference=${RECIPIENT}&foo=bar`);
  assert.equal(parsed.message, "a b");
  assert.deepEqual(parsed.references, [REFERENCE, RECIPIENT]);
});

test("rejects transaction requests and malformed links with readable messages", () => {
  const cases: [string, RegExp][] = [
    ["solana:https://merchant.example/api/pay", /transaction request/],
    ["solana:https%3A%2F%2Fmerchant.example%2Fpay", /transaction request/],
    ["bitcoin:abc", /must start with solana:/],
    ["solana:notanaddress", /recipient/],
    [`solana:${RECIPIENT}?amount=1e3`, /plain decimal/],
    [`solana:${RECIPIENT}?amount=1&amount=2`, /more than once/],
    [`solana:${RECIPIENT}?reference=xyz`, /reference/],
    [`solana:${RECIPIENT}?spl-token=nope`, /spl-token/],
    [`solana:${RECIPIENT}?message=%E0%A4%A`, /malformed message/],
    [`solana:${RECIPIENT}?${"x".repeat(3000)}`, /too long/],
  ];
  for (const [url, re] of cases) assert.throws(() => parseTransferUrl(url), (e: unknown) => e instanceof SolanaPayError && re.test(e.message), url);
});

test("isSolanaAddress accepts 32-byte base58 keys only", () => {
  assert.ok(isSolanaAddress(RECIPIENT));
  assert.ok(isSolanaAddress("11111111111111111111111111111111"));
  assert.equal(isSolanaAddress("0x3806c85df527e5336f05277ab8cc3932b9abe42a"), false);
  assert.equal(isSolanaAddress("1111111111111111111111111111111"), false); // 31 bytes
  assert.equal(isSolanaAddress("FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvO"), false);
  assert.equal(isSolanaAddress(42), false);
});
