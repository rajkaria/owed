import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { ZodType } from "zod";
import {
  CreateGroupBody,
  CreateInvoiceBody,
  InvoiceResponse,
  CreateRequestBody,
  CreateRequestResponse,
  ErrorResponse,
  GetRequestResponse,
  GroupResponse,
  StatsResponse,
  StatusBody,
  StatusRawBody,
  StatusRawResponse,
  StatusResponse,
} from "@/lib/contract";
import { LedgerBody, LedgerResponse } from "@/lib/contract";
import { CancelBody, CancelResponse } from "@/lib/contract"; // W3-C
import { CreateScheduleBody, ScheduleResponse } from "@/lib/contract"; // W3-D

const dir = new URL("../../contract/fixtures/", import.meta.url);

const SCHEMAS: Record<string, ZodType> = {
  "base.create-request.req.json": CreateRequestBody, // W3-B
  "base.create-request.res.json": CreateRequestResponse,
  "base.get-request.res.json": GetRequestResponse,
  "base.status.res.json": StatusResponse,
  "create-request.req.json": CreateRequestBody,
  "create-request.res.json": CreateRequestResponse,
  "error.res.json": ErrorResponse,
  "get-request.res.json": GetRequestResponse,
  "groups.create.req.json": CreateGroupBody,
  "groups.create.res.json": GroupResponse,
  "groups.get.res.json": GroupResponse,
  "stats.res.json": StatsResponse,
  "status-raw.req.json": StatusRawBody,
  "status-raw.res.json": StatusRawResponse,
  "status.req.json": StatusBody,
  "status.res.json": StatusResponse,
  "invoices.create.req.json": CreateInvoiceBody,
  "invoices.create.res.json": InvoiceResponse,
  "invoices.get.res.json": InvoiceResponse,
  "ledger.req.json": LedgerBody,
  "ledger.res.json": LedgerResponse,
  // W3-C
  "cancel.req.json": CancelBody,
  "cancel.res.json": CancelResponse,
  "status.ended.res.json": StatusResponse,
  // W3-D
  "ledger.schedules.req.json": LedgerBody,
  "ledger.schedules.res.json": LedgerResponse,
  "schedules.create.req.json": CreateScheduleBody,
  "schedules.create.res.json": ScheduleResponse,
  // local-currency asks
  "fiat.create-request.req.json": CreateRequestBody,
  "fiat.create-request.res.json": CreateRequestResponse,
  "fiat.get-request.res.json": GetRequestResponse,
  "fiat.status.res.json": StatusResponse,
  "fiat.ledger.res.json": LedgerResponse,
  "fiat.groups.create.req.json": CreateGroupBody,
  "fiat.groups.create.res.json": GroupResponse,
  "fiat.invoices.create.req.json": CreateInvoiceBody,
  "fiat.invoices.create.res.json": InvoiceResponse,
};

test("every contract fixture has a schema", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, Object.keys(SCHEMAS).sort());
});

for (const [file, schema] of Object.entries(SCHEMAS)) {
  test(`fixture ${file} parses`, () => {
    const data = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const result = schema.safeParse(data);
    assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  });
}

test("create body defaults token, kind and source", () => {
  const body = CreateRequestBody.parse({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", amount: "1" });
  assert.equal(body.token, "USDC");
  assert.equal(body.kind, "single");
  assert.equal(body.source, "web");
});

test("status body allows 1 to 20 ids", () => {
  assert.equal(StatusBody.safeParse({ ids: [] }).success, false);
  assert.equal(StatusBody.safeParse({ ids: Array(21).fill("JArQ6g9JvoWr") }).success, false);
  assert.equal(StatusBody.safeParse({ ids: Array(20).fill("JArQ6g9JvoWr") }).success, true);
});
