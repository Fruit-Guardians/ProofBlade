import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { normalizeKnowledgeUri, projectKnowledge, projectProjectKnowledge, readKnowledge, readProjectKnowledge, searchKnowledge, searchProjectKnowledge } from "../src/knowledge/projection.js";
import {
  CONSOLIDATION_EVIDENCE_ID_LIMIT,
  CONSOLIDATION_NEGATIVE_RESULT_ID_LIMIT,
  CONSOLIDATION_RECOVERY_CANDIDATE_LIMIT,
  ConsolidationInterruptedError,
  EvidenceConsolidator,
} from "../src/knowledge/consolidation.js";
import type { ProofBladeConfig } from "../src/config.js";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";

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

test("knowledge projections use canonical pb URIs and bounded artifact L2", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-knowledge-"));
  try {
    const services = createServices(root, config);
    const runId = "KNOWLEDGE-001";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const artifact = await services.artifacts.putText(runId, "sensitive-looking raw observation\n".repeat(100), { filename: "raw.txt", mime: "text/plain", sensitivity: "public" });
    const snapshot = await services.control.snapshot(runId);

    const taskProjection = projectKnowledge(snapshot, `pb://run/${runId}/task/current`);
    assert.equal(taskProjection.uri, `pb://run/${runId}/task/current`);
    assert.equal(taskProjection.kind, "task");
    assert.equal(taskProjection.trust, "verified");
    assert.match(taskProjection.levels.L0, /KNOWLEDGE-001/);
    assert.deepEqual(taskProjection.links.forward, [`pb://run/${runId}/forest`]);

    const artifactProjection = projectKnowledge(snapshot, `pb://run/${runId}/artifact/${artifact.id}`);
    assert.equal(artifactProjection.levels.L2?.uri, `pb://run/${runId}/artifact/${artifact.id}/content`);
    const l2 = await readKnowledge(snapshot, services.artifacts, artifactProjection.uri, "L2", 256);
    assert.equal(l2.artifactId, artifact.id);
    assert.equal(l2.truncated, true);
    assert.equal(l2.content.length, 256);

    const l1 = await readKnowledge(snapshot, services.artifacts, artifactProjection.uri, "L1", 256);
    assert.equal(l1.truncated, true);
    assert.ok(l1.content.length <= 256);

    const boundedSearch = searchKnowledge(snapshot, "", 200, 1_000, true);
    assert.ok(JSON.stringify(boundedSearch).length <= 1_000);

    snapshot.artifacts[artifact.id] = { ...snapshot.artifacts[artifact.id]!, sourceEffectId: "EF-NOT-A-KNOWLEDGE-TARGET" };
    const artifactWithEffectReference = projectKnowledge(snapshot, artifactProjection.uri);
    assert.deepEqual(artifactWithEffectReference.links.forward, []);

    assert.equal(searchKnowledge(snapshot, "raw.txt").some((item) => item.uri === artifactProjection.uri), true);
    const staleSnapshot = structuredClone(snapshot);
    staleSnapshot.artifacts[artifact.id] = { ...staleSnapshot.artifacts[artifact.id]!, generation: snapshot.generation - 1 };
    assert.equal(searchKnowledge(staleSnapshot, "raw.txt").some((item) => item.uri === artifactProjection.uri), false);
    assert.equal(searchKnowledge(staleSnapshot, "raw.txt", 50, 12_000, true).some((item) => item.uri === artifactProjection.uri), true);
    const consolidator = new EvidenceConsolidator(services.control, services.artifacts);
    const consolidated = await consolidator.consolidate(runId, { artifactIds: [artifact.id], policy: "summarize" });
    assert.equal(consolidated.status, "FINISHED");
    assert.deepEqual(await consolidator.orphanOperations(runId), []);
    const replayed = await consolidator.consolidate(runId, { artifactIds: [artifact.id], policy: "summarize" });
    assert.equal(replayed.status, "REPLAYED");
    assert.equal(replayed.artifactId, consolidated.artifactId);
    const [concurrentOne, concurrentTwo] = await Promise.all([
      new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [artifact.id], policy: "all" }),
      new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [artifact.id], policy: "all" }),
    ]);
    assert.deepEqual(new Set([concurrentOne.status, concurrentTwo.status]), new Set(["FINISHED", "REPLAYED"]));
    assert.equal(concurrentOne.artifactId, concurrentTwo.artifactId);
    const afterConcurrent = await services.control.snapshot(runId);
    assert.equal(Object.values(afterConcurrent.artifacts).filter((item) => item.semantic?.tags.includes("consolidation")).length, 2);
    const eventTypes = (await services.control.events(runId)).map((event) => event.type);
    assert.equal(eventTypes.includes("consolidate_started"), true);
    assert.equal(eventTypes.includes("consolidate_summary"), true);
    assert.equal(eventTypes.includes("consolidate_finished"), true);
    assert.throws(() => projectKnowledge(snapshot, "pb://run/OTHER/artifact/A-1"), /another run/);
    assert.throws(() => projectKnowledge(snapshot, `pb://run/${runId}/artifact/../content`), /Unsupported knowledge URI|scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project knowledge exposes bounded read-only skill and resource directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-project-knowledge-"));
  try {
    const skillDir = join(root, "skills", "triage");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: triage\ndescription: Focus evidence review\n---\n\n${"procedure\n".repeat(2_000)}`, "utf8");
    const skills = await ProofBladeSkillRegistry.load(root, "skills");
    const source = {
      skills,
      skillCatalogHash: skills.catalogHash(),
      tools: [{ id: "proofblade.test", description: "Test tool", version: "1" }],
      toolCatalogHash: sha256(canonicalJson(["proofblade.test"])),
      mcpServers: [{ name: "reverse", description: "Reverse server", configHash: "a".repeat(64), status: "configured" }],
      mcpCatalogHash: sha256(canonicalJson(["reverse"])),
    };
    const index = projectProjectKnowledge(source, "pb://project/index");
    assert.equal(index.kind, "project");
    assert.deepEqual(index.links.forward, ["pb://project/skills/triage"]);
    const l0 = readProjectKnowledge(source, "pb://project/skills/triage", "L0", 256);
    assert.match(l0.content, /Focus evidence review/);
    const l2 = readProjectKnowledge(source, "pb://project/skills/triage", "L2", 256);
    assert.equal(l2.content.length <= 256, true);
    assert.equal(l2.truncated, true);
    assert.equal(JSON.stringify(l2.projection).length < 4_000, true);
    const results = searchProjectKnowledge(source, "triage", 200, 1_000);
    assert.equal(results.some((item) => item.uri === "pb://project/skills/triage"), true);
    assert.equal(JSON.stringify(results).length <= 1_000, true);
    assert.equal(normalizeKnowledgeUri(" pb://project/skills/triage "), "pb://project/skills/triage");
    assert.throws(() => normalizeKnowledgeUri("pb://project/skills/%2e%2e"), /scope/);
    assert.throws(() => normalizeKnowledgeUri("pb://project/skills/a%2Fb"), /scope/);
    assert.throws(() => projectProjectKnowledge(source, "pb://project/skills/missing"), /Unknown project skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consolidation closes over complete bounded evidence and rejected-hypothesis sets", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-consolidation-closure-"));
  try {
    const services = createServices(root, config);
    const runId = "CONSOLIDATE-CLOSURE";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const source = await services.artifacts.putText(runId, "bounded consolidation source", { filename: "source.txt", sensitivity: "public" });
    const evidenceIds = Array.from({ length: CONSOLIDATION_EVIDENCE_ID_LIMIT + 6 }, (_, index) => `EV-BOUND-${String(index).padStart(3, "0")}`);
    const rejectedHypothesisIds = Array.from({ length: CONSOLIDATION_NEGATIVE_RESULT_ID_LIMIT + 6 }, (_, index) => `H-BOUND-${String(index).padStart(3, "0")}`);
    await services.control.dispatchBatch(runId, evidenceIds.map((evidenceId) => ({
      type: "evidence" as const,
      evidence: { id: evidenceId, kind: "observation" as const, summary: evidenceId, source: { artifactId: source.id, generation }, confidence: 0.8, supports: [], refutes: [] },
    })));
    await services.control.dispatchBatch(runId, rejectedHypothesisIds.map((hypothesisId, index) => ({
      type: "hypothesis" as const,
      hypothesis: { id: hypothesisId, statement: hypothesisId, status: "REJECTED" as const, evidenceIds: [evidenceIds[index % evidenceIds.length]!] },
    })));

    const consolidator = new EvidenceConsolidator(services.control, services.artifacts);
    const first = await consolidator.consolidate(runId, { artifactIds: [source.id], policy: "all" });
    const firstContent = JSON.parse(await services.artifacts.readText(runId, (await services.control.snapshot(runId)).artifacts[first.artifactId]!)) as {
      beforeHash: string;
      closure: typeof first.closure;
      evidenceIds: string[];
      negativeResults: string[];
    };
    assert.deepEqual(firstContent.evidenceIds, evidenceIds.slice(0, CONSOLIDATION_EVIDENCE_ID_LIMIT));
    assert.deepEqual(firstContent.negativeResults, rejectedHypothesisIds.slice(0, CONSOLIDATION_NEGATIVE_RESULT_ID_LIMIT));
    assert.equal(firstContent.closure.evidence.count, evidenceIds.length);
    assert.equal(firstContent.closure.evidence.hash, sha256(canonicalJson(evidenceIds)));
    assert.equal(firstContent.closure.rejectedHypotheses.count, rejectedHypothesisIds.length);
    assert.equal(firstContent.closure.rejectedHypotheses.hash, sha256(canonicalJson(rejectedHypothesisIds)));
    assert.deepEqual(first.closure, firstContent.closure);
    assert.equal(first.beforeHash, firstContent.beforeHash);
    assert.ok(JSON.stringify(firstContent).length < 32_000);
    const firstStart = (await services.control.events(runId)).find((event) => event.type === "consolidate_started" && event.payload?.operationId === first.operationId);
    assert.deepEqual(firstStart?.payload?.closure, first.closure);
    assert.deepEqual(firstStart?.payload?.evidenceIds, firstContent.evidenceIds);
    assert.deepEqual(firstStart?.payload?.negativeResults, firstContent.negativeResults);

    const extraRejectedId = "H-BOUND-ZZZ";
    await services.control.dispatch(runId, {
      type: "hypothesis",
      hypothesis: { id: extraRejectedId, statement: extraRejectedId, status: "REJECTED", evidenceIds: [evidenceIds[0]!] },
    });
    const afterRejected = await consolidator.consolidate(runId, { artifactIds: [source.id], policy: "all" });
    const afterRejectedContent = JSON.parse(await services.artifacts.readText(runId, (await services.control.snapshot(runId)).artifacts[afterRejected.artifactId]!)) as typeof firstContent;
    assert.notEqual(afterRejected.operationId, first.operationId);
    assert.deepEqual(afterRejectedContent.negativeResults, firstContent.negativeResults);
    assert.equal(afterRejectedContent.closure.rejectedHypotheses.count, rejectedHypothesisIds.length + 1);
    assert.equal(afterRejectedContent.closure.rejectedHypotheses.hash, sha256(canonicalJson([...rejectedHypothesisIds, extraRejectedId].sort())));

    const extraEvidenceId = "EV-BOUND-ZZZ";
    await services.control.dispatch(runId, {
      type: "evidence",
      evidence: { id: extraEvidenceId, kind: "observation", summary: extraEvidenceId, source: { artifactId: source.id, generation }, confidence: 0.8, supports: [], refutes: [] },
    });
    const afterEvidence = await consolidator.consolidate(runId, { artifactIds: [source.id], policy: "all" });
    const afterEvidenceContent = JSON.parse(await services.artifacts.readText(runId, (await services.control.snapshot(runId)).artifacts[afterEvidence.artifactId]!)) as typeof firstContent;
    assert.notEqual(afterEvidence.operationId, afterRejected.operationId);
    assert.deepEqual(afterEvidenceContent.evidenceIds, firstContent.evidenceIds);
    assert.equal(afterEvidenceContent.closure.evidence.count, evidenceIds.length + 1);
    assert.equal(afterEvidenceContent.closure.evidence.hash, sha256(canonicalJson([...evidenceIds, extraEvidenceId].sort())));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consolidation resumes start and artifact crash points without duplicate promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-consolidation-recovery-"));
  try {
    const services = createServices(root, config);
    const runId = "CONSOLIDATE-RECOVERY";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const source = await services.artifacts.putText(runId, "recoverable raw output", { filename: "source.txt", sensitivity: "public" });
    let startOperation = "";
    const startCrash = new EvidenceConsolidator(services.control, services.artifacts, (point, operationId) => {
      if (point === "after_start") {
        startOperation = operationId;
        throw new ConsolidationInterruptedError(point);
      }
    });
    await assert.rejects(startCrash.consolidate(runId, { artifactIds: [source.id], policy: "deduplicate" }), ConsolidationInterruptedError);
    const startEvent = (await services.control.events(runId)).find((event) => event.type === "consolidate_started" && event.payload?.operationId === startOperation);
    const durableStartBeforeHash = String(startEvent?.payload?.beforeHash);
    assert.match(durableStartBeforeHash, /^[a-f0-9]{64}$/);
    assert.notEqual((await services.control.snapshot(runId)).projectionHash, durableStartBeforeHash);
    assert.deepEqual(await startCrash.orphanOperations(runId), [startOperation]);
    const resumedStart = await new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [source.id], policy: "deduplicate" });
    assert.equal(resumedStart.operationId, startOperation);
    assert.equal(resumedStart.status, "FINISHED");
    assert.equal(resumedStart.beforeHash, durableStartBeforeHash);
    assert.deepEqual(await startCrash.orphanOperations(runId), []);

    let artifactOperation = "";
    const artifactCrash = new EvidenceConsolidator(services.control, services.artifacts, (point, operationId) => {
      if (point === "after_artifact") {
        artifactOperation = operationId;
        throw new ConsolidationInterruptedError(point);
      }
    });
    await assert.rejects(artifactCrash.consolidate(runId, { artifactIds: [source.id], policy: "summarize" }), ConsolidationInterruptedError);
    const artifactStartEvent = (await services.control.events(runId)).find((event) => event.type === "consolidate_started" && event.payload?.operationId === artifactOperation);
    const durableArtifactBeforeHash = String(artifactStartEvent?.payload?.beforeHash);
    assert.match(durableArtifactBeforeHash, /^[a-f0-9]{64}$/);
    await Promise.all(Array.from({ length: CONSOLIDATION_RECOVERY_CANDIDATE_LIMIT + 12 }, (_, index) => services.artifacts.putText(runId, JSON.stringify({ operationId: `DECOY-${index}` }), {
      filename: `consolidation-decoy-${index}.json`,
      mime: "application/json",
      sensitivity: "public",
      semantic: { name: `Decoy ${index}`, summary: "Recovery scan decoy.", tags: ["consolidation"], role: "debug", relatedIds: [], annotatedBy: "harness" },
    })));
    const beforeResume = await services.control.snapshot(runId);
    const draftArtifacts = Object.values(beforeResume.artifacts).filter((item) => item.semantic?.tags.includes("consolidation"));
    const recoverableDraft = draftArtifacts.find((item) => item.path.replaceAll("\\", "/").split("/").at(-1) === `${item.id}-consolidate-${artifactOperation}.json`);
    assert.ok(recoverableDraft);
    assert.notEqual(beforeResume.projectionHash, durableArtifactBeforeHash);
    const evidenceCount = Object.keys(beforeResume.evidence).length;
    const originalReadText = services.artifacts.readText.bind(services.artifacts);
    let recoveryCandidateReads = 0;
    services.artifacts.readText = async (candidateRunId, artifact) => {
      recoveryCandidateReads += 1;
      return await originalReadText(candidateRunId, artifact);
    };
    assert.deepEqual(await artifactCrash.orphanOperations(runId), [artifactOperation]);
    const resumedArtifact = await new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [source.id], policy: "summarize" });
    assert.equal(resumedArtifact.operationId, artifactOperation);
    assert.equal(resumedArtifact.artifactId, recoverableDraft.id);
    assert.equal(resumedArtifact.beforeHash, durableArtifactBeforeHash);
    assert.equal(recoveryCandidateReads, 1);
    assert.ok(recoveryCandidateReads <= CONSOLIDATION_RECOVERY_CANDIDATE_LIMIT);
    const afterResume = await services.control.snapshot(runId);
    assert.equal(Object.values(afterResume.artifacts).filter((item) => item.semantic?.tags.includes("consolidation")).length, draftArtifacts.length);
    assert.equal(Object.keys(afterResume.evidence).length, evidenceCount);
    const terminalEvents = (await services.control.events(runId)).filter((event) => event.payload?.operationId === artifactOperation && (event.type === "consolidate_summary" || event.type === "consolidate_finished"));
    assert.deepEqual(terminalEvents.map((event) => event.type), ["consolidate_summary", "consolidate_finished"]);
    assert.equal(terminalEvents[1]!.seq, terminalEvents[0]!.seq + 1);
    assert.equal(resumedArtifact.projectionHash, terminalEvents[0]!.payload.projectionHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
