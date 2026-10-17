import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type * as z from "zod/v4";
import {
  createRequestReqSchema, createRequestResSchema, errorResSchema, getRequestResSchema, statsResSchema,
  statusRawReqSchema, statusRawResSchema, statusReqSchema, statusResSchema,
} from "../src/contract.ts";
import { fixture } from "./helpers.ts";

const SCHEMAS: Record<string, z.ZodType> = {
  "create-request.req.json": createRequestReqSchema,
  "create-request.res.json": createRequestResSchema,
  "error.res.json": errorResSchema,
  "get-request.res.json": getRequestResSchema,
  "stats.res.json": statsResSchema,
  "status-raw.req.json": statusRawReqSchema,
  "status-raw.res.json": statusRawResSchema,
  "status.req.json": statusReqSchema,
  "status.res.json": statusResSchema,
};

const files = readdirSync(fileURLToPath(new URL("../../contract/fixtures/", import.meta.url))).filter((f) => f.endsWith(".json")).sort();

test("every contract fixture has a schema", () => {
  assert.deepEqual(files, Object.keys(SCHEMAS).sort());
});

for (const file of files) {
  test(`contract: ${file} parses with every field covered`, () => {
    const data = fixture(file);
    // Parsing must not drop a single key: the schema covers the whole fixture.
    assert.deepEqual(SCHEMAS[file]!.parse(data), data);
  });
}

test("contract: responses tolerate additive fields, requests stay strict", () => {
  const res = { ...fixture("create-request.res.json"), new_field: 1 };
  assert.equal(createRequestResSchema.safeParse(res).success, true);
  const req = { ...fixture("create-request.req.json"), extra: 1 };
  assert.equal(createRequestReqSchema.safeParse(req).success, false);
});

test("contract: rejects bad money, tokens, statuses and error codes", () => {
  const res = fixture("status.res.json");
  const bad = (patch: object) => statusResSchema.safeParse({ results: [{ ...res.results[0], ...patch }] }).success;
  assert.equal(bad({ amount_requested: "15.0.0" }), false);
  assert.equal(bad({ amount_requested: "-1" }), false);
  assert.equal(bad({ amount_requested: 15 }), false);
  assert.equal(bad({ token: "BONK" }), false);
  assert.equal(bad({ status: "maybe" }), false);
  assert.equal(bad({ id: "short" }), false);
  assert.equal(errorResSchema.safeParse({ error: { code: "teapot", message: "x" } }).success, false);
  assert.equal(statusReqSchema.safeParse({ ids: [] }).success, false);
  assert.equal(statusReqSchema.safeParse({ ids: Array(21).fill("7Gh2kQpXa9") }).success, false);
});

test("contract: get-request accepts nulls for absent requester text", () => {
  const data = { ...fixture("get-request.res.json"), payer_name: null, for: null, note: null, requester_name: null, paid: null, status: "open" };
  assert.equal(getRequestResSchema.safeParse(data).success, true);
});
