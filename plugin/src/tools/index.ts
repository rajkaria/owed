import type { McpServer } from "@modelcontextprotocol/server";
import { register as echo } from "./echo.js";

// One line per tool. Sprints append their import + entry; LEAD resolves merge conflicts.
export const tools: Array<(server: McpServer) => void> = [
  echo,
];
