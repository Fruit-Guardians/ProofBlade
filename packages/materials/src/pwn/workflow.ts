import type {
  DomainPhase,
  DomainRecord,
  PwnBinaryProfileRecord,
  PwnCrashRecord,
  PwnExploitStageRecord,
  PwnLeakRecord,
  PwnPrimitiveRecord,
  RunSnapshot,
} from "../domain/types.js";
import { isPageAligned } from "./leak.js";

export type PwnWorkflowPhase = Extract<DomainPhase, "RECON" | "TARGET_MODEL" | "HYPOTHESIS" | "EXPERIMENT" | "REPRODUCE">;

export type PwnWorkflowRoute =
  | "undetermined"
  | "direct-ret2win"
  | "leak-base-rop"
  | "format-string"
  | "heap"
  | "shellcode";

export type PwnWorkflowStatus =
  | "disabled"
  | "recon"
  | "target_model"
  | "hypothesis"
  | "experiment"
  | "reproduce"
  | "verified";

export interface PwnWorkflowAction {
  id: string;
  phase: PwnWorkflowPhase;
  toolNames: string[];
  objective: string;
  expectedEvidence: string;
  stopCondition: string;
  dependsOn: string[];
}

export interface PwnWorkflowAttempt {
  artifactId: string;
  recordIds: string[];
  status: "passed" | "failed";
  stageCount: number;
  passedStageCount: number;
  lastSeq: number;
}

export interface PwnWorkflowBasis {
  primitiveId?: string;
  controlOffset?: { recordId: string; offset: number };
  leakId?: string;
  baseId?: string;
}

export interface PwnWorkflowCurrentView {
  recordIds: {
    binaryProfiles: string[];
    protocolTranscripts: string[];
    primitives: string[];
    crashes: string[];
    leaks: string[];
    bases: string[];
    exploitStages: string[];
  };
  artifactIds: string[];
  evidenceIds: string[];
  latestPrimitive?: { id: string; primitive: string; confidence: number };
  latestCrash?: { id: string; classification: PwnCrashRecord["classification"]; cyclicOffset?: number; ripControlled: boolean };
  latestBase?: { id: string; value: string; addressKind: PwnLeakRecord["addressKind"]; symbol?: string };
  experiments: Array<{ id: string; action: string; outcome: string }>;
}

export interface PwnWorkflowState {
  schemaVersion: 1;
  runId: string;
  generation: number;
  enabled: boolean;
  currentPhase: DomainPhase;
  recommendedPhase: DomainPhase;
  status: PwnWorkflowStatus;
  route: PwnWorkflowRoute;
  routeConfidence: "low" | "medium" | "high";
  phaseTransition: { required: boolean; from: DomainPhase; to: DomainPhase; reason: string };
  blockers: string[];
  basis: PwnWorkflowBasis;
  candidateReady: boolean;
  reproductionAvailable: boolean;
  retryBlocked: boolean;
  lastAttempt?: PwnWorkflowAttempt;
  stale: { domainRecordCount: number; artifactCount: number; evidenceCount: number };
  current: PwnWorkflowCurrentView;
  nextActions: PwnWorkflowAction[];
}

const PWN_TARGET_KINDS = new Set(["pwn", "mixed", "unknown"]);
const MAX_ACTIONS = 4;
const MAX_IDS = 32;
const MAX_EXPERIMENTS = 8;
const MAX_ARTIFACTS = 16;
const MAX_EVIDENCE = 16;

/**
 * Derive the next Pwn step from durable state only.
 *
 * Nothing in this function invokes a tool or assumes that a previous
 * generation is reusable. This makes the workflow safe to call before every
 * model turn and after a fixture reset.
 */
export function derivePwnWorkflow(snapshot: RunSnapshot): PwnWorkflowState {
  const enabled = PWN_TARGET_KINDS.has(snapshot.task.target_kind);
  const currentGeneration = snapshot.generation;
  const domainRecords = Object.values(snapshot.domainRecords ?? {});
  const artifacts = Object.values(snapshot.artifacts ?? {});
  const evidence = Object.values(snapshot.evidence ?? {});
  const experiments = Object.values(snapshot.experiments ?? {});
  const currentRecords = domainRecords
    .filter((record) => record.runId === snapshot.runId && record.generation === currentGeneration)
    .sort(bySeq);
  const currentArtifacts = artifacts
    .filter((artifact) => artifact.runId === snapshot.runId && artifact.generation === currentGeneration)
    .sort(byArtifactSeq);
  const currentEvidence = evidence
    .filter((item) => isCurrentEvidence(item, snapshot.runId, currentGeneration))
    .sort(bySeq);
  const currentExperiments = experiments
    .filter((item) => item.runId === snapshot.runId && item.generation === currentGeneration)
    .sort(bySeq);

  const stale = {
    domainRecordCount: domainRecords.filter((record) => record.runId !== snapshot.runId || record.generation !== currentGeneration).length,
    artifactCount: artifacts.filter((artifact) => artifact.runId !== snapshot.runId || artifact.generation !== currentGeneration).length,
    evidenceCount: evidence.filter((item) => !isCurrentEvidence(item, snapshot.runId, currentGeneration)).length,
  };

  const pwnRecords = currentRecords.filter((record) => record.kind.startsWith("pwn_"));
  const profiles = pwnRecords.filter(isKind("pwn_binary_profile"));
  const transcripts = pwnRecords.filter(isKind("pwn_protocol_transcript"));
  const primitives = pwnRecords.filter(isKind("pwn_primitive"));
  const crashes = pwnRecords.filter(isKind("pwn_crash"));
  const leaks = pwnRecords.filter(isKind("pwn_leak"));
  const derivedBases = leaks.filter((record) => hasCurrentLeakSources(record, domainRecords, snapshot.runId, currentGeneration));
  const bases = derivedBases.filter(isUsableBase);
  const stages = pwnRecords.filter(isKind("pwn_exploit_stage"));
  const latestPrimitive = last(primitives);
  const latestCrash = last(crashes);
  const latestBase = last(bases);
  const lastAttempt = latestAttempt(stages);
  const retryBlocked = Boolean(lastAttempt?.status === "failed" && !hasMaterialAfter(lastAttempt.lastSeq, pwnRecords));
  const primitiveText = latestPrimitive?.primitive.toLowerCase() ?? "";
  // A primitive's current-generation preconditions are stronger route evidence
  // than its free text: a "control hijack" hypothesis whose preconditions are
  // current leaks is on the leak/base route no matter how it is worded.
  const primitiveLinkedKinds = new Set<DomainRecord["kind"]>();
  if (latestPrimitive) {
    for (const preconditionId of latestPrimitive.preconditionRecordIds) {
      const linked = snapshot.domainRecords[preconditionId];
      if (linked && linked.runId === snapshot.runId && linked.generation === currentGeneration) primitiveLinkedKinds.add(linked.kind);
    }
  }
  const route = chooseRoute(primitiveText, profiles, leaks, latestCrash, primitiveLinkedKinds);
  const routeConfidence = confidenceForRoute(route, latestPrimitive, latestCrash, latestBase);
  const controlOffset = controlOffsetFor(crashes);
  const reproductionAvailable = Boolean(
    snapshot.task.verification.pwn
    && snapshot.task.verification.pwn.target.command.length > 0
    && snapshot.task.verification.pwn.flag_path
    && snapshot.task.verification.pwn.flag_pattern,
  );
  const basis: PwnWorkflowBasis = {
    ...(latestPrimitive ? { primitiveId: latestPrimitive.id } : {}),
    ...(controlOffset ? { controlOffset } : {}),
    ...(latestBase?.derivation?.sourceRecordIds[0] ? { leakId: latestBase.derivation.sourceRecordIds[0], baseId: latestBase.id } : {}),
  };

  const currentView: PwnWorkflowCurrentView = {
    recordIds: {
      binaryProfiles: ids(profiles),
      protocolTranscripts: ids(transcripts),
      primitives: ids(primitives),
      crashes: ids(crashes),
      leaks: ids(leaks),
      bases: ids(bases),
      exploitStages: ids(stages),
    },
    artifactIds: currentArtifacts.slice(-MAX_ARTIFACTS).map((artifact) => artifact.id),
    evidenceIds: currentEvidence.slice(-MAX_EVIDENCE).map((item) => item.id),
    ...(latestPrimitive ? {
      latestPrimitive: {
        id: latestPrimitive.id,
        primitive: safeText(latestPrimitive.primitive, 256),
        confidence: latestPrimitive.confidence,
      },
    } : {}),
    ...(latestCrash ? {
      latestCrash: {
        id: latestCrash.id,
        classification: latestCrash.classification,
        ...(latestCrash.cyclicOffset === undefined ? {} : { cyclicOffset: latestCrash.cyclicOffset }),
        ripControlled: latestCrash.ripControlled,
      },
    } : {}),
    ...(latestBase ? {
      latestBase: {
        id: latestBase.id,
        value: latestBase.value,
        addressKind: latestBase.addressKind,
        ...(latestBase.symbol ? { symbol: safeText(latestBase.symbol, 128) } : {}),
      },
    } : {}),
    experiments: currentExperiments.slice(-MAX_EXPERIMENTS).map((experiment) => ({ id: experiment.id, action: safeText(experiment.action, 96), outcome: experiment.outcome })),
  };

  if (!enabled) {
    return {
      schemaVersion: 1,
      runId: snapshot.runId,
      generation: currentGeneration,
      enabled: false,
      currentPhase: snapshot.domainPhase,
      recommendedPhase: snapshot.domainPhase,
      status: "disabled",
      route: "undetermined",
      routeConfidence: "low",
      phaseTransition: { required: false, from: snapshot.domainPhase, to: snapshot.domainPhase, reason: "The task is not Pwn-scoped." },
      blockers: ["Pwn workflow is disabled for this task target kind."],
      basis: {},
      candidateReady: false,
      reproductionAvailable: false,
      retryBlocked: false,
      stale,
      current: currentView,
      nextActions: [],
    };
  }

  const hasRecon = profiles.length > 0 || transcripts.length > 0 || currentArtifacts.length > 0 || currentEvidence.length > 0;
  const hasPrimitive = latestPrimitive !== undefined;
  const routeReady = route !== "undetermined";
  const directReady = route === "direct-ret2win" && controlOffset !== undefined;
  const leakReady = route === "leak-base-rop" && latestBase !== undefined;
  const explicitlyValidated = Boolean(
    latestPrimitive
    && latestPrimitive.confidence >= 0.75
    && /\b(?:validated|working|proven|reliable)\b/i.test(latestPrimitive.primitive),
  );
  const advancedReady = ["format-string", "heap", "shellcode"].includes(route) && (explicitlyValidated || (lastAttempt?.status === "passed"));
  const candidateReady = !retryBlocked && (directReady || leakReady || advancedReady);
  const blockers: string[] = [];
  let status: PwnWorkflowStatus;
  let recommendedPhase: DomainPhase;
  let nextActions: PwnWorkflowAction[];

  if (!hasRecon) {
    status = "recon";
    recommendedPhase = "RECON";
    blockers.push("No current-generation binary profile, protocol transcript, observation, or Artifact is available.");
    nextActions = [
      action("recon.binary-profile", "RECON", ["capability", "bash", "read"], "Identify the binary format, architecture, mitigations, and relevant symbols.", "A current-generation binary profile or bounded inspection Artifact.", "Stop after one bounded identify/checksec pass; do not craft a payload yet.", []),
      action("recon.protocol-state", "RECON", ["pwn_open", "pwn_recv"], "Establish one synchronized prompt or remote protocol state.", "A current-generation transcript with a state-specific prompt or a classified EOF/timeout.", "Stop after one bounded receive window and preserve the transcript.", []),
    ];
  } else if (!hasPrimitive) {
    status = "target_model";
    recommendedPhase = "TARGET_MODEL";
    blockers.push("Recon exists, but no current-generation Pwn primitive hypothesis has been recorded.");
    nextActions = [
      action("model.primitive", "TARGET_MODEL", ["read", "capability", "pwn_record_primitive"], "Turn the strongest recon observation into one falsifiable primitive hypothesis.", "A pwn_primitive linked to current-generation Artifact or Evidence, with a failure prediction.", "Record one mechanism only; do not describe a shell or flag as the primitive.", currentView.artifactIds.slice(-2)),
    ];
  } else if (!routeReady) {
    status = "hypothesis";
    recommendedPhase = "HYPOTHESIS";
    blockers.push("The primitive is not specific enough to select a bounded exploit route.");
    nextActions = [
      action("hypothesis.route", "HYPOTHESIS", ["read", "bash", "capability", "pwn_record_primitive"], "Refine the mechanism into one route: direct control, leak/base/ROP, format-string, heap, or shellcode.", "A route-specific primitive with supporting current-generation evidence.", "Reject route names that are only inferred from a generic crash or prompt.", [latestPrimitive!.id]),
    ];
  } else if (retryBlocked) {
    status = "experiment";
    recommendedPhase = "EXPERIMENT";
    blockers.push("The latest clean reproduction failed and no newer material evidence has changed the exploit path.");
    nextActions = [recoveryAction(route, basis, lastAttempt!.recordIds)];
  } else if (route === "direct-ret2win" && !controlOffset) {
    status = "hypothesis";
    recommendedPhase = "HYPOTHESIS";
    blockers.push("A direct-control route is selected, but a validated cyclic control offset is missing.");
    nextActions = [
      action("hypothesis.control-offset", "HYPOTHESIS", ["pwn_cyclic", "bash", "pwn_crash_analyze"], "Measure the saved control offset with one cyclic crash and preserve the debugger transcript.", "A current-generation pwn_crash with cyclicOffset and ripControlled=true.", "Change only the probe length/input between attempts; treat canary or bad-pointer crashes as negative evidence.", [latestPrimitive!.id]),
    ];
  } else if (route === "leak-base-rop" && leaks.length === 0) {
    status = "hypothesis";
    recommendedPhase = "HYPOTHESIS";
    blockers.push("A leak/base/ROP route is selected, but no exact current-generation leak is recorded.");
    nextActions = [
      action("hypothesis.leak", "HYPOTHESIS", ["pwn_send", "pwn_recv", "pwn_record_leak"], "Plan one exact leak parse and bind it to the transcript Artifact or Evidence.", "A current-generation pwn_leak with exact source bytes, format, address kind, and confidence below one.", "Do not derive a base from a guessed or truncated value.", [latestPrimitive!.id]),
    ];
  } else if (route === "leak-base-rop" && !latestBase) {
    status = "hypothesis";
    recommendedPhase = "HYPOTHESIS";
    blockers.push(derivedBases.length > 0
      ? "A current-generation base derivation exists but is not page-aligned; do not use it for ROP."
      : "The leak is recorded, but its base formula has not been derived from the current-generation leak.");
    nextActions = [
      action("hypothesis.base", "HYPOTHESIS", ["pwn_derive_base"], "Derive a page-aligned libc, PIE, or heap base from the recorded leak and known symbol offset.", "A current-generation derived pwn_leak whose formula names its source leak.", "Reject negative or non-page-aligned bases unless the mapping evidence explains the exception.", [derivedBases.at(-1)?.id ?? leaks.at(-1)!.id]),
    ];
  } else if (candidateReady && reproductionAvailable) {
    status = "reproduce";
    recommendedPhase = "REPRODUCE";
    nextActions = [
      action("reproduce.clean", "REPRODUCE", ["pwn_reproduce"], "Replay the ordered exploit stages in a fresh verifier-owned session.", "Verifier-owned shell-marker and flag evidence from the same clean session.", "A proposal, local shell, EOF, or flag-shaped input is not success; return to EXPERIMENT on failure.", Object.values(basis).flatMap((value) => typeof value === "string" ? [value] : [value.recordId])),
    ];
  } else if (candidateReady) {
    status = "experiment";
    recommendedPhase = "EXPERIMENT";
    blockers.push("The exploit basis is ready, but this task has no immutable Pwn reproduction contract.");
    nextActions = [];
  } else {
    status = "experiment";
    recommendedPhase = "EXPERIMENT";
    blockers.push(`The ${route} route still needs a bounded payload experiment before clean reproduction.`);
    nextActions = [experimentAction(route, basis, currentView.recordIds, latestPrimitive!.id)];
  }

  const acceptedCompletion = Object.values(snapshot.completions ?? {}).find((completion) =>
    completion.runId === snapshot.runId
    && completion.generation === currentGeneration
    && completion.status === "ACCEPTED"
    && completion.purpose !== "legacy_unclassified",
  );
  if (acceptedCompletion) {
    status = "verified";
    recommendedPhase = snapshot.domainPhase === "REPORT" || snapshot.domainPhase === "SUBMIT" ? snapshot.domainPhase : "REPORT";
    blockers.length = 0;
    nextActions = [];
  }

  const phaseReason = phaseReasonFor(status, route, blockers);
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    generation: currentGeneration,
    enabled: true,
    currentPhase: snapshot.domainPhase,
    recommendedPhase,
    status,
    route,
    routeConfidence,
    phaseTransition: {
      required: snapshot.domainPhase !== recommendedPhase,
      from: snapshot.domainPhase,
      to: recommendedPhase,
      reason: phaseReason,
    },
    blockers: uniqueText(blockers),
    basis,
    candidateReady,
    reproductionAvailable,
    retryBlocked,
    ...(lastAttempt ? { lastAttempt } : {}),
    stale,
    current: currentView,
    nextActions: nextActions.slice(0, MAX_ACTIONS),
  };
}

/** Return the bounded provider-facing form of a workflow state. */
export function pwnWorkflowContext(state: PwnWorkflowState): Record<string, unknown> {
  return {
    schema_version: state.schemaVersion,
    generation: state.generation,
    status: state.status,
    current_phase: state.currentPhase,
    recommended_phase: state.recommendedPhase,
    phase_transition: state.phaseTransition,
    route: state.route,
    route_confidence: state.routeConfidence,
    candidate_ready: state.candidateReady,
    reproduction_available: state.reproductionAvailable,
    retry_blocked: state.retryBlocked,
    blockers: state.blockers,
    basis: state.basis,
    current_record_ids: state.current.recordIds,
    current_artifact_ids: state.current.artifactIds,
    current_evidence_ids: state.current.evidenceIds,
    current_experiments: state.current.experiments,
    latest_primitive: state.current.latestPrimitive,
    latest_crash: state.current.latestCrash,
    latest_base: state.current.latestBase,
    last_attempt: state.lastAttempt,
    stale: state.stale,
    next_actions: state.nextActions,
  };
}

function action(id: string, phase: PwnWorkflowPhase, toolNames: string[], objective: string, expectedEvidence: string, stopCondition: string, dependsOn: string[]): PwnWorkflowAction {
  return { id, phase, toolNames: uniqueText(toolNames).slice(0, 12), objective, expectedEvidence, stopCondition, dependsOn: uniqueText(dependsOn).slice(0, 16) };
}

function recoveryAction(route: PwnWorkflowRoute, basis: PwnWorkflowBasis, recordIds: string[]): PwnWorkflowAction {
  const tools = route === "leak-base-rop"
    ? ["pwn_send", "pwn_recv", "pwn_record_leak", "pwn_derive_base", "pwn_identify_libc", "pwn_rop_chain"]
    : route === "format-string"
      ? ["pwn_send", "pwn_recv", "pwn_fmtstr", "pwn_crash_analyze"]
      : route === "heap"
        ? ["pwn_send", "pwn_recv", "pwn_heap_calc", "pwn_crash_analyze"]
        : ["pwn_send", "pwn_recv", "pwn_crash_analyze", "pwn_record_primitive"];
  return action("experiment.recover-failed-reproduction", "EXPERIMENT", tools, "Change one material exploit assumption, run one bounded probe, and preserve the new result.", "A new current-generation crash, leak/base derivation, primitive, or binary profile that changes the exploit basis.", "Do not call pwn_reproduce again until new material evidence exists.", [
    ...recordIds,
    ...(basis.primitiveId ? [basis.primitiveId] : []),
  ]);
}

function experimentAction(route: PwnWorkflowRoute, basis: PwnWorkflowBasis, recordIds: PwnWorkflowCurrentView["recordIds"], primitiveId: string): PwnWorkflowAction {
  const tools = route === "direct-ret2win"
    ? ["pwn_send", "pwn_recv", "pwn_crash_analyze", "pwn_rop_chain"]
    : route === "leak-base-rop"
      ? ["pwn_send", "pwn_recv", "pwn_record_leak", "pwn_derive_base", "pwn_identify_libc", "pwn_rop_chain"]
      : route === "format-string"
        ? ["pwn_send", "pwn_recv", "pwn_fmtstr", "pwn_crash_analyze"]
        : route === "heap"
          ? ["pwn_send", "pwn_recv", "pwn_heap_calc", "pwn_crash_analyze"]
          : ["pwn_send", "pwn_recv", "pwn_crash_analyze", "pwn_record_primitive"];
  return action("experiment.route-probe", "EXPERIMENT", tools, `Run one bounded ${route} probe and classify its result.`, "A new current-generation transcript, crash, leak, base, or validated route observation.", "Change one material input only; EOF, timeout, and a guessed shell are failure evidence.", [primitiveId, ...recordIds.primitives.slice(-2), ...recordIds.crashes.slice(-2), ...recordIds.leaks.slice(-2)]);
}

function chooseRoute(primitive: string, profiles: PwnBinaryProfileRecord[], leaks: PwnLeakRecord[], crash: PwnCrashRecord | undefined, linkedKinds: ReadonlySet<DomainRecord["kind"]> = new Set()): PwnWorkflowRoute {
  if (/(?:heap|uaf|use[- ]after[- ]free|tcache|fastbin|unsorted|malloc|free\s*hook|fsop|house of)/i.test(primitive)) return "heap";
  if (/(?:format[- ]string|fmt\b|printf\s*\(|got\s*overwrite|format write)/i.test(primitive)) return "format-string";
  if (/(?:shellcode|execve|mprotect|seccomp)/i.test(primitive)) return "shellcode";
  if (leaks.length > 0 || linkedKinds.has("pwn_leak") || /(?:leak|libc|pie|ret2libc|ret2csu|rop|one_gadget)/i.test(primitive)) return "leak-base-rop";
  if (/(?:ret2win|win\b|return address|stack overflow|buffer overflow|control(?:led)?\s+(?:rip|eip|pc))/i.test(primitive)) return "direct-ret2win";
  if ((crash?.ripControlled || linkedKinds.has("pwn_crash")) && profiles.some((profile) => !hasEnabledCanary(profile))) return "direct-ret2win";
  return "undetermined";
}

function confidenceForRoute(route: PwnWorkflowRoute, primitive: PwnPrimitiveRecord | undefined, crash: PwnCrashRecord | undefined, base: PwnLeakRecord | undefined): "low" | "medium" | "high" {
  if (route === "undetermined" || !primitive) return "low";
  if (route === "direct-ret2win" && crash?.ripControlled && crash.cyclicOffset !== undefined) return "high";
  if (route === "leak-base-rop" && base) return "high";
  return primitive.confidence >= 0.75 ? "medium" : "low";
}

function controlOffsetFor(crashes: PwnCrashRecord[]): { recordId: string; offset: number } | undefined {
  const crash = [...crashes].reverse().find((record) => record.ripControlled && record.cyclicOffset !== undefined);
  if (crash?.cyclicOffset !== undefined) return { recordId: crash.id, offset: crash.cyclicOffset };
  return undefined;
}

function hasEnabledCanary(profile: PwnBinaryProfileRecord): boolean {
  return profile.protections.some((protection) => /canary/i.test(protection) && !/(?:no|disabled|off|false)/i.test(protection));
}

function isUsableBase(record: PwnLeakRecord): boolean {
  if (!record.derivation?.sourceRecordIds.length) return false;
  try {
    return isPageAligned(BigInt(record.value));
  } catch {
    return false;
  }
}

function hasCurrentLeakSources(record: PwnLeakRecord, records: DomainRecord[], runId: string, generation: number): boolean {
  const sourceRecordIds = record.derivation?.sourceRecordIds ?? [];
  if (sourceRecordIds.length === 0) return false;
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
  return sourceRecordIds.every((sourceId) => {
    const normalizedId = sourceId.startsWith("PWN-LEAK-") ? sourceId : `PWN-LEAK-${sourceId}`;
    const source = byId.get(normalizedId);
    return source?.kind === "pwn_leak" && source.runId === runId && source.generation === generation;
  });
}

function latestAttempt(stages: PwnExploitStageRecord[]): PwnWorkflowAttempt | undefined {
  const groups = new Map<string, PwnExploitStageRecord[]>();
  for (const stage of stages) {
    const artifactId = stage.inputArtifactId ?? stage.artifactIds[0];
    if (!artifactId) continue;
    const group = groups.get(artifactId) ?? [];
    group.push(stage);
    groups.set(artifactId, group);
  }
  const attempts = [...groups.entries()].map(([artifactId, records]) => {
    const ordered = records.sort(bySeq);
    const passedStageCount = ordered.filter((record) => record.status === "passed").length;
    const attemptStatuses = ordered.map((record) => record.attemptStatus);
    const persistedStatuses = attemptStatuses.filter((status): status is "passed" | "failed" => status !== undefined);
    // New records carry the verifier's final whole-attempt verdict. If a
    // record set is mixed or incomplete, fail closed instead of reconstructing
    // success from only the stage rows we happened to persist.
    const status = persistedStatuses.length === 0
      ? passedStageCount === ordered.length ? "passed" as const : "failed" as const
      : persistedStatuses.length !== ordered.length || new Set(persistedStatuses).size !== 1
        ? "failed" as const
        : persistedStatuses[0]!;
    return {
      artifactId,
      recordIds: ordered.map((record) => record.id).slice(0, 64),
      status,
      stageCount: ordered.length,
      passedStageCount,
      lastSeq: Math.max(...ordered.map((record) => record.createdSeq)),
    };
  });
  return attempts.sort((left, right) => left.lastSeq - right.lastSeq).at(-1);
}

function hasMaterialAfter(seq: number, records: DomainRecord[]): boolean {
  // Only observations that can change the exploit basis unblock a failed
  // clean reproduction. Interaction telemetry and experiment journal rows
  // are intentionally excluded: pwn_signal/send/recv or a repeated probe do
  // not by themselves justify spending another clean reproduction attempt.
  const materialKinds = new Set<DomainRecord["kind"]>([
    "pwn_binary_profile",
    "pwn_crash",
    "pwn_leak",
    "pwn_primitive",
  ]);
  return records.some((record) => record.createdSeq > seq && materialKinds.has(record.kind));
}

function phaseReasonFor(status: PwnWorkflowStatus, route: PwnWorkflowRoute, blockers: string[]): string {
  if (status === "verified") return "The current generation has an accepted completion; reporting is verifier-owned.";
  if (blockers.length > 0) return safeText(blockers[0]!, 256);
  return `Continue the ${route} route through one bounded ${status} step.`;
}

function isKind<K extends DomainRecord["kind"]>(kind: K): (record: DomainRecord) => record is Extract<DomainRecord, { kind: K }> {
  return (record): record is Extract<DomainRecord, { kind: K }> => record.kind === kind;
}

function last<T extends { createdSeq: number }>(items: T[]): T | undefined {
  return items.at(-1);
}

function ids(items: Array<{ id: string }>): string[] {
  return items.slice(-MAX_IDS).map((item) => item.id);
}

function bySeq(left: { createdSeq: number }, right: { createdSeq: number }): number {
  return left.createdSeq - right.createdSeq;
}

function byArtifactSeq(left: { id: string; semantic?: { updatedSeq: number } }, right: { id: string; semantic?: { updatedSeq: number } }): number {
  return (left.semantic?.updatedSeq ?? 0) - (right.semantic?.updatedSeq ?? 0) || left.id.localeCompare(right.id);
}

function isCurrentEvidence(item: RunSnapshot["evidence"][string], runId: string, generation: number): boolean {
  return item.provenance.runId === runId
    && item.provenance.generation === generation
    && item.source.generation === generation;
}

function safeText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueText(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
