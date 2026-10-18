// F4 cash out against the real bundle, run the way PayBox runs it (fresh process, clean env, 10 s, network guard). The
// harness has no stub server, so these runs never reach a real Owed server: inputs the tool refuses on its own touch no
// network at all, and an unreachable Owed server (--down, a simulated outage) gives a clean refusal with no proposal.
// The server-answer paths (MoonPay's link, the deposit address, every mismatch) run against the same contract fixtures
// in plugin/test/cash_out.test.ts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));
const skip = !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built";
const WALLET = "SRxf5fukmnFADYWsdsCvUX2VJqTeZnmAU562yv38htT"; // contract/fixtures/cash-out.*.json (a throwaway key)
const BASE = "https://www.getowed.xyz";

test("real bundle: cash_out is listed, destructive, with no input that takes an address", { skip }, async () => {
  const report = await runE2E({ artifact: BUNDLE });
  assert.deepEqual(report.failures, []);
  const tool = report.tools.find((t) => t.name === "cash_out");
  assert.ok(tool, "cash_out is in tools/list");
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.equal(tool.outputSchema, true);
});

test("real bundle: amount and request_ids together are refused before any network", { skip }, async () => {
  const report = await runE2E({
    artifact: BUNDLE, tool: "cash_out", arguments: { wallet: WALLET, amount: "10", request_ids: ["JArQ6g9JvoWr"] },
    hosts: "none", expectError: true, expectNoProposal: true, expectTexts: ["not both", "Nothing was set up"],
  });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.call.network ?? [], []);
});

test("real bundle: call 1 with Owed's server unreachable is a clean refusal, nothing proposed", { skip }, async () => {
  const report = await runE2E({
    artifact: BUNDLE, tool: "cash_out", arguments: { wallet: WALLET, amount: "10" }, baseUrl: BASE, down: ["www.getowed.xyz"],
    expectError: true, expectNoProposal: true, expectTexts: ["couldn't be reached", "Nothing moved"],
  });
  assert.deepEqual(report.failures, []);
  assert.ok(report.call.network.every((n) => n.host === "www.getowed.xyz" && n.simulated), "only Owed's server is asked, never MoonPay");
});

test("real bundle: call 2 with Owed's server unreachable is a clean refusal, nothing proposed", { skip }, async () => {
  const report = await runE2E({
    artifact: BUNDLE, tool: "cash_out", arguments: { wallet: WALLET, cash_out_id: "Cq7wN2dXk9Hm", amount: "10" }, baseUrl: BASE, down: ["www.getowed.xyz"],
    expectError: true, expectNoProposal: true, expectTexts: ["Nothing moved"],
  });
  assert.deepEqual(report.failures, []);
});
