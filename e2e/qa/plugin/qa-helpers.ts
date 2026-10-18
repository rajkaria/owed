// Shared doubles for the W2-G repro tests. They reuse plugin/test's doubles and real DoH captures.
import { dohFixture, dohRoutes, withTxt, type DohFixture } from "../../../plugin/test/payee-helpers.ts";
import type { Route } from "../../../plugin/test/helpers.ts";

/** Every code point the QA-01 tests require the sanitizers to drop (invisible or blank-rendering). */
export const INVISIBLE_CODE_POINTS: Array<[string, number]> = [
  ["tag: language tag", 0xe0001], ["tag: space", 0xe0020], ["tag: A", 0xe0041], ["tag: z", 0xe007a], ["tag: cancel", 0xe007f],
  ["variation selector 1", 0xfe00], ["variation selector 16", 0xfe0f], ["variation selector 17", 0xe0100], ["variation selector 256", 0xe01ef],
  ["Mongolian free variation selector 1", 0x180b], ["Mongolian vowel separator", 0x180e], ["combining grapheme joiner", 0x034f],
  ["Hangul choseong filler", 0x115f], ["Hangul jungseong filler", 0x1160], ["Hangul filler", 0x3164], ["halfwidth Hangul filler", 0xffa0],
  ["Braille pattern blank", 0x2800],
];

export function hiddenIn(text: string): string[] {
  const set = new Set(INVISIBLE_CODE_POINTS.map(([, cp]) => cp));
  const tagOrSelector = (cp: number) => (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
  return [...text].filter((ch) => set.has(ch.codePointAt(0)!) || tagOrSelector(ch.codePointAt(0)!))
    .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
}

/** ASCII text as invisible Unicode tag characters (U+E0000 + code). */
export const asTags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
/** Bytes as variation selectors (0–15 → U+FE00–FE0F, 16–255 → U+E0100–E01EF). */
export const asSelectors = (s: string) =>
  [...Buffer.from(s)].map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16)).join("");

/** A real NOERROR capture (nodata-signed, example.com) renamed to `domain`, carrying `owed-pay=` TXT values. */
export function dohFor(domain: string, values: string[]): Record<string, Route> {
  const base = dohFixture("nodata-signed");
  const from = base.query.qname;
  const to = `_owed.${domain}`;
  const renamed: DohFixture = {
    ...base,
    query: { ...base.query, domain, qname: to },
    responses: base.responses.map((r) => ({ ...r, url: r.url.replace(from, to), body: r.body.split(from).join(to) })),
  };
  return dohRoutes(withTxt(renamed, values));
}
