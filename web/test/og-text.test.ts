import { test } from "node:test";
import assert from "node:assert/strict";
import { cardText } from "@/components/marketing/og-text";

// QA-17: what the /r preview card is allowed to draw.

test("plain text, accents, CJK and emoji are drawn as written", () => {
  for (const s of ["dinner", "café crème", "Konzert für 2", "寿司", "pizza 🍕", "tickets (row 4)"]) assert.equal(cardText(s), s);
});

test("right-to-left scripts are left off: Satori would reverse them", () => {
  for (const s of ["ארוחת ערב", "عشاء", "dinner ארוחה", "ܫܠܡܐ", "ދިވެހި", "ߒߞߏ", "𞤀𞤣𞤤𞤢𞤥"]) assert.equal(cardText(s), null, s);
});

test("invisible characters and variation selectors are left off: Satori draws them as tofu", () => {
  const cases = [
    "din​ner", // zero-width space
    "din‍ner", // zero-width joiner
    "pay‮yaprefund", // right-to-left override
    "a⁦b⁩", // isolates
    "❤️", // variation selector 16
    "x\u{E0101}", // variation selector supplement
    "x\u{E0041}", // tag character
    "soft­hyphen",
    "bell\u0007",
    "privateuse",
  ];
  for (const s of cases) assert.equal(cardText(s), null, JSON.stringify(s));
});

test("missing text stays missing", () => {
  assert.equal(cardText(null), null);
  assert.equal(cardText(undefined), null);
  assert.equal(cardText(""), null);
});
