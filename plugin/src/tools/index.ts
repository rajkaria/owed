import type { McpServer } from "@modelcontextprotocol/server";
import { register as askForMoney } from "./ask_for_money.js";
import { register as checkPayments } from "./check_payments.js";
import { register as payLink } from "./pay_link.js";
import { register as verifyPayee } from "./verify_payee.js";
import { register as splitBill } from "./split_bill.js";
import { register as createInvoice } from "./create_invoice.js";
import { register as whoOwesMe } from "./who_owes_me.js";
import { register as writeReminder } from "./write_reminder.js";

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
];
