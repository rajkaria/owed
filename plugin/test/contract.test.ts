import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type * as z from "zod/v4";
import {
  createGroupReqSchema, createRequestReqSchema, createRequestResSchema, errorResSchema, getRequestResSchema, groupResSchema,
  statsResSchema, statusRawReqSchema, statusRawResSchema, statusReqSchema, statusResSchema,
  createInvoiceReqSchema, invoiceResSchema,
} from "../src/contract.ts";
import { ledgerReqSchema, ledgerResSchema } from "../src/contract.ts";
import { cancelReqSchema, cancelResSchema } from "../src/contract.ts"; // W3-C
import { createScheduleReqSchema, scheduleResSchema } from "../src/contract.ts"; // W3-D
import { attributedReqSchema, attributedResSchema, matchReqSchema, matchResSchema, restReqSchema, restResSchema } from "../src/contract.ts"; // 0012
import { bulkRequestsResSchema, inboxBlockReqSchema, inboxBlockResSchema, inboxReqSchema, inboxResSchema } from "../src/contract.ts"; // F1
import { createPlanReqSchema, createPlanResSchema, fundingPlanDocSchema, planStatsResSchema, planUsedReqSchema, planUsedResSchema } from "../src/contract.ts"; // F2
import { addExpenseReqSchema, addExpenseResSchema, createGroupLedgerReqSchema, groupLedgerResSchema, settleUpReqSchema, settleUpResSchema } from "../src/contract.ts"; // F6 ledger
import { createInvoiceTermsReqSchema, createRefundReqSchema, createRefundResSchema, invoiceTermsResSchema, ledgerResF8Schema, refundResSchema, refundsLookupResSchema, statementResSchema } from "../src/contract.ts"; // F8 invoices
import { alertTokenReqSchema, confirmAlertResSchema, createAlertReqSchema, createAlertResSchema, unsubscribeAlertResSchema } from "../src/contract.ts"; // S1 alerts
import { cashOutResSchema, createCashOutReqSchema } from "../src/contract.ts"; // F4 cash out
import { autopayCreateReqSchema, autopayCreateResSchema, autopayRevokeReqSchema, autopayRevokeResSchema } from "../src/contract.ts"; // F5 autopay
import { fixture } from "./helpers.ts";

const SCHEMAS: Record<string, z.ZodType> = {
  "base.create-request.req.json": createRequestReqSchema, // W3-B
  "base.create-request.res.json": createRequestResSchema,
  "base.get-request.res.json": getRequestResSchema,
  "base.status.res.json": statusResSchema,
  "create-request.req.json": createRequestReqSchema,
  "create-request.res.json": createRequestResSchema,
  "error.res.json": errorResSchema,
  "get-request.res.json": getRequestResSchema,
  "groups.create.req.json": createGroupReqSchema,
  "groups.create.res.json": groupResSchema,
  "groups.get.res.json": groupResSchema,
  "stats.res.json": statsResSchema,
  "status-raw.req.json": statusRawReqSchema,
  "status-raw.res.json": statusRawResSchema,
  "status.req.json": statusReqSchema,
  "status.res.json": statusResSchema,
  "invoices.create.req.json": createInvoiceReqSchema,
  "invoices.create.res.json": invoiceResSchema,
  "invoices.get.res.json": invoiceResSchema,
  "ledger.req.json": ledgerReqSchema,
  "ledger.res.json": ledgerResSchema,
  // W3-C
  "cancel.req.json": cancelReqSchema,
  "cancel.res.json": cancelResSchema,
  "status.ended.res.json": statusResSchema,
  // W3-D
  "ledger.schedules.req.json": ledgerReqSchema,
  "ledger.schedules.res.json": ledgerResSchema,
  "schedules.create.req.json": createScheduleReqSchema,
  "schedules.create.res.json": scheduleResSchema,
  // 0012 matched payments
  "match.req.json": matchReqSchema,
  "match.res.json": matchResSchema,
  "match.rest.res.json": matchResSchema,
  "rest.req.json": restReqSchema,
  "rest.res.json": restResSchema,
  "attributed.req.json": attributedReqSchema,
  "attributed.res.json": attributedResSchema,
  "status.matched.res.json": statusResSchema,
  // local-currency asks
  "fiat.create-request.req.json": createRequestReqSchema,
  "fiat.create-request.res.json": createRequestResSchema,
  "fiat.get-request.res.json": getRequestResSchema,
  "fiat.status.res.json": statusResSchema,
  "fiat.ledger.res.json": ledgerResSchema,
  "fiat.groups.create.req.json": createGroupReqSchema,
  "fiat.groups.create.res.json": groupResSchema,
  "fiat.invoices.create.req.json": createInvoiceReqSchema,
  "fiat.invoices.create.res.json": invoiceResSchema,
  // W3-S
  "sns.create-request.req.json": createRequestReqSchema,
  "sns.create-request.res.json": createRequestResSchema,
  "sns.get-request.res.json": getRequestResSchema,
  // F1 payer inbox
  "payer.create-request.req.json": createRequestReqSchema,
  "payer.create-request.res.json": createRequestResSchema,
  "payer.get-request.res.json": getRequestResSchema,
  "payer.groups.create.req.json": createGroupReqSchema,
  "payer.groups.create.res.json": groupResSchema,
  "payer.invoices.create.req.json": createInvoiceReqSchema,
  "payer.invoices.create.res.json": invoiceResSchema,
  "payer.schedules.create.req.json": createScheduleReqSchema,
  "payer.schedules.create.res.json": scheduleResSchema,
  "inbox.req.json": inboxReqSchema,
  "inbox.res.json": inboxResSchema,
  "inbox.block.req.json": inboxBlockReqSchema,
  "inbox.block.res.json": inboxBlockResSchema,
  "requests.bulk.res.json": bulkRequestsResSchema,
  // F2 funding plans
  "plans.create.req.json": createPlanReqSchema,
  "plans.create.res.json": createPlanResSchema,
  "plans.used.req.json": planUsedReqSchema,
  "plans.used.res.json": planUsedResSchema,
  "plans.stats.res.json": planStatsResSchema,
  "funding-plan.swap.json": fundingPlanDocSchema,
  "funding-plan.buy.json": fundingPlanDocSchema,
  "funding-plan.fee.json": fundingPlanDocSchema,
  "funding-plan.pay-all.json": fundingPlanDocSchema,
  // F6 ledger
  "ledgers.create.req.json": createGroupLedgerReqSchema,
  "ledgers.create.res.json": groupLedgerResSchema,
  "ledgers.get.res.json": groupLedgerResSchema,
  "ledgers.expense.req.json": addExpenseReqSchema,
  "ledgers.expense.res.json": addExpenseResSchema,
  "ledgers.expense.fiat.req.json": addExpenseReqSchema,
  "ledgers.expense.fiat.res.json": addExpenseResSchema,
  "ledgers.settle.req.json": settleUpReqSchema,
  "ledgers.settle.res.json": settleUpResSchema,
  // F8 invoices
  "invoice.terms.create.req.json": createInvoiceTermsReqSchema,
  "invoice.terms.create.res.json": invoiceTermsResSchema,
  "invoice.terms.get.res.json": invoiceTermsResSchema,
  "invoice.terms.child.res.json": invoiceTermsResSchema,
  "invoice.statement.res.json": statementResSchema,
  "refund.create.req.json": createRefundReqSchema,
  "refund.create.res.json": createRefundResSchema,
  "refund.get.res.json": refundResSchema,
  "refunds.lookup.res.json": refundsLookupResSchema,
  // S1 alerts (server-only routes; mirrored so both sides parse every fixture)
  "alerts.create.telegram.req.json": createAlertReqSchema,
  "alerts.create.telegram.res.json": createAlertResSchema,
  "alerts.create.email.req.json": createAlertReqSchema,
  "alerts.create.email.res.json": createAlertResSchema,
  "alerts.confirm.req.json": alertTokenReqSchema,
  "alerts.confirm.res.json": confirmAlertResSchema,
  "alerts.unsubscribe.req.json": alertTokenReqSchema,
  "alerts.unsubscribe.res.json": unsubscribeAlertResSchema,
  // F4 cash out
  "cash-out.create.req.json": createCashOutReqSchema,
  "cash-out.create.res.json": cashOutResSchema,
  "cash-out.status.res.json": cashOutResSchema,
  "cash-out.enterprise.res.json": cashOutResSchema,
  // F3 bank rail: a request paid by bank transfer (paid.rail "bank_transfer")
  "bank.get-request.res.json": getRequestResSchema,
  // F5 autopay + F3 deposit link
  "autopay.create.req.json": autopayCreateReqSchema,
  "autopay.create.res.json": autopayCreateResSchema,
  "autopay.revoke.req.json": autopayRevokeReqSchema,
  "autopay.revoke.res.json": autopayRevokeResSchema,
  "autopay.inbox.req.json": inboxReqSchema,
  "autopay.inbox.res.json": inboxResSchema,
  "autopay.requests.bulk.res.json": bulkRequestsResSchema,
  "deposit.create-request.req.json": createRequestReqSchema,
  "deposit.create-request.res.json": createRequestResSchema,
  "deposit.get-request.res.json": getRequestResSchema,
  "deposit.status.res.json": statusResSchema,
  "deposit.invoices.create.req.json": createInvoiceReqSchema,
  "deposit.invoices.create.res.json": invoiceResSchema,
};

// F5/F3: older replies (no autopay, no deposit link) still parse; the request bodies stay strict.
test("F5/F3: optional autopay and deposit fields, strict bodies", () => {
  assert.equal(inboxResSchema.parse(fixture("inbox.res.json")).autopay_rules, undefined);
  assert.equal(createRequestReqSchema.safeParse({ ...fixture("deposit.create-request.req.json"), deposit_link: true }).success, false);
  assert.equal(autopayCreateReqSchema.safeParse({ ...fixture("autopay.create.req.json"), extra: 1 }).success, false);
  assert.equal(createInvoiceTermsReqSchema.safeParse(fixture("deposit.invoices.create.req.json")).success, true);
  assert.equal(invoiceTermsResSchema.parse(fixture("deposit.invoices.create.res.json")).deposit_url, "https://deposit.paybox.sh/d/7f3a9c2e");
});

// F8 invoices: the existing invoice and ledger fixtures parse with the terms-aware schemas too (every F8 field is optional).
test("F8: existing invoice and ledger fixtures parse with the terms-aware schemas", () => {
  for (const file of ["invoices.create.res.json", "invoices.get.res.json", "fiat.invoices.create.res.json", "payer.invoices.create.res.json"]) {
    assert.ok(invoiceTermsResSchema.safeParse(fixture(file)).success, file);
  }
  for (const file of ["invoices.create.req.json", "fiat.invoices.create.req.json", "payer.invoices.create.req.json"]) {
    assert.ok(createInvoiceTermsReqSchema.safeParse({ ...fixture(file), source: "plugin" }).success, file);
  }
  for (const file of ["ledger.res.json", "ledger.schedules.res.json", "fiat.ledger.res.json"]) assert.ok(ledgerResF8Schema.safeParse(fixture(file)).success, file);
});

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
  assert.equal(statusReqSchema.safeParse({ ids: Array(21).fill("JArQ6g9JvoWr") }).success, false);
});

test("contract: get-request accepts nulls for absent requester text", () => {
  const data = { ...fixture("get-request.res.json"), payer_name: null, for: null, note: null, requester_name: null, paid: null, status: "open" };
  assert.equal(getRequestResSchema.safeParse(data).success, true);
});
