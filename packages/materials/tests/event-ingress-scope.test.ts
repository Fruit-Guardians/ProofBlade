import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { RunEventIngress } from "../src/orchestration/event-ingress.js";
import { RunCoordinator } from "../src/orchestration/run-coordinator.js";
import { acknowledgeObservationItems, formatObservationQueue, projectObservationQueue } from "../src/orchestration/observation-queue.js";
import { ContextCompiler } from "../src/context/compiler.js";
import { Scope } from "../src/runtime/scope.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { HarnessEvent, JobRecord, RequestEpoch } from "../src/domain/types.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

test("Scope disposes children before parent, resources in LIFO order, and is idempotent", async () => {
  const order: string[] = [];
  const scope = new Scope("run");
  const child = scope.child("lane");
  scope.add("parent-resource", () => order.push("parent"));
  child.add("child-first", () => order.push("child-1"));
  child.add("child-last", () => order.push("child-2"));
  await Promise.all([scope.dispose(), scope.dispose()]);
  assert.deepEqual(order, ["child-2", "child-1", "parent"]);
  assert.equal(scope.isDisposed, true);
  await scope.dispose();
  assert.deepEqual(order, ["child-2", "child-1", "parent"]);
});

test("Scope collects disposal failures without skipping later resources", async () => {
  const order: string[] = [];
  const scope = new Scope("partial");
  scope.add("bad", () => { order.push("bad"); throw new Error("cleanup failed"); });
  scope.add("good", () => order.push("good"));
  await assert.rejects(scope.dispose(), /disposal had 1 failure/);
  assert.deepEqual(order, ["good", "bad"]);
  assert.equal(scope.isDisposed, true);
});

test("RunEventIngress deduplicates, prioritizes, coalesces, and fences stale generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ingress-"));
  try {
    const services = createServices(root, config);
    const runId = "INGRESS-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ingress = new RunEventIngress(services.control);
    const first = await ingress.enqueue(runId, { source: "job", kind: "job.output", correlationId: "job-1", coalescingKey: "job-1", payload: { cursor: 1 } });
    const duplicate = await ingress.enqueue(runId, { source: "job", kind: "job.output", correlationId: "job-1", coalescingKey: "job-1", payload: { cursor: 1 } });
    assert.equal(duplicate.id, first.id);
    await ingress.enqueue(runId, { source: "user", kind: "user.cancel", priority: "urgent", correlationId: "user-1", payload: { reason: "stop" } });
    await ingress.enqueue(runId, { source: "job", kind: "job.output", correlationId: "job-2", coalescingKey: "job-1", payload: { cursor: 2 } });
    await ingress.enqueue(runId, { source: "job", kind: "job.output", generation: 99, correlationId: "stale", payload: { cursor: 3 } });
    const drained = await ingress.drain(runId, "job_safe_point", 8);
    assert.deepEqual(drained.admitted.map((item) => item.kind), ["user.cancel", "job.output"]);
    assert.equal(drained.coalesced.length, 1);
    assert.equal(drained.deferred.length, 0);
    assert.equal(drained.failed.length, 1);
    const replayed = await ingress.drain(runId, "job_safe_point", 8);
    assert.deepEqual(replayed.admitted, []);
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "event_ingress_received").every((event) => event.envelope?.runId === runId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunCoordinator applies user control events through the normal command path", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ingress-control-"));
  try {
    const services = createServices(root, config);
    const runId = "INGRESS-002";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const coordinator = new RunCoordinator(services.control);
    await coordinator.enqueueEvent(runId, { source: "user", kind: "user.cancel", correlationId: "cancel-1", payload: { reason: "operator stop" } });
    const drained = await coordinator.drainEvents(runId, "user_cancel");
    assert.equal(drained.admitted.length, 1);
    assert.equal((await services.control.snapshot(runId)).status, "CANCELLED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunEventIngress leaves deferred events retryable and fences stale events as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ingress-retry-"));
  try {
    const services = createServices(root, config);
    const runId = "INGRESS-RETRY-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ingress = new RunEventIngress(services.control);
    const deferred = await ingress.enqueue(runId, {
      source: "provider",
      kind: "provider.completed",
      correlationId: "provider-1",
      priority: "normal",
      payload: { requestId: "req-1" },
    });
    const stale = await ingress.enqueue(runId, {
      source: "job",
      kind: "job.exit",
      generation: 99,
      correlationId: "job-stale",
      payload: { jobId: "job-1" },
    });

    const first = await ingress.drain(runId, "provider_terminal", 8);
    assert.deepEqual(first.admitted, []);
    assert.deepEqual(first.failed, [stale.id]);
    assert.deepEqual(first.deferred, [deferred.id]);

    const second = await ingress.drain(runId, "idle", 8);
    assert.deepEqual(second.admitted.map((item) => item.ingressId), [deferred.id]);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.deferred, []);

    const processed = (await services.control.events(runId)).filter((event) => event.type === "event_ingress_processed");
    assert.deepEqual(processed.map((event) => [event.payload?.ingressId, event.payload?.status]), [
      [stale.id, "failed"],
      [deferred.id, "applied"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent ingress drains atomically claim each event once", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ingress-concurrent-"));
  try {
    const services = createServices(root, config);
    const runId = "INGRESS-CONCURRENT-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ingress = new RunEventIngress(services.control);
    const envelope = await ingress.enqueue(runId, {
      source: "job",
      kind: "job.keyword",
      correlationId: "job-keyword-1",
      payload: { jobId: "job-1", keyword: "needle" },
    });

    const results = await Promise.all([
      ingress.drain(runId, "job_safe_point", 8),
      ingress.drain(runId, "job_safe_point", 8),
    ]);
    assert.equal(results.filter((result) => result.admitted.some((item) => item.ingressId === envelope.id)).length, 1);
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "event_ingress_processed" && event.payload?.ingressId === envelope.id).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent enqueue calls deduplicate received ingress inside the Run lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ingress-enqueue-race-"));
  try {
    const services = createServices(root, config);
    const runId = "INGRESS-ENQUEUE-RACE-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ingress = new RunEventIngress(services.control);
    const input = {
      source: "job" as const,
      kind: "job.heartbeat",
      correlationId: "job-heartbeat-1",
      idempotencyKey: "job-heartbeat-idempotency",
      payload: { jobId: "job-1", heartbeat: 1 },
    };
    const envelopes = await Promise.all([ingress.enqueue(runId, input), ingress.enqueue(runId, input)]);
    assert.equal(envelopes[0]?.id, envelopes[1]?.id);
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "event_ingress_received").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Observation queue is rebuilt from events, coalesces progress, redacts output, and acknowledges atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-observation-queue-"));
  try {
    const services = createServices(root, config);
    const runId = "OBSERVATION-001";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const ingress = new RunEventIngress(services.control);
    await ingress.enqueue(runId, {
      source: "job",
      kind: "job.output",
      correlationId: "job-output-1",
      coalescingKey: "job:1",
      payload: { jobId: "job-1", status: "running", cursor: 12, output: "secret target output" },
    });
    await ingress.enqueue(runId, {
      source: "job",
      kind: "job.output",
      correlationId: "job-output-2",
      coalescingKey: "job:1",
      payload: { jobId: "job-1", status: "running", cursor: 24, output: "secret target output" },
    });
    const snapshot = await services.control.snapshot(runId);
    const projection = projectObservationQueue(await services.control.events(runId), snapshot);
    assert.equal(projection.total, 1);
    assert.equal(projection.items[0]?.sourceEventIds.length, 2);
    assert.match(projection.items[0]?.summary ?? "", /cursor/);
    assert.doesNotMatch(formatObservationQueue(projection), /secret target output/);
    assert.match(formatObservationQueue(projection), /未处理观察 1\/1/);

    const compiled = new ContextCompiler().build({
      runId,
      lane: "main",
      phase: snapshot.phase,
      task,
      snapshot,
      observationQueue: projection.items,
    });
    assert.equal(compiled.manifest.observationQueue?.total, 1);
    assert.equal(compiled.manifest.observationQueue?.ids[0], projection.items[0]?.id);
    assert.match(compiled.messages[3]?.content ?? "", /Pending observations/);

    await Promise.all([
      acknowledgeObservationItems(services.control, runId, projection.items),
      acknowledgeObservationItems(services.control, runId, projection.items),
    ]);
    const after = await services.control.snapshot(runId);
    const persistedEvents = await services.control.events(runId);
    const rebuilt = projectObservationQueue(await services.control.events(runId), after);
    assert.equal(rebuilt.total, 0);
    assert.equal(persistedEvents.filter((event) => event.type === "observation_consumed").length, 2);
    assert.equal(after.lastSeq, persistedEvents.at(-1)?.seq, "the materialized projection must advance with acknowledgement telemetry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Observation queue derives legacy Job and Provider generations without treating missing generation as current", () => {
  const runId = "OBSERVATION-GENERATION-001";
  const oldJob = jobRecord("J-OLD", 0);
  const currentJob = jobRecord("J-CURRENT", 1);
  const oldEpoch = requestEpoch("RE-OLD", "PR-OLD", 0);
  const currentEpoch = requestEpoch("RE-CURRENT", "PR-CURRENT", 1);
  const snapshot = {
    runId,
    generation: 1,
    jobs: { [oldJob.id]: oldJob, [currentJob.id]: currentJob },
    requestEpochs: { [oldEpoch.id]: oldEpoch, [currentEpoch.id]: currentEpoch },
  };
  const events = [
    legacyEvent(runId, 1, "job_queued", { job: oldJob }),
    legacyEvent(runId, 2, "job_queued", { job: currentJob }),
    legacyEvent(runId, 3, "job_finished", { jobId: oldJob.id }),
    legacyEvent(runId, 4, "job_finished", { jobId: currentJob.id }),
    legacyEvent(runId, 5, "provider_request_stalled", { requestId: oldEpoch.requestId }),
    legacyEvent(runId, 6, "provider_request_stalled", { requestId: currentEpoch.requestId }),
    legacyEvent(runId, 7, "provider_request_stalled", { requestId: "PR-UNKNOWN" }),
  ];
  const projection = projectObservationQueue(events, snapshot);
  assert.deepEqual(projection.items.map((item) => item.relatedIds[0]), [currentJob.id, currentEpoch.requestId]);
  assert.equal(projection.items.some((item) => item.relatedIds.includes(oldJob.id)), false);
  assert.equal(projection.items.some((item) => item.relatedIds.includes(oldEpoch.requestId)), false);
  assert.equal(projection.items.some((item) => item.relatedIds.includes("PR-UNKNOWN")), false);
});

function jobRecord(id: string, generation: number): JobRecord {
  return {
    id,
    capabilityId: "proofblade.test",
    operation: "run",
    backendId: "test",
    backendVersion: "1",
    args: {},
    replayPolicy: "idempotent",
    status: "SUCCEEDED",
    lane: "executor",
    generation,
    createdSeq: generation + 1,
  };
}

function requestEpoch(id: string, requestId: string, generation: number): RequestEpoch {
  return {
    id,
    requestId,
    runId: "OBSERVATION-GENERATION-001",
    generation,
    lane: "executor",
    provider: "test",
    model: "test",
    adapter: "openai-completions",
    toolNames: ["read"],
    status: "STARTED",
    createdAt: new Date(0).toISOString(),
    createdSeq: 1,
    updatedSeq: 1,
  };
}

function legacyEvent(runId: string, seq: number, type: HarnessEvent["type"], payload: Record<string, unknown>): HarnessEvent {
  return {
    schemaVersion: 1,
    id: `${runId}-E${seq}`,
    streamId: runId,
    runId,
    lane: "main",
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    correlationId: `${runId}:legacy`,
    actor: "orchestrator",
    type,
    payload,
  } as HarnessEvent;
}
