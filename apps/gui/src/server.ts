import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { loadConfig } from "@proofblade/materials";
import { DebugDataService } from "./debug-data.js";

const guiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(option("--project-root") ?? process.env.PROOFBLADE_ROOT ?? resolve(guiRoot, "../.."));
const configPath = option("--config") ?? process.env.PROOFBLADE_CONFIG ?? "proofblade.config.json";
const port = Number(option("--port") ?? process.env.PORT ?? 4173);
const host = option("--host") ?? process.env.HOST ?? "127.0.0.1";
const config = await loadConfig(projectRoot, configPath);
const data = new DebugDataService(projectRoot, config, configPath);
let vite: Awaited<ReturnType<typeof createViteServer>>;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      await api(request.method ?? "GET", url, request, response);
      return;
    }
    vite.middlewares(request, response, (error: unknown) => {
      if (error) sendError(response, error);
    });
  } catch (error) {
    sendError(response, error);
  }
});
vite = await createViteServer({
  root: guiRoot,
  server: { middlewareMode: true, hmr: { server, host, port, clientPort: port } },
  appType: "spa",
});

server.listen(port, host, () => {
  console.log(`ProofBlade GUI listening on http://${host}:${port}`);
  console.log(`Project root: ${projectRoot}`);
  console.log(`Config: ${configPath}`);
});

async function api(method: string, url: URL, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, data.bootstrap());
  if (method === "GET" && url.pathname === "/api/runs") return sendJson(response, 200, await data.listRuns());
  if (method === "POST" && url.pathname === "/api/conversations") {
    const body = await readBody(request);
    const snapshot = await data.createConversation({
      runId: string(body.runId, "runId"),
      title: typeof body.title === "string" ? body.title : "新对话",
    });
    return sendJson(response, 201, { runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase });
  }
  if (method === "POST" && url.pathname === "/api/fixture-conversations") {
    const body = await readBody(request);
    const snapshot = await data.createFixtureConversation({
      runId: string(body.runId, "runId"),
      fixtureId: string(body.fixtureId, "fixtureId"),
      objective: string(body.objective, "objective"),
    });
    return sendJson(response, 201, { runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase });
  }
  if (method === "POST" && url.pathname === "/api/solve") {
    const body = await readBody(request);
    const mode = body.mode === "auto" ? "auto" : "assist";
    const maxTurns = body.maxTurns === undefined ? undefined : Number(body.maxTurns);
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error("maxTurns must be a positive integer");
    return sendJson(response, 202, await data.startSolve({ runId: string(body.runId, "runId"), fixtureId: string(body.fixtureId, "fixtureId"), mode, maxTurns }));
  }
  if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
    const runId = parts[2];
    if (method === "GET" && parts.length === 3) return sendJson(response, 200, await data.getRun(runId));
    if (method === "GET" && parts[3] === "artifacts" && parts[4]) return sendJson(response, 200, await data.artifact(runId, parts[4]));
    if (method === "POST" && parts[3] === "chat") {
      const body = await readBody(request);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const emit = (event: import("./shared.js").ChatStreamEvent): void => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await data.chat(runId, string(body.prompt, "prompt"), emit);
      } catch (error) {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        response.end();
      }
      return;
    }
    if (method === "POST" && parts[3] === "checkpoint") {
      const body = await readBody(request);
      return sendJson(response, 201, await data.checkpoint(runId, typeof body.reason === "string" ? body.reason : "GUI manual checkpoint"));
    }
    if (method === "POST" && parts[3] === "reconcile") return sendJson(response, 200, await data.recover(runId));
  }
  sendJson(response, 404, { error: "API route not found" });
}

async function readBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendError(response: import("node:http").ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, /not found/i.test(message) ? 404 : 400, { error: message });
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
