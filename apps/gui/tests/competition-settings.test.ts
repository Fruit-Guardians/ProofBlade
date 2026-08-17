import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { HttpCompetitionApi, type ProofBladeConfig } from "@proofblade/materials";
import { CompetitionSettingsStore } from "../src/competition-settings.js";
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

const ENV_KEYS = ["PROOFBLADE_COMPETITION_BASE_URL", "PROOFBLADE_COMPETITION_TOKEN", "PROOFBLADE_COMPETITION_TOKEN_HEADER"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function tempDir(prefix: string): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  return await mkdtemp(join(tempRoot, prefix));
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
