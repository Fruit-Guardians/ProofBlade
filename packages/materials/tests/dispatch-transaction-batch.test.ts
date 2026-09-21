import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import type { ProofBladeConfig } from "../src/config.js";

/**
 * Settles PLAN-240 item T2: can `artifact → artifact_annotation → observation →
 * evidence` be committed as **one** transaction instead of four dispatches?
 *
 * The plan closed T2 as infeasible on the claim that `prepare` validates every
 * command in a batch against the snapshot taken *before* the batch. The commit
 * loop does not do that — it folds the batch and validates each command against
 * the running `after` (`control-store.ts`, `#commitCommands`), so a later
 * command can reference a record an earlier command in the same batch created.
 * The only ordering constraint is that a creator precedes its referencee.
 *
 * This file is the measurement, not an argument: it commits the four commands
 * in one `dispatchTransaction` and asserts the projector saw all four records.
 * If this ever goes red, T2 is genuinely infeasible and the plan needs a real
 * reason rather than the one it currently records.
 */

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
};

test("one transaction can create an artifact, annotate it, observe it and cite it as evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-t2-batch-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "T2-BATCH-001";
    await control.createRun(runId, demoTask(runId, root, config));
    const generation = (await control.snapshot(runId)).generation;

    const projected = await control.dispatchTransaction(runId, () => ({
      commands: [
        {
          type: "artifact" as const,
          generation,
          artifact: {
            id: "A-T2",
            path: "artifacts/t2.txt",
            sha256: "a".repeat(64),
            bytes: 6,
            mime: "text/plain",
            sensitivity: "public" as const,
          },
          lane: "executor" as const,
        },
        {
          type: "artifact_annotation" as const,
          artifactId: "A-T2",
          semantic: { name: "T2 artifact", summary: "created in the same batch", tags: ["t2"], role: "intermediate" as const, relatedIds: [], annotatedBy: "agent" as const },
          lane: "main" as const,
        },
        {
          type: "observation" as const,
          observation: {
            id: "O-T2",
            summary: "Observed the artifact created in this batch",
            source: { operation: "read", artifactId: "A-T2", generation },
            candidateKinds: [],
          },
          lane: "executor" as const,
        },
        {
          type: "evidence" as const,
          evidence: {
            id: "EV-T2",
            kind: "observation" as const,
            summary: "Cited the artifact created in this batch",
            source: { operation: "read", artifactId: "A-T2", generation },
            // Below 1: confidence 1 is reserved for the trusted verifier service,
            // which is orthogonal to batching.
            confidence: 0.8,
            supports: [],
            refutes: [],
          },
          lane: "executor" as const,
        },
      ],
      project: () => "committed" as const,
    }));

    assert.equal(projected, "committed", "the transaction result is the projector's, not the store's snapshot");

    const after = await control.snapshot(runId);
    assert.ok(after.artifacts["A-T2"], "the artifact must exist after the batch");
    assert.equal(after.artifacts["A-T2"]?.semantic?.name, "T2 artifact", "the annotation in the same batch must apply");
    assert.ok(after.observations["O-T2"], "the observation in the same batch must apply");
    assert.ok(after.evidence["EV-T2"], "the evidence in the same batch must apply");
    assert.deepEqual(after.evidence["EV-T2"]?.provenance.artifactIds, ["A-T2"], "evidence provenance must resolve the same-batch artifact");

    // The batch is durable as one contiguous run of events, and replay agrees.
    const events = await control.events(runId);
    assert.deepEqual(
      events.slice(-4).map((event) => event.envelope?.kind),
      ["artifact", "artifact_annotation", "observation", "evidence"],
    );
    assert.equal(after.lastSeq, events.length);
    assert.equal(JSON.stringify(await control.replay(runId).then((run) => run.evidence["EV-T2"])), JSON.stringify(after.evidence["EV-T2"]));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a reference may also precede its creator inside one batch", async () => {
  // Stronger than "creation must come first": `buildBatchReferences` seeds the
  // reference sets with the ids the batch itself creates, so the order inside
  // the batch does not matter either. This ordering was expected to be rejected;
  // it is accepted, which is the second half of why T2 is feasible.
  const root = await mkdtemp(join(tmpdir(), "proofblade-t2-order-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "T2-ORDER-001";
    await control.createRun(runId, demoTask(runId, root, config));
    const generation = (await control.snapshot(runId)).generation;

    await control.dispatchTransaction(runId, () => ({
      commands: [
        {
          type: "observation" as const,
          observation: { id: "O-EARLY", summary: "references a later artifact", source: { operation: "read", artifactId: "A-LATE", generation }, candidateKinds: [] },
        },
        {
          type: "artifact" as const,
          generation,
          artifact: { id: "A-LATE", path: "artifacts/late.txt", sha256: "b".repeat(64), bytes: 1, mime: "text/plain", sensitivity: "public" as const },
        },
      ],
      project: () => undefined,
    }));

    const after = await control.snapshot(runId);
    assert.ok(after.observations["O-EARLY"], "the batch is order-independent, so the observation must apply");
    assert.ok(after.artifacts["A-LATE"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("only artifact_annotation resolves its artifact against the stored snapshot", async () => {
  // Recorded while settling T2, as a boundary on the finding rather than a claim
  // that batching is unguarded. `artifact_annotation` is the one command in this
  // group that reads `snapshot.artifacts` directly, so it is both the command
  // that would have made T2 infeasible and the only one that rejects an unknown
  // artifact. `observation` carries an `artifactId` that nothing validates, and
  // `evidence` without an effect returns before its artifact is resolved — both
  // are pre-existing gaps, not effects of batching.
  const root = await mkdtemp(join(tmpdir(), "proofblade-t2-missing-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "T2-MISSING-001";
    await control.createRun(runId, demoTask(runId, root, config));
    const generation = (await control.snapshot(runId)).generation;
    const eventCount = (await control.events(runId)).length;

    await assert.rejects(
      control.dispatchTransaction(runId, () => ({
        commands: [
          {
            type: "artifact" as const,
            generation,
            artifact: { id: "A-OK", path: "artifacts/ok.txt", sha256: "c".repeat(64), bytes: 1, mime: "text/plain", sensitivity: "public" as const },
          },
          {
            type: "artifact_annotation" as const,
            artifactId: "A-ABSENT",
            semantic: { name: "orphan", summary: "references an artifact nobody creates", tags: [], role: "debug" as const, relatedIds: [], annotatedBy: "agent" as const },
          },
        ],
        project: () => undefined,
      })),
      /Unknown artifact A-ABSENT/,
    );

    const after = await control.snapshot(runId);
    assert.equal(after.artifacts["A-OK"], undefined, "a rejected batch must roll back its own creations");
    assert.equal((await control.events(runId)).length, eventCount, "a rejected batch must persist nothing");

    // The unchecked half, stated so it cannot be mistaken for a guarantee.
    await control.dispatch(runId, {
      type: "observation",
      observation: { id: "O-DANGLING", summary: "artifactId is not resolved", source: { operation: "read", artifactId: "A-NEVER", generation }, candidateKinds: [] },
    });
    assert.ok((await control.snapshot(runId)).observations["O-DANGLING"], "observed behaviour: an observation's artifactId is stored unchecked");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
