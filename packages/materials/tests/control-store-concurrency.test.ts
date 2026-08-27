import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

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

const workerSource = `
  const [{ ControlStore }, { demoTask }, { JsonlControlStore }] = await Promise.all([
    import('./packages/materials/src/control/control-store.ts'),
    import('./packages/materials/src/app/demo.ts'),
    import('./packages/materials/src/storage/jsonl-store.ts'),
  ]);
  const [runsRoot, runId, secret, workerId] = process.argv.slice(1);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  for (let index = 0; index < 8; index += 1) {
    await control.append(runId, [{
      schemaVersion: 1,
      lane: 'executor',
      correlationId: workerId + '-' + index,
      actor: 'orchestrator',
      type: 'model_usage',
      payload: { requestId: workerId + '-' + index, provider: 'test', model: 'test-model', phase: 'recon', usage: { input: 1, output: 1, totalTokens: 2 } },
    }]);
  }
`;

test("independent processes serialize ControlStore transactions without sequence collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-control-concurrency-"));
  const runsRoot = join(root, "runs");
  const secret = "cross-process-control-secret-0123456789";
  const runId = "CONCURRENT-RUN";
  try {
    const creator = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    await creator.createRun(runId, demoTask(runId, root, config));
    await Promise.all([
      runWorker(runsRoot, runId, secret, "worker-a"),
      runWorker(runsRoot, runId, secret, "worker-b"),
    ]);
    const events = await new JsonlControlStore(runsRoot).events(runId);
    const telemetry = events.filter((event) => event.type === "model_usage");
    assert.equal(telemetry.length, 16);
    assert.deepEqual(events.map((event, index) => event.seq), events.map((_event, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    assert.equal((await creator.replay(runId)).lastSeq, 17);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runWorker(runsRoot: string, runId: string, secret: string, workerId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerSource, runsRoot, runId, secret, workerId], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`control worker ${workerId} exited with ${String(code)} ${String(signal)}: ${stderr}`));
    });
  });
}
