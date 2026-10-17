import { test } from "node:test";
import assert from "node:assert/strict";
import { TOKENS } from "../src/money.ts";

test("token table", () => {
  assert.equal(TOKENS.USDC.decimals, 6);
  assert.equal(TOKENS.SOL.mint, null);
});
