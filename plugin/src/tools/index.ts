import type { McpServer } from "@modelcontextprotocol/server";
import { register as echo } from "./echo.js";
import { register as askForMoney } from "./ask_for_money.js";
import { register as checkPayments } from "./check_payments.js";
import { register as payLink } from "./pay_link.js";

// One line per tool. Sprints append their import + entry; LEAD resolves merge conflicts.
export const tools: Array<(server: McpServer) => void> = [
  echo,
  askForMoney,
  checkPayments,
  payLink,
];
