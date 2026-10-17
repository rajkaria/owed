import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

// Placeholder kept until the first real tool lands (conformance needs one tool). LEAD removes it.
export function register(server: McpServer) {
  server.registerTool(
    "echo",
    {
      title: "Echo message",
      description: "Returns the provided message.",
      inputSchema: z.object({ message: z.string().min(1).max(256) }).strict(),
      outputSchema: z.object({ message: z.string() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }], structuredContent: { message } }),
  );
}
