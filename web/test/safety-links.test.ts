// W2-E: QA-09 (links the plugin kept) and QA-13 (sanitizer cosmetics) on the server and pages, and the
// one TLD list the plugin, the server and the pages share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TLDS as PLUGIN_TLDS, clean } from "../../plugin/src/text.ts";
import { sanitizeText, WEB_TLDS } from "@/lib/safety";
import { cleanText, PAGE_TLDS } from "@/lib/view/text";

test("one TLD list: plugin, server and pages strip the same domains", () => {
  assert.equal(WEB_TLDS, PLUGIN_TLDS);
  assert.equal(PAGE_TLDS, PLUGIN_TLDS);
  const tlds = PLUGIN_TLDS.split("|");
  assert.equal(new Set(tlds).size, tlds.length, "no duplicates");
  for (const t of ["zip", "mov", "lol", "icu", "bond", "cyou", "sbs", "country", "fi", "claim", "com", "xyz"]) assert.ok(tlds.includes(t), t);
});

const LINKS = ["45.33.12.9/claim", "45.33.12.9:8080", "evil.zip", "claim.mov", "pay.lol", "wallet.icu", "refund.bond", "x.cyou", "airdrop.sbs", "verify.country"];

test("QA-09: bare IPv4 and newer TLDs are links everywhere", () => {
  for (const link of LINKS) {
    const raw = `claim at ${link} now`;
    assert.ok(!clean(raw, 140).includes(link), `plugin kept ${link}`);
    assert.ok(!(sanitizeText(raw, 140) ?? "").includes(link), `server kept ${link}`);
    assert.ok(!(cleanText(raw, 140) ?? "").includes(link), `page kept ${link}`);
  }
});

test("QA-09 control: decimals, versions, abbreviations and plain sentences are not links", () => {
  for (const text of ["dinner for 2.5 people, v1.2", "e.g. pizza, i.e. food", "U.S. trip", "St. Louis at 7.30 p.m.", "3.5.1 release"]) {
    assert.equal(clean(text, 140), text, `plugin: ${text}`);
    assert.equal(sanitizeText(text, 140), text, `server: ${text}`);
    assert.equal(cleanText(text, 140), text, `page: ${text}`);
  }
});

test("QA-13: a URL glued to a word takes only the URL, not the word", () => {
  const raw = "INV-99999999999999999999​https://evil.example/x";
  assert.equal(sanitizeText(raw, 40), "INV-99999999999999999999");
  assert.equal(clean(raw, 60), "INV-99999999999999999999[link removed]");
  assert.equal(sanitizeText("Hello-https://evil.example now", 60), "Hello- now");
  assert.equal(sanitizeText("web+evil://x and hxxps://y.example", 60), "and");
});

test("QA-13: the plugin's '[link removed]' stays readable on the server as '(link removed)'", () => {
  const fromPlugin = clean("Claim at https://a.example or www.b.example now", 140);
  assert.equal(fromPlugin, "Claim at [link removed] or [link removed] now");
  assert.equal(sanitizeText(fromPlugin, 140), "Claim at (link removed) or (link removed) now");
  assert.equal(sanitizeText("[link removed]", 40), "(link removed)");
});
