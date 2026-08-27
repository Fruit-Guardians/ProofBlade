import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerContainerResourceAdapter } from "../src/container/docker-resource-adapter.js";
import type { DockerCommandRunner, DockerProcessResult } from "../src/container/docker.js";
import { ExternalResourceRegistry, externalResourceBindingTransactionId, type ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

test("Docker resource adapter adopts only a container with exact immutable ownership labels", async () => {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args) {
      calls.push(args);
      return result(JSON.stringify({
        Id: "container-1",
        State: { Running: true },
        Config: { Labels: { "proofblade.managed": "true", "proofblade.run_id": "RUN-1", "proofblade.generation": "3" } },
      }));
    },
  };
  const adapter = new DockerContainerResourceAdapter(runner);
  const inspection = await adapter.inspect(record());
  assert.equal(inspection.status, "PRESENT");
  assert.equal(inspection.binding, "MATCH");
  assert.equal((await adapter.adopt(record(), inspection)).state, "CONFIRMED");
  assert.deepEqual(calls, [["inspect", "--format", "{{json .}}", "container-1"]]);
});

test("Docker resource adapter refuses a mismatched container and never removes it", async () => {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args) {
      calls.push(args);
      return result(JSON.stringify({
        Id: "container-1",
        State: { Running: true },
        Config: { Labels: { "proofblade.managed": "true", "proofblade.run_id": "OTHER-RUN", "proofblade.generation": "3" } },
      }));
    },
  };
  const adapter = new DockerContainerResourceAdapter(runner);
  const resource = record();
  const inspection = await adapter.inspect(resource);
  assert.equal(inspection.binding, "MISMATCH");
  assert.equal((await adapter.adopt(resource, inspection)).state, "UNKNOWN");
  assert.equal((await adapter.release(resource, "stale generation")).released, false);
  assert.deepEqual(calls, [
    ["inspect", "--format", "{{json .}}", "container-1"],
    ["inspect", "--format", "{{json .}}", "container-1"],
  ]);
});

test("Docker resource adapter treats a missing container as absent and release is idempotent", async () => {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args) {
      calls.push(args);
      return result("Error: No such container: container-1\n", 1);
    },
  };
  const adapter = new DockerContainerResourceAdapter(runner);
  const resource = record();
  assert.equal((await adapter.inspect(resource)).status, "ABSENT");
  assert.equal((await adapter.release(resource, "cleanup")).released, true);
  assert.deepEqual(calls, [
    ["inspect", "--format", "{{json .}}", "container-1"],
    ["inspect", "--format", "{{json .}}", "container-1"],
  ]);
});

test("Docker resource adapter fails closed on unsafe or malformed identities", async () => {
  let called = false;
  const adapter = new DockerContainerResourceAdapter({
    async run() {
      called = true;
      return result("not-json");
    },
  });
  const unsafe = await adapter.inspect({ ...record(), externalId: "container id" });
  assert.equal(unsafe.status, "UNKNOWN");
  assert.equal(called, false);
  await assert.rejects(
    adapter.inspect(record(), undefined),
    /Docker inspect returned malformed JSON/,
  );
});

test("Docker adapter lets registry recovery adopt a matching container and release a stale one", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-docker-resource-recovery-"));
  try {
    let removeCalls = 0;
    const runner: DockerCommandRunner = {
      async run(args) {
        if (args[0] === "rm") {
          removeCalls += 1;
          return result("");
        }
        return result(JSON.stringify({
          Id: "container-1",
          State: { Running: true },
          Config: { Labels: {
            "proofblade.managed": "true",
            "proofblade.run_id": "RUN-1",
            "proofblade.generation": "3",
            "proofblade.binding_txn": externalResourceBindingTransactionId({ id: "container:container-1", kind: "container", runId: "RUN-1", generation: 3, ownerLane: "executor" }),
          } },
        }));
      },
    };
    const registry = new ExternalResourceRegistry(join(root, "resources.json"));
    await registry.register({ id: "container:container-1", kind: "container", runId: "RUN-1", generation: 3, ownerLane: "executor", externalId: "container-1" });
    await registry.markStarted("container:container-1", "container-1");
    const adapter = new DockerContainerResourceAdapter(runner);
    const adopted = await registry.reconcileRun("RUN-1", 3, [adapter]);
    assert.deepEqual(adopted.adopted, ["container:container-1"]);
    assert.equal((await registry.get("container:container-1"))?.state, "CONFIRMED");

    const stale = await registry.reconcileRun("RUN-1", 4, [adapter]);
    assert.deepEqual(stale.released, ["container:container-1"]);
    assert.equal(removeCalls, 1);
    assert.equal((await registry.get("container:container-1"))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function record(): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: "container:container-1",
    kind: "container",
    runId: "RUN-1",
    generation: 3,
    ownerLane: "executor",
    state: "STARTED",
    externalId: "container-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    inspectCount: 0,
  };
}

function result(stdout: string, exitCode = 0): DockerProcessResult {
  return { stdout, stderr: exitCode === 0 ? "" : stdout, exitCode, truncated: false, durationMs: 1 };
}
