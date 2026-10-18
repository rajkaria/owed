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
    "match_payments", // 0012
    "what_do_i_owe", "pay_all", // F1
    "start_ledger", "add_expense", "ledger_balances", "settle_up", // F6 ledger
    "refund_payment", // F8 invoices
    "start_pot", // F7 pots
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
  // F8 invoices: a refund sends money out of the user's wallet (destructive); each one is new (not idempotent).
  assert.deepEqual(seen.get("refund_payment")!.config.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  // F7 pots: each call starts a new pot (not idempotent); a pot moves no money (not destructive).
  assert.deepEqual(seen.get("start_pot")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  // 0012: confirm records a match and ask_for_rest makes a request (not read-only); doing either twice changes nothing more.
  assert.deepEqual(seen.get("match_payments")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  // F1: the inbox needs a fresh signature each time and can block a requester; pay_all moves money like pay_link.
  assert.deepEqual(seen.get("what_do_i_owe")!.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(seen.get("pay_all")!.config.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});

test("schemas convert to strict JSON Schema; pay_link outputs the starter's Solana or x402 proposal", () => {
  const seen = registerAll();
  for (const name of ["ask_for_money", "check_payments", "pay_link", "verify_payee", "split_bill", "create_invoice", "write_reminder", "who_owes_me", "cancel_request", "ask_every_month", "match_payments", "what_do_i_owe", "pay_all"]) {
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
  // F1: pay_all proposes exactly the starter's Solana shape, nothing else.
  const payAllOutput = seen.get("pay_all")!.config.outputSchema;
  assert.deepEqual(payAllOutput.parse(solana), solanaOutputSchema.parse(solana));
  assert.equal(payAllOutput.safeParse(x402).success, false);
  assert.equal(payAllOutput.safeParse({ ...solana, remaining: [] }).success, false);
  const payAllInput = z.toJSONSchema(seen.get("pay_all")!.config.inputSchema, { io: "input" }) as { required?: string[] };
  assert.deepEqual(payAllInput.required?.sort(), ["ids", "max_total", "sender"]);
  // Every asking tool takes payer and requester_handle, and says to resolve the handle with PayBox first.
  for (const name of ["ask_for_money", "split_bill", "create_invoice", "ask_every_month"]) {
    const input = JSON.stringify(z.toJSONSchema(seen.get(name)!.config.inputSchema, { io: "input" }));
    assert.match(input, /resolve_username/, name);
    assert.match(input, /requester_handle/, name);
  }
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
