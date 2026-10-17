import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAID_ON, REFUSALS } from "@/app/proof/refusals";
import { isRequestId } from "@/lib/ids";

// /proof's "What Owed refuses" and "Paid on" rows are static claims. Each must still be backed by the FACTS.md
// line it was taken from, link only to explorers, its own pages or this repo, and never claim more than FACTS says.

const FACTS = readFileSync(new URL("../../docs/FACTS.md", import.meta.url), "utf8");
const EXTERNAL = ["https://solscan.io/tx/", "https://basescan.org/tx/", "https://dns.google/resolve?", "https://github.com/rajkaria/owed/blob/"];

test("every row's phrase still appears in docs/FACTS.md", () => {
  for (const row of [...REFUSALS, ...PAID_ON]) assert.ok(FACTS.includes(row.facts), `not in FACTS.md: ${row.facts}`);
});

test("evidence links go to an explorer, DNS, this repo or Owed's own request pages", () => {
  const hrefs = [...REFUSALS.flatMap((r) => r.evidence), ...PAID_ON.map((p) => p.tx)].map((e) => e.href);
  for (const href of hrefs) {
    if (href.startsWith("/r/")) assert.ok(isRequestId(href.slice(3)), href);
    else assert.ok(EXTERNAL.some((p) => href.startsWith(p)), href);
  }
  for (const p of PAID_ON) assert.ok(isRequestId(p.requestId), p.requestId);
});

test("each explorer link names a transaction FACTS.md records", () => {
  const txs = [...REFUSALS.flatMap((r) => r.evidence), ...PAID_ON.map((p) => p.tx)]
    .map((e) => e.href.match(/^https:\/\/(?:solscan\.io|basescan\.org)\/tx\/(.+)$/)?.[1])
    .filter((t): t is string => Boolean(t));
  assert.ok(txs.length >= 5);
  // FACTS.md records some signatures by their first 8 characters only (line 53).
  for (const tx of txs) assert.ok(FACTS.includes(tx) || FACTS.includes(`${tx.slice(0, 8)}…`), tx);
});

test("unit-test rows link to a test and claim nothing else; GitHub links pin a commit", () => {
  for (const r of REFUSALS) {
    assert.ok(r.observed.length > 0 && r.evidence.length > 0, r.scenario);
    for (const e of r.evidence.filter((e) => e.href.includes("github.com")))
      assert.match(e.href, /^https:\/\/github\.com\/rajkaria\/owed\/blob\/[0-9a-f]{40}\/(web|plugin)\/test\/[\w.-]+\.test\.ts#L\d+$/);
    if (r.observed.includes("unit test")) {
      assert.deepEqual(r.observed, ["unit test"], r.scenario);
      assert.ok(r.evidence.every((e) => e.href.includes("/test/")), r.scenario);
    }
  }
  // The swapped-terms check (FACTS.md line 61) is a unit test, never a production observation.
  const swap = REFUSALS.find((r) => r.scenario.includes("swaps"));
  assert.deepEqual(swap?.observed, ["unit test"]);
});

test("Phantom is named only beside the payment FACTS.md records it for", () => {
  const text = JSON.stringify([REFUSALS, PAID_ON]);
  assert.equal(text.split("Phantom").length - 1, 1);
  assert.match(FACTS, /Solana Pay by wallet QR \(Phantom/);
  assert.equal(PAID_ON.find((p) => p.via.includes("Phantom"))?.requestId, "qNaosx73zzt3");
});
