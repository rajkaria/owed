import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { tools } from "./tools/index.js";

const PROTOCOL_VERSION = "2026-07-28";

function createServer() {
  const server = new McpServer(
    { name: "owed", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );
  for (const register of tools) register(server);
  return server;
}

serveStdio(createServer, { legacy: "reject" });
