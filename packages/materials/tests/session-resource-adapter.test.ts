import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExternalResourceRegistry,
  resolveExternalResourceAdapters,
  type ExternalResourceInspection,
  type ExternalResourceRecord,
} from "../src/recovery/external-resource-registry.js";
import {
  SessionResourceAdapter,
  type SessionRuntimeAdoptResult,
  withSessionResourceAdapters,
  type SessionRuntimeBroker,
} from "../src/recovery/session-resource-adapter.js";
import { sha256 } from "../src/domain/utils.js";
import type { ContainerRef } from "../src/container/contracts.js";

function registration(kind: "pwn-session" | "http-session", id: string, externalId?: string) {
  return {
    id,
    kind,
    runId: "RUN-SESSION-BROKER",
    generation: 3,
    ownerLane: "verifier" as const,
    ...(externalId ? { externalId } : {}),
    policyHash: sha256("policy"),
    recipeHash: sha256("recipe"),
    scopeHash: sha256("scope"),
  };
}

class FakeBroker implements SessionRuntimeBroker {
  public readonly name = "fake-session-broker";
  public readonly adopted: string[] = [];
  public readonly released: string[] = [];
  public inspection: ExternalResourceInspection = { status: "PRESENT", binding: "MATCH", externalId: "opaque-pwn-1", summary: "exact broker match" };
  public failRelease = false;
  public failInspect = false;
  public provideBinding = true;

  public constructor(public readonly kind: "pwn-session" | "http-session") {}

  public async inspect(_record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
    if (this.failInspect) throw new Error("broker query timed out");
    return this.inspection;
  }

  public async adopt(record: ExternalResourceRecord): Promise<SessionRuntimeAdoptResult> {
    this.adopted.push(record.id);
    if (!this.provideBinding) return { state: "CONFIRMED", summary: "broker adopted ownership but could not bind this process" };
    if (this.kind === "pwn-session") {
      return {
        state: "CONFIRMED",
        summary: "broker adopted exact handle",
        binding: {
          kind: "pwn-session",
          externalId: record.externalId!,
          handle: { sessionId: `runtime-${record.id}`, externalId: record.externalId, ref: fakeRef(record) },
          runtime: fakeSessionRuntime,
        },
      };
    }
    return {
      state: "CONFIRMED",
      summary: "broker adopted exact handle",
      binding: { kind: "http-session", externalId: record.externalId!, fetchImpl: async () => new Response("ok") },
    };
  }

  public async release(record: ExternalResourceRecord): Promise<{ released: boolean; summary?: string }> {
    if (this.failRelease) throw new Error("broker temporarily unavailable");
    this.released.push(record.id);
    return { released: true, summary: "broker released exact handle" };
  }
}

const fakeSessionRuntime = {
  async sessionWrite() { return { delta: "", waitReason: "idle" as const, exited: false, truncated: false }; },
  async sessionRead() { return { delta: "", waitReason: "idle" as const, exited: false, truncated: false }; },
  async sessionSignal() { return true; },
  async closeSession() { return { exitCode: 0 }; },
};

function fakeRef(record: ExternalResourceRecord): ContainerRef {
  return {
    runId: record.runId,
    generation: record.generation,
    containerId: "container-1",
    name: "proofblade-test",
    profile: "pwn",
    image: "proofblade/pwn:test",
    imageDigest: "sha256:test",
    workspaceHostPath: "/workspace",
    workspaceContainerPath: "/workspace",
    networkPolicy: "none",
  };
}

test("Pwn broker adapter adopts only the exact opaque handle after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-session-broker-"));
  try {
    const ledgerPath = join(root, "external-resources.json");
    const first = new ExternalResourceRegistry(ledgerPath);
    await first.register(registration("pwn-session", "session:PWN-1", "opaque-pwn-1"));
    await first.markStarted("session:PWN-1", "opaque-pwn-1");
    const broker = new FakeBroker("pwn-session");
    const restarted = new ExternalResourceRegistry(ledgerPath);
    const adapter = new SessionResourceAdapter(broker);
    const result = await restarted.reconcileRun("RUN-SESSION-BROKER", 3, [adapter]);
    assert.deepEqual(result, { examined: 1, adopted: ["session:PWN-1"], released: [], unknown: [], failed: [] });
    assert.deepEqual(broker.adopted, ["session:PWN-1"]);
    assert.equal((await restarted.get("session:PWN-1"))?.state, "CONFIRMED");
    assert.equal(adapter.takeBinding("session:PWN-1")?.kind, "pwn-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP broker adapter refuses a different handle and never releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-http-session-broker-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("http-session", "session:HTTP-1", "opaque-http-1"));
    await registry.markStarted("session:HTTP-1", "opaque-http-1");
    const broker = new FakeBroker("http-session");
    broker.inspection = { status: "PRESENT", binding: "MATCH", externalId: "opaque-http-foreign", summary: "foreign session" };
    const adapter = new SessionResourceAdapter(broker);
    const result = await registry.reconcileRun("RUN-SESSION-BROKER", 3, [adapter]);
    assert.deepEqual(result, { examined: 1, adopted: [], released: [], unknown: ["session:HTTP-1"], failed: [] });
    assert.equal((await registry.get("session:HTTP-1"))?.state, "UNKNOWN");
    assert.deepEqual(broker.adopted, []);
    assert.deepEqual(broker.released, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker release re-inspects and remains retryable after a temporary failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-release-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("pwn-session", "session:RETRY", "opaque-pwn-1"));
    await registry.markStarted("session:RETRY", "opaque-pwn-1");
    const broker = new FakeBroker("pwn-session");
    broker.failRelease = true;
    const adapter = new SessionResourceAdapter(broker);
    assert.equal(await registry.release("session:RETRY", adapter, "cleanup"), false);
    assert.equal((await registry.get("session:RETRY"))?.state, "UNKNOWN");
    broker.failRelease = false;
    assert.equal(await registry.release("session:RETRY", adapter, "cleanup retry"), true);
    assert.equal((await registry.get("session:RETRY"))?.state, "RELEASED");
    assert.deepEqual(broker.released, ["session:RETRY"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing opaque handles stay UNKNOWN and lazy composition preserves existing adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-composition-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("http-session", "session:NO-HANDLE"));
    await registry.markStarted("session:NO-HANDLE", "process-local");
    const broker = new FakeBroker("http-session");
    const existing = {
      kind: "container" as const,
      inspect: async () => ({ status: "ABSENT" as const, binding: "UNKNOWN" as const }),
      adopt: async () => ({ state: "UNKNOWN" as const }),
      release: async () => ({ released: true }),
    };
    const source = withSessionResourceAdapters([existing], [broker]);
    const adapters = await resolveExternalResourceAdapters(source, { runId: "RUN-SESSION-BROKER", generation: 3 });
    assert.deepEqual(adapters.map((adapter) => adapter.kind), ["container", "http-session"]);
    const result = await registry.reconcileRun("RUN-SESSION-BROKER", 3, adapters);
    assert.deepEqual(result, { examined: 1, adopted: [], released: [], unknown: ["session:NO-HANDLE"], failed: [] });
    assert.equal((await registry.get("session:NO-HANDLE"))?.state, "UNKNOWN");

    await registry.register(registration("http-session", "session:NO-ECHO", "opaque-http-2"));
    await registry.markStarted("session:NO-ECHO", "opaque-http-2");
    broker.inspection = { status: "PRESENT", binding: "MATCH", summary: "broker omitted the handle" };
    const noEcho = await registry.reconcileRun("RUN-SESSION-BROKER", 3, adapters);
    assert.deepEqual(noEcho, { examined: 2, adopted: [], released: [], unknown: ["session:NO-ECHO", "session:NO-HANDLE"], failed: [] });
    assert.equal((await registry.get("session:NO-ECHO"))?.state, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownership confirmation without a runtime binding remains UNKNOWN", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-no-binding-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("pwn-session", "session:NO-RUNTIME", "opaque-pwn-2"));
    await registry.markStarted("session:NO-RUNTIME", "opaque-pwn-2");
    const broker = new FakeBroker("pwn-session");
    broker.provideBinding = false;
    const result = await registry.reconcileRun("RUN-SESSION-BROKER", 3, [new SessionResourceAdapter(broker)]);
    assert.deepEqual(result, { examined: 1, adopted: [], released: [], unknown: ["session:NO-RUNTIME"], failed: [] });
    assert.equal((await registry.get("session:NO-RUNTIME"))?.state, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker inspection failures stay UNKNOWN and do not invoke adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-query-failure-"));
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await registry.register(registration("http-session", "session:QUERY-FAIL", "opaque-http-query"));
    await registry.markStarted("session:QUERY-FAIL", "opaque-http-query");
    const broker = new FakeBroker("http-session");
    broker.failInspect = true;
    const result = await registry.reconcileRun("RUN-SESSION-BROKER", 3, [new SessionResourceAdapter(broker)]);
    assert.deepEqual(result, { examined: 1, adopted: [], released: [], unknown: ["session:QUERY-FAIL"], failed: [] });
    assert.deepEqual(broker.adopted, []);
    assert.equal((await registry.get("session:QUERY-FAIL"))?.state, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
