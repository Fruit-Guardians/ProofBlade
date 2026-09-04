import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "@proofblade/materials";
import { AblationExperimentStore, validateAblationExperiment } from "@proofblade/materials";
import { AblationService } from "../src/ablation-service.js";
import { ProviderSettingsStore } from "../src/provider-settings.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "PROOFBLADE_GUI_TEST_KEY",
      contextWindow: 8192,
      maxTokens: 1024,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
    },
  },
};

test("GUI projects an interrupted running ablation as paused until resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ablation-status-"));
  try {
    const directory = join(root, ".proofblade", "ablation");
    await mkdir(directory, { recursive: true });
    const experiment = validateAblationExperiment({
      schemaVersion: 1,
      experimentId: "AB-GUI-STATUS",
      name: "status",
      question: "q",
      corpus: { path: "manifest", hash: "a".repeat(64) },
      model: { profileId: "local", model: "local-model" },
      budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 },
      variants: [
        { id: "baseline", name: "base", baseline: true, changedFactor: "none" },
        { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } },
      ],
    }, config.modelProfiles.executor);
    await new AblationExperimentStore(directory).save(experiment);
    await writeFile(join(directory, `${experiment.experimentId}.status.json`), JSON.stringify({ status: "running", startedAt: "2026-09-02T00:00:00.000Z" }));
    const providers = await ProviderSettingsStore.create(config, join(root, "provider.json"));
    const items = await new AblationService(root, config, providers).list();
    assert.equal(items[0]?.status, "paused");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GUI does not project a ledger from a different experiment snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ablation-binding-"));
  try {
    const directory = join(root, ".proofblade", "ablation");
    await mkdir(directory, { recursive: true });
    const experiment = validateAblationExperiment({
      schemaVersion: 1,
      experimentId: "AB-GUI-BINDING",
      name: "binding",
      question: "q",
      corpus: { path: "manifest", hash: "a".repeat(64) },
      model: { profileId: "local", model: "local-model" },
      budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 },
      variants: [
        { id: "baseline", name: "base", baseline: true, changedFactor: "none" },
        { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } },
      ],
    }, config.modelProfiles.executor);
    await new AblationExperimentStore(directory).save(experiment);
    await writeFile(join(directory, `${experiment.experimentId}.ledger.json`), JSON.stringify({
      schemaVersion: 1,
      experimentId: "AB-FOREIGN",
      experimentFingerprint: "f".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      attempts: {},
    }));
    const providers = await ProviderSettingsStore.create(config, join(root, "provider.json"));
    const detail = await new AblationService(root, config, providers).detail(experiment.experimentId);
    assert.equal(detail.ledger, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
