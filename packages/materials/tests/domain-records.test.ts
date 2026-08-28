import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { createServices } from "../src/app/demo.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

test("Web/Pwn domain records are immutable, replayable, and reference current artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-domain-records-control-"));
  try {
    const runId = "WEB-DOMAIN-CONTROL";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "web", target: "http://127.0.0.1:8080/" });
    await control.dispatch(runId, {
      type: "artifact",
      generation: 0,
      artifact: { id: "A-WEB-RECORD", path: "artifacts/exchange.json", sha256: "a".repeat(64), bytes: 4, mime: "application/json", sensitivity: "public" },
      lane: "executor",
    });
    await control.dispatch(runId, {
      type: "evidence",
      evidence: { id: "EV-WEB-RECORD", kind: "observation", summary: "baseline response", source: { artifactId: "A-WEB-RECORD", generation: 0 }, confidence: 0.8, supports: [], refutes: [] },
      lane: "executor",
    });
    await control.dispatch(runId, {
      type: "domain_record",
      record: {
        id: "WEB-BASELINE-001",
        kind: "web_baseline",
        summary: "Baseline response is durable.",
        artifactIds: ["A-WEB-RECORD"],
        evidenceIds: ["EV-WEB-RECORD"],
        baseUrl: "http://127.0.0.1:8080/",
        status: 200,
        stateHash: "b".repeat(64),
      },
      lane: "executor",
    });
    const replayed = await control.replay(runId);
    assert.equal(replayed.domainRecords["WEB-BASELINE-001"]?.kind, "web_baseline");
    assert.deepEqual(replayed.domainRecords["WEB-BASELINE-001"]?.artifactIds, ["A-WEB-RECORD"]);
    await assert.rejects(
      control.dispatch(runId, {
        type: "domain_record",
        record: { id: "WEB-CHAIN-UNTRUSTED", kind: "web_exploit_chain", summary: "pretend reproduced", artifactIds: ["A-WEB-RECORD"], evidenceIds: ["EV-WEB-RECORD"], stepRecordIds: [], status: "reproduced" },
        lane: "executor",
      }),
      /trusted verifier service/,
    );
    await assert.rejects(
      control.dispatch(runId, {
        type: "domain_record",
        record: { id: "PWN-RECORD-WRONG-TARGET", kind: "pwn_binary_profile", summary: "wrong direction", artifactIds: ["A-WEB-RECORD"], evidenceIds: [], format: "ELF", architecture: "x86_64", bits: 64, protections: [] },
        lane: "executor",
      }),
      /not allowed for target kind web/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary capability emits a current-generation pwn profile bound to its Effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-domain-records-binary-"));
  try {
    const runId = "PWN-BINARY-PROFILE";
    const services = createServices(root, config);
    const task = { ...demoTask(runId, root, config), target_kind: "pwn" as const, target: "./chall", scope: { ...demoTask(runId, root, config).scope, allowed_workspace: root } };
    await services.control.createRun(runId, task);
    const binary = Buffer.alloc(64);
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    binary.writeUInt16LE(0x3e, 18);
    binary.writeBigUInt64LE(0x401000n, 24);
    await writeFile(join(root, "chall"), binary);
    const runtime = new ProofBladeToolRuntime(
      runId,
      { fixtureId: runId, generation: 0, path: root, privatePath: join(root, ".proofblade") },
      services.runsRoot,
      services.control,
      services.artifacts,
      services.journal,
      root,
      { includeMcp: false },
    );
    try {
      const result = await runtime.invokeCapability({ capabilityId: "proofblade.binary", operation: "identify", input: { path: "chall" } });
      assert.ok(result.domainRecordIds?.length === 1);
      const snapshot = await services.control.replay(runId);
      const profile = Object.values(snapshot.domainRecords).find((record) => record.kind === "pwn_binary_profile");
      assert.ok(profile);
      assert.equal(profile.effectId, result.effectId);
      assert.deepEqual(profile.artifactIds, [result.artifactId]);
      assert.deepEqual(profile.evidenceIds, [result.evidenceId]);
      assert.equal(profile.architecture, "x86_64");
      assert.equal(profile.bits, 64);
      await services.fixtureControl.reset(runId, 1);
      const second = await runtime.invokeCapability({ capabilityId: "proofblade.binary", operation: "identify", input: { path: "chall" } });
      const profiles = Object.values((await services.control.replay(runId)).domainRecords).filter((record) => record.kind === "pwn_binary_profile");
      assert.equal(profiles.length, 2);
      assert.notEqual(second.domainRecordIds?.[0], result.domainRecordIds?.[0]);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
