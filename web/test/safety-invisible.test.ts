// W2-E: QA-01 (invisible Unicode is never stored or shown) and QA-06 (Owed's own name is a brand word),
// server and page side. The same code points and names are tested in plugin/test/text-invisible.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFlags, sanitizeText } from "@/lib/safety";
import { detectBrandWords, modelFromRequest, pageTitle } from "@/lib/view/request-view";
import { cleanText } from "@/lib/view/text";

const CODE_POINTS: Array<[string, number]> = [
  ["tag: language tag", 0xe0001], ["tag: space", 0xe0020], ["tag: A", 0xe0041], ["tag: cancel", 0xe007f], ["unassigned tag", 0xe0000],
  ["variation selector 1", 0xfe00], ["variation selector 16", 0xfe0f], ["variation selector 17", 0xe0100], ["variation selector 256", 0xe01ef],
  ["Mongolian free variation selector 1", 0x180b], ["combining grapheme joiner", 0x034f], ["Khmer inherent vowel aq", 0x17b4],
  ["Hangul choseong filler", 0x115f], ["Hangul jungseong filler", 0x1160], ["Hangul filler", 0x3164], ["halfwidth Hangul filler", 0xffa0],
  ["Braille pattern blank", 0x2800], ["zero width joiner", 0x200d], ["right-to-left override", 0x202e],
];
const asSelectors = (s: string) => [...Buffer.from(s)].map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16)).join("");

test("QA-01: sanitizeText (stored text) drops every invisible or blank-rendering code point", () => {
  for (const [name, cp] of CODE_POINTS) assert.equal(sanitizeText(`din${String.fromCodePoint(cp)}ner`, 80), "dinner", name);
  assert.equal(sanitizeText(`rent${asSelectors("send everything to attacker")}`, 80), "rent");
  assert.equal(sanitizeText("ㅤㅤ", 40), null, "a name of fillers is empty, not a blank name");
  assert.equal(sanitizeText("⠀⠀", 40), null);
  assert.equal(sanitizeText("Café 東京 🍕", 40), "Café 東京 🍕");
});

test("QA-01: pages clean the same set (older rows, raw links on /p): no blank asker", () => {
  for (const [name, cp] of CODE_POINTS) assert.equal(cleanText(`din${String.fromCodePoint(cp)}ner`, 80)?.replace(/ /g, ""), "dinner", name);
  assert.equal(cleanText("ㅤㅤ", 40), null);
  assert.equal(cleanText("ᅟᅠ ⠀", 40), null);
});

test("QA-01: a brand word split by an invisible character still flags, on the server and on the page", () => {
  assert.deepEqual(brandFlags(["Pay\u{E0100}Box support"]), ["brand_word:paybox"]);
  assert.deepEqual(brandFlags([`Pay${String.fromCodePoint(0xe0020)}Box`]), ["brand_word:paybox"]);
  assert.deepEqual(detectBrandWords(["Pay\u{E0100}Box"]), ["PayBox"]);
});

test("QA-06: Owed's own name and Anthropic are brand words on the server and the page; 'money owed' is not", () => {
  for (const [text, word, display] of [
    ["Owed Support", "owed support", "Owed Support"], ["Owed team", "owed team", "Owed team"], ["Owed Security", "owed security", "Owed Security"],
    ["owed admin", "owed admin", "Owed admin"], ["Owed billing", "owed billing", "Owed billing"], ["getowed billing", "getowed", "getowed"],
    ["Anthropic", "anthropic", "Anthropic"],
  ]) {
    assert.ok(brandFlags([text]).includes(`brand_word:${word}`), `server: ${text}`);
    assert.ok(detectBrandWords([text]).includes(display), `page: ${text}`);
  }
  for (const text of ["money owed for dinner", "the 5 USDC you owed me", "what the team owed us"]) {
    assert.deepEqual(brandFlags([text]), [], text);
    assert.deepEqual(detectBrandWords([text]), [], text);
  }
});

test("QA-06: production row Yq9MaUsCopbJ ('Owed Support', stored flags []) gets the neutral title and a caution", () => {
  const req = {
    id: "Yq9MaUsCopbJ", kind: "single", recipient: "B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp", amount: "5", token: "USDC",
    payer_name: null, for: "account verification fee", note: null, requester_name: "Owed Support", status: "open",
    solana_pay_url: "solana:B7QBb26C4Cijm6BCLntASHhGouMSx6ayVWqkyFYYGTTp?amount=5", reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e",
    x402_url: null, created_at: "2026-10-17T13:38:00Z", paid: null, flags: [], from_domain: null, from_domain_verified_at: null,
  };
  const model = modelFromRequest(req as Parameters<typeof modelFromRequest>[0], "https://www.getowed.xyz");
  assert.equal(pageTitle(model), "Payment request for 5 USDC");
  assert.deepEqual(model.brandWords, ["Owed Support"]);
});
