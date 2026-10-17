// Text that next/og (Satori) can draw as written. Satori lays every line out left to right with no
// bidi pass, so Hebrew or Arabic comes out letter-reversed (and Arabic unjoined), and invisible or
// variation-selector characters draw as tofu boxes (QA-17). A card leaves such a line off rather than
// print something the requester didn't write; the pay page still shows the text, quoted.

/** Blocks of right-to-left scripts: Hebrew through Arabic Extended-A, their presentation forms, and the SMP RTL blocks. */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/** Invisible or layout-only characters: default-ignorables (zero-width, bidi controls, variation selectors, tags), controls, private use. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Co}]/u;

/** The text unchanged when a card can draw it faithfully, otherwise null. */
export function cardText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (RTL.test(text) || INVISIBLE.test(text)) return null;
  return text;
}
