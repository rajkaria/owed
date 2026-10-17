import type { McpServer } from "@modelcontextprotocol/server";
import { register as askForMoney } from "./ask_for_money.js";
import { register as checkPayments } from "./check_payments.js";
import { register as payLink } from "./pay_link.js";
import { register as verifyPayee } from "./verify_payee.js";

// One line per tool. Sprints append their import + entry; LEAD resolves merge conflicts.
export const tools: Array<(server: McpServer) => void> = [
  askForMoney,
  checkPayments,
  payLink,
  verifyPayee,
];
