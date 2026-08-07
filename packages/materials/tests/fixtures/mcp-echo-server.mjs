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
server.registerTool(
  "agent_tools",
  { description: "List synthetic nested tools.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: JSON.stringify(["page_info", "page_eval", "run_node"]) }] }),
);
server.registerTool(
  "agent_call_tool",
  {
    description: "Dispatch one synthetic nested tool.",
    inputSchema: z.object({ name: z.string(), args: z.record(z.unknown()).optional() }),
  },
  async ({ name, args = {} }) => ({ content: [{ type: "text", text: JSON.stringify({ name, args }) }] }),
);

await server.connect(new StdioServerTransport());
