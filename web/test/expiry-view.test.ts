import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyStatus, boardFromGroup, progress, unsettledIds } from "@/app/g/[id]/model";
import { invoiceDescription, invoiceModel } from "@/app/i/[id]/model";
import type { PublicGroup } from "@/lib/groups";
import type { PublicInvoice } from "@/lib/invoices";
import type { PublicRequest } from "@/lib/public-api";
import { modelFromRequest, pageDescription, stateFromRequest, stateFromStatus } from "@/lib/view/request-view";

// W3-C: how the pay page, the split board and the invoice render cancelled and expired requests. Pure view
// models over the contract fixtures (contract/fixtures/cancel.res.json, status.ended.res.json and the group
// and invoice fixtures with an ended status patched in).

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8")) as T;
const ORIGIN = "https://www.getowed.xyz";

test("status results: cancelled and expired stop the poll with when they ended; unknown times are left out", () => {
  const { results } = fixture<{ results: Array<Record<string, string>> }>("status.ended.res.json");
  assert.deepEqual(stateFromStatus(results[0], "0.5", "USDC"), { status: "expired", at: "2026-10-17T09:00:00Z" });
  assert.deepEqual(stateFromStatus(results[1], "15", "USDC"), { status: "cancelled", at: "2026-10-17T14:02:13Z" });
  assert.deepEqual(stateFromStatus({ status: "expired" }, "1", "USDC"), { status: "expired" });
  assert.deepEqual(stateFromStatus({ status: "cancelled", cancelled_at: "not a time" }, "1", "USDC"), { status: "cancelled" });
});

test("pay page: a cancelled request renders as cancelled with its time and its preview never invites a payment", () => {
  const req = fixture<PublicRequest>("cancel.res.json");
  const model = modelFromRequest(req, ORIGIN);
  assert.deepEqual(model.initial, { status: "cancelled", at: "2026-10-17T14:02:13Z" });
  assert.equal(model.expiresAt, "2026-10-24T13:40:00Z");
  assert.equal(pageDescription(model), "This request was cancelled. Don't send money to it.");
});

test("pay page: an expired request, and an open one that will expire", () => {
  const req = fixture<PublicRequest>("cancel.res.json");
  const expired = { ...req, status: "expired", cancelled: null } as PublicRequest;
  assert.deepEqual(stateFromRequest(expired), { status: "expired", at: "2026-10-24T13:40:00Z" });
  assert.equal(pageDescription(modelFromRequest(expired, ORIGIN)), "This request has expired and no longer takes payments.");
  const open = modelFromRequest({ ...req, status: "open", cancelled: null } as PublicRequest, ORIGIN);
  assert.deepEqual(open.initial, { status: "open" });
  assert.equal(open.expiresAt, "2026-10-24T13:40:00Z");
  assert.match(pageDescription(open), /^15 USDC for “dinner”\. Pay with any Solana wallet/);
});

test("board: an expired share stops being polled, shows as expired, and counts as done", () => {
  const group = fixture<PublicGroup>("groups.create.res.json");
  const withExpiry = { ...group, expires_at: "2026-10-24T07:30:00Z" };
  const m = boardFromGroup(withExpiry, ORIGIN);
  assert.equal(m.expiresAt, "2026-10-24T07:30:00Z");
  const [a, b, c] = m.shares.map((s) => s.id);
  const next = applyStatus(m, { results: [
    { id: a, status: "expired", amount_requested: "0.5", token: "USDC", expires_at: "2026-10-24T07:30:00Z" },
    { id: b, status: "cancelled", amount_requested: "0.5", token: "USDC" },
    { id: c, status: "paid", amount_requested: "0.5", token: "USDC", amount_paid: "0.5", payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", paid_at: "2026-10-17T08:00:00Z" },
  ] });
  assert.deepEqual(next.shares.map((s) => s.status), ["expired", "cancelled", "paid"]);
  assert.deepEqual(unsettledIds(next), []);
  const p = progress(next);
  assert.equal(p.done, true);
  assert.equal(p.paid, 1);
  // A later poll can't move an expired share anywhere.
  assert.equal(applyStatus(next, { results: [{ id: a, status: "open", amount_requested: "0.5", token: "USDC" }] }), next);
  assert.equal(boardFromGroup({ ...group, shares: group.shares.map((s) => ({ ...s, status: "expired" as const })) }, ORIGIN).shares[0]!.status, "expired");
});

test("invoice: expired and cancelled invoices show as such, with no payment invited in the preview", () => {
  const inv = fixture<PublicInvoice>("invoices.create.res.json");
  const now = Date.parse("2026-10-18T12:00:00Z");
  const expired = invoiceModel({ ...inv, status: "expired", expires_at: "2026-10-18T05:00:00Z" }, now);
  assert.deepEqual(expired.initial, { status: "expired", at: "2026-10-18T05:00:00Z" });
  assert.equal(invoiceDescription(expired), "Invoice for 1 USDC: expired, no longer payable.");
  const cancelled = invoiceModel({ ...inv, status: "cancelled", cancelled_at: "2026-10-17T06:00:00Z" }, now);
  assert.deepEqual(cancelled.initial, { status: "cancelled", at: "2026-10-17T06:00:00Z" });
  assert.equal(invoiceDescription(cancelled), "Invoice for 1 USDC: cancelled. Don't send money for it.");
  const open = invoiceModel({ ...inv, expires_at: "2026-11-01T05:00:00Z" }, now);
  assert.equal(open.expiresAt, "2026-11-01T05:00:00Z");
  assert.deepEqual(open.initial, { status: "open" });
});
