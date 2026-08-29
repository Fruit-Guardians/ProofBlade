import type { HarnessEvent, RunSnapshot, RunStatus, TaskContract, UpdateEvaluationGate, UpdateProposal } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";
import { validateDomainRecordShape } from "../domain/records.js";
import { completedWorkItemForCompletion } from "../domain/work-item.js";
import { validateUpdateEvaluationGate } from "../evolution/evaluation-gates.js";

export function createInitialSnapshot(runId: string, task: TaskContract): RunSnapshot {
  return {
    runId,
    task,
    taskHash: sha256(canonicalJson(task)),
    authorityHash: "UNANCHORED",
    status: "CREATED",
    phase: "intake",
    domainPhase: "INTAKE",
    generation: 0,
    lastSeq: 0,
    facts: {},
    observations: {},
    evidence: {},
    domainRecords: {},
    reasoningNodes: {},
    reasoningEdges: {},
    reasoningTrees: {},
    hypotheses: {},
    intents: {},
    schedulerIntents: {},
    completions: {},
    verificationRequests: {},
    checkpoints: {},
    jobs: {},
    handoffs: {},
    workItems: {},
    sessions: {},
    requestEpochs: {},
    experiments: {},
    replans: {},
    updateProposals: {},
    replanCount: 0,
    contextOverflowRecoveries: 0,
    artifacts: {},
    effects: {},
    leases: {},
    leaseEpochs: {},
    activeLanes: [],
  };
}

const terminal: RunStatus[] = ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"];

export function reduce(snapshot: RunSnapshot, event: HarnessEvent): RunSnapshot {
  if (event.runId !== snapshot.runId || event.streamId !== snapshot.runId) {
    throw new Error(`Event stream does not match Run ${snapshot.runId}`);
  }
  if (event.seq !== snapshot.lastSeq + 1) {
    throw new Error(`Event sequence gap for ${event.runId}: expected ${snapshot.lastSeq + 1}, got ${event.seq}`);
  }
  const next = structuredClone(snapshot);
  next.schedulerIntents ??= {};
  next.leaseEpochs ??= {};
  next.replans ??= {};
  next.updateProposals ??= {};
  next.domainRecords ??= {};
  next.replanCount ??= Object.keys(next.replans).length;
  next.lastSeq = event.seq;
  const p = event.payload ?? {};

  switch (event.type) {
    case "run_started":
      if (snapshot.lastSeq !== 0 || snapshot.status !== "CREATED" || snapshot.authorityHash !== "UNANCHORED") {
        throw new Error("run_started is immutable and may only be the first Run event");
      }
      if (p.taskHash !== undefined && (typeof p.taskHash !== "string" || p.taskHash !== next.taskHash)) {
        throw new Error("Task contract hash does not match the immutable run anchor");
      }
      if (p.taskHash === undefined && p.authorityHash !== undefined) {
        throw new Error("A trusted authority anchor cannot omit its task contract hash");
      }
      next.authorityHash = typeof p.authorityHash === "string" && /^[a-f0-9]{64}$/i.test(p.authorityHash)
        ? p.authorityHash
        : "LEGACY-UNTRUSTED";
      next.status = "READY";
      next.startedAt = event.ts;
      next.generation = Number(p.generation ?? 0);
      next.versionSnapshot = p.versionSnapshot as RunSnapshot["versionSnapshot"];
      break;
    case "run_authority_migrated":
      if (snapshot.authorityHash !== "LEGACY-UNTRUSTED") throw new Error("Run authority migration is only valid for an untrusted legacy Run");
      if (typeof p.taskHash !== "string" || p.taskHash !== next.taskHash) throw new Error("Legacy Run migration task hash does not match task.json");
      if (typeof p.authorityHash !== "string" || !/^[a-f0-9]{64}$/i.test(p.authorityHash)) throw new Error("Legacy Run migration requires a valid authority hash");
      next.authorityHash = p.authorityHash;
      break;
    case "phase_started":
      next.phase = p.phase as RunSnapshot["phase"];
      if (next.status !== "PAUSED") {
        if (next.phase === "verification") next.status = "VERIFYING";
        else if (next.status === "READY" || next.status === "VERIFYING") next.status = "RUNNING";
      }
      break;
    case "phase_finished":
      if (p.phase) next.phase = p.phase as RunSnapshot["phase"];
      break;
    case "domain_phase_changed": {
      const phase = p.domainPhase as RunSnapshot["domainPhase"];
      if (!["INTAKE", "RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE", "REPORT", "SUBMIT"].includes(phase)) throw new Error(`Unknown domain phase: ${String(phase)}`);
      next.domainPhase = phase;
      break;
    }
    case "tool_preparation_recorded":
      next.toolPreparation = p.preparation as RunSnapshot["toolPreparation"];
      break;
    case "fixture_reset":
      {
        if (terminal.includes(next.status)) throw new Error(`Cannot reset fixture for terminal run ${next.status}`);
        if (next.phase === "verification" || next.phase === "report") throw new Error(`Cannot reset fixture during ${next.phase}`);
        const generation = Number(p.generation);
        if (!Number.isInteger(generation) || generation <= next.generation) throw new Error("fixture_reset requires a monotonically increasing generation");
        next.generation = generation;
        for (const intent of Object.values(next.schedulerIntents)) {
          if (intent.fixtureGeneration === generation || (intent.status !== "PROPOSED" && intent.status !== "CLAIMED")) continue;
          if (intent.status === "CLAIMED") {
            for (const [resourceKey, claim] of Object.entries(intent.leaseClaims ?? {})) {
              const lease = next.leases[resourceKey];
              if (lease?.ownerLane === claim.ownerLane && lease.generation === claim.generation) delete next.leases[resourceKey];
            }
          }
          intent.status = "STALE";
        }
      }
      break;
    case "run_paused":
      ensureNotTerminal(next.status);
      next.status = "PAUSED";
      break;
    case "run_resumed":
      if (next.status !== "PAUSED") throw new Error(`Cannot resume run in ${next.status}`);
      next.status = "RUNNING";
      break;
    case "run_finished": {
      const status = p.status as RunStatus;
      if (!terminal.includes(status)) throw new Error(`Invalid terminal status: ${String(status)}`);
      if (next.status === "PAUSED") throw new Error(`Cannot transition a paused run to ${status}; resume it first`);
      if (status === "SUCCEEDED" && typeof p.completionId !== "string") {
        // Pre-provenance success events cannot be upgraded into trusted current
        // conclusions. Keep the Run replayable, but fail closed for consumers.
        ensureNotTerminal(next.status);
        next.status = "NEED_HUMAN";
        next.finishedAt = event.ts;
        next.terminalReason = "Legacy success lacks a completion-bound verifier verdict";
        next.failureCategory = "verification_missing";
        break;
      }
      if (status === "SUCCEEDED" && (p.verified !== true || !Array.isArray(p.evidenceIds) || p.evidenceIds.length === 0)) {
        throw new Error("A successful run requires verifier approval and evidence");
      }
      if (status === "SUCCEEDED" && typeof p.completionId !== "string") throw new Error("A successful run requires an explicitly bound completion");
      if (status === "SUCCEEDED") {
        const completionId = String(p.completionId);
        const completion = next.completions[completionId];
        if (!completion || completion.status !== "ACCEPTED") throw new Error(`Successful run references a non-accepted completion: ${completionId}`);
        const evidenceIds = Array.isArray(p.evidenceIds) ? p.evidenceIds.map(String) : [];
        if (!sameStringSet(evidenceIds, completion.evidenceIds)) throw new Error("Successful run evidence does not exactly match its completion");
        if (completion.runId !== next.runId || completion.generation !== next.generation) throw new Error("Successful run completion is stale");
        if (p.candidateHash !== completion.candidateHash || p.artifactId !== completion.artifactId || Number(p.generation) !== completion.generation) {
          throw new Error("Successful run result payload does not match its completion");
        }
        for (const evidenceId of evidenceIds) {
          const evidence = next.evidence[evidenceId];
          if (!evidence || evidence.kind !== "reproduction" || evidence.provenance?.recordedBy !== "verifier" || evidence.provenance.generation !== next.generation || !evidence.supports.includes(completion.id)) {
            throw new Error(`Successful run contains invalid evidence ${evidenceId}`);
          }
          const verdict = evidence.provenance.effect ? next.effects[evidence.provenance.effect.id]?.verification : undefined;
          if (!verdict?.valid || !verdict.accepted || verdict.completionId !== completion.id || verdict.candidateHash !== completion.candidateHash || verdict.candidateArtifactId !== completion.artifactId) {
            throw new Error(`Successful run contains evidence without a bound accepted verdict: ${evidenceId}`);
          }
        }
        if (!completedWorkItemForCompletion(next, completion, evidenceIds)) {
          ensureNotTerminal(next.status);
          next.status = "NEED_HUMAN";
          next.finishedAt = event.ts;
          next.terminalReason = "Successful run lacks a completed executor WorkItem bound to its completion";
          next.failureCategory = "verification_missing";
          break;
        }
        next.finalResult = {
          completionId: completion.id,
          candidateHash: completion.candidateHash,
          artifactId: completion.artifactId,
          evidenceIds,
          generation: completion.generation,
        };
      }
      ensureNotTerminal(next.status);
      next.status = status;
      next.finishedAt = event.ts;
      next.terminalReason = typeof p.reason === "string" ? p.reason : undefined;
      next.failureCategory = status === "SUCCEEDED" ? undefined : p.failureCategory as RunSnapshot["failureCategory"];
      break;
    }
    case "run_failed":
      if (next.status === "PAUSED") throw new Error("Cannot transition a paused run to FAILED; resume it first");
      ensureNotTerminal(next.status);
      next.status = "FAILED";
      next.terminalReason = typeof p.reason === "string" ? p.reason : "run_failed";
      next.failureCategory = p.failureCategory as RunSnapshot["failureCategory"];
      break;
    case "fact_added": {
      const raw = p.fact as RunSnapshot["facts"][string];
      const fact = { ...raw, runId: raw?.runId ?? next.runId, generation: raw?.generation ?? next.generation };
      if (!fact?.id) throw new Error("fact_added requires fact");
      if (fact.runId !== next.runId || fact.generation !== next.generation) throw new Error(`Fact ${fact.id} provenance is stale or invalid`);
      const previous = next.facts[fact.id];
      if (previous && (previous.runId !== fact.runId || previous.generation !== fact.generation)) throw new Error(`Fact ${fact.id} cannot cross generations`);
      next.facts[fact.id] = fact;
      break;
    }
    case "observation_added": {
      const raw = p.observation as RunSnapshot["observations"][string];
      const observation = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
        source: { ...raw?.source, generation: raw?.source?.generation ?? next.generation },
      };
      if (!observation?.id) throw new Error("observation_added requires observation");
      if (observation.runId !== next.runId || observation.generation !== next.generation || observation.source.generation !== next.generation) throw new Error(`Observation ${observation.id} provenance is stale or invalid`);
      if (next.observations[observation.id]) throw new Error(`Observation already exists: ${observation.id}`);
      next.observations[observation.id] = observation;
      break;
    }
    case "evidence_added": {
      const raw = p.evidence as RunSnapshot["evidence"][string];
      const source = { ...raw?.source, generation: raw?.source?.generation ?? next.generation };
      const artifactIds = [...new Set([...(source.artifactIds ?? []), ...(source.artifactId ? [source.artifactId] : [])])];
      const evidence = {
        ...raw,
        source,
        provenance: raw?.provenance ?? {
          schemaVersion: 1 as const,
          runId: next.runId,
          generation: next.generation,
          recordedBy: "agent" as const,
          artifactIds,
        },
      };
      if (!evidence?.id) throw new Error("evidence_added requires evidence");
      if (next.evidence[evidence.id]) throw new Error(`Evidence already exists: ${evidence.id}`);
      next.evidence[evidence.id] = evidence;
      break;
    }
    case "domain_record_added": {
      const raw = p.record as RunSnapshot["domainRecords"][string];
      const record = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
      };
      if (!record?.id) throw new Error("domain_record_added requires record");
      if (record.runId !== next.runId || record.generation !== next.generation) throw new Error(`Domain record ${record.id} provenance is stale or invalid`);
      if (next.domainRecords[record.id]) throw new Error(`Domain record already exists: ${record.id}`);
      validateDomainRecordShape(record);
      next.domainRecords[record.id] = { ...record, createdSeq: event.seq };
      break;
    }
    case "experiment_recorded": {
      const experiment = p.experiment as RunSnapshot["experiments"][string];
      if (!experiment?.id) throw new Error("experiment_recorded requires experiment");
      if (next.experiments[experiment.id]) throw new Error(`Experiment already exists: ${experiment.id}`);
      next.experiments[experiment.id] = experiment;
      break;
    }
    case "replan_requested": {
      const raw = p.replan as RunSnapshot["replans"][string];
      const replan = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
      };
      if (!replan?.id) throw new Error("replan_requested requires replan");
      if (replan.runId !== next.runId || replan.generation !== next.generation) throw new Error(`Replan ${replan.id} provenance is stale or invalid`);
      if (next.replans[replan.id]) throw new Error(`Replan already exists: ${replan.id}`);
      if (!Array.isArray(replan.prohibitedRepeatKeys)) throw new Error(`Replan ${replan.id} requires prohibited repeat keys`);
      next.replans[replan.id] = { ...replan, createdSeq: event.seq };
      next.replanCount += 1;
      break;
    }
    case "update_proposal_created": {
      const proposal = p.proposal as RunSnapshot["updateProposals"][string];
      if (!proposal?.id || proposal.runId !== next.runId) throw new Error("update_proposal_created requires a Run-bound proposal");
      if (proposal.status !== "PROPOSED") throw new Error("Update proposal must start in PROPOSED state");
      if (next.updateProposals[proposal.id]) throw new Error(`Update proposal already exists: ${proposal.id}`);
      next.updateProposals[proposal.id] = proposal;
      break;
    }
    case "update_proposal_evaluated": {
      const proposal = getUpdateProposal(next, String(p.proposalId));
      if (proposal.status !== "PROPOSED") throw new Error(`Cannot evaluate update proposal in ${proposal.status}`);
      const evaluated = validateEvaluatedProposalPayload(proposal, p);
      proposal.status = "EVALUATED";
      proposal.evaluationHash = evaluated.evaluationHash;
      proposal.metrics = structuredClone(evaluated.metrics);
      proposal.evaluationGate = structuredClone(evaluated.gate);
      proposal.updatedSeq = event.seq;
      break;
    }
    case "update_proposal_approved": {
      const proposal = getUpdateProposal(next, String(p.proposalId));
      if (proposal.status !== "EVALUATED") throw new Error(`Cannot approve update proposal in ${proposal.status}`);
      validatePersistedProposalGate(proposal, true);
      proposal.status = "APPROVED";
      proposal.reason = typeof p.reason === "string" ? p.reason : proposal.reason;
      proposal.updatedSeq = event.seq;
      break;
    }
    case "update_proposal_activated": {
      const proposal = getUpdateProposal(next, String(p.proposalId));
      if (proposal.status !== "APPROVED") throw new Error(`Cannot activate update proposal in ${proposal.status}`);
      proposal.status = "ACTIVE";
      proposal.activeVersion = proposal.candidateVersion;
      proposal.updatedSeq = event.seq;
      break;
    }
    case "update_proposal_rejected": {
      const proposal = getUpdateProposal(next, String(p.proposalId));
      if (["ACTIVE", "ROLLED_BACK"].includes(proposal.status)) throw new Error(`Cannot reject update proposal in ${proposal.status}`);
      proposal.status = "REJECTED";
      proposal.reason = String(p.reason ?? "rejected");
      proposal.updatedSeq = event.seq;
      break;
    }
    case "update_proposal_rolled_back": {
      const proposal = getUpdateProposal(next, String(p.proposalId));
      if (proposal.status !== "ACTIVE") throw new Error(`Cannot roll back update proposal in ${proposal.status}`);
      if (p.candidateHash !== proposal.candidateHash) throw new Error("Rollback candidate hash does not match proposal");
      proposal.status = "ROLLED_BACK";
      proposal.rollbackVersion = proposal.baseVersion;
      proposal.reason = String(p.reason ?? "rolled back");
      proposal.updatedSeq = event.seq;
      break;
    }
    case "reasoning_node_upserted": {
      const value = p.node as Omit<RunSnapshot["reasoningNodes"][string], "createdSeq" | "updatedSeq">;
      if (!value?.id) throw new Error("reasoning_node_upserted requires node");
      validateReasoningNode(next, value);
      const previous = next.reasoningNodes[value.id];
      next.reasoningNodes[value.id] = {
        ...value,
        createdSeq: previous?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      };
      break;
    }
    case "reasoning_edge_added": {
      const value = p.edge as Omit<RunSnapshot["reasoningEdges"][string], "createdSeq">;
      if (!value?.id) throw new Error("reasoning_edge_added requires edge");
      validateReasoningEdge(next, value);
      next.reasoningEdges[value.id] = { ...value, createdSeq: event.seq };
      break;
    }
    case "reasoning_tree_upserted": {
      const value = p.tree as Omit<RunSnapshot["reasoningTrees"][string], "createdSeq" | "updatedSeq">;
      if (!value?.id) throw new Error("reasoning_tree_upserted requires tree");
      validateReasoningTree(next, value);
      const previous = next.reasoningTrees[value.id];
      next.reasoningTrees[value.id] = {
        ...value,
        createdSeq: previous?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      };
      break;
    }
    case "hypothesis_added": {
      const raw = p.hypothesis as RunSnapshot["hypotheses"][string];
      const hypothesis = { ...raw, runId: raw?.runId ?? next.runId, generation: raw?.generation ?? next.generation };
      if (!hypothesis?.id) throw new Error("hypothesis_added requires hypothesis");
      if (hypothesis.runId !== next.runId || hypothesis.generation !== next.generation) throw new Error(`Hypothesis ${hypothesis.id} provenance is stale or invalid`);
      const previous = next.hypotheses[hypothesis.id];
      if (previous && (previous.runId !== hypothesis.runId || previous.generation !== hypothesis.generation)) throw new Error(`Hypothesis ${hypothesis.id} cannot cross generations`);
      next.hypotheses[hypothesis.id] = hypothesis;
      break;
    }
    case "intent_changed": {
      const intent = p.intent as RunSnapshot["intents"][string];
      if (!intent?.id) throw new Error("intent_changed requires intent");
      next.intents[intent.id] = intent;
      break;
    }
    case "scheduler_intent_changed": {
      const intent = p.intent as RunSnapshot["schedulerIntents"][string];
      if (!intent?.id) throw new Error("scheduler_intent_changed requires intent");
      next.schedulerIntents[intent.id] = intent;
      break;
    }
    case "artifact_registered": {
      const raw = p.artifact as RunSnapshot["artifacts"][string];
      const artifact = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
        origin: raw?.origin ? {
          ...raw.origin,
          // Legacy Artifact events did not attest a registration capability.
          // Treat them as ordinary agent artifacts so verifier recovery fails closed.
          registeredBy: raw.origin.registeredBy ?? "agent",
        } : {
          schemaVersion: 1 as const,
          registeredBy: "agent" as const,
          operation: raw?.sourceEffectId ? next.effects[raw.sourceEffectId]?.operation : undefined,
          tags: [...(raw?.semantic?.tags ?? [])],
        },
      };
      if (!artifact?.id) throw new Error("artifact_registered requires artifact");
      if (artifact.runId !== next.runId || artifact.generation !== next.generation || artifact.origin?.schemaVersion !== 1
        || !["agent", "verifier"].includes(artifact.origin.registeredBy) || !Array.isArray(artifact.origin.tags)) throw new Error(`Artifact ${artifact.id} provenance is stale or invalid`);
      if (next.artifacts[artifact.id]) throw new Error(`Artifact already exists: ${artifact.id}`);
      next.artifacts[artifact.id] = artifact;
      break;
    }
    case "artifact_annotated": {
      const artifact = next.artifacts[String(p.artifactId)];
      if (!artifact) throw new Error(`Unknown artifact ${String(p.artifactId)}`);
      const semantic = p.semantic as RunSnapshot["artifacts"][string]["semantic"];
      if (!semantic?.name) throw new Error("artifact_annotated requires semantic metadata");
      artifact.semantic = semantic;
      break;
    }
    case "effect_proposed": {
      const raw = p.effect as RunSnapshot["effects"][string];
      const effect = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
        producerLane: raw?.producerLane ?? event.lane,
        commandHash: raw?.commandHash ?? (raw?.command ? sha256(raw.command) : undefined),
      };
      if (!effect?.id) throw new Error("effect_proposed requires effect");
      if (effect.status !== "PROPOSED") throw new Error("A proposed Effect must start in PROPOSED state");
      if (effect.outcome !== undefined || effect.artifactId !== undefined || effect.externalId !== undefined || effect.durationMs !== undefined || effect.outputBytes !== undefined || effect.exitCode !== undefined || effect.errorSignature !== undefined || effect.verification !== undefined) {
        throw new Error("A proposed Effect cannot contain result fields");
      }
      if (next.effects[effect.id]) throw new Error(`Effect already exists: ${effect.id}`);
      next.effects[effect.id] = effect;
      break;
    }
    case "effect_started": {
      const effect = getEffect(next, String(p.effectId));
      if (effect.status !== "PROPOSED") throw new Error(`Cannot start effect in ${effect.status}`);
      effect.status = "STARTED";
      if (typeof p.sessionId === "string" && p.sessionId.trim()) effect.sessionId = p.sessionId;
      if (typeof p.externalId === "string" && p.externalId.trim()) effect.externalId = p.externalId;
      break;
    }
    case "effect_finished": {
      const effect = getEffect(next, String(p.effectId));
      if (effect.status !== "STARTED") throw new Error(`Cannot finish effect in ${effect.status}`);
      effect.status = "FINISHED";
      effect.outcome = p.outcome as typeof effect.outcome;
      effect.artifactId = typeof p.artifactId === "string" ? p.artifactId : effect.artifactId;
      effect.externalId = typeof p.externalId === "string" ? p.externalId : effect.externalId;
      effect.durationMs = typeof p.durationMs === "number" ? p.durationMs : effect.durationMs;
      effect.outputBytes = typeof p.outputBytes === "number" ? p.outputBytes : effect.outputBytes;
      effect.exitCode = typeof p.exitCode === "number" || p.exitCode === null ? p.exitCode : effect.exitCode;
      effect.errorSignature = typeof p.errorSignature === "string" ? p.errorSignature : effect.errorSignature;
      effect.verification = p.verification as typeof effect.verification;
      break;
    }
    case "effect_reconciled": {
      const effect = getEffect(next, String(p.effectId));
      if (effect.status !== "PROPOSED" && effect.status !== "STARTED") throw new Error(`Cannot reconcile effect in ${effect.status}`);
      effect.status = p.outcome === "unknown" ? "UNKNOWN" : "RECONCILED";
      effect.outcome = p.outcome as typeof effect.outcome;
      break;
    }
    case "lease_acquired": {
      const lease = p.lease as RunSnapshot["leases"][string];
      if (!lease?.resourceKey) throw new Error("lease_acquired requires lease");
      if (next.leases[lease.resourceKey]) throw new Error(`Resource already leased: ${lease.resourceKey}`);
      next.leases[lease.resourceKey] = lease;
      next.leaseEpochs[lease.resourceKey] = Math.max(next.leaseEpochs[lease.resourceKey] ?? 0, lease.generation);
      break;
    }
    case "lease_heartbeat": {
      const resourceKey = String(p.resourceKey);
      const lease = next.leases[resourceKey];
      if (!lease) throw new Error(`Unknown lease: ${resourceKey}`);
      if (p.ownerLane !== lease.ownerLane || Number(p.generation) !== lease.generation) throw new Error(`Lease ownership mismatch: ${resourceKey}`);
      lease.heartbeatAt = String(p.heartbeatAt);
      lease.expiresAt = String(p.expiresAt);
      break;
    }
    case "lease_released":
      delete next.leases[String(p.resourceKey)];
      break;
    case "completion_proposed": {
      const raw = p.completion as RunSnapshot["completions"][string];
      const completion = {
        ...raw,
        runId: raw?.runId ?? next.runId,
        generation: raw?.generation ?? next.generation,
        purpose: raw?.purpose ?? "legacy_unclassified" as const,
      };
      if (!completion?.id) throw new Error("completion_proposed requires completion");
      if (!["submission", "claim_reproduction", "harness_verification", "legacy_unclassified"].includes(completion.purpose)) throw new Error("completion_proposed requires an immutable purpose");
      if (next.completions[completion.id]) throw new Error(`Completion already exists: ${completion.id}`);
      if (completion.verificationKey !== undefined) {
        const request = Object.values(next.verificationRequests).find((value) => value.key === completion.verificationKey);
        if (!request || request.status !== "PENDING" || request.completionId) throw new Error(`Completion ${completion.id} cannot bind its verification request`);
        request.status = "BOUND";
        request.completionId = completion.id;
      }
      next.completions[completion.id] = completion;
      break;
    }
    case "verification_requested": {
      const raw = p.request as RunSnapshot["verificationRequests"][string];
      if (!raw?.id || !raw.key) throw new Error("verification_requested requires a request");
      if (next.verificationRequests[raw.id] || Object.values(next.verificationRequests).some((value) => value.key === raw.key)) throw new Error(`Verification request already exists: ${raw.id}`);
      next.verificationRequests[raw.id] = {
        ...raw,
        runId: raw.runId ?? next.runId,
        generation: raw.generation ?? next.generation,
        status: raw.status ?? "PENDING",
        recoveryState: raw.recoveryState ?? "READY",
      };
      break;
    }
    case "verification_recovery_required": {
      const request = next.verificationRequests[String(p.requestId)];
      if (!request) throw new Error(`Unknown verification request ${String(p.requestId)}`);
      if (request.runId !== next.runId || request.generation !== next.generation) throw new Error(`Verification request ${request.id} is stale`);
      request.recoveryState = "RECOVERY_REQUIRED";
      request.recoveryReason = String(p.reason ?? "Verifier recovery requires explicit reconciliation.");
      request.recoverySeq = event.seq;
      break;
    }
    case "verification_recovery_resolved": {
      const request = next.verificationRequests[String(p.requestId)];
      if (!request) throw new Error(`Unknown verification request ${String(p.requestId)}`);
      if (request.runId !== next.runId || request.generation !== next.generation) throw new Error(`Verification request ${request.id} is stale`);
      request.recoveryState = "RECOVERED";
      request.recoveryReason = String(p.reason ?? "Verifier recovery completed.");
      request.recoverySeq = event.seq;
      break;
    }
    case "completion_verified": {
      const completion = next.completions[String(p.completionId)];
      if (!completion) throw new Error(`Unknown completion ${String(p.completionId)}`);
      if (completion.status !== "PROPOSED") throw new Error(`Completion ${completion.id} is already ${completion.status}`);
      completion.status = p.accepted === true ? "ACCEPTED" : "REJECTED";
      completion.evidenceIds = Array.isArray(p.evidenceIds) ? p.evidenceIds.map(String) : [];
      for (const request of Object.values(next.verificationRequests)) {
        if (request.completionId === completion.id && request.recoveryState === "RECOVERY_REQUIRED") {
          request.recoveryState = "RECOVERED";
          request.recoveryReason = "Completion was durably verified after recovery.";
          request.recoverySeq = event.seq;
        }
      }
      break;
    }
    case "checkpoint_created": {
      const checkpoint = p.checkpoint as RunSnapshot["checkpoints"][string];
      if (!checkpoint?.id) throw new Error("checkpoint_created requires checkpoint");
      next.checkpoints[checkpoint.id] = checkpoint;
      break;
    }
    case "job_queued": {
      const job = p.job as RunSnapshot["jobs"][string];
      if (!job?.id) throw new Error("job_queued requires job");
      next.jobs[job.id] = job;
      break;
    }
    case "job_started": {
      const job = getJob(next, String(p.jobId));
      if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new Error(`Cannot start job in ${job.status}`);
      job.status = "RUNNING";
      job.startedAt = typeof p.startedAt === "string" ? p.startedAt : job.startedAt;
      break;
    }
    case "job_finished": {
      const job = getJob(next, String(p.jobId));
      if (["CANCELLED", "SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(job.status)) break;
      const status = p.status as typeof job.status;
      if (!["SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(status)) throw new Error(`Invalid job terminal status: ${String(status)}`);
      job.status = status;
      job.finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : job.finishedAt;
      job.effectId = typeof p.effectId === "string" ? p.effectId : job.effectId;
      job.artifactId = typeof p.artifactId === "string" ? p.artifactId : job.artifactId;
      job.externalId = typeof p.externalId === "string" ? p.externalId : job.externalId;
      job.outcome = p.outcome as typeof job.outcome;
      job.error = typeof p.error === "string" ? p.error : job.error;
      job.outputTier = p.outputTier as typeof job.outputTier;
      break;
    }
    case "job_cancelled": {
      const job = getJob(next, String(p.jobId));
      if (job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "TIMED_OUT") break;
      job.status = "CANCELLED";
      job.finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : job.finishedAt;
      job.error = typeof p.reason === "string" ? p.reason : job.error;
      break;
    }
    case "job_reconciled": {
      const job = getJob(next, String(p.jobId));
      job.status = "UNKNOWN";
      job.outcome = "unknown";
      job.error = typeof p.reason === "string" ? p.reason : job.error;
      break;
    }
    case "handoff_proposed": {
      const handoff = p.handoff as RunSnapshot["handoffs"][string];
      if (!handoff?.id) throw new Error("handoff_proposed requires handoff");
      if (handoff.status !== "PROPOSED") throw new Error("handoff_proposed requires PROPOSED status");
      next.handoffs[handoff.id] = handoff;
      break;
    }
    case "handoff_accepted": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status !== "PROPOSED" && handoff.status !== "ACCEPTED") throw new Error(`Cannot accept handoff in ${handoff.status}`);
      handoff.status = "ACCEPTED";
      handoff.acceptedSeq = event.seq;
      break;
    }
    case "handoff_superseded": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status === "SUPERSEDED" || handoff.status === "REJECTED") break;
      handoff.status = "SUPERSEDED";
      handoff.reason = typeof p.reason === "string" ? p.reason : handoff.reason;
      break;
    }
    case "handoff_rejected": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status === "SUPERSEDED" || handoff.status === "REJECTED") break;
      handoff.status = "REJECTED";
      handoff.reason = typeof p.reason === "string" ? p.reason : handoff.reason;
      break;
    }
    case "work_item_created": {
      const item = p.workItem as RunSnapshot["workItems"][string];
      if (!item?.id) throw new Error("work_item_created requires workItem");
      if (next.workItems[item.id]) throw new Error(`Work item already exists: ${item.id}`);
      next.workItems[item.id] = item;
      break;
    }
    case "work_item_ready": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "READY";
      item.ownerLane = undefined;
      item.lease = undefined;
      item.blockReason = undefined;
      item.failureReason = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_claimed": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "RUNNING";
      item.attempt += 1;
      item.ownerLane = p.ownerLane as RunSnapshot["activeLanes"][number];
      item.lease = {
        ownerLane: item.ownerLane,
        acquiredAt: String(p.acquiredAt),
        expiresAt: String(p.leaseExpiresAt),
        heartbeatAt: String(p.acquiredAt),
      };
      item.blockReason = undefined;
      item.failureReason = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_blocked": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "BLOCKED";
      item.blockReason = String(p.reason ?? "blocked");
      item.lease = undefined;
      item.ownerLane = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_completed": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "SUCCEEDED";
      item.evidenceIds = mergeIds(item.evidenceIds, p.evidenceIds);
      item.artifactIds = mergeIds(item.artifactIds, p.artifactIds);
      item.lease = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_failed": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "FAILED";
      item.failureReason = String(p.reason ?? "failed");
      item.lease = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_cancelled": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "CANCELLED";
      item.failureReason = String(p.reason ?? "cancelled");
      item.lease = undefined;
      item.ownerLane = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "work_item_superseded": {
      const item = getWorkItem(next, String(p.workItemId));
      item.status = "SUPERSEDED";
      item.failureReason = String(p.reason ?? "superseded");
      item.lease = undefined;
      item.ownerLane = undefined;
      item.updatedSeq = event.seq;
      break;
    }
    case "session_opened": {
      const session = p.session as RunSnapshot["sessions"][string];
      if (!session?.id) throw new Error("session_opened requires session");
      if (next.sessions[session.id]) throw new Error(`Session already exists: ${session.id}`);
      next.sessions[session.id] = {
        ...session,
        status: "OPEN",
        interactions: Number.isInteger(session.interactions) && session.interactions > 0 ? session.interactions : 0,
        createdSeq: Number.isInteger(session.createdSeq) && session.createdSeq > 0 ? session.createdSeq : event.seq,
        updatedSeq: event.seq,
      };
      break;
    }
    case "session_binding_completed": {
      const session = getSession(next, String(p.sessionId));
      if (session.status !== "OPEN") throw new Error(`Session ${session.id} is not OPEN`);
      if (session.bindingTxnId !== String(p.bindingTxnId) || session.bindingIdentityHash !== String(p.bindingIdentityHash)) {
        throw new Error(`Session ${session.id} binding identity mismatch`);
      }
      if (session.bindingState !== "FINALIZING") throw new Error(`Session ${session.id} is not FINALIZING`);
      session.bindingState = "BOUND";
      session.updatedSeq = event.seq;
      break;
    }
    case "session_interacted": {
      const session = getSession(next, String(p.sessionId));
      if (session.status !== "OPEN") throw new Error(`Session ${session.id} is not OPEN`);
      session.interactions += 1;
      if (p.waitReason !== undefined) session.lastWaitReason = p.waitReason as RunSnapshot["sessions"][string]["lastWaitReason"];
      if (p.transcriptArtifactId !== undefined) session.transcriptArtifactId = String(p.transcriptArtifactId);
      if (p.stateHash !== undefined) session.stateHash = String(p.stateHash);
      if (p.exited === true) {
        session.status = "EXITED";
        session.exitCode = p.exitCode === undefined ? null : (p.exitCode as number | null);
      }
      session.updatedSeq = event.seq;
      break;
    }
    case "session_signaled": {
      const session = getSession(next, String(p.sessionId));
      if (session.status !== "OPEN") throw new Error(`Session ${session.id} is not OPEN`);
      session.updatedSeq = event.seq;
      break;
    }
    case "session_closed": {
      const session = getSession(next, String(p.sessionId));
      // Closing an already-exited session is legal (the process died first);
      // only refuse to reopen a superseded session as closeable.
      if (session.status === "SUPERSEDED") throw new Error(`Session ${session.id} was superseded`);
      session.status = "CLOSED";
      session.closeReason = p.reason === undefined ? undefined : String(p.reason);
      if (p.exitCode !== undefined) session.exitCode = p.exitCode as number | null;
      session.updatedSeq = event.seq;
      break;
    }
    case "session_superseded": {
      const session = getSession(next, String(p.sessionId));
      session.status = "SUPERSEDED";
      session.closeReason = String(p.reason ?? "superseded");
      session.updatedSeq = event.seq;
      break;
    }
    case "request_epoch_started": {
      const epoch = p.epoch as RunSnapshot["requestEpochs"][string];
      if (!epoch?.id) throw new Error("request_epoch_started requires epoch");
      if (next.requestEpochs[epoch.id]) throw new Error(`Request epoch already exists: ${epoch.id}`);
      next.requestEpochs[epoch.id] = {
        ...epoch,
        createdSeq: Number.isInteger(epoch.createdSeq) && epoch.createdSeq > 0 ? epoch.createdSeq : event.seq,
        updatedSeq: Number.isInteger(epoch.updatedSeq) && epoch.updatedSeq > 0 ? epoch.updatedSeq : event.seq,
      };
      break;
    }
    case "request_epoch_context": {
      const epoch = next.requestEpochs[String(p.requestEpochId)];
      if (!epoch) break;
      const fields = p.fields && typeof p.fields === "object" ? p.fields as Record<string, unknown> : {};
      for (const key of ["requestBodyHash", "requestHeadersHash", "requestContextHash", "providerBindingId", "scopePolicyHash", "stablePrefixHash", "dynamicSuffixHash", "systemPromptHash", "toolCatalogHash", "capabilityCatalogHash", "contextManifestHash"] as const) {
        if (typeof fields[key] === "string") epoch[key] = fields[key];
      }
      epoch.updatedSeq = event.seq;
      break;
    }
    case "context_overflow_recovered":
      next.contextOverflowRecoveries += 1;
      break;
    case "turn_started":
    case "assistant_message":
    case "provider_request_started":
      updateEpochStatus(next, p, "STARTED", event.seq);
      break;
    case "provider_request_queued":
    case "provider_request_slot_acquired":
    case "provider_request_retried":
    case "provider_request_first_event":
    case "provider_request_first_token":
    case "provider_request_inter_event_idle":
    case "provider_request_stalled":
    case "tool_call_recorded":
    case "tool_result_recorded":
    case "consolidate_started":
    case "consolidate_summary":
    case "consolidate_finished":
    case "consolidate_failed":
    case "compaction_recorded":
    case "event_ingress_received":
    case "event_ingress_processed":
    case "observation_consumed":
      break;
    case "provider_request_queue_cancelled":
      updateEpochStatus(next, p, "CANCELLED", event.seq);
      break;
    case "provider_recovery_required":
      updateEpochStatus(next, p, "FAILED", event.seq);
      break;
    case "provider_response_received":
      updateEpochStatus(next, p, Number(p.status) >= 400 ? "FAILED" : "RESPONSE_RECEIVED", event.seq);
      break;
    case "model_usage":
      updateEpochStatus(next, p, "COMPLETED", event.seq);
      break;
    default:
      throw new Error(`Unhandled event ${(event as HarnessEvent).type}`);
  }
  next.projectionHash = projectionHash(next);
  return next;
}

function ensureNotTerminal(status: RunStatus): void {
  if (terminal.includes(status)) throw new Error(`Run is already terminal: ${status}`);
}

function getEffect(snapshot: RunSnapshot, effectId: string) {
  const effect = snapshot.effects[effectId];
  if (!effect) throw new Error(`Unknown effect ${effectId}`);
  return effect;
}

function getJob(snapshot: RunSnapshot, jobId: string) {
  const job = snapshot.jobs[jobId];
  if (!job) throw new Error(`Unknown job ${jobId}`);
  return job;
}

function getHandoff(snapshot: RunSnapshot, handoffId: string) {
  const handoff = snapshot.handoffs[handoffId];
  if (!handoff) throw new Error(`Unknown handoff ${handoffId}`);
  return handoff;
}

function getWorkItem(snapshot: RunSnapshot, workItemId: string) {
  const item = snapshot.workItems[workItemId];
  if (!item) throw new Error(`Unknown work item ${workItemId}`);
  return item;
}

function getSession(snapshot: RunSnapshot, sessionId: string) {
  const session = snapshot.sessions[sessionId];
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session;
}

function getUpdateProposal(snapshot: RunSnapshot, proposalId: string): UpdateProposal {
  const proposal = snapshot.updateProposals[proposalId];
  if (!proposal) throw new Error(`Unknown update proposal: ${proposalId}`);
  return proposal;
}

function validateEvaluatedProposalPayload(proposal: UpdateProposal, payload: Record<string, unknown>): {
  evaluationHash: string;
  metrics: NonNullable<UpdateProposal["metrics"]>;
  gate: UpdateEvaluationGate;
} {
  if (typeof payload.evaluationHash !== "string" || !/^[a-f0-9]{64}$/i.test(payload.evaluationHash)) throw new Error("update_proposal_evaluated requires a sha256 evaluationHash");
  if (!proposal.evaluationSets) throw new Error("update_proposal_evaluated requires proposal evaluation sets");
  const metrics = validateReplayGateMetrics(payload.metrics);
  validateUpdateEvaluationGate(payload.gate, {
    candidateHash: proposal.candidateHash,
    evaluationSets: proposal.evaluationSets,
    evaluationHash: payload.evaluationHash,
    gatePassed: metrics.gatePassed,
  });
  validateGateMetricValues(payload.gate, metrics);
  return { evaluationHash: payload.evaluationHash, metrics, gate: payload.gate };
}

function validatePersistedProposalGate(proposal: UpdateProposal, requirePassing: boolean): void {
  if (!proposal.evaluationGate || !proposal.evaluationHash || !proposal.evaluationSets) throw new Error("Approved update proposal requires a persisted evaluation gate");
  const metrics = validateReplayGateMetrics(proposal.metrics);
  validateUpdateEvaluationGate(proposal.evaluationGate, {
    candidateHash: proposal.candidateHash,
    evaluationSets: proposal.evaluationSets,
    evaluationHash: proposal.evaluationHash,
    gatePassed: metrics.gatePassed,
  });
  validateGateMetricValues(proposal.evaluationGate, metrics);
  if (requirePassing && (!proposal.evaluationGate.passed || metrics.gatePassed !== 1)) throw new Error("Approved update proposal requires a passing evaluation gate");
}

function validateReplayGateMetrics(value: unknown): NonNullable<UpdateProposal["metrics"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Update proposal replay requires gate metrics");
  const metrics = value as NonNullable<UpdateProposal["metrics"]>;
  if (metrics.gatePassed !== 0 && metrics.gatePassed !== 1) throw new Error("Update proposal replay gatePassed is invalid");
  for (const [key, metric] of Object.entries(metrics)) {
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || (key !== "p95LatencyMs" && key !== "costUsd" && metric > 1)) throw new Error(`Update proposal replay metric is invalid: ${key}`);
  }
  return metrics;
}

function validateGateMetricValues(gate: UpdateEvaluationGate, metrics: NonNullable<UpdateProposal["metrics"]>): void {
  if (metrics.triggerPassRate !== gate.scores.triggerPassRate
    || metrics.retentionPassRate !== gate.scores.retentionPassRate
    || metrics.migrationPassRate !== gate.scores.migrationPassRate
    || metrics.safetyPassRate !== gate.scores.safetyPassRate
    || metrics.retentionRegressionRate !== gate.scores.retentionRegressionRate
    || metrics.activationRate !== gate.activationRate
    || metrics.followingRate !== gate.followingRate) throw new Error("Update proposal replay metrics do not match evaluation gate");
}

function updateEpochStatus(snapshot: RunSnapshot, payload: Record<string, unknown>, status: RunSnapshot["requestEpochs"][string]["status"], seq: number): void {
  const epochId = typeof payload.epochId === "string" ? payload.epochId : undefined;
  if (!epochId) return;
  const epoch = snapshot.requestEpochs[epochId];
  if (epoch) {
    epoch.status = status;
    epoch.updatedSeq = seq;
  }
}

function mergeIds(existing: string[], value: unknown): string[] {
  const additions = Array.isArray(value) ? value.map(String) : [];
  return [...new Set([...existing, ...additions])];
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function projectionHash(snapshot: RunSnapshot): string {
  const { projectionHash: _ignored, ...withoutHash } = snapshot;
  return sha256(canonicalJson(withoutHash));
}
