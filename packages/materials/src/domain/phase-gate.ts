import type { DomainPhase, Evidence, RunSnapshot } from "./types.js";

export type PhaseGateStatus = "pass" | "blocked" | "stale";

export interface PhaseGateEvaluation {
  domainPhase: DomainPhase;
  generation: number;
  status: PhaseGateStatus;
  required: string[];
  satisfied: string[];
  missing: string[];
  stale: string[];
  evidenceIds: string[];
}

/**
 * Recomputable domain gate. It never trusts a model-written “phase complete”
 * claim; every result is derived from the current Run projection. `phase` is
 * explicit so recovery can evaluate a target gate before the projection moves
 * to that phase.
 */
export function evaluatePhaseGate(snapshot: RunSnapshot, phase: DomainPhase = snapshot.domainPhase): PhaseGateEvaluation {
  const currentGeneration = snapshot.generation;
  const required: string[] = [];
  const satisfied: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const evidenceIds = new Set<string>();
  const currentEvidence = Object.values(snapshot.evidence).filter((evidence) => evidence.provenance?.generation === currentGeneration && evidence.source.generation === currentGeneration);
  const currentObservations = Object.values(snapshot.observations).filter((observation) => observation.generation === currentGeneration);
  const currentExperiments = Object.values(snapshot.experiments).filter((experiment) => experiment.generation === currentGeneration);
  const currentDomainRecords = Object.values(snapshot.domainRecords ?? {}).filter((record) => record.generation === currentGeneration);
  const currentHypotheses = Object.values(snapshot.hypotheses).filter((hypothesis) => hypothesis.generation === currentGeneration);
  const currentEffects = Object.values(snapshot.effects).filter((effect) => effect.generation === currentGeneration);
  const oldObservations = Object.values(snapshot.observations).some((observation) => observation.generation !== currentGeneration);
  const oldEvidence = Object.values(snapshot.evidence).some((evidence) => evidence.source.generation !== currentGeneration || evidence.provenance?.generation !== currentGeneration);
  const oldDomainRecords = Object.values(snapshot.domainRecords ?? {}).some((record) => record.generation !== currentGeneration);
  const add = (label: string, ok: boolean, wasStale = false): void => {
    required.push(label);
    if (ok) satisfied.push(label);
    else {
      missing.push(label);
      if (wasStale) stale.push(label);
    }
  };
  const addEvidence = (...evidence: Evidence[]): void => {
    for (const item of evidence) evidenceIds.add(item.id);
  };
  const preparationReady = snapshot.toolPreparation?.generation === currentGeneration
    && (snapshot.toolPreparation.health === "ready" || snapshot.toolPreparation.health === "degraded")
    && snapshot.toolPreparation.missingRequiredTools.length === 0;
  const actionBundle = snapshot.toolPreparation?.actionBundles?.some((bundle) => bundle.domainPhase === phase) === true;
  const currentHypothesis = currentHypotheses.find((hypothesis) => hypothesis.status === "OPEN" || hypothesis.status === "CONFIRMED");
  const supportingEvidence = currentHypothesis
    ? currentEvidence.filter((evidence) => evidence.supports.includes(currentHypothesis.id))
    : [];
  const currentReproductionEvidence = currentEvidence.filter((evidence) => evidence.kind === "reproduction" && evidence.provenance.recordedBy === "verifier" && evidence.provenance.effect?.id !== undefined);
  const acceptedCompletion = Object.values(snapshot.completions).find((completion) => completion.generation === currentGeneration && completion.status === "ACCEPTED");
  const acceptedCompletionEvidence = acceptedCompletion
    ? currentReproductionEvidence.filter((evidence) => evidence.supports.includes(acceptedCompletion.id))
    : [];
  if (phase === "INTAKE") {
    add("task-contract", Boolean(snapshot.task.task_id && snapshot.task.target && snapshot.task.scope.allowed_workspace));
    add("current-generation-tool-preparation", preparationReady, snapshot.toolPreparation !== undefined);
  } else if (phase === "RECON") {
    const reconRecord = currentDomainRecords.some((record) => ["web_baseline", "web_request", "pwn_binary_profile", "pwn_protocol_transcript"].includes(record.kind));
    add("current-generation-observation", currentObservations.length > 0 || reconRecord, oldObservations || oldDomainRecords);
    add("target-model-or-hypothesis", currentHypothesis !== undefined, Object.keys(snapshot.hypotheses).length > 0);
    if (currentObservations.length > 0) {
      for (const observation of currentObservations) {
        const linked = currentEvidence.filter((evidence) => evidence.source.artifactId === observation.source.artifactId);
        addEvidence(...linked);
      }
    }
  } else if (phase === "TARGET_MODEL") {
    add("current-generation-hypothesis", currentHypothesis !== undefined, Object.keys(snapshot.hypotheses).length > 0);
    add("hypothesis-supporting-evidence", supportingEvidence.length > 0, currentHypothesis !== undefined && Object.keys(snapshot.evidence).length > 0);
    add("phase-action-bundle", actionBundle, snapshot.toolPreparation?.actionBundles !== undefined);
    addEvidence(...supportingEvidence);
  } else if (phase === "HYPOTHESIS") {
    add("open-or-confirmed-hypothesis", currentHypothesis !== undefined, Object.keys(snapshot.hypotheses).length > 0);
    add("phase-action-bundle", actionBundle, snapshot.toolPreparation?.actionBundles !== undefined);
    addEvidence(...supportingEvidence);
  } else if (phase === "EXPERIMENT") {
    add("current-generation-experiment", currentExperiments.length > 0, Object.keys(snapshot.experiments).length > 0);
    const experimentEvidence = currentEvidence.filter((evidence) => evidence.source.effectId !== undefined || evidence.source.artifactId !== undefined);
    add("classified-experiment-result", experimentEvidence.length > 0, oldEvidence);
    addEvidence(...experimentEvidence);
  } else if (phase === "REPRODUCE") {
    add("accepted-completion-candidate", acceptedCompletion !== undefined, Object.values(snapshot.completions).length > 0);
    add("verifier-owned-reproduction", acceptedCompletionEvidence.length > 0, currentReproductionEvidence.length === 0 && oldEvidence);
    addEvidence(...acceptedCompletionEvidence);
  } else if (phase === "REPORT") {
    add("accepted-completion", acceptedCompletion !== undefined, Object.values(snapshot.completions).length > 0);
    add("completed-executor-work-item", acceptedCompletion !== undefined && hasCompletedWorkItem(snapshot, acceptedCompletion.id, acceptedCompletion.artifactId, acceptedCompletion.evidenceIds), Object.values(snapshot.workItems).length > 0);
    addEvidence(...acceptedCompletionEvidence);
  } else if (phase === "SUBMIT") {
    add("accepted-completion", acceptedCompletion !== undefined, Object.values(snapshot.completions).length > 0);
    const platformSubmission = snapshot.task.verification.kind === "platform_submission";
    const acceptedPlatformEffect = acceptedCompletionEvidence.some((evidence) => evidence.provenance.effect?.operation === "fixture_score" && snapshot.effects[evidence.provenance.effect.id]?.verification?.accepted === true);
    add(platformSubmission ? "accepted-platform-verdict" : "accepted-reproduction-verdict", acceptedCompletion !== undefined && (platformSubmission ? acceptedPlatformEffect : acceptedCompletionEvidence.length > 0), acceptedCompletion !== undefined && oldEvidence);
    add("completed-executor-work-item", acceptedCompletion !== undefined && hasCompletedWorkItem(snapshot, acceptedCompletion.id, acceptedCompletion.artifactId, acceptedCompletion.evidenceIds), Object.values(snapshot.workItems).length > 0);
    addEvidence(...acceptedCompletionEvidence);
  }
  const onlyStaleRequirements = missing.length > 0 && missing.every((label) => stale.includes(label));
  const status: PhaseGateStatus = missing.length === 0 ? "pass" : onlyStaleRequirements ? "stale" : "blocked";
  return { domainPhase: phase, generation: currentGeneration, status, required, satisfied, missing, stale, evidenceIds: [...evidenceIds].sort() };
}

function hasCompletedWorkItem(snapshot: RunSnapshot, completionId: string, artifactId: string, evidenceIds: string[]): boolean {
  return Object.values(snapshot.workItems).some((item) => item.runId === snapshot.runId
    && item.ownerLane === "executor"
    && item.status === "SUCCEEDED"
    && item.artifactIds.includes(artifactId)
    && evidenceIds.every((evidenceId) => item.evidenceIds.includes(evidenceId))
    && (item.evidenceIds.length === 0 || item.evidenceIds.some((evidenceId) => snapshot.evidence[evidenceId]?.supports.includes(completionId))));
}
