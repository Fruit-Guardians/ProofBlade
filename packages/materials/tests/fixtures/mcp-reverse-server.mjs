import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "proofblade-reverse-test-mcp", version: "1.0.0" });

const functions = [
  { address: "0x401020", name: "sym.main", size: 48, type: "fcn" },
  { address: "0x401000", name: "entry0", size: 32, type: "fcn" },
];
const instructions = [
  { address: "0x401001", bytes: "4889e5", mnemonic: "mov", operands: "rbp, rsp", type: "mov" },
  { address: "0x401000", bytes: "554889e5", mnemonic: "push", operands: "rbp", type: "push" },
];
const xrefs = [
  { from: "0x401030", to: "0x401000", type: "JMP" },
  { from: "0x401020", to: "0x401000", type: "CALL" },
  { from: "0x401020", to: "0x401000", type: "CALL" },
];

function stagedPathError(path) {
  const marker = process.env.MCP_PATH_MARKER;
  if (!marker) return undefined;
  if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) return "MCP reverse path must be an existing absolute staged file";
  if (readFileSync(path, "utf8") !== "synthetic binary") return "MCP reverse staged file did not contain the fixture bytes";
  appendFileSync(marker, `${path}\n`, "utf8");
  return undefined;
}

server.registerTool("reverse", {
  description: "Return deterministic reverse-analysis rows.",
  inputSchema: z.record(z.unknown()),
  annotations: { readOnlyHint: true },
}, async (args) => {
  const pathError = stagedPathError(args.path);
  if (pathError) return { isError: true, content: [{ type: "text", text: pathError }] };
  const operation = typeof args.operation === "string" ? args.operation : "functions";
  const value = operation === "functions" ? functions : operation === "disassemble" ? instructions : xrefs;
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
});

server.registerTool("dispatch", {
  description: "Return deterministic reverse-analysis rows through a nested dispatcher.",
  inputSchema: z.object({ name: z.string(), args: z.record(z.unknown()).optional() }),
}, async ({ name, args }) => {
  const pathError = stagedPathError(args?.path);
  if (pathError) return { isError: true, content: [{ type: "text", text: pathError }] };
  const value = name === "functions" ? functions : name === "disassemble" ? instructions : xrefs;
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
});

await server.connect(new StdioServerTransport());
