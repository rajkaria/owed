// The real bundle, run the way PayBox runs it, lists exactly the tools the registry (plugin/src/tools/index.ts) registers,
// with no network during discovery: the 11 submitted at cecfbd2, F1's what_do_i_owe and pay_all, and every tool a
// later sprint appends (F6 ledger: start_ledger, add_expense, ledger_balances, settle_up; F8: refund_payment). The expected names are read
// from the registry's source, so a sprint that adds a tool updates this test by registering it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));
const TOOLS = new URL("../../plugin/src/tools/", import.meta.url);

/** Tool names registered by plugin/src/tools/index.ts: each module it lists in `tools`, and that module's registerTool name. */
function registeredToolNames() {
  const index = readFileSync(new URL("index.ts", TOOLS), "utf8");
  const modules = new Map([...index.matchAll(/import \{ register as (\w+) \} from "\.\/([\w-]+)\.js";/g)].map((m) => [m[1], m[2]]));
  const list = /export const tools[^\n]*\[\n([\s\S]*?)\n\];/.exec(index)?.[1] ?? "";
  const entries = [...list.matchAll(/^\s*(\w+),/gm)].map((m) => m[1]);
  return entries.map((entry) => {
    const file = modules.get(entry);
    assert.ok(file, `tools entry ${entry} has no import`);
    const name = /registerTool\(\s*"([a-z_]+)"/.exec(readFileSync(new URL(`${file}.ts`, TOOLS), "utf8"))?.[1];
    assert.ok(name, `${file}.ts registers no tool`);
    return name;
  });
}

test("the registry lists the 11 submitted tools, F1's two, F6's four and F8's refund_payment", () => {
  const names = registeredToolNames();
  for (const name of [
    "ask_every_month", "ask_for_money", "cancel_request", "check_payments", "create_invoice", "match_payments", "pay_link", "split_bill",
    "verify_payee", "who_owes_me", "write_reminder", "what_do_i_owe", "pay_all", // F1
    "start_ledger", "add_expense", "ledger_balances", "settle_up", // F6 ledger
    "refund_payment", // F8 invoices
    "start_pot", // F7 pots
  ]) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length, "no tool is registered twice");
});

test("real bundle: exactly the registry's tools", { skip: !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built" }, async () => {
  const listed = await runE2E({ artifact: BUNDLE });
  assert.deepEqual(listed.failures, []);
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), registeredToolNames().sort());
});
