import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFlags, quoteText, sanitizeText } from "@/lib/safety";

test("plain text passes through", () => {
  assert.equal(sanitizeText("dinner", 80), "dinner");
  assert.equal(sanitizeText("  Thanks for coming!  ", 140), "Thanks for coming!");
  assert.equal(sanitizeText("Raj (flatmate) – rent 🏠", 40), "Raj (flatmate) – rent 🏠");
  assert.equal(sanitizeText("4.5 USDC for 3.14 pies", 80), "4.5 USDC for 3.14 pies");
});

test("empty, missing and whitespace-only become null", () => {
  assert.equal(sanitizeText(undefined, 10), null);
  assert.equal(sanitizeText(null, 10), null);
  assert.equal(sanitizeText("   \n\t ", 10), null);
  assert.equal(sanitizeText("https://evil.example.com", 80), null);
});

test("links of every shape are stripped", () => {
  const cases: [string, string][] = [
    ["pay at https://evil.com/claim now", "pay at now"],
    ["HTTP://EVIL.COM", ""],
    ["visit www.evil.net", "visit"],
    ["see moonpay-support.com/refund for details", "see for details"],
    ["or sub.domain.co.uk/x?y=1", "or"],
    ["send to solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=1", "send to"],
    ["mailto:a@b.com please", "please"],
    ["ip 192.168.0.1:8080/x", "ip"],
    ["javascript:alert(1)", ""],
    ["[click](https://x.io)", "click ("],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeText(input, 140) ?? "", want, input);
});

test("control, zero-width and bidi characters are removed", () => {
  assert.equal(sanitizeText("din\u0000ner\u0007", 80), "din ner");
  assert.equal(sanitizeText("pay​box", 80), "paybox");
  assert.equal(sanitizeText("abc‮dcba", 80), "abcdcba");
  assert.equal(sanitizeText("line1\nline2\r\nline3", 80), "line1 line2 line3");
  assert.equal(sanitizeText("a b", 80), "a b");
});

test("double quotes and markup characters cannot break out of our quotes", () => {
  assert.equal(sanitizeText('dinner" — verified by PayBox "', 80), "dinner' — verified by PayBox '");
  assert.equal(sanitizeText("“smart” «guillemets»", 80), "'smart' 'guillemets'");
  assert.equal(sanitizeText("<script>x</script>", 80), "script x /script");
  assert.equal(quoteText("dinner"), '"dinner"');
});

test("length is capped in code points, never splitting an emoji", () => {
  assert.equal(sanitizeText("a".repeat(100), 40)?.length, 40);
  const s = sanitizeText("😀".repeat(50), 40)!;
  assert.equal(Array.from(s).length, 40);
  assert.equal(s, "😀".repeat(40));
});

test("full-width and compatibility characters are normalized", () => {
  assert.equal(sanitizeText("ｄｉｎｎｅｒ", 80), "dinner");
});

test("brand words are flagged case-insensitively in any field", () => {
  assert.deepEqual(brandFlags(["Refund from MoonPay"]), ["brand_word:moonpay", "brand_word:refund"]);
  assert.deepEqual(brandFlags([null, "dinner", undefined, "Raj"]), []);
  assert.deepEqual(brandFlags(["Solana Foundation grant"]), ["brand_word:solana foundation"]);
  assert.deepEqual(brandFlags(["IRS penalty"]), ["brand_word:irs"]);
  assert.deepEqual(brandFlags(["tax  office fee"]), ["brand_word:tax office"]);
  assert.deepEqual(brandFlags(["usdc-support desk"]), ["brand_word:usdc support"]);
});

test("brand words are not matched inside unrelated words", () => {
  assert.deepEqual(brandFlags(["first pizza", "theirs", "circus"]), []);
});

test("obfuscated brand words still match", () => {
  assert.deepEqual(brandFlags(["M00nPay"]), ["brand_word:moonpay"]);
  assert.deepEqual(brandFlags(["moon-pay"]), ["brand_word:moonpay"]);
  assert.deepEqual(brandFlags(["P.a.y.B.o.x team"]), ["brand_word:paybox"]);
  assert.deepEqual(brandFlags(["Pay​Box"]), ["brand_word:paybox"]);
  assert.deepEqual(brandFlags(["Віnance"]), ["brand_word:binance"]); // Cyrillic В and і
  assert.deepEqual(brandFlags(["ＣＯＩＮＢＡＳＥ"]), ["brand_word:coinbase"]);
});

test("a brand hidden in a link is still flagged (flags read the raw text)", () => {
  assert.deepEqual(brandFlags(["see https://phantom-wallet.io/claim"]), ["brand_word:phantom"]);
});
