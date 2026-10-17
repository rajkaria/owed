// QA-21 (Low): the server's from_domain re-check (web/lib/payee.ts PAYEE_BUDGET_MS = 2 × 2.5 s) can
// outlast the plugin's API timeout (plugin/src/api.ts API_TIMEOUT_MS = 4 s). When Cloudflare's DoH is
// slow from Vercel, POST /requests (or /groups, /invoices) keeps going past 4 s: the plugin gives up,
// hands out an OFFLINE link with no domain ("payers will see this one as unverified") even though its own
// DNS check just passed, and the server still writes a verified hosted row nobody gets.
// Owner: W2-H (server budget for the re-check). Run: command node e2e/qa/run.mjs QA-21
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAYEE_BUDGET_MS } from "@/lib/payee";

const pluginApi = readFileSync(new URL("../../../plugin/src/api.ts", import.meta.url), "utf8");
const API_TIMEOUT_MS = Number(/export const API_TIMEOUT_MS = (\d+)/.exec(pluginApi)?.[1]);

test("QA-21 the server's DNS re-check plus a DB round trip fits inside the plugin's API timeout", () => {
  assert.ok(Number.isFinite(API_TIMEOUT_MS), "API_TIMEOUT_MS not found in plugin/src/api.ts");
  const headroomMs = 1000; // rate-limit slot + insert + TLS on a cold function
  assert.ok(PAYEE_BUDGET_MS + headroomMs <= API_TIMEOUT_MS,
    `server re-check budget ${PAYEE_BUDGET_MS} ms + ${headroomMs} ms > plugin timeout ${API_TIMEOUT_MS} ms`);
});
