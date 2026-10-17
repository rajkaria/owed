import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, brandFlags, brandWordsFromFlags, cautionLine, clean, explorerUrl, LINK_REMOVED, quote, shareText, shortAddress } from "../src/text.ts";
import { SIGNATURE } from "./helpers.ts";

const ch = (...codes: number[]) => String.fromCodePoint(...codes);

test("clean strips links in every common form", () => {
  for (const input of [
    "pay at https://evil.example.com/x?y=1 now",
    "pay at http://evil.com now",
    "pay at www.evil-site.io now",
    "pay at moonpay-support.com now",
    "pay at t.me/scammer now",
    "pay at solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM now",
    "pay at ipfs://bafy now",
    "pay at mailto:a@b.c now",
  ]) {
    assert.equal(clean(input, 200), `pay at ${LINK_REMOVED} now`, input);
  }
  // Ordinary text with dots survives.
  assert.equal(clean("e.g. dinner at 7.30, St. Louis", 80), "e.g. dinner at 7.30, St. Louis");
});

test("clean removes control, zero-width and bidi characters and collapses whitespace", () => {
  const nasty = `din${ch(0x200b)}ner${ch(0)}\n\tfor ${ch(0x202e)}two${ch(0x2066)}${ch(0xfeff)}  ${ch(0x2028)}people${ch(0x7f)}`;
  assert.equal(clean(nasty, 80), "dinner for two people");
  assert.equal(clean("   ", 10), "");
  assert.equal(clean(undefined, 10), "");
  assert.equal(clean(null, 10), "");
});

test("clean caps length by characters, not bytes, with an ellipsis", () => {
  assert.equal(clean("a".repeat(100), 10), `${"a".repeat(9)}…`);
  const emoji = ch(0x1f355).repeat(50);
  const out = clean(emoji, 10);
  assert.equal(Array.from(out).length, 10);
  assert.ok(out.endsWith("…"));
  assert.equal(clean("short", 10), "short");
  assert.equal(clean("exactly ten", 11), "exactly ten");
});

test("quote wraps cleaned text and neutralises inner double quotes", () => {
  assert.equal(quote("dinner", 80), '"dinner"');
  assert.equal(quote('say "hi" at https://x.com', 80), `"say 'hi' at ${LINK_REMOVED}"`);
  assert.equal(quote("", 80), "");
  assert.equal(quote(ch(0x200b), 80), "");
});

test("brandFlags finds every SPEC §6 word, case-insensitive and lightly obfuscated", () => {
  assert.deepEqual(brandFlags("MoonPay refund"), ["brand_word:moonpay", "brand_word:refund"]);
  assert.deepEqual(brandFlags("Moon Pay"), ["brand_word:moonpay"]);
  assert.deepEqual(brandFlags("I.R.S. notice"), ["brand_word:irs"]);
  assert.deepEqual(brandFlags("from the Solana  Foundation"), ["brand_word:solana foundation"]);
  assert.deepEqual(brandFlags(`the tax${ch(0x2003)}office`), ["brand_word:tax office"]);
  // Separate texts never join into a phrase.
  assert.deepEqual(brandFlags("Solana", "Foundation"), []);
  assert.deepEqual(brandFlags(`pay${ch(0x200b)}box`), ["brand_word:paybox"]);
  assert.deepEqual(brandFlags("USDC Support team", "tax office", "Circle", "coinbase", "binance", "phantom", "solflare"), [
    "brand_word:coinbase", "brand_word:binance", "brand_word:phantom", "brand_word:solflare",
    "brand_word:circle", "brand_word:usdc support", "brand_word:tax office",
  ]);
  assert.deepEqual(brandFlags("refunds"), ["brand_word:refund"]);
  assert.deepEqual(brandFlags(undefined, null, ""), []);
});

test("brandFlags ignores words that only contain a brand word", () => {
  assert.deepEqual(brandFlags("first round, theirs, circled, semicircle, birs"), []);
  assert.deepEqual(brandFlags("dinner"), []);
});

test("caution line names the words with display casing", () => {
  assert.equal(cautionLine(["brand_word:moonpay"]), 'Caution: this request mentions "MoonPay". Owed can\'t confirm who sent it.');
  assert.equal(cautionLine(["brand_word:moonpay", "brand_word:refund", "brand_word:irs"]),
    'Caution: this request mentions "MoonPay", "refund" and "IRS". Owed can\'t confirm who sent it.');
  assert.equal(cautionLine([]), null);
  assert.equal(cautionLine(["something_else", "brand_word:unknown"]), null);
  assert.deepEqual(brandWordsFromFlags(["brand_word:paybox", "brand_word:paybox"]), ["PayBox"]);
});

test("share text matches the SPEC example and degrades gracefully", () => {
  const link = "https://owed.link/r/7Gh2kQpX";
  assert.equal(
    shareText({ payerName: "Priya", requesterName: "Raj", forText: "dinner", amount: "15", token: "USDC", link }),
    `Hey Priya, it's Raj. Your share for "dinner" is 15 USDC. Pay with any Solana wallet here: ${link}`,
  );
  assert.equal(shareText({ amount: "0.5", token: "SOL", link }), `Hi! This is a request for 0.5 SOL. Pay with any Solana wallet here: ${link}`);
  assert.equal(shareText({ payerName: "Sam", amount: "2", token: "USDC", link }), `Hey Sam! This is a request for 2 USDC. Pay with any Solana wallet here: ${link}`);
  assert.equal(shareText({ requesterName: "Raj", forText: 'the "big" trip', amount: "2", token: "USDC", link }),
    `Hi, it's Raj. Your share for "the 'big' trip" is 2 USDC. Pay with any Solana wallet here: ${link}`);
});

test("shortAddress, ago and explorerUrl", () => {
  assert.equal(shortAddress("FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"), "FN6G…cbvs");
  assert.equal(shortAddress("short"), "short");
  const now = Date.parse("2026-10-17T07:14:00Z");
  assert.equal(ago("2026-10-17T05:00:00Z", now), "2h 14m");
  assert.equal(ago("2026-10-17T07:00:00Z", now), "14m");
  assert.equal(ago("2026-10-17T07:13:30Z", now), "<1m");
  assert.equal(ago("2026-10-14T03:00:00Z", now), "3d 4h");
  assert.equal(ago("2026-10-17T07:14:30Z", now), "<1m"); // small clock skew
  assert.equal(ago("2026-10-18T00:00:00Z", now), undefined);
  assert.equal(ago("garbage", now), undefined);
  assert.equal(explorerUrl(SIGNATURE), `https://solscan.io/tx/${SIGNATURE}`);
});
