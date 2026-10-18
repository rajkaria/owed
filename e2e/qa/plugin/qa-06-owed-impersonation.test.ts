// QA-06 (High), plugin half: pay_link's caution line comes from the server's flags plus plugin
// brandFlags(); neither knows "Owed", so a raw solana: link labelled "Owed Support" gets no caution.
// Owner: W2-E / LEAD (plugin/src/text.ts). Run: command node e2e/qa/run.mjs QA-06
import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFlags } from "../../../plugin/src/text.ts";

for (const name of ["Owed Support", "Owed team", "Owed Security", "getowed billing", "Anthropic"]) {
  test(`QA-06 plugin brandFlags flags "${name}"`, () => {
    assert.ok(brandFlags(name).length > 0, `no flag for ${name}`);
  });
}

test("QA-06 no false alarm on the ordinary word: 'money owed for dinner'", () => {
  assert.deepEqual(brandFlags("money owed for dinner"), []);
});
