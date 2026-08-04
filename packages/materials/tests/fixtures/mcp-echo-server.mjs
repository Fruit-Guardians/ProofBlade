import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.MCP_MARKER) writeFileSync(process.env.MCP_MARKER, String(process.pid), "utf8");

const server = new McpServer({ name: "proofblade-test-mcp", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo bounded test input.",
    inputSchema: z.object({ text: z.string(), token: z.string().optional() }),
    annotations: { readOnlyHint: true },
  },
  async ({ text, token }) => ({
    content: [{ type: "text", text: JSON.stringify({ text, token, environment: process.env.MCP_SECRET }) }],
  }),
);
server.registerTool(
  "hidden",
  { description: "Tool excluded by the project allowlist.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: "hidden" }] }),
);

await server.connect(new StdioServerTransport());
