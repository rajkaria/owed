import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeParam, neonEndpoint, pgTextArray, toRows } from "@/lib/db";

test("endpoint is the regional api host, pooled or direct", () => {
  assert.equal(
    neonEndpoint("postgresql://u:p@ep-cool-darkness-a1b2c3d4-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require"),
    "https://api.us-east-1.aws.neon.tech/sql",
  );
  assert.equal(
    neonEndpoint("postgres://u:p@ep-cool-darkness-a1b2c3d4.us-east-1.aws.neon.tech/neondb"),
    "https://api.us-east-1.aws.neon.tech/sql",
  );
});

test("params encode as Postgres text", () => {
  assert.equal(encodeParam(null), null);
  assert.equal(encodeParam("x"), "x");
  assert.equal(encodeParam(123456789012345678901234567890n), "123456789012345678901234567890");
  assert.equal(encodeParam(true), "true");
  assert.equal(encodeParam(7), "7");
  assert.equal(encodeParam([]), "{}");
  assert.equal(pgTextArray(["brand_word:moonpay", "brand_word:solana foundation", 'q"\\']), '{"brand_word:moonpay","brand_word:solana foundation","q\\"\\\\"}');
});

test("array-mode results become objects of text values", () => {
  // Shape of a real response from the Neon SQL-over-HTTP endpoint (captured 2026-10-17).
  const rows = toRows({
    fields: [
      { name: "id", dataTypeID: 25 },
      { name: "amount_atomic", dataTypeID: 1700 },
      { name: "paid_at", dataTypeID: 25 },
    ],
    rows: [
      ["JArQ6g9JvoWr", "15000000", null],
      ["Bq3wL8mNc2", "4500000", "2026-10-17T05:00:09Z"],
    ],
  });
  assert.deepEqual(rows, [
    { id: "JArQ6g9JvoWr", amount_atomic: "15000000", paid_at: null },
    { id: "Bq3wL8mNc2", amount_atomic: "4500000", paid_at: "2026-10-17T05:00:09Z" },
  ]);
});
