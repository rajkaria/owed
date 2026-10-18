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
import { AttributedBody, AttributedResponse, MatchBody, MatchResponse, RestBody, RestResponse } from "@/lib/contract"; // 0012
import { BulkRequestsResponse, InboxBlockBody, InboxBlockResponse, InboxBody, InboxResponse } from "@/lib/contract"; // F1
import { CreatePlanBody, CreatePlanResponse, FundingPlanDoc, PlanStatsResponse, PlanUsedBody, PlanUsedResponse } from "@/lib/contract"; // F2
import { AddExpenseBody, AddExpenseResponse, CreateLedgerBody, GroupLedgerResponse, SettleUpBody, SettleUpResponse } from "@/lib/contract"; // F6 ledger
import { CreateInvoiceTermsBody, CreateRefundBody, CreateRefundResponse, InvoiceTermsResponse, RefundResponse, RefundsLookupResponse, StatementResponse } from "@/lib/contract"; // F8 invoices
import { CashOutResponse, CreateCashOutBody } from "@/lib/contract"; // F4 cash out

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
  // 0012 matched payments
  "match.req.json": MatchBody,
  "match.res.json": MatchResponse,
  "match.rest.res.json": MatchResponse,
  "rest.req.json": RestBody,
  "rest.res.json": RestResponse,
  "attributed.req.json": AttributedBody,
  "attributed.res.json": AttributedResponse,
  "status.matched.res.json": StatusResponse,
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
  // W3-S
  "sns.create-request.req.json": CreateRequestBody,
  "sns.create-request.res.json": CreateRequestResponse,
  "sns.get-request.res.json": GetRequestResponse,
  // F1 payer inbox
  "payer.create-request.req.json": CreateRequestBody,
  "payer.create-request.res.json": CreateRequestResponse,
  "payer.get-request.res.json": GetRequestResponse,
  "payer.groups.create.req.json": CreateGroupBody,
  "payer.groups.create.res.json": GroupResponse,
  "payer.invoices.create.req.json": CreateInvoiceBody,
  "payer.invoices.create.res.json": InvoiceResponse,
  "payer.schedules.create.req.json": CreateScheduleBody,
  "payer.schedules.create.res.json": ScheduleResponse,
  "inbox.req.json": InboxBody,
  "inbox.res.json": InboxResponse,
  "inbox.block.req.json": InboxBlockBody,
  "inbox.block.res.json": InboxBlockResponse,
  "requests.bulk.res.json": BulkRequestsResponse,
  // F2 funding plans
  "plans.create.req.json": CreatePlanBody,
  "plans.create.res.json": CreatePlanResponse,
  "plans.used.req.json": PlanUsedBody,
  "plans.used.res.json": PlanUsedResponse,
  "plans.stats.res.json": PlanStatsResponse,
  "funding-plan.swap.json": FundingPlanDoc,
  "funding-plan.buy.json": FundingPlanDoc,
  "funding-plan.fee.json": FundingPlanDoc,
  "funding-plan.pay-all.json": FundingPlanDoc,
  // F6 ledger
  "ledgers.create.req.json": CreateLedgerBody,
  "ledgers.create.res.json": GroupLedgerResponse,
  "ledgers.get.res.json": GroupLedgerResponse,
  "ledgers.expense.req.json": AddExpenseBody,
  "ledgers.expense.res.json": AddExpenseResponse,
  "ledgers.expense.fiat.req.json": AddExpenseBody,
  "ledgers.expense.fiat.res.json": AddExpenseResponse,
  "ledgers.settle.req.json": SettleUpBody,
  "ledgers.settle.res.json": SettleUpResponse,
  // F8 invoices: terms, refunds, statements (the plain invoice fixtures parse with the terms schemas too, below)
  "invoice.terms.create.req.json": CreateInvoiceTermsBody,
  "invoice.terms.create.res.json": InvoiceTermsResponse,
  "invoice.terms.get.res.json": InvoiceTermsResponse,
  "invoice.terms.child.res.json": InvoiceTermsResponse,
  "invoice.statement.res.json": StatementResponse,
  "refund.create.req.json": CreateRefundBody,
  "refund.create.res.json": CreateRefundResponse,
  "refund.get.res.json": RefundResponse,
  "refunds.lookup.res.json": RefundsLookupResponse,
  // F4 cash out
  "cash-out.create.req.json": CreateCashOutBody,
  "cash-out.create.res.json": CashOutResponse,
  "cash-out.status.res.json": CashOutResponse,
  "cash-out.enterprise.res.json": CashOutResponse,
  // F3 bank rail: a request paid by bank transfer (paid.rail "bank_transfer")
  "bank.get-request.res.json": GetRequestResponse,
};

// F8 invoices: every existing invoice fixture still parses with the terms-aware schemas (all F8 fields are optional).
test("F8: existing invoice fixtures parse as InvoiceTermsResponse and CreateInvoiceTermsBody", () => {
  for (const file of ["invoices.create.res.json", "invoices.get.res.json", "fiat.invoices.create.res.json", "payer.invoices.create.res.json"]) {
    const r = InvoiceTermsResponse.safeParse(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    assert.ok(r.success, `${file}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
  for (const file of ["invoices.create.req.json", "fiat.invoices.create.req.json", "payer.invoices.create.req.json"]) {
    const r = CreateInvoiceTermsBody.safeParse(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    assert.ok(r.success, `${file}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
});

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
