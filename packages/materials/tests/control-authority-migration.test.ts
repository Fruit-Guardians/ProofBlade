import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { ControlStore } from "../src/control/control-store.js";
import { canonicalJson } from "../src/domain/utils.js";
import { JsonlControlStore, makeEvent } from "../src/storage/jsonl-store.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test-model",
      modelDiscoveryPath: "/models", apiKeyEnv: "TEST_API_KEY", contextWindow: 4096, maxTokens: 512,
      requestTimeoutMs: 1000, maxRetries: 0, input: ["text"],
    },
  },
};

test("default host credential keeps a new persistent Run writable after service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-restart-"));
  const state = join(root, "host-private-state");
  try {
    const runId = "AUTHORITY-RESTART";
    const first = createServices(root, config, { authorityStateDirectory: state });
    await first.control.createRun(runId, demoTask(runId, root, config));

    const reopened = createServices(root, config, { authorityStateDirectory: state });
    await reopened.control.dispatch(runId, { type: "pause", reason: "restart credential regression" });
    assert.equal((await reopened.control.snapshot(runId)).status, "PAUSED");
    assert.equal((await readFile(join(state, "control-authority.key"), "utf8")).trim().length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct ControlStore construction also uses the stable host credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-direct-"));
  const state = join(root, "host-private-state");
  const previousStateDirectory = process.env.PROOFBLADE_STATE_DIR;
  process.env.PROOFBLADE_STATE_DIR = state;
  try {
    const runId = "AUTHORITY-DIRECT-RESTART";
    const runsRoot = join(root, "runs");
    const first = new ControlStore(new JsonlControlStore(runsRoot));
    await first.createRun(runId, demoTask(runId, root, config));

    const reopened = new ControlStore(new JsonlControlStore(runsRoot));
    await reopened.dispatch(runId, { type: "pause", reason: "direct constructor restart regression" });
    assert.equal((await reopened.snapshot(runId)).status, "PAUSED");
  } finally {
    if (previousStateDirectory === undefined) delete process.env.PROOFBLADE_STATE_DIR;
    else process.env.PROOFBLADE_STATE_DIR = previousStateDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy run_started is replayed, backed up, append-only migrated, and recoverably writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-legacy-"));
  const state = join(root, "host-private-state");
  try {
    const runId = "LEGACY-UPGRADE";
    const task = demoTask(runId, root, config);
    const runDir = join(root, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "task.json"), `${canonicalJson(task)}\n`, "utf8");
    const legacyStart = makeEvent(runId, 1, "run_started", "orchestrator", "main", { generation: 0, versionSnapshot: undefined });
    await writeFile(join(runDir, "events.jsonl"), `${canonicalJson(legacyStart)}\n`, "utf8");

    const upgraded = createServices(root, config, { authorityStateDirectory: state });
    const snapshot = await upgraded.control.snapshot(runId);
    assert.equal(snapshot.status, "READY");
    assert.match(snapshot.authorityHash, /^[a-f0-9]{64}$/i);
    assert.notEqual(snapshot.authorityHash, "LEGACY-UNTRUSTED");
    assert.equal((await readFile(join(runDir, "events.pre-authority-migration.jsonl"), "utf8")).trim(), canonicalJson(legacyStart));
    assert.equal((await readFile(join(runDir, "task.pre-authority-migration.json"), "utf8")).trim(), canonicalJson(task));
    const events = await upgraded.control.events(runId);
    assert.deepEqual(events.map((event) => event.type), ["run_started", "run_authority_migrated"]);

    await upgraded.control.dispatch(runId, { type: "pause", reason: "legacy migration writable" });
    const reopened = createServices(root, config, { authorityStateDirectory: state });
    await reopened.control.dispatch(runId, { type: "resume" });
    assert.equal((await reopened.control.snapshot(runId)).status, "RUNNING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed legacy migration remains replayable but read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-readonly-"));
  const state = join(root, "host-private-state");
  try {
    const runId = "LEGACY-READ-ONLY";
    const task = demoTask(runId, root, config);
    const runDir = join(root, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "task.json"), `${canonicalJson(task)}\n`, "utf8");
    await writeFile(join(runDir, "events.jsonl"), `${canonicalJson(makeEvent(runId, 1, "run_started", "orchestrator", "main", { generation: 0 }))}\n`, "utf8");
    // Simulate a prior/failed migrator owning the create-exclusive backup lock.
    await writeFile(join(runDir, "events.pre-authority-migration.jsonl"), "migration-lock\n", "utf8");

    const services = createServices(root, config, { authorityStateDirectory: state });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.status, "READY");
    assert.equal(snapshot.authorityHash, "LEGACY-UNTRUSTED");
    await assert.rejects(services.control.dispatch(runId, { type: "pause", reason: "must remain read-only" }), /no trusted JSONL write anchor/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
