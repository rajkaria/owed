import type { McpServer } from "@modelcontextprotocol/server";
import { register as askForMoney } from "./ask_for_money.js";
import { register as checkPayments } from "./check_payments.js";
import { register as payLink } from "./pay_link.js";
import { register as verifyPayee } from "./verify_payee.js";
import { register as splitBill } from "./split_bill.js";
import { register as createInvoice } from "./create_invoice.js";
import { register as whoOwesMe } from "./who_owes_me.js";
import { register as writeReminder } from "./write_reminder.js";
import { register as cancelRequest } from "./cancel_request.js"; // W3-C
import { register as askEveryMonth } from "./ask_every_month.js"; // W3-D
import { register as matchPayments } from "./match_payments.js"; // 0012
import { register as whatDoIOwe } from "./what_do_i_owe.js"; // F1
import { register as payAll } from "./pay_all.js"; // F1
import { register as startLedger } from "./start_ledger.js"; // F6 ledger
import { register as addExpense } from "./add_expense.js"; // F6 ledger
import { register as ledgerBalances } from "./ledger_balances.js"; // F6 ledger
import { register as settleUp } from "./settle_up.js"; // F6 ledger
import { register as refundPayment } from "./refund_payment.js"; // F8 invoices
import { register as cashOut } from "./cash_out.js"; // F4 cash out
import { register as setAutopay } from "./set_autopay.js"; // F5 autopay

// One line per tool. Sprints append their import + entry; LEAD resolves merge conflicts.
export const tools: Array<(server: McpServer) => void> = [
  askForMoney,
  checkPayments,
  payLink,
  verifyPayee,
  splitBill,
  createInvoice,
  writeReminder,
  whoOwesMe,
  cancelRequest, // W3-C
  askEveryMonth, // W3-D
  matchPayments, // 0012
  whatDoIOwe, // F1
  payAll, // F1
  startLedger, // F6 ledger
  addExpense, // F6 ledger
  ledgerBalances, // F6 ledger
  settleUp, // F6 ledger
  refundPayment, // F8 invoices
  cashOut, // F4 cash out
  setAutopay, // F5 autopay
];
