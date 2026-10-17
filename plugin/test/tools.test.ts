import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { proposeSolana, proposeX402, solanaOutputSchema, x402OutputSchema } from "../src/paybox.ts";
import { tools } from "../src/tools/index.ts";

interface Registered { name: string; config: any; handler: unknown }

function registerAll(): Map<string, Registered> {
  const seen = new Map<string, Registered>();
  const server = { registerTool: (name: string, config: unknown, handler: unknown) => { seen.set(name, { name, config, handler }); } };
  for (const register of tools) register(server as unknown as McpServer);
  return seen;
}

test("index registers the Owed tools", () => {
  assert.deepEqual([...registerAll().keys()], [
    "ask_for_money", "check_payments", "pay_link", "verify_payee", "split_bill", "create_invoice", "write_reminder", "who_owes_me",
    "cancel_request", // W3-C
    "ask_every_month", // W3-D
  ]);
});

test("annotations are exactly the SPEC §5.1 hints", () => {
  const seen = registerAll();
  assert.deepEqual(seen.get("ask_for_money")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(seen.get("check_payments")!.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(seen.get("pay_link")!.config.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(seen.get("verify_payee")!.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(seen.get("split_bill")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(seen.get("create_invoice")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(seen.get("write_reminder")!.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  // Not idempotent: each signed message unlocks the ledger once.
  assert.deepEqual(seen.get("who_owes_me")!.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  // W3-C: cancelling ends a request (destructive); cancelling twice changes nothing (idempotent).
  assert.deepEqual(seen.get("cancel_request")!.config.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  // W3-D: creates a schedule (and maybe this month's request) each call, like ask_for_money.
  assert.deepEqual(seen.get("ask_every_month")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
});

test("schemas convert to strict JSON Schema; pay_link outputs the starter's Solana or x402 proposal", () => {
  const seen = registerAll();
  for (const name of ["ask_for_money", "check_payments", "pay_link", "verify_payee", "split_bill", "create_invoice", "write_reminder", "who_owes_me", "cancel_request", "ask_every_month"]) {
    const { config } = seen.get(name)!;
    const input = z.toJSONSchema(config.inputSchema, { io: "input" }) as { additionalProperties?: boolean; required?: string[] };
    assert.equal(input.additionalProperties, false, `${name} input must be strict`);
    const output = z.toJSONSchema(config.outputSchema, { io: "output" });
    assert.ok(Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(JSON.stringify(output)) < 64 * 1024);
    assert.ok(config.title && config.description.length > 80, `${name} needs a description that speaks to the agent`);
    assert.match(config.description, /list_credentials|check_payments|ask_for_money|pay_link|request_wallet_sign/);
  }
  // rail solana_pay proposes a Solana transaction, rail x402 an x402 payment (SPEC §5.2): exactly the starter's two shapes.
  const payOutput = seen.get("pay_link")!.config.outputSchema;
  const solana = proposeSolana({ transactionBase64: Buffer.alloc(200, 1).toString("base64") }).structuredContent;
  const x402 = proposeX402({ chain: "solana:mainnet", url: "https://owed-omega.vercel.app/x/JArQ6g9JvoWr", maxAmount: "10000" }).structuredContent;
  assert.deepEqual(payOutput.parse(solana), solanaOutputSchema.parse(solana));
  assert.deepEqual(payOutput.parse(x402), x402OutputSchema.parse(x402));
  assert.equal(payOutput.safeParse({ ...solana, extra: 1 }).success, false);
  const askInput = z.toJSONSchema(seen.get("ask_for_money")!.config.inputSchema, { io: "input" }) as { required?: string[] };
  assert.deepEqual(askInput.required?.sort(), ["amount", "recipient"]);
});

test("registering tools touches no network and no clock", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = (() => { throw new Error("network during registration"); }) as typeof fetch;
  Date.now = () => { throw new Error("clock during registration"); };
  try {
    registerAll();
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});
