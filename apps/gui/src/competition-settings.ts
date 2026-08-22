import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CompetitionChallengeSolver,
  CompetitionEnvironmentJanitor,
  ApprovalPolicy,
  DasctfCompetitionApi,
  HttpCompetitionApi,
  DockerContainerRuntime,
  resolveExecutionConfig,
  type ChallengeSolver,
  type CompetitionApi,
  type CompetitionHttpEndpoints,
  type ContainerRuntimePort,
  type ProofBladeConfig,
} from "@proofblade/materials";
import { DemoChallengeSolver, DemoCompetitionApi } from "./fleet.js";

/**
 * Live-platform wiring for the fleet.
 *
 * The contest exposes only an HTTP API, so real play needs a configured
 * endpoint. This store reads that config from `~/.proofblade/competition.json`
 * (env vars win, so a token never has to be written to disk), and hands back the
 * pair the FleetController needs: the `HttpCompetitionApi` client plus the real
 * `CompetitionChallengeSolver`. With no baseUrl configured it falls back to the
 * Demo pair, so the dashboard still runs with no network and no model.
 *
 * The token is deliberately kept out of the returned `source` and every log
 * line; only its presence is reported.
 */
export interface CompetitionBackend {
  api: CompetitionApi;
  solver: ChallengeSolver;
  /** "http" when a live endpoint is configured, "demo" otherwise. */
  kind: "http" | "demo";
  /** The base URL in use, for a one-line startup log. Never includes the token. */
  baseUrl?: string;
  /** Where the config came from, for the startup log. */
  source: "config-file" | "env" | "none";
  /** Shared Docker runtime, when live execution is configured for containers. */
  containerRuntime?: ContainerRuntimePort;
}

interface StoredCompetitionConfig {
  /** Selects the platform adapter. "dasctf" uses the 西湖论剑 platform contract. */
  platform?: "dasctf" | "http";
  /** DASCTF: platform origin, e.g. https://gcsis.dasctf.com. */
  serverHost?: string;
  /** DASCTF: team Agent AccessKey (env var wins; never written to the log). */
  accessKey?: string;
  baseUrl?: string;
  token?: string;
  tokenHeader?: string;
  timeoutMs?: number;
  /** DASCTF: how long to wait for an async env build (ms). Defaults to 300s. */
  envReadyTimeoutMs?: number;
  /** DASCTF response codes that are confirmed to mean a wrong flag. */
  wrongFlagCodes?: string[];
  /** Maximum live platform environments owned by this GUI/Fleet ledger. */
  maxActiveEnvironments?: number;
  /** Require a durable operator approval before platform submission effects. */
  requireApproval?: boolean;
  headers?: Record<string, string>;
  endpoints?: Partial<CompetitionHttpEndpoints>;
}

export class CompetitionSettingsStore {
  private constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly stored: StoredCompetitionConfig,
    private readonly source: CompetitionBackend["source"],
  ) {}

  public static async create(
    root: string,
    config: ProofBladeConfig,
    settingsPath = join(homedir(), ".proofblade", "competition.json"),
  ): Promise<CompetitionSettingsStore> {
    const fromFile = await loadFile(settingsPath);
    const merged = applyEnvOverrides(fromFile);
    const configured = merged.platform === "dasctf" ? Boolean(merged.serverHost && merged.accessKey) : Boolean(merged.baseUrl);
    // "env" when the decisive live-config value came from an env var, not the file.
    const fromFileConfigured = fromFile.platform === "dasctf" ? Boolean(fromFile.serverHost && fromFile.accessKey) : Boolean(fromFile.baseUrl);
    const source: CompetitionBackend["source"] = configured ? (fromFileConfigured ? "config-file" : "env") : "none";
    return new CompetitionSettingsStore(root, config, merged, source);
  }

  /**
   * Build the api+solver pair for the FleetController. When no baseUrl is
   * configured this returns the Demo pair so the dashboard still works offline.
   */
  public backend(): CompetitionBackend {
    if (this.stored.platform === "dasctf") {
      const serverHost = this.stored.serverHost?.trim();
      const accessKey = this.stored.accessKey?.trim();
      if (!serverHost || !accessKey) {
        return { api: new DemoCompetitionApi(), solver: new DemoChallengeSolver(), kind: "demo", source: "none" };
      }
      const api = new DasctfCompetitionApi({
        serverHost,
        accessKey,
        ...(this.stored.timeoutMs !== undefined ? { timeoutMs: this.stored.timeoutMs } : {}),
        ...(this.stored.envReadyTimeoutMs !== undefined ? { envReadyTimeoutMs: this.stored.envReadyTimeoutMs } : {}),
        ...(this.stored.wrongFlagCodes !== undefined ? { wrongFlagCodes: this.stored.wrongFlagCodes } : {}),
      });
      const execution = resolveExecutionConfig(this.config);
      const containerRuntime = execution.backend === "docker" ? new DockerContainerRuntime(execution) : undefined;
      const environmentJanitor = this.createEnvironmentJanitor(api);
      const approvalPolicy = this.createApprovalPolicy();
      const solver = new CompetitionChallengeSolver({ root: this.root, config: this.config, api, mode: "auto", environmentJanitor, ...(approvalPolicy ? { approvalPolicy } : {}), ...(containerRuntime ? { containerRuntime } : {}) });
      return { api, solver, kind: "http", baseUrl: serverHost, source: this.source, ...(containerRuntime ? { containerRuntime } : {}) };
    }
    const baseUrl = this.stored.baseUrl?.trim();
    if (!baseUrl) {
      return { api: new DemoCompetitionApi(), solver: new DemoChallengeSolver(), kind: "demo", source: "none" };
    }
    const api = new HttpCompetitionApi({
      baseUrl,
      ...(this.stored.token ? { token: this.stored.token } : {}),
      ...(this.stored.tokenHeader ? { tokenHeader: this.stored.tokenHeader } : {}),
      ...(this.stored.timeoutMs !== undefined ? { timeoutMs: this.stored.timeoutMs } : {}),
      ...(this.stored.headers ? { headers: this.stored.headers } : {}),
      ...(this.stored.endpoints ? { endpoints: this.stored.endpoints } : {}),
    });
    const execution = resolveExecutionConfig(this.config);
    const containerRuntime = execution.backend === "docker" ? new DockerContainerRuntime(execution) : undefined;
    const environmentJanitor = this.createEnvironmentJanitor(api);
    const approvalPolicy = this.createApprovalPolicy();
    const solver = new CompetitionChallengeSolver({ root: this.root, config: this.config, api, mode: "auto", environmentJanitor, ...(approvalPolicy ? { approvalPolicy } : {}), ...(containerRuntime ? { containerRuntime } : {}) });
    return { api, solver, kind: "http", baseUrl, source: this.source, ...(containerRuntime ? { containerRuntime } : {}) };
  }

  private createEnvironmentJanitor(api: CompetitionApi): CompetitionEnvironmentJanitor {
    return new CompetitionEnvironmentJanitor({
      api,
      ledgerPath: join(this.root, this.config.storage.runsDir, "competition-environments.json"),
      maxActive: this.stored.maxActiveEnvironments ?? 8,
    });
  }

  private createApprovalPolicy(): ApprovalPolicy | undefined {
    return this.stored.requireApproval
      ? new ApprovalPolicy({ ledgerPath: join(this.root, this.config.storage.runsDir, "approvals.json") })
      : undefined;
  }
}

async function loadFile(path: string): Promise<StoredCompetitionConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`竞赛平台配置读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`竞赛平台配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return validate(parsed);
}

/**
 * Parse the config file. A field that is ABSENT is fine (falls through to env
 * or Demo). A field that is PRESENT but the wrong type is a configuration
 * mistake and fails closed with a clear message — silently dropping it would
 * quietly fall back to the Demo backend, whose submitFlag() always returns
 * success, so a misconfigured operator could believe a real challenge was
 * solved when nothing ever reached the platform.
 */
function validate(value: unknown): StoredCompetitionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("竞赛平台配置必须是一个 JSON 对象");
  }
  const input = value as Record<string, unknown>;
  const config: StoredCompetitionConfig = {};
  const present = (key: string): boolean => Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null;

  if (present("platform")) {
    if (input.platform !== "dasctf" && input.platform !== "http") throw fieldError("platform", '"dasctf" 或 "http"');
    config.platform = input.platform;
  }
  if (present("serverHost")) {
    if (typeof input.serverHost !== "string" || !input.serverHost.trim()) throw fieldError("serverHost", "一个非空字符串");
    config.serverHost = validateBaseUrl(input.serverHost.trim());
  }
  if (present("accessKey")) {
    if (typeof input.accessKey !== "string" || !input.accessKey.trim()) throw fieldError("accessKey", "一个非空字符串");
    config.accessKey = input.accessKey.trim();
  }
  if (present("baseUrl")) {
    if (typeof input.baseUrl !== "string" || !input.baseUrl.trim()) throw fieldError("baseUrl", "一个非空字符串");
    config.baseUrl = validateBaseUrl(input.baseUrl.trim());
  }
  if (present("token")) {
    if (typeof input.token !== "string" || !input.token.trim()) throw fieldError("token", "一个非空字符串");
    config.token = input.token.trim();
  }
  if (present("tokenHeader")) {
    if (typeof input.tokenHeader !== "string" || !input.tokenHeader.trim()) throw fieldError("tokenHeader", "一个非空字符串");
    config.tokenHeader = input.tokenHeader.trim();
  }
  if (present("timeoutMs")) {
    if (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs)) throw fieldError("timeoutMs", "一个数字");
    config.timeoutMs = input.timeoutMs;
  }
  if (present("envReadyTimeoutMs")) {
    if (typeof input.envReadyTimeoutMs !== "number" || !Number.isFinite(input.envReadyTimeoutMs)) throw fieldError("envReadyTimeoutMs", "一个数字");
    config.envReadyTimeoutMs = input.envReadyTimeoutMs;
  }
  if (present("wrongFlagCodes")) {
    if (!Array.isArray(input.wrongFlagCodes)) throw fieldError("wrongFlagCodes", "一个字符串数组");
    config.wrongFlagCodes = input.wrongFlagCodes.map((raw, index) => {
      if (typeof raw !== "string" || !raw.trim()) throw fieldError(`wrongFlagCodes.${index}`, "一个非空字符串");
      return raw.trim();
    });
  }
  if (present("maxActiveEnvironments")) {
    if (typeof input.maxActiveEnvironments !== "number" || !Number.isInteger(input.maxActiveEnvironments) || input.maxActiveEnvironments < 1 || input.maxActiveEnvironments > 128) {
      throw fieldError("maxActiveEnvironments", "1 到 128 之间的整数");
    }
    config.maxActiveEnvironments = input.maxActiveEnvironments;
  }
  if (present("requireApproval")) {
    if (typeof input.requireApproval !== "boolean") throw fieldError("requireApproval", "true 或 false");
    config.requireApproval = input.requireApproval;
  }
  if (present("headers")) {
    if (typeof input.headers !== "object" || Array.isArray(input.headers)) throw fieldError("headers", "一个字符串到字符串的对象");
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof raw !== "string") throw fieldError(`headers.${key}`, "一个字符串");
      headers[key] = raw;
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  if (present("endpoints")) {
    if (typeof input.endpoints !== "object" || Array.isArray(input.endpoints)) throw fieldError("endpoints", "一个对象");
    const endpoints: Partial<CompetitionHttpEndpoints> = {};
    for (const key of ["listChallenges", "getChallenge", "startEnvironment", "submitFlag", "stopEnvironment"] as const) {
      const raw = (input.endpoints as Record<string, unknown>)[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "string" || !raw.trim()) throw fieldError(`endpoints.${key}`, "一个非空字符串");
      endpoints[key] = raw.trim();
    }
    if (Object.keys(endpoints).length > 0) config.endpoints = endpoints;
  }
  return config;
}

function fieldError(field: string, expected: string): Error {
  return new Error(`竞赛平台配置字段 ${field} 类型错误：应为${expected}`);
}

/**
 * Reject a baseUrl that carries credentials in userinfo (https://user:pass@host).
 * Those are sent on every request and are almost always a mistake — the token
 * belongs in `token`/`tokenHeader`. Rejecting also keeps credentials out of the
 * startup log. Full http(s)/shape validation stays in HttpCompetitionApi.
 */
function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("竞赛平台配置 baseUrl 必须是合法的绝对 URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("竞赛平台配置 baseUrl 不得在 URL 中携带凭据（user:pass@），请改用 token / tokenHeader");
  }
  return raw;
}

/** Origin + path only, for logging. Drops any userinfo, query, and fragment. */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

/** Env vars win over the file so a token need not be written to disk. */
function applyEnvOverrides(base: StoredCompetitionConfig): StoredCompetitionConfig {
  const merged: StoredCompetitionConfig = { ...base };
  const baseUrl = process.env.PROOFBLADE_COMPETITION_BASE_URL?.trim();
  const token = process.env.PROOFBLADE_COMPETITION_TOKEN?.trim();
  const tokenHeader = process.env.PROOFBLADE_COMPETITION_TOKEN_HEADER?.trim();
  const serverHost = process.env.PROOFBLADE_COMPETITION_SERVER_HOST?.trim();
  const accessKey = process.env.PROOFBLADE_COMPETITION_ACCESS_KEY?.trim();
  const wrongFlagCodes = process.env.PROOFBLADE_COMPETITION_WRONG_FLAG_CODES;
  const maxActiveEnvironments = process.env.PROOFBLADE_COMPETITION_MAX_ACTIVE_ENVIRONMENTS?.trim();
  const requireApproval = process.env.PROOFBLADE_COMPETITION_REQUIRE_APPROVAL?.trim();
  if (baseUrl) merged.baseUrl = validateBaseUrl(baseUrl);
  if (token) merged.token = token;
  if (tokenHeader) merged.tokenHeader = tokenHeader;
  // DASCTF: let the AccessKey come from the environment so it need not touch disk.
  // Setting either DASCTF var also selects the dasctf platform.
  if (serverHost) { merged.serverHost = validateBaseUrl(serverHost); merged.platform = "dasctf"; }
  if (accessKey) { merged.accessKey = accessKey; merged.platform = "dasctf"; }
  if (wrongFlagCodes !== undefined) {
    merged.wrongFlagCodes = wrongFlagCodes.split(",").map((code) => code.trim()).filter(Boolean);
    merged.platform = "dasctf";
  }
  if (maxActiveEnvironments) {
    const parsed = Number(maxActiveEnvironments);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 128) throw new Error("PROOFBLADE_COMPETITION_MAX_ACTIVE_ENVIRONMENTS 必须是 1 到 128 之间的整数");
    merged.maxActiveEnvironments = parsed;
  }
  if (requireApproval !== undefined && requireApproval !== "") {
    if (requireApproval !== "true" && requireApproval !== "false") throw new Error("PROOFBLADE_COMPETITION_REQUIRE_APPROVAL 必须是 true 或 false");
    merged.requireApproval = requireApproval === "true";
  }
  return merged;
}
