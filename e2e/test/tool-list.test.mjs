// The real bundle, run the way PayBox runs it, lists exactly the 13 Owed tools (11 submitted + F1's what_do_i_owe and
// pay_all), with no network during discovery.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));

test("real bundle: 13 tools, what_do_i_owe and pay_all among them", { skip: !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built" }, async () => {
  const listed = await runE2E({ artifact: BUNDLE });
  assert.deepEqual(listed.failures, []);
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
    "ask_every_month", "ask_for_money", "cancel_request", "check_payments", "create_invoice", "match_payments", "pay_all", "pay_link",
    "split_bill", "verify_payee", "what_do_i_owe", "who_owes_me", "write_reminder",
  ]);
});
