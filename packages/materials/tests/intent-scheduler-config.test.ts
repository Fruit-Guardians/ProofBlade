import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { IntentScheduler } from "../src/orchestration/intent-scheduler.js";

test("intent scheduler configuration is loaded and applied to scoring", async () => {
  const root = await projectTemp("intent-config-");
  const path = join(root, "proofblade.json");
  await writeFile(path, JSON.stringify(baseConfig({
    maxOpenIntents: 4,
    maxAttemptsPerIntent: 2,
    scoringWeights: { novelty: 2.5, cost: -3 },
  })), "utf8");
  try {
    const config = await loadConfig(root, path);
    const scheduler = new IntentScheduler({} as never, {} as never, config.intentScheduler);
    assert.equal(config.intentScheduler?.maxOpenIntents, 4);
    assert.equal(config.intentScheduler?.maxAttemptsPerIntent, 2);
    assert.equal(scheduler.getScoringWeights().novelty, 2.5);
    assert.equal(scheduler.getScoringWeights().cost, -3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("intent scheduler configuration rejects invalid limits and scoring keys", async () => {
  const root = await projectTemp("intent-config-invalid-");
  const path = join(root, "proofblade.json");
  try {
    await writeFile(path, JSON.stringify(baseConfig({ maxOpenIntents: 0 })), "utf8");
    await assert.rejects(() => loadConfig(root, path), /maxOpenIntents/);

    await writeFile(path, JSON.stringify(baseConfig({ maxAttemptsPerIntent: 1.5 })), "utf8");
    await assert.rejects(() => loadConfig(root, path), /maxAttemptsPerIntent/);

    await writeFile(path, JSON.stringify(baseConfig({ scoringWeights: { unknown: 1 } })), "utf8");
    await assert.rejects(() => loadConfig(root, path), /scoring weight unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baseConfig(intentScheduler: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    intentScheduler,
    modelProfiles: {
      executor: {
        provider: "test",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test",
        modelDiscoveryPath: "/models",
        apiKeyEnv: "TEST_KEY",
        contextWindow: 4_096,
        maxTokens: 512,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  };
}

async function projectTemp(prefix: string): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(join(root, prefix));
}
