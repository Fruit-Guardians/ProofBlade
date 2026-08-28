import assert from "node:assert/strict";
import test from "node:test";
import { parseVerifierOutcomeEnvelope, serializeVerifierOutcomeEnvelope, type VerifierOutcomeEnvelope } from "../src/verification/outcome-envelope.js";

const HASH = "a".repeat(64);

test("VerifierOutcomeEnvelope is bounded, deterministic, and replay-safe", () => {
  const envelope: VerifierOutcomeEnvelope = {
    schemaVersion: 1,
    requestKey: HASH,
    runId: "RUN-OUTCOME",
    generation: 3,
    kind: "pwn",
    policyHash: HASH,
    recipeHash: "b".repeat(64),
    externalId: "dxs-1",
    externalStatus: "CONFIRMED",
    attempts: [{ id: "attempt-1", phase: "pwn_replay", status: "PASSED", externalId: "dxs-1", summary: "shell and flag barriers passed" }],
    transcriptArtifactIds: ["A-1"],
    stageSummary: { reproduced: true, stageCount: 3 },
    evidenceIds: [],
    terminal: false,
  };
  const serialized = serializeVerifierOutcomeEnvelope(envelope, { replay: true });
  assert.equal(serialized, serializeVerifierOutcomeEnvelope(parseVerifierOutcomeEnvelope(serialized ? JSON.parse(serialized) : undefined), { replay: true }));
  assert.equal(parseVerifierOutcomeEnvelope(JSON.parse(serialized), { replay: true }).stageSummary?.reproduced, true);
  assert.throws(() => parseVerifierOutcomeEnvelope({ ...envelope, candidateHash: HASH }, { replay: true }), /cannot contain a candidate/);
  assert.throws(() => parseVerifierOutcomeEnvelope({ ...envelope, accepted: true }, { replay: true }), /cannot contain a candidate/);
  assert.throws(() => parseVerifierOutcomeEnvelope({ ...envelope, transcriptArtifactIds: Array.from({ length: 129 }, () => "A") }), /0-128/);
});

test("VerifierOutcomeEnvelope rejects terminal results without a verdict and malformed hashes", () => {
  const base = {
    schemaVersion: 1,
    requestKey: HASH,
    runId: "RUN-OUTCOME",
    generation: 0,
    kind: "claim",
    policyHash: HASH,
    recipeHash: HASH,
    externalStatus: "CONFIRMED",
    attempts: [],
    transcriptArtifactIds: [],
    evidenceIds: [],
    terminal: true,
  };
  assert.throws(() => parseVerifierOutcomeEnvelope(base), /requires an accepted boolean/);
  assert.throws(() => parseVerifierOutcomeEnvelope({ ...base, accepted: true, policyHash: "bad" }), /policyHash must be a sha256 hash/);
});

test("claim final attestations may carry a verdict, but replay envelopes may not", () => {
  const final: VerifierOutcomeEnvelope = {
    schemaVersion: 1,
    requestKey: "claim-request",
    runId: "RUN-CLAIM",
    generation: 2,
    kind: "claim",
    policyHash: HASH,
    recipeHash: HASH,
    candidateHash: HASH,
    externalStatus: "CONFIRMED",
    attempts: [{ id: "ATT-1", phase: "claim_reproduction", status: "PASSED", artifactId: "A-EXEC", summary: "exact candidate" }],
    primaryArtifactId: "A-EXEC",
    transcriptArtifactIds: ["A-EXEC"],
    evidenceIds: ["EV-1"],
    accepted: true,
    terminal: true,
  };
  const serialized = serializeVerifierOutcomeEnvelope(final);
  assert.deepEqual(parseVerifierOutcomeEnvelope(JSON.parse(serialized)), final);
  assert.throws(() => serializeVerifierOutcomeEnvelope(final, { replay: true }), /cannot contain a candidate/);
});
