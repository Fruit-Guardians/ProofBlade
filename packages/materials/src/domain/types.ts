import type { ArtifactAtom, EffectAtom, MessageAtom, ReplayPolicyAtom, SequencedEventAtom } from "@proofblade/atoms";

export type Lane = "main" | "planner" | "executor" | "verifier";

export type ExecutionMode = "auto" | "assist";

export type Phase =
  | "intake"
  | "reconnaissance"
  | "hypothesis"
  | "experiment"
  | "verification"
  | "report";

export type RunStatus =
  | "CREATED"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "EXHAUSTED"
  | "CANCELLED"
  | "NEED_HUMAN";

export type TargetKind = "unknown" | "web" | "reverse" | "pwn" | "crypto" | "misc" | "mixed";

export interface TaskContract {
  schema_version: 1;
  task_id: string;
  mode: "ctf_solve" | "vulnerability_discovery";
  target_kind: TargetKind;
  target: string;
  objective: string;
  inputs: Array<{ path: string; sha256: string; read_only: boolean }>;
  success_criteria: string[];
  verification: {
    kind: "platform_submission" | "hidden_scorer" | "reproduction";
    command?: string;
    required_reproductions: number;
  };
  scope: {
    allowed_hosts: string[];
    allowed_ports: number[];
    external_network: boolean;
    allowed_workspace: string;
  };
  pause_policy: string[];
  constraints: {
    deadline_ms: number;
    max_cost_usd: number;
    max_tool_calls: number;
    max_submissions: number;
  };
}

export interface Evidence {
  id: string;
  kind: "observation" | "reproduction" | "source" | "negative";
  summary: string;
  source: { tool?: string; effectId?: string; artifactId?: string; generation?: number };
  confidence: number;
  supports: string[];
  refutes: string[];
  createdSeq: number;
}

export interface Observation {
  id: string;
  summary: string;
  source: { operation: string; effectId: string; artifactId: string; generation: number };
  candidateKinds: string[];
  createdSeq: number;
}

export interface Fact {
  id: string;
  statement: string;
  status: "PROPOSED" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface Hypothesis {
  id: string;
  statement: string;
  status: "OPEN" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface Intent {
  id: string;
  title: string;
  description: string;
  phase: Phase;
  status: "OPEN" | "CLAIMED" | "DONE" | "REJECTED";
  priority: number;
  ownerLane?: Lane;
  createdSeq: number;
}

export interface CompletionProposal {
  id: string;
  candidateHash: string;
  artifactId: string;
  status: "PROPOSED" | "ACCEPTED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface CheckpointRef {
  id: string;
  artifactId: string;
  snapshotSeq: number;
  reason: string;
  contextManifestHash?: string;
  createdSeq: number;
}

export type ReplayPolicy = ReplayPolicyAtom;

export interface ArtifactRef extends ArtifactAtom {
  id: string;
  sensitivity: "public" | "secret" | "flag_candidate";
  sourceEffectId?: string;
  truncated?: boolean;
}

export interface Effect extends EffectAtom<ReplayPolicy> {
  id: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  status: "PROPOSED" | "STARTED" | "FINISHED" | "UNKNOWN" | "RECONCILED";
  outcome?: "success" | "error" | "timeout" | "unknown";
  artifactId?: string;
  externalId?: string;
  createdSeq: number;
}

export interface Lease {
  resourceKey: string;
  ownerLane: Lane;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface RunSnapshot {
  runId: string;
  task: TaskContract;
  status: RunStatus;
  phase: Phase;
  generation: number;
  lastSeq: number;
  startedAt?: string;
  finishedAt?: string;
  facts: Record<string, Fact>;
  observations: Record<string, Observation>;
  evidence: Record<string, Evidence>;
  hypotheses: Record<string, Hypothesis>;
  intents: Record<string, Intent>;
  completions: Record<string, CompletionProposal>;
  checkpoints: Record<string, CheckpointRef>;
  contextOverflowRecoveries: number;
  artifacts: Record<string, ArtifactRef>;
  effects: Record<string, Effect>;
  leases: Record<string, Lease>;
  activeLanes: Lane[];
  terminalReason?: string;
  projectionHash?: string;
}

export type EventType =
  | "run_started"
  | "phase_started"
  | "phase_finished"
  | "fixture_reset"
  | "turn_started"
  | "assistant_message"
  | "observation_added"
  | "effect_proposed"
  | "effect_started"
  | "effect_finished"
  | "effect_reconciled"
  | "fact_added"
  | "intent_changed"
  | "hypothesis_added"
  | "evidence_added"
  | "artifact_registered"
  | "lease_acquired"
  | "lease_heartbeat"
  | "lease_released"
  | "checkpoint_created"
  | "context_overflow_recovered"
  | "completion_proposed"
  | "completion_verified"
  | "model_usage"
  | "run_paused"
  | "run_resumed"
  | "run_finished"
  | "run_failed";

export interface HarnessEvent extends SequencedEventAtom<
  EventType,
  Record<string, unknown>,
  Lane,
  "user" | "orchestrator" | "model" | "tool" | "sandbox"
> {
  schemaVersion: 1;
  runId: string;
}

export interface RawEffectResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  externalId?: string;
}

export interface EffectRequest extends EffectAtom<ReplayPolicy> {
  id: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ContextMessage extends MessageAtom<"system" | "user" | "assistant" | "tool", string> {}

export interface ContextManifest {
  version: 1;
  runId: string;
  lane: Lane;
  phase: Phase;
  compilerVersion: string;
  layerTokens: Record<"L0" | "L1" | "L2" | "L3" | "L4" | "L5", number>;
  factIds: string[];
  hypothesisIds: string[];
  observationIds: string[];
  evidenceIds: string[];
  completionIds: string[];
  artifactIds: string[];
  memory: {
    standingInstructionHash: string;
    confirmedFactIds: string[];
    rejectedHypothesisIds: string[];
    recalledObservationIds: string[];
    recalledEvidenceIds: string[];
  };
  maintenance: {
    stage: "stable" | "notice" | "snip" | "prune" | "compact";
    ratio: number;
    shouldCompact: boolean;
    forceCompact: boolean;
  };
  dropped: Array<{ kind: string; id?: string; reason: string }>;
  budget: {
    contextWindow: number;
    outputBudget: number;
    safetyMargin: number;
    availableInput: number;
    estimatedInput: number;
    ratio: number;
    overBudget: boolean;
  };
  hash: string;
}

export interface ContextBuildInput {
  runId: string;
  lane: Lane;
  phase: Phase;
  task: TaskContract;
  snapshot: RunSnapshot;
  recentMessages?: ContextMessage[];
  contextWindow?: number;
  outputBudget?: number;
  safetyMargin?: number;
}

export interface ContextBuildOutput {
  messages: ContextMessage[];
  manifest: ContextManifest;
  estimatedTokens: number;
}
