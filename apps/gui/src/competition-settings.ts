import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CompetitionChallengeSolver,
  HttpCompetitionApi,
  type ChallengeSolver,
  type CompetitionApi,
  type CompetitionHttpEndpoints,
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
}

interface StoredCompetitionConfig {
  baseUrl?: string;
  token?: string;
  tokenHeader?: string;
  timeoutMs?: number;
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
    const source: CompetitionBackend["source"] = merged.baseUrl
      ? (fromFile.baseUrl ? "config-file" : "env")
      : "none";
    return new CompetitionSettingsStore(root, config, merged, source);
  }

  /**
   * Build the api+solver pair for the FleetController. When no baseUrl is
   * configured this returns the Demo pair so the dashboard still works offline.
   */
  public backend(): CompetitionBackend {
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
    const solver = new CompetitionChallengeSolver({ root: this.root, config: this.config, api, mode: "auto" });
    return { api, solver, kind: "http", baseUrl, source: this.source };
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

function validate(value: unknown): StoredCompetitionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const config: StoredCompetitionConfig = {};
  if (typeof input.baseUrl === "string" && input.baseUrl.trim()) config.baseUrl = input.baseUrl.trim();
  if (typeof input.token === "string" && input.token.trim()) config.token = input.token.trim();
  if (typeof input.tokenHeader === "string" && input.tokenHeader.trim()) config.tokenHeader = input.tokenHeader.trim();
  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) config.timeoutMs = input.timeoutMs;
  if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input.headers)) if (typeof raw === "string") headers[key] = raw;
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  if (input.endpoints && typeof input.endpoints === "object" && !Array.isArray(input.endpoints)) {
    const endpoints: Partial<CompetitionHttpEndpoints> = {};
    for (const key of ["listChallenges", "getChallenge", "startEnvironment", "submitFlag", "stopEnvironment"] as const) {
      const raw = (input.endpoints as Record<string, unknown>)[key];
      if (typeof raw === "string" && raw.trim()) endpoints[key] = raw.trim();
    }
    if (Object.keys(endpoints).length > 0) config.endpoints = endpoints;
  }
  return config;
}

/** Env vars win over the file so a token need not be written to disk. */
function applyEnvOverrides(base: StoredCompetitionConfig): StoredCompetitionConfig {
  const merged: StoredCompetitionConfig = { ...base };
  const baseUrl = process.env.PROOFBLADE_COMPETITION_BASE_URL?.trim();
  const token = process.env.PROOFBLADE_COMPETITION_TOKEN?.trim();
  const tokenHeader = process.env.PROOFBLADE_COMPETITION_TOKEN_HEADER?.trim();
  if (baseUrl) merged.baseUrl = baseUrl;
  if (token) merged.token = token;
  if (tokenHeader) merged.tokenHeader = tokenHeader;
  return merged;
}
