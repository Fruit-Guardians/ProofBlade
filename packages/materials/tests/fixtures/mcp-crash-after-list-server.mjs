import { existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const marker = process.env.MCP_CRASH_MARKER;
const shouldCrash = Boolean(marker && !existsSync(marker));

const server = new McpServer({ name: "proofblade-crash-test-mcp", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo test input before or after a synthetic process restart.",
    inputSchema: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

await server.connect(new StdioServerTransport());

if (shouldCrash && marker) {
  setTimeout(() => {
    writeFileSync(marker, "crashed", "utf8");
    process.exit(0);
  }, 100);
}
