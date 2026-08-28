import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExternalResourceRegistry,
  type ExternalResourceAdapter,
  type ExternalResourceInspection,
  type ExternalResourceRecord,
} from "../src/recovery/external-resource-registry.js";
import { sha256 } from "../src/domain/utils.js";
import { ControlStore } from "../src/control/control-store.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { demoTask } from "../src/app/demo.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import type { ContainerRef, ContainerRuntimePort, ContainerSessionHandle, ContainerSessionResult } from "../src/container/contracts.js";
import type { ProofBladeConfig } from "../src/config.js";

const POLICY_HASH = sha256("policy");
const RECIPE_HASH = sha256("recipe");

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

const ref: ContainerRef = {
  runId: "RUN-SESSION",
  generation: 0,
  containerId: "container",
  name: "container",
  profile: "pwn",
  image: "image",
  imageDigest: sha256("image"),
  workspaceHostPath: "/workspace",
  workspaceContainerPath: "/workspace",
  networkPolicy: "none",
};

class FakeSessionRuntime implements Partial<ContainerRuntimePort> {
  public async openSession(input: ContainerRef): Promise<ContainerSessionHandle> {
    return { sessionId: "docker-session-1", externalId: "opaque-session-1", ref: input };
  }
  public async closeSession(): Promise<{ exitCode: number | null }> {
    return { exitCode: 0 };
  }
  public async sessionWrite(): Promise<ContainerSessionResult> {
    return { delta: "", waitReason: "idle", exited: false, truncated: false };
  }
  public async sessionRead(): Promise<ContainerSessionResult> {
    return { delta: "", waitReason: "idle", exited: false, truncated: false };
  }
  public async sessionSignal(): Promise<boolean> {
    return true;
  }
}

class FakeResourceAdapter implements ExternalResourceAdapter {
  public readonly kind = "pwn-session" as const;
  public inspection: ExternalResourceInspection = { status: "PRESENT", binding: "MATCH", externalId: "docker-exec-1", summary: "owned" };
  public readonly adopted: string[] = [];
  public readonly released: string[] = [];
  public failRelease = false;

  public async inspect(_record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
    return this.inspection;
  }

  public async adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string }> {
    this.adopted.push(record.id);
    return inspection.binding === "MATCH" ? { state: "CONFIRMED", summary: "adopted" } : { state: "UNKNOWN", summary: "binding mismatch" };
  }

  public async release(record: ExternalResourceRecord): Promise<{ released: boolean; summary?: string }> {
    if (this.failRelease) throw new Error("release unavailable");
    this.released.push(record.id);
    return { released: true, summary: "released" };
  }
}

function registration(id: string, generation = 2) {
  return {
    id,
    kind: "pwn-session" as const,
    runId: "RUN-RESOURCE",
    generation,
    ownerLane: "verifier" as const,
    effectId: "EF-RESOURCE",
    requestKey: "VR-resource",
    policyHash: POLICY_HASH,
    recipeHash: RECIPE_HASH,
  };
}

test("external resource registry persists lifecycle and exact-binding adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-registry-"));
  try {
    const ledgerPath = join(root, "runs", "external-resources.json");
    const first = new ExternalResourceRegistry(ledgerPath);
    const proposed = await first.register(registration("session:SES-1"));
    assert.equal(proposed.state, "PROPOSED");
    await first.markStarted(proposed.id, "docker-exec-1");

    const adapter = new FakeResourceAdapter();
    const restarted = new ExternalResourceRegistry(ledgerPath);
    const result = await restarted.reconcileRun("RUN-RESOURCE", 2, [adapter]);
    assert.deepEqual(result, { examined: 1, adopted: ["session:SES-1"], released: [], unknown: [], failed: [] });
    assert.deepEqual(adapter.adopted, ["session:SES-1"]);
    assert.equal((await restarted.get("session:SES-1"))?.state, "CONFIRMED");

    const repeated = await restarted.reconcileRun("RUN-RESOURCE", 2, [adapter]);
    assert.deepEqual(repeated, { examined: 1, adopted: ["session:SES-1"], released: [], unknown: [], failed: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale generation releases only a backend-confirmed matching resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-stale-"));
  try {
    const ledgerPath = join(root, "external-resources.json");
    const registry = new ExternalResourceRegistry(ledgerPath);
    await registry.register(registration("session:STALE", 1));
    await registry.markStarted("session:STALE", "docker-exec-stale");
    const adapter = new FakeResourceAdapter();
    const released = await registry.reconcileRun("RUN-RESOURCE", 2, [adapter]);
    assert.deepEqual(released, { examined: 1, adopted: [], released: ["session:STALE"], unknown: [], failed: [] });
    assert.deepEqual(adapter.released, ["session:STALE"]);
    assert.equal((await registry.get("session:STALE"))?.state, "RELEASED");

    await registry.register(registration("session:MISMATCH", 1));
    await registry.markStarted("session:MISMATCH", "foreign");
    adapter.inspection = { status: "PRESENT", binding: "MISMATCH", externalId: "foreign", summary: "foreign owner" };
    const protectedResult = await registry.reconcileRun("RUN-RESOURCE", 2, [adapter]);
    assert.deepEqual(protectedResult, { examined: 1, adopted: [], released: [], unknown: ["session:MISMATCH"], failed: [] });
    assert.equal((await registry.get("session:MISMATCH"))?.state, "UNKNOWN");
    assert.deepEqual(adapter.released, ["session:STALE"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposed resources stay unknown without an adapter and release failures remain retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-failure-"));
  try {
    const ledgerPath = join(root, "external-resources.json");
    const registry = new ExternalResourceRegistry(ledgerPath);
    await registry.register(registration("session:PROPOSED"));
    const proposed = await registry.reconcileRun("RUN-RESOURCE", 2);
    assert.deepEqual(proposed, { examined: 1, adopted: [], released: [], unknown: ["session:PROPOSED"], failed: [] });
    assert.equal((await registry.get("session:PROPOSED"))?.state, "UNKNOWN");

    await registry.register(registration("session:RETRY"));
    await registry.markStarted("session:RETRY", "docker-exec-retry");
    const adapter = new FakeResourceAdapter();
    adapter.failRelease = true;
    assert.equal(await registry.release("session:RETRY", adapter, "cleanup"), false);
    assert.equal((await registry.get("session:RETRY"))?.state, "UNKNOWN");
    adapter.failRelease = false;
    assert.equal(await registry.release("session:RETRY", adapter, "cleanup retry"), true);
    assert.equal((await registry.get("session:RETRY"))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposed resources are inspected and released through the adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-proposed-recovery-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register({ ...registration("session:PROPOSED-STARTED"), externalId: "opaque-proposed" });
    const adapter = new FakeResourceAdapter();
    const result = await registry.reconcileRun("RUN-RESOURCE", 2, [adapter]);
    assert.deepEqual(result, { examined: 1, adopted: [], released: ["session:PROPOSED-STARTED"], unknown: [], failed: [] });
    assert.deepEqual(adapter.released, ["session:PROPOSED-STARTED"]);
    assert.equal((await registry.get("session:PROPOSED-STARTED"))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external resource locators are cloned before entering the durable ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-ref-clone-"));
  try {
    const refs = { solver: "solver-name" };
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register({ ...registration("session:REFS"), externalRefs: refs });
    refs.solver = "mutated-name";
    assert.deepEqual((await registry.get("session:REFS"))?.externalRefs, { solver: "solver-name" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate resource ids cannot change immutable bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-binding-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("session:DUP"));
    await registry.register(registration("session:DUP"));
    await assert.rejects(() => registry.register({ ...registration("session:DUP"), generation: 3 }), /binding mismatch for generation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control-session binding is durable and immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-control-binding-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const record = await registry.registerStarted({ ...registration("session:BOUND"), externalId: "opaque-bound" });
    assert.match(record.bindingTxnId ?? "", /^[a-f0-9]{64}$/);
    const bound = await registry.markControlBound(record.id, "BOUND");
    assert.equal(bound.controlSessionId, "BOUND");
    await assert.rejects(() => registry.markControlBound(record.id, "OTHER"), /binding mismatch/);
    const repeated = await registry.markControlBound(record.id, "BOUND");
    assert.equal(repeated.controlSessionId, "BOUND");
    await assert.rejects(
      () => registry.registerStarted({ ...registration("session:BOUND"), externalId: "opaque-bound", bindingTxnId: sha256("different-binding") }),
      /binding transaction mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionRegistry mirrors open/close and restart orphan state into the resource ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-resource-session-"));
  try {
    const runId = "RUN-SESSION";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "runs", "external-resources.json"));
    const registry = new SessionRegistry(runId, new FakeSessionRuntime() as unknown as ContainerRuntimePort, control, ledger);
    const session = await registry.open({ ref, kind: "pwn-local", ownerLane: "executor", command: ["/bin/sh"] });
    assert.equal((await ledger.get(`session:${session.id}`))?.state, "STARTED");
    assert.equal((await ledger.get(`session:${session.id}`))?.externalId, "opaque-session-1");
    assert.equal((await ledger.get(`session:${session.id}`))?.controlSessionId, session.id);
    await registry.close("executor", session.id, "test close");
    assert.equal((await ledger.get(`session:${session.id}`))?.state, "RELEASED");

    const orphan = await registry.open({ ref, kind: "pwn-local", ownerLane: "executor", command: ["/bin/sh"] });
    const fresh = SessionRegistry.forRecovery(runId, control, ledger);
    assert.equal(await fresh.supersedeOrphans(), 1);
    assert.equal((await ledger.get(`session:${orphan.id}`))?.state, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
