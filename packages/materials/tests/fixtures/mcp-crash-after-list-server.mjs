import { existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const marker = process.env.MCP_CRASH_MARKER;
const exitMarker = process.env.MCP_CRASH_EXIT_MARKER;
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

if (shouldCrash && marker && exitMarker) {
  // Advertise readiness before waiting for the test to release the crash.
  // This keeps the first tools/list handshake independent of host load.
  writeFileSync(marker, String(process.pid), "utf8");
  const waitForExit = setInterval(() => {
    if (existsSync(exitMarker)) {
      clearInterval(waitForExit);
      process.exit(0);
    }
  }, 10);
}
