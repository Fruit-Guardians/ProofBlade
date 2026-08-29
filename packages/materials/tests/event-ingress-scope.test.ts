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
    assert.equal(drained.deferred.length, 1);
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
