import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("project IDALIB-MCP binding uses the streamable launcher contract", async () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { url?: string; includeTools?: string[] }>;
  };
  const server = config.mcpServers?.["idalib-mcp"];
  assert.equal(server?.url, "http://127.0.0.1:18745/mcp");
  assert.ok(server?.includeTools?.includes("get_metadata"));
  assert.ok(server?.includeTools?.includes("list_functions"));
  assert.ok(server?.includeTools?.includes("decompile_function"));
  assert.ok(!server?.includeTools?.includes("idalib_open"));
  assert.ok(!server?.includeTools?.includes("analyze_batch"));
});
