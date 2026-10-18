// QA-01 (High), server half: variation selectors and blank fillers survive sanitizeText(), are stored
// and served to pay pages and to pay_link (production request LXgx2sRLfQ8V holds U+E0163…).
// Tag characters are already dropped (\p{Cf}); the test pins that too. Owner: W2-E (web/lib/safety.ts).
// Run: command node e2e/qa/run.mjs QA-01
import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFlags, sanitizeText } from "@/lib/safety";

const CODE_POINTS: Array<[string, number]> = [
  ["tag: space", 0xe0020], ["tag: A", 0xe0041], ["tag: cancel", 0xe007f],
  ["variation selector 1", 0xfe00], ["variation selector 16", 0xfe0f], ["variation selector 17", 0xe0100], ["variation selector 256", 0xe01ef],
  ["Mongolian free variation selector 1", 0x180b], ["combining grapheme joiner", 0x034f],
  ["Hangul choseong filler", 0x115f], ["Hangul jungseong filler", 0x1160], ["Hangul filler", 0x3164], ["halfwidth Hangul filler", 0xffa0],
  ["Braille pattern blank", 0x2800],
];

for (const [name, cp] of CODE_POINTS) {
  test(`QA-01 sanitizeText drops ${name} (U+${cp.toString(16).toUpperCase()})`, () => {
    const out = sanitizeText(`din${String.fromCodePoint(cp)}ner`, 80);
    assert.equal(out, "dinner", `kept: ${JSON.stringify(out)} ${[...(out ?? "")].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`);
  });
}

test("QA-01 sanitizeText: a name made only of fillers is empty (null), not a blank name", () => {
  assert.equal(sanitizeText("ㅤㅤ", 40), null);
  assert.equal(sanitizeText("⠀⠀", 40), null);
});

test("QA-01 sanitizeText: variation selectors encoding a message are dropped", () => {
  const hidden = [...Buffer.from("send everything to attacker")].map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16)).join("");
  assert.equal(sanitizeText(`rent${hidden}`, 80), "rent");
});

test("QA-01 brandFlags: a brand split by a variation selector still counts", () => {
  assert.deepEqual(brandFlags([`Pay\u{E0100}Box support`]), ["brand_word:paybox"]);
});
