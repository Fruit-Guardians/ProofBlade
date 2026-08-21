import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { WebToolHandler } from "../src/web/web-tools.js";
import { createWebSessionTools } from "../src/runtime/web-coding-tools.js";
import { codingActiveToolNames, CODING_WEB_SESSION_TOOL_NAMES } from "../src/runtime/coding-resources.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

function startTarget(flag: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/login") { response.setHeader("set-cookie", "sid=abc; Path=/"); response.end("ok"); return; }
    if (request.url === "/flag") {
      const authed = request.headers.cookie === "sid=abc";
      response.statusCode = authed ? 200 : 403;
      response.end(authed ? `x ${flag}` : "nope");
      return;
    }
    response.statusCode = 404; response.end("nf");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  }));
}

function toolByName(name: string) {
  const tool = createWebSessionTools().find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool!;
}

function contextWith(handler?: WebToolHandler): CodingResourceContext {
  return { webSession: handler } as unknown as CodingResourceContext;
}

test("web session tools expose a stable, complete tool set", () => {
  const names = createWebSessionTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [...CODING_WEB_SESSION_TOOL_NAMES].sort());
});

test("web session tools are active only when webSessionEnabled", () => {
  const base = { tools: ["bash"], skills: [], mcpServers: [] };
  assert.equal(codingActiveToolNames(base).some((n) => n.startsWith("web_")), false);
  const enabled = codingActiveToolNames({ ...base, webSessionEnabled: true });
  for (const name of CODING_WEB_SESSION_TOOL_NAMES) assert.ok(enabled.includes(name), `expected ${name} active`);
});

test("web session tools fail closed with a clear message when no handler is attached", async () => {
  const open = toolByName("web_open");
  await assert.rejects(
    open.execute!("t1", { baseUrl: "http://1.2.3.4/" }, new AbortController().signal, () => {}, contextWith(undefined)),
    /no resolvable web target|unavailable/,
  );
});

test("web_open then web_request route through the real handler and durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-ct-"));
  const { server, baseUrl } = await startTarget("flag{ct}");
  try {
    const runId = "WEB-CT";
    const services = createServices(root, config);
    await services.control.createRun(runId, demoTask(runId, root, config));
    const handler = new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main" });
    const context = contextWith(handler);

    const opened = await toolByName("web_open").execute!("t1", { baseUrl }, new AbortController().signal, () => {}, context);
    assert.equal(opened.isError, false);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    assert.ok(sessionId.startsWith("HTTP"));

    await toolByName("web_request").execute!("t2", { sessionId, path: "/login", method: "POST" }, new AbortController().signal, () => {}, context);
    const flag = await toolByName("web_request").execute!("t3", { sessionId, path: "/flag" }, new AbortController().signal, () => {}, context);
    assert.equal(flag.isError, false);
    assert.equal((flag.details as { status: number }).status, 200);
    assert.match((flag.details as { bodyViewport: string }).bodyViewport, /flag\{ct\}/);

    assert.equal((await services.control.replay(runId)).sessions[sessionId]?.kind, "http");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
