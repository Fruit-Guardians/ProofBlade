import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { McpProjectRegistry, ProofBladeSkillRegistry, codingToolCatalog, loadConfig, providerNativeCapabilities, resolveExecutionConfig } from "@proofblade/materials";
import { DebugDataService } from "./debug-data.js";
import { FleetController } from "./fleet.js";
import { CompetitionSettingsStore, sanitizeUrlForLog } from "./competition-settings.js";
import { ProviderSettingsStore } from "./provider-settings.js";
import { WorkspaceSettingsStore } from "./workspace-settings.js";
import { listDirectories, requireDirectory } from "./directory-browser.js";
import { closeGuiResources } from "./shutdown.js";
import type { ConversationPreferences, ProviderCacheRetention, ProviderSettingsInput, ProviderThinkingLevel, WorkspaceSettings } from "./shared.js";

const guiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(option("--project-root") ?? process.env.PROOFBLADE_ROOT ?? resolve(guiRoot, "../.."));
const configPath = option("--config") ?? process.env.PROOFBLADE_CONFIG ?? "proofblade.config.json";
const port = Number(option("--port") ?? positionalPort() ?? process.env.PORT ?? 4173);
const host = option("--host") ?? process.env.HOST ?? "127.0.0.1";
const config = await loadConfig(projectRoot, configPath);
const providerSettings = await ProviderSettingsStore.create(config);
config.modelProfiles.executor = providerSettings.modelProfile();
const workspaceSettings = await WorkspaceSettingsStore.create();
const data = new DebugDataService(projectRoot, config, configPath);
const competitionSettings = await CompetitionSettingsStore.create(projectRoot, config);
const competitionBackend = competitionSettings.backend();
if (competitionBackend.containerRuntime) {
  try {
    const recovered = await competitionBackend.containerRuntime.reapStale({
      olderThanMs: resolveExecutionConfig(config).staleContainerTtlMs,
      includeRunning: true,
    });
    if (recovered > 0) console.log(`Recovered ${recovered} stale ProofBlade container${recovered === 1 ? "" : "s"}.`);
  } catch (error) {
    // Docker recovery is best-effort; a daemon outage must not prevent the GUI
    // from starting and allow the operator to inspect or repair the setup.
    console.warn(`ProofBlade stale-container recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const fleet = new FleetController(competitionBackend.api, competitionBackend.solver);
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
  console.log(
    competitionBackend.kind === "http"
      ? `Competition platform: ${sanitizeUrlForLog(competitionBackend.baseUrl ?? "")} (live, source=${competitionBackend.source})`
      : "Competition platform: demo (no baseUrl configured — set ~/.proofblade/competition.json or PROOFBLADE_COMPETITION_BASE_URL for live play)",
  );
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      await fleet.close();
      await closeGuiResources({
        closeData: () => data.close(),
        closeHttp: () => new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }),
        closeVite: () => vite.close(),
      });
    } catch (error) {
      process.exitCode = 1;
      console.error(`ProofBlade GUI shutdown failed after ${signal}:`, error);
    }
  })();
  return shutdownPromise;
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

async function api(method: string, url: URL, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, data.bootstrap());
  if (method === "GET" && url.pathname === "/api/provider") return sendJson(response, 200, providerSettings.publicSettings());
  if (method === "POST" && url.pathname === "/api/provider/models") {
    const body = await readBody(request);
    return sendJson(response, 200, await providerSettings.discover({
      profileId: optionalString(body.profileId),
      api: optionalString(body.api) as import("@proofblade/materials").ProviderApi | undefined,
      baseUrl: optionalString(body.baseUrl),
      proxyUrl: optionalString(body.proxyUrl),
      apiKey: optionalString(body.apiKey),
    }));
  }
  if (method === "PUT" && url.pathname === "/api/provider") {
    const body = await readBody(request);
    const saved = await providerSettings.save(providerInput(body));
    data.updateModelProfile(providerSettings.modelProfile());
    return sendJson(response, 200, saved);
  }
  if (method === "PUT" && url.pathname === "/api/provider/active") {
    const body = await readBody(request);
    const saved = await providerSettings.activate(string(body.profileId, "profileId"));
    data.updateModelProfile(providerSettings.modelProfile());
    return sendJson(response, 200, saved);
  }
  if (method === "DELETE" && parts[0] === "api" && parts[1] === "provider" && parts[2]) {
    const saved = await providerSettings.remove(parts[2]);
    data.updateModelProfile(providerSettings.modelProfile());
    return sendJson(response, 200, saved);
  }
  if (method === "GET" && url.pathname === "/api/workspace") {
    const capabilities = await capabilityCatalog();
    return sendJson(response, 200, workspaceSettings.publicSettings(capabilities, defaultPreferences(capabilities)));
  }
  if (method === "GET" && url.pathname === "/api/directories") {
    return sendJson(response, 200, await listDirectories(projectRoot, url.searchParams.get("path") ?? undefined));
  }
  if (method === "POST" && url.pathname === "/api/folders") {
    const body = await readBody(request);
    return sendJson(response, 201, await workspaceSettings.createFolder(string(body.name, "name")));
  }
  if (parts[0] === "api" && parts[1] === "folders" && parts[2]) {
    if (method === "PUT") {
      const body = await readBody(request);
      return sendJson(response, 200, await workspaceSettings.renameFolder(parts[2], string(body.name, "name")));
    }
    if (method === "DELETE") {
      await workspaceSettings.removeFolder(parts[2]);
      return sendJson(response, 200, { ok: true });
    }
  }
  if (method === "GET" && url.pathname === "/api/runs") return sendJson(response, 200, await data.listRuns());
  if (method === "POST" && url.pathname === "/api/conversations") {
    const body = await readBody(request);
    const capabilities = await capabilityCatalog();
    const defaults = defaultPreferences(capabilities);
    const workspacePath = await requireDirectory(optionalString(body.workspacePath) || projectRoot);
    const snapshot = await data.createConversation({
      runId: string(body.runId, "runId"),
      title: typeof body.title === "string" ? body.title : "新对话",
      workspacePath,
    });
    await workspaceSettings.saveConversation(snapshot.runId, {
      workspacePath,
      ...(typeof body.folderId === "string" && body.folderId ? { folderId: body.folderId } : {}),
    }, defaults);
    return sendJson(response, 201, { runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase });
  }
  if (parts[0] === "api" && parts[1] === "conversations" && parts[2] && parts[3] === "preferences") {
    const capabilities = await capabilityCatalog();
    const defaults = defaultPreferences(capabilities);
    if (method === "GET") return sendJson(response, 200, normalizedPreferences(workspaceSettings.preferences(parts[2], defaults), capabilities));
    if (method === "PUT") {
      const body = await readBody(request);
      const patch = conversationPreferencesInput(body, workspaceSettings.preferences(parts[2], defaults));
      if (patch.workspacePath !== undefined) patch.workspacePath = await requireDirectory(patch.workspacePath);
      const next = normalizedPreferences({ ...workspaceSettings.preferences(parts[2], defaults), ...patch }, capabilities);
      return sendJson(response, 200, await workspaceSettings.saveConversation(parts[2], next, defaults));
    }
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
    if (method === "POST" && parts[3] === "pause") return sendJson(response, 202, await data.pause(runId));
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
        const capabilities = await capabilityCatalog();
        const preferences = normalizedPreferences(workspaceSettings.preferences(runId, defaultPreferences(capabilities)), capabilities);
        const workspacePath = await requireDirectory(preferences.workspacePath);
        await data.chat(
          runId,
          string(body.prompt, "prompt"),
          emit,
          providerSettings.modelProfile(preferences.profileId, preferences.model, preferences.thinkingLevel),
          {
            enabledTools: preferences.enabledTools,
            enabledSkills: preferences.enabledSkills,
            enabledMcpServers: preferences.enabledMcpServers,
          },
          workspacePath,
        );
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
  if (parts[0] === "api" && parts[1] === "fleet") {
    if (method === "GET" && parts[2] === "stream" && parts.length === 3) {
      // Load the first snapshot BEFORE committing the 200/SSE headers. If the
      // live backend is down fleet.load() throws here, while the response is
      // still uncommitted, so the outer handler can send a clean JSON error.
      // Doing it after writeHead() would have headers already sent, and the
      // retry sendJson() would throw ERR_HTTP_HEADERS_SENT — leaving the client
      // with no error event and a hung connection.
      const initial = await fleet.load();
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const emit = (snapshot: import("./shared.js").FleetSnapshot): void => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      };
      const unsubscribe = fleet.subscribe(emit);
      emit(initial);
      request.on("close", () => { unsubscribe(); if (!response.writableEnded) response.end(); });
      return;
    }
    if (method === "POST" && parts[2] === "start" && parts.length === 3) return sendJson(response, 202, await fleet.start());
    if (method === "POST" && parts[2] === "concurrency" && parts.length === 3) {
      const body = await readBody(request);
      const concurrency = Number(body.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("concurrency must be an integer between 1 and 32");
      return sendJson(response, 200, fleet.setConcurrency(concurrency));
    }
    if (parts[2] === "challenges" && parts[3]) {
      const challengeId = parts[3];
      if (method === "POST" && parts[4] === "cancel") return sendJson(response, 200, fleet.cancelChallenge(challengeId));
      if (method === "POST" && parts[4] === "mode") {
        const body = await readBody(request);
        const mode = body.mode === "auto" ? "auto" : body.mode === "assist" ? "assist" : undefined;
        if (!mode) throw new Error("mode must be auto or assist");
        return sendJson(response, 200, fleet.setChallengeMode(challengeId, mode));
      }
      if (method === "POST" && parts[4] === "priority") {
        const body = await readBody(request);
        const priority = Number(body.priority);
        if (!Number.isFinite(priority)) throw new Error("priority must be a number");
        return sendJson(response, 200, fleet.reprioritize(challengeId, priority));
      }
    }
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function providerInput(body: Record<string, unknown>): ProviderSettingsInput {
  return {
    id: optionalString(body.id),
    name: string(body.name, "name"),
    provider: string(body.provider, "provider"),
    api: optionalString(body.api) as import("@proofblade/materials").ProviderApi | undefined,
    baseUrl: string(body.baseUrl, "baseUrl"),
    proxyUrl: optionalString(body.proxyUrl),
    model: string(body.model, "model"),
    models: stringArray(body.models),
    thinkingLevel: string(body.thinkingLevel, "thinkingLevel") as ProviderThinkingLevel,
    cacheRetention: typeof body.cacheRetention === "string" ? body.cacheRetention as ProviderCacheRetention : undefined,
    maxConcurrentRequests: body.maxConcurrentRequests === undefined ? undefined : Number(body.maxConcurrentRequests),
    apiKey: optionalString(body.apiKey),
    clearApiKey: body.clearApiKey === true,
    setActive: body.setActive === true,
  };
}

async function capabilityCatalog(): Promise<WorkspaceSettings["capabilities"]> {
  const [skills, mcp] = await Promise.all([
    ProofBladeSkillRegistry.load(projectRoot),
    Promise.resolve(McpProjectRegistry.load(projectRoot)),
  ]);
  try {
    return {
      tools: codingToolCatalog(),
      skills: skills.list({ includeDisabled: true }).map((skill) => ({ name: skill.name, description: skill.description, path: skill.path, disabled: skill.disableModelInvocation })),
      mcpServers: mcp.summaries().map((server) => ({
        name: server.name,
        description: server.description,
        status: server.status,
        disabled: server.disabled,
        ...(server.toolchain ? { toolchain: server.toolchain } : {}),
      })),
      providerNative: Object.fromEntries(providerSettings.publicSettings().profiles.map((profile) => [
        profile.id,
        providerNativeCapabilities(profile),
      ])),
    };
  } finally {
    await mcp.close();
  }
}

function defaultPreferences(capabilities: WorkspaceSettings["capabilities"]): ConversationPreferences {
  const providers = providerSettings.publicSettings();
  const profile = providers.profiles.find((item) => item.id === providers.activeProfileId) ?? providers.profiles[0]!;
  return {
    workspacePath: projectRoot,
    profileId: profile.id,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    enabledTools: capabilities.tools.map((tool) => tool.name),
    enabledSkills: capabilities.skills.filter((skill) => !skill.disabled).map((skill) => skill.name),
    enabledMcpServers: capabilities.mcpServers.filter((server) => !server.disabled).map((server) => server.name),
  };
}

function normalizedPreferences(input: ConversationPreferences, capabilities: WorkspaceSettings["capabilities"]): ConversationPreferences {
  const providers = providerSettings.publicSettings();
  const profile = providers.profiles.find((item) => item.id === input.profileId)
    ?? providers.profiles.find((item) => item.id === providers.activeProfileId)
    ?? providers.profiles[0]!;
  const allowedTools = new Set(capabilities.tools.map((tool) => tool.name));
  const allowedSkills = new Set(capabilities.skills.filter((skill) => !skill.disabled).map((skill) => skill.name));
  const allowedMcp = new Set(capabilities.mcpServers.filter((server) => !server.disabled).map((server) => server.name));
  return {
    ...(input.folderId ? { folderId: input.folderId } : {}),
    workspacePath: input.workspacePath || projectRoot,
    profileId: profile.id,
    model: input.profileId === profile.id && input.model ? input.model : profile.model,
    thinkingLevel: input.thinkingLevel,
    enabledTools: input.enabledTools.filter((name) => allowedTools.has(name)),
    enabledSkills: input.enabledSkills.filter((name) => allowedSkills.has(name)),
    enabledMcpServers: input.enabledMcpServers.filter((name) => allowedMcp.has(name)),
  };
}

function conversationPreferencesInput(body: Record<string, unknown>, current: ConversationPreferences): Partial<ConversationPreferences> {
  return {
    ...current,
    ...(body.folderId === null ? { folderId: undefined } : typeof body.folderId === "string" ? { folderId: body.folderId } : {}),
    ...(typeof body.workspacePath === "string" ? { workspacePath: body.workspacePath } : {}),
    ...(typeof body.profileId === "string" ? { profileId: body.profileId } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel as ProviderThinkingLevel } : {}),
    ...(Array.isArray(body.enabledTools) ? { enabledTools: stringArray(body.enabledTools) } : {}),
    ...(Array.isArray(body.enabledSkills) ? { enabledSkills: stringArray(body.enabledSkills) } : {}),
    ...(Array.isArray(body.enabledMcpServers) ? { enabledMcpServers: stringArray(body.enabledMcpServers) } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positionalPort(): string | undefined {
  return process.argv.slice(2).find((value) => /^\d+$/.test(value));
}
