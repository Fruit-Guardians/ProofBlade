import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DasctfCompetitionApi, HttpCompetitionApi, type ProofBladeConfig } from "@proofblade/materials";
import { CompetitionSettingsStore, sanitizeUrlForLog } from "../src/competition-settings.js";
import { DemoCompetitionApi } from "../src/fleet.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "auto",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "PROOFBLADE_GUI_TEST_KEY",
      contextWindow: 20_000,
      maxTokens: 2_048,
      requestTimeoutMs: 10_000,
      maxRetries: 1,
      input: ["text"],
    },
  },
};

const ENV_KEYS = ["PROOFBLADE_COMPETITION_BASE_URL", "PROOFBLADE_COMPETITION_TOKEN", "PROOFBLADE_COMPETITION_TOKEN_HEADER", "PROOFBLADE_COMPETITION_SERVER_HOST", "PROOFBLADE_COMPETITION_ACCESS_KEY", "PROOFBLADE_COMPETITION_WRONG_FLAG_CODES"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function tempDir(prefix: string): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  return await mkdtemp(join(tempRoot, prefix));
}

function configuredWrongFlagCodes(api: DasctfCompetitionApi): string[] {
  return [...(api as unknown as { wrongFlagCodes: Set<string> }).wrongFlagCodes];
}

test("falls back to the demo backend when no baseUrl is configured", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-none-");
  const store = await CompetitionSettingsStore.create("/root", config, join(dir, "competition.json"));
  const backend = store.backend();
  assert.equal(backend.kind, "demo");
  assert.equal(backend.source, "none");
  assert.ok(backend.api instanceof DemoCompetitionApi);
});

test("builds a live DasctfCompetitionApi when platform=dasctf with serverHost+accessKey in the file", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-dasctf-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ platform: "dasctf", serverHost: "https://gcsis.dasctf.com", accessKey: "ak_secret", wrongFlagCodes: ["B0001"] }), "utf8");
  const store = await CompetitionSettingsStore.create("/root", config, path);
  const backend = store.backend();
  assert.equal(backend.kind, "http");
  assert.equal(backend.source, "config-file");
  assert.equal(backend.baseUrl, "https://gcsis.dasctf.com");
  assert.ok(backend.api instanceof DasctfCompetitionApi);
  assert.deepEqual(configuredWrongFlagCodes(backend.api), ["B0001"]);
});

test("dasctf platform without an accessKey falls back to demo (fail-closed, no false solves)", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-dasctf-partial-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ platform: "dasctf", serverHost: "https://gcsis.dasctf.com" }), "utf8");
  const store = await CompetitionSettingsStore.create("/root", config, path);
  const backend = store.backend();
  assert.equal(backend.kind, "demo");
  assert.equal(backend.source, "none");
});

test("the DASCTF accessKey can come from an env var (kept off disk) and selects the dasctf platform", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-dasctf-env-");
  const path = join(dir, "competition.json");
  // File carries only the host; the secret arrives via env.
  await writeFile(path, JSON.stringify({ platform: "dasctf", serverHost: "https://gcsis.dasctf.com" }), "utf8");
  process.env.PROOFBLADE_COMPETITION_ACCESS_KEY = "ak_from_env";
  try {
    const store = await CompetitionSettingsStore.create("/root", config, path);
    const backend = store.backend();
    assert.equal(backend.kind, "http");
    assert.equal(backend.source, "env");
    assert.ok(backend.api instanceof DasctfCompetitionApi);
  } finally {
    clearEnv();
  }
});

test("DASCTF wrongFlagCodes can come from a comma-separated env var", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-dasctf-wrong-codes-env-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ platform: "dasctf", serverHost: "https://gcsis.dasctf.com", accessKey: "ak_secret", wrongFlagCodes: ["40001"] }), "utf8");
  process.env.PROOFBLADE_COMPETITION_WRONG_FLAG_CODES = " B0001, 40001 ";
  try {
    const backend = (await CompetitionSettingsStore.create("/root", config, path)).backend();
    assert.ok(backend.api instanceof DasctfCompetitionApi);
    assert.deepEqual(configuredWrongFlagCodes(backend.api), ["B0001", "40001"]);
  } finally {
    clearEnv();
  }
});

test("a wrong-typed platform value fails closed with a clear message", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-badplatform-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ platform: "nope" }), "utf8");
  await assert.rejects(() => CompetitionSettingsStore.create("/root", config, path), /platform/);
});

test("builds a live HttpCompetitionApi from the config file", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-file-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ baseUrl: "https://ctf.example/api", token: "secret-token", timeoutMs: 15_000 }), "utf8");
  const store = await CompetitionSettingsStore.create("/root", config, path);
  const backend = store.backend();
  assert.equal(backend.kind, "http");
  assert.equal(backend.source, "config-file");
  assert.equal(backend.baseUrl, "https://ctf.example/api");
  assert.ok(backend.api instanceof HttpCompetitionApi);
});

test("env vars override the file and report source=env when only env sets baseUrl", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-env-");
  process.env.PROOFBLADE_COMPETITION_BASE_URL = "https://env.example/api";
  process.env.PROOFBLADE_COMPETITION_TOKEN = "env-token";
  try {
    const store = await CompetitionSettingsStore.create("/root", config, join(dir, "competition.json"));
    const backend = store.backend();
    assert.equal(backend.kind, "http");
    assert.equal(backend.source, "env");
    assert.equal(backend.baseUrl, "https://env.example/api");
  } finally {
    clearEnv();
  }
});

test("env baseUrl overrides a file baseUrl but source stays config-file when the file also set it", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-override-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ baseUrl: "https://file.example/api" }), "utf8");
  process.env.PROOFBLADE_COMPETITION_BASE_URL = "https://env.example/api";
  try {
    const store = await CompetitionSettingsStore.create("/root", config, path);
    const backend = store.backend();
    assert.equal(backend.baseUrl, "https://env.example/api");
    assert.equal(backend.source, "config-file");
  } finally {
    clearEnv();
  }
});

test("rejects a malformed config file rather than silently falling back", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-bad-");
  const path = join(dir, "competition.json");
  await writeFile(path, "{ not json", "utf8");
  await assert.rejects(() => CompetitionSettingsStore.create("/root", config, path), /不是合法 JSON/);
});

test("fails closed on a present-but-wrong-typed baseUrl instead of falling back to Demo", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-badtype-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ baseUrl: 123 }), "utf8");
  await assert.rejects(() => CompetitionSettingsStore.create("/root", config, path), /baseUrl 类型错误/);
});

test("fails closed on wrong-typed token, timeoutMs, wrongFlagCodes, headers, and endpoints", async () => {
  clearEnv();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ baseUrl: "https://ctf.example/api", token: 5 }, /token 类型错误/],
    [{ baseUrl: "https://ctf.example/api", timeoutMs: "30s" }, /timeoutMs 类型错误/],
    [{ platform: "dasctf", wrongFlagCodes: "B0001" }, /wrongFlagCodes 类型错误/],
    [{ platform: "dasctf", wrongFlagCodes: ["B0001", ""] }, /wrongFlagCodes\.1 类型错误/],
    [{ baseUrl: "https://ctf.example/api", headers: { "X-A": 1 } }, /headers\.X-A 类型错误/],
    [{ baseUrl: "https://ctf.example/api", endpoints: { submitFlag: 42 } }, /endpoints\.submitFlag 类型错误/],
  ];
  let i = 0;
  for (const [cfg, pattern] of cases) {
    const dir = await tempDir(`competition-settings-badtype-${i++}-`);
    const path = join(dir, "competition.json");
    await writeFile(path, JSON.stringify(cfg), "utf8");
    await assert.rejects(() => CompetitionSettingsStore.create("/root", config, path), pattern);
  }
});

test("rejects a baseUrl carrying credentials in userinfo", async () => {
  clearEnv();
  const dir = await tempDir("competition-settings-creds-");
  const path = join(dir, "competition.json");
  await writeFile(path, JSON.stringify({ baseUrl: "https://user:pass@ctf.example/api" }), "utf8");
  await assert.rejects(() => CompetitionSettingsStore.create("/root", config, path), /不得在 URL 中携带凭据/);
});

test("sanitizeUrlForLog strips userinfo and query so credentials never reach the log", () => {
  assert.equal(sanitizeUrlForLog("https://user:pass@ctf.example/api?token=secret"), "https://ctf.example/api");
  assert.equal(sanitizeUrlForLog("https://ctf.example:8443/api/v1?x=1#frag"), "https://ctf.example:8443/api/v1");
  assert.equal(sanitizeUrlForLog("not a url"), "<invalid-url>");
});
