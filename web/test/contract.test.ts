import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { ZodType } from "zod";
import {
  CreateRequestBody,
  CreateRequestResponse,
  ErrorResponse,
  GetRequestResponse,
  StatsResponse,
  StatusBody,
  StatusRawBody,
  StatusRawResponse,
  StatusResponse,
} from "@/lib/contract";
import { LedgerBody, LedgerResponse } from "@/lib/contract";

const dir = new URL("../../contract/fixtures/", import.meta.url);

const SCHEMAS: Record<string, ZodType> = {
  "create-request.req.json": CreateRequestBody,
  "create-request.res.json": CreateRequestResponse,
  "error.res.json": ErrorResponse,
  "get-request.res.json": GetRequestResponse,
  "stats.res.json": StatsResponse,
  "status-raw.req.json": StatusRawBody,
  "status-raw.res.json": StatusRawResponse,
  "status.req.json": StatusBody,
  "status.res.json": StatusResponse,
  "ledger.req.json": LedgerBody,
  "ledger.res.json": LedgerResponse,
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
