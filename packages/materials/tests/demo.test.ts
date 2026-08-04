import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, runDemo } from "../src/app/demo.js";
import { projectionHash } from "../src/control/reducer.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("demo reaches success with artifacts, evidence and replay parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-demo-"));
  try {
    const runId = "DEMO-TEST";
    const outcome = await runDemo(root, runId, config);
    assert.equal(outcome.flag, "PB{evidence_first}");
    const services = createServices(root, config);
    const snapshot = await services.control.snapshot(runId);
    const replayed = await services.control.replay(runId);
    assert.equal(snapshot.status, "SUCCEEDED");
    assert.equal(snapshot.generation, 1);
    assert.equal(Object.keys(snapshot.evidence).length, 2);
    assert.equal(Object.keys(snapshot.effects).length, 2);
    assert.equal(projectionHash(snapshot), projectionHash(replayed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
