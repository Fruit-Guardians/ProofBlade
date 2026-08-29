import type { ArtifactAtom, EffectAtom, MessageAtom, ReplayPolicyAtom, SequencedEventAtom } from "@proofblade/atoms";

export type Lane = "main" | "planner" | "executor" | "verifier";

export type ExecutionMode = "auto" | "assist";

export type Phase =
  | "intake"
  | "reconnaissance"
  | "target_model"
  | "hypothesis"
  | "experiment"
  | "verification"
  | "report";

/** Competition-specific phase that survives the generic harness phase machine. */
export type DomainPhase = "INTAKE" | "RECON" | "TARGET_MODEL" | "HYPOTHESIS" | "EXPERIMENT" | "REPRODUCE" | "REPORT" | "SUBMIT";

export type ExperimentOutcome = "success" | "failure" | "timeout" | "blocked" | "unknown";

export interface ExperimentRecord {
  id: string;
  runId: string;
  generation: number;
  domainPhase: DomainPhase;
  hypothesisId?: string;
  repeatKey: string;
  action: string;
  inputHash: string;
  outcome: ExperimentOutcome;
  summary: string;
  createdSeq: number;
}

/** Durable record of an actual recovery replan. Retries that stay within the
 * same experiment do not create one of these records. */
export interface ReplanRecord {
  id: string;
  runId: string;
  generation: number;
  domainPhase: DomainPhase;
  category: PrimaryFailureCategory;
  reason: string;
  sourceWorkItemId?: string;
  nextWorkItemId?: string;
  prohibitedRepeatKeys: string[];
  createdSeq: number;
}

export type UpdateProposalKind = "prompt" | "tool" | "skill" | "knowledge" | "program" | "model";
export type UpdateProposalStatus = "PROPOSED" | "EVALUATED" | "APPROVED" | "ACTIVE" | "REJECTED" | "ROLLED_BACK";

/** Evaluation-backed change candidate. A proposal never becomes active by implication. */
export interface UpdateProposal {
  id: string;
  schemaVersion: 1;
  runId: string;
  kind: UpdateProposalKind;
  status: UpdateProposalStatus;
  baseVersion: string;
  candidateVersion: string;
  candidateHash: string;
  sourceArtifactIds: string[];
  triggerFailureIds: string[];
  retentionDataset: string;
  migrationDataset: string;
  safetyDataset: string;
  /** Explicit evaluation partitions. Older proposals may omit this field. */
  evaluationSets?: {
    trigger: string[];
    retention: string[];
    migration: string[];
    safety: string[];
  };
  metrics?: {
    passAtK?: number;
    passAll?: number;
    failToPass?: number;
    passToPass?: number;
    flakyRate?: number;
    p95LatencyMs?: number;
    costUsd?: number;
    triggerPassRate?: number;
    retentionPassRate?: number;
    migrationPassRate?: number;
    safetyPassRate?: number;
    retentionRegressionRate?: number;
    gatePassed?: number;
    activationRate?: number;
    followingRate?: number;
  };
  evaluationHash?: string;
  activeVersion?: string;
  rollbackVersion?: string;
  reason?: string;
  createdSeq: number;
  updatedSeq: number;
}

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

export type PrimaryFailureCategory =
  | "model_no_tool_call"
  | "bad_tool_args"
  | "tool_timeout"
  | "tool_schema_mismatch"
  | "context_overflow"
  | "context_amnesia"
  | "wrong_hypothesis"
  | "verification_missing"
  | "permission_or_environment"
  | "budget_exhausted"
  | "effect_outcome_unknown"
  | "environment_drift"
  | "prompt_injection_followed"
  | "duplicate_submission"
  | "verifier_disagreement";

export interface RunVersionSnapshot {
  schemaVersion: 1;
  runtimeVersion: string;
  piVersion: string;
  nodeVersion: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  promptVersion: string;
  promptHash: string;
  contextCompilerVersion: string;
  toolContractVersion: string;
  toolContractHash: string;
  routerPolicyVersion: string;
  skillCatalogHash: string;
  skills: Array<{ name: string; contentHash: string }>;
  mcpCatalogHash: string;
  mcpServers: Array<{ name: string; configHash: string; disabled: boolean }>;
  toolCatalogHash: string;
  toolCatalog: Array<{ id: string; name: string; kind: ToolKind; path: string; contentHash: string }>;
  hash: string;
}

export type ToolKind = "tool" | "interpreter" | "toolchain";

export type ToolPreparationRuntime = "host" | "container";

export type ToolPreparationHealth = "ready" | "degraded";

/**
 * Bounded, category-specific action allowed before a challenge lane broadens
 * its investigation. The model-facing description remains in the selected
 * tool profile; this structure is the durable policy the lane can enforce.
 */
export interface FirstActionPlan {
  id: string;
  allowedToolNames: string[];
  maxCalls: number;
}

/**
 * A phase-scoped, preflighted unit of work for a challenge direction.  The
 * bundle is a bounded tool contract: it tells the lane which prepared tools
 * are relevant now, what must already be true, and what counts as success or
 * failure before the next phase can be selected.
 */
export interface ActionBundle {
  id: string;
  domainPhase: Extract<DomainPhase, "RECON" | "TARGET_MODEL" | "HYPOTHESIS" | "EXPERIMENT" | "REPRODUCE">;
  objective: string;
  toolNames: string[];
  capabilityIds: string[];
  preconditions: string[];
  successCriteria: string[];
  failureCriteria: string[];
  maxCalls: number;
}

export interface RunToolPreparation {
  schemaVersion: 1;
  generation: number;
  profileId: string;
  targetKind: Exclude<TargetKind, "unknown" | "mixed">;
  runtime: ToolPreparationRuntime;
  /** Stable runtime identity: `host` or the container image/runtime digest. */
  runtimeKey: string;
  cacheKey: string;
  toolCatalogHash: string;
  mcpCatalogHash: string;
  checkedAt: number;
  health: ToolPreparationHealth;
  tools: Array<{ id: string; name: string; path: string; status: "ready" | "missing"; required: boolean }>;
  mcpServers: Array<{ name: string; status: string; toolchainState?: string }>;
  missingRequiredTools: string[];
  missingOptionalTools: string[];
  fallbackStrategies: string[];
  /** Added after schema 1 was introduced; old preparations remain replayable. */
  firstActionPlan?: FirstActionPlan;
  /** Added after schema 1 was introduced; old preparations remain replayable. */
  actionBundles?: ActionBundle[];
  hash: string;
}

export type TargetKind = "unknown" | "web" | "reverse" | "pwn" | "crypto" | "misc" | "mixed";

export interface PwnReproductionContract {
  target: {
    kind: "local" | "remote";
    command: string[];
    endpoint?: string;
  };
  flag_path: string;
  flag_pattern: string;
}

export type BrowserActionKind = "navigate" | "click" | "fill" | "submit" | "wait";

export interface BrowserSelector {
  kind: "role" | "label" | "test_id" | "css";
  value: string;
  name?: string;
}

/** Optional limits for a verifier-owned browser replay. */
export interface BrowserVerificationPolicy {
  /** Actions that a future browser recipe may use; navigation is the current baseline. */
  allowed_actions?: BrowserActionKind[];
  max_steps?: number;
  max_duration_ms?: number;
  max_response_bytes?: number;
}

export interface WebReproductionContract {
  flag_pattern: string;
  /** Select the clean verifier transport; omitted keeps the HTTP default. */
  transport?: "http" | "browser";
  /** Browser-only immutable action and resource limits. */
  browser?: BrowserVerificationPolicy;
}

export interface TaskContract {
  schema_version: 1;
  task_id: string;
  mode: "ctf_solve" | "vulnerability_discovery" | "coding_assistant";
  target_kind: TargetKind;
  target: string;
  objective: string;
  inputs: Array<{ path: string; sha256: string; read_only: boolean }>;
  success_criteria: string[];
  verification: {
    kind: "platform_submission" | "hidden_scorer" | "reproduction";
    command?: string;
    required_reproductions: number;
    /** Task-owned inputs for barrier-gated pwn reproduction. */
    pwn?: PwnReproductionContract;
    /** Task-owned inputs for barrier-gated web reproduction. */
    web?: WebReproductionContract;
  };
  scope: {
    allowed_hosts: string[];
    allowed_ports: number[];
    allowed_endpoints?: Array<{ host: string; port: number }>;
    external_network: boolean;
    allowed_workspace: string;
  };
  pause_policy: string[];
  constraints: {
    deadline_ms: number;
    max_cost_usd: number;
    max_tool_calls: number;
    max_submissions: number;
    /** Optional schema-1 override; old tasks use the target-kind default. */
    max_replans?: number;
  };
}

export interface Evidence {
  id: string;
  kind: "observation" | "reproduction" | "source" | "negative";
  name?: string;
  summary: string;
  tags?: string[];
  dependsOn?: string[];
  source: { tool?: string; effectId?: string; artifactId?: string; artifactIds?: string[]; generation: number };
  /**
   * Control-plane materialized provenance. Callers provide `source`; the
   * ControlStore derives this record from the current Run, referenced Artifact,
   * and completed Effect. It is immutable because Evidence ids are append-only.
   */
  provenance: {
    schemaVersion: 1;
    runId: string;
    generation: number;
    recordedBy: "agent" | "verifier";
    artifactIds: string[];
    effect?: {
      id: string;
      operation: string;
      status: "FINISHED";
      outcome: "success" | "error" | "timeout" | "unknown";
      exitCode: number | null;
      commandHash?: string;
      sessionId?: string;
    };
  };
  confidence: number;
  supports: string[];
  refutes: string[];
  createdSeq: number;
}

/**
 * Structured, append-only domain facts emitted by Web/Pwn capabilities.
 * Records carry only bounded metadata and references to durable Artifacts and
 * Evidence; raw bodies, transcripts, payloads, and secrets remain in those
 * referenced artifacts rather than in the control projection.
 */
export type DomainRecordKind =
  | "web_baseline"
  | "web_endpoint"
  | "web_request"
  | "web_exploit_chain"
  | "pwn_binary_profile"
  | "pwn_protocol_transcript"
  | "pwn_primitive"
  | "pwn_leak"
  | "pwn_exploit_stage";

export interface DomainRecordBase {
  id: string;
  runId: string;
  generation: number;
  summary: string;
  artifactIds: string[];
  evidenceIds: string[];
  effectId?: string;
  createdSeq: number;
}

export interface WebBaselineRecord extends DomainRecordBase {
  kind: "web_baseline";
  baseUrl: string;
  status: number;
  stateHash: string;
}

export interface WebEndpointRecord extends DomainRecordBase {
  kind: "web_endpoint";
  method: string;
  path: string;
  sourceRecordIds: string[];
}

export interface WebRequestRecord extends DomainRecordBase {
  kind: "web_request";
  method: string;
  path: string;
  status: number;
  sessionId: string;
  stateHash: string;
}

export interface WebExploitChainRecord extends DomainRecordBase {
  kind: "web_exploit_chain";
  stepRecordIds: string[];
  status: "proposed" | "observed" | "reproduced";
}

export interface PwnBinaryProfileRecord extends DomainRecordBase {
  kind: "pwn_binary_profile";
  format: string;
  architecture: string;
  bits: number;
  protections: string[];
}

export interface PwnProtocolTranscriptRecord extends DomainRecordBase {
  kind: "pwn_protocol_transcript";
  sessionId: string;
  interactionCount: number;
  anchors: string[];
}

export interface PwnPrimitiveRecord extends DomainRecordBase {
  kind: "pwn_primitive";
  primitive: string;
  confidence: number;
  preconditionRecordIds: string[];
}

export interface PwnLeakRecord extends DomainRecordBase {
  kind: "pwn_leak";
  sourceHex: string;
  format: "le64" | "le32" | "be64" | "be32";
  value: string;
  addressKind: "stack" | "heap" | "libc" | "pie" | "code" | "unknown";
  symbol?: string;
  derivation?: { expression: string; sourceRecordIds: string[] };
}

export interface PwnExploitStageRecord extends DomainRecordBase {
  kind: "pwn_exploit_stage";
  stageIndex: number;
  stageName: string;
  status: "proposed" | "observed" | "passed" | "failed";
  inputArtifactId?: string;
  expectedAnchor?: string;
}

export type DomainRecord =
  | WebBaselineRecord
  | WebEndpointRecord
  | WebRequestRecord
  | WebExploitChainRecord
  | PwnBinaryProfileRecord
  | PwnProtocolTranscriptRecord
  | PwnPrimitiveRecord
  | PwnLeakRecord
  | PwnExploitStageRecord;

export type DomainRecordInput = {
  [K in DomainRecord["kind"]]: Omit<Extract<DomainRecord, { kind: K }>, "createdSeq" | "runId" | "generation">
}[DomainRecord["kind"]];

export interface Observation {
  id: string;
  runId: string;
  generation: number;
  summary: string;
  /** effectId is present for journal-backed capability observations. Coding
   * read/bash artifacts are already durable and may be observed by artifact id. */
  source: { operation: string; effectId?: string; artifactId: string; generation: number };
  candidateKinds: string[];
  createdSeq: number;
}

export interface Fact {
  id: string;
  runId: string;
  generation: number;
  statement: string;
  status: "PROPOSED" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface Hypothesis {
  id: string;
  runId: string;
  generation: number;
  statement: string;
  status: "OPEN" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export type ReasoningNodeKind = "artifact" | "observation" | "evidence" | "hypothesis" | "inference" | "claim" | "reproduction" | "result";

export type ReasoningNodeStatus = "OPEN" | "SUPPORTED" | "CONTESTED" | "REFUTED" | "CONFIRMED";

export interface ReasoningNode {
  id: string;
  kind: ReasoningNodeKind;
  name: string;
  summary: string;
  tags: string[];
  status: ReasoningNodeStatus;
  explanation: string;
  reference?: {
    kind: "artifact" | "observation" | "evidence" | "fact" | "hypothesis" | "completion";
    id: string;
  };
  generation: number;
  explainedBy: "harness" | "agent" | "curator" | "user";
  createdSeq: number;
  updatedSeq: number;
}

export type ReasoningEdgeRelation = "derived_from" | "supports" | "refutes" | "depends_on" | "adopts" | "reproduces";

export interface ReasoningEdge {
  id: string;
  from: string;
  to: string;
  relation: ReasoningEdgeRelation;
  explanation: string;
  confidence: number;
  generation: number;
  createdSeq: number;
}

export interface ReasoningTree {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  purpose: string;
  explanation: string;
  rootNodeId: string;
  nodeIds: string[];
  relatedTreeIds: string[];
  status: "ACTIVE" | "SUPPORTED" | "CONTESTED" | "ARCHIVED";
  generation: number;
  explainedBy: "agent" | "curator" | "user";
  createdSeq: number;
  updatedSeq: number;
}

export interface ReasoningForestTreeSummary {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  purpose: string;
  rootNodeId: string;
  status: ReasoningTree["status"];
  nodeCount: number;
  edgeCount: number;
  artifactCount: number;
  evidenceCount: number;
  sharedNodeCount: number;
  relatedTreeIds: string[];
  updatedSeq: number;
}

export interface ReasoningForestIndex {
  version: 1;
  generatedSeq: number;
  trees: ReasoningForestTreeSummary[];
  sharedNodes: Array<{ nodeId: string; treeIds: string[] }>;
  orphanNodeCount: number;
  orphanNodeIds: string[];
  orphanNodes: Array<{ id: string; name: string; summary: string; kind: ReasoningNodeKind; updatedSeq: number }>;
  hash: string;
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

/**
 * Durable unit of work in the run's work graph.  WorkItems intentionally live
 * in the Control Store next to intents, evidence, and effects; they are not a
 * second scheduler database.  A lease is embedded here for the first vertical
 * slice so claim/recovery can be replayed without consulting process memory.
 */
export type WorkItemStatus =
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "SUPERSEDED";

export type WorkItemRole = "planner" | "researcher" | "coder" | "executor" | "verifier";

export interface WorkItem {
  id: string;
  runId: string;
  /**
   * Optional link to the scheduler projection that selected this work.  The
   * WorkItem remains the durable execution record; this link lets replay and
   * recovery correlate the policy decision without creating a second lane.
   */
  schedulerIntentId?: string;
  parentId?: string;
  title: string;
  objective: string;
  role: WorkItemRole;
  status: WorkItemStatus;
  dependsOn: string[];
  evidenceIds: string[];
  artifactIds: string[];
  attempt: number;
  maxAttempts: number;
  ownerLane?: Lane;
  lease?: {
    ownerLane: Lane;
    acquiredAt: string;
    expiresAt: string;
    heartbeatAt: string;
  };
  blockReason?: string;
  failureReason?: string;
  createdSeq: number;
  updatedSeq: number;
}

/**
 * A replayable description of one model request.  The request body and
 * context are represented by hashes only; raw prompts remain in the provider
 * boundary and are never copied into the durable control projection.
 */
export type RequestEpochStatus = "STARTED" | "RESPONSE_RECEIVED" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface RequestEpoch {
  id: string;
  requestId: string;
  runId: string;
  turnId?: string;
  stepId?: string;
  lane: Lane;
  provider: string;
  model: string;
  adapter: string;
  contextWindow?: number;
  systemPromptHash?: string;
  toolCatalogHash?: string;
  toolNames: string[];
  capabilityCatalogHash?: string;
  contextManifestHash?: string;
  /** Hash of the request headers after sensitive values are removed. */
  requestHeadersHash?: string;
  /** Hash of the bounded context metadata used to construct the request. */
  requestContextHash?: string;
  /** Stable Provider registration identity fixed for this request. */
  providerBindingId?: string;
  /** Hash of the scope policy applied to this request. */
  scopePolicyHash?: string;
  stablePrefixHash?: string;
  dynamicSuffixHash?: string;
  requestBodyHash?: string;
  parentEpochId?: string;
  status: RequestEpochStatus;
  createdAt: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface CompletionProposal {
  id: string;
  runId: string;
  generation: number;
  /** Immutable intent used to keep local claim checks out of platform submission accounting. */
  purpose: "submission" | "claim_reproduction" | "harness_verification" | "legacy_unclassified";
  candidateHash: string;
  artifactId: string;
  status: "PROPOSED" | "ACCEPTED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
  /** Stable request identity; random Completion IDs remain references only. */
  verificationKey?: string;
}

export type VerificationRequestKind = "web" | "browser" | "pwn" | "claim";

/** Durable recovery marker for a verifier request after an interrupted run. */
export type VerificationRecoveryState = "READY" | "RECOVERY_REQUIRED" | "RECOVERED";

export interface VerificationRequest {
  id: string;
  key: string;
  runId: string;
  generation: number;
  kind: VerificationRequestKind;
  policyHash: string;
  recipeHash: string;
  status: "PENDING" | "BOUND";
  recoveryState?: VerificationRecoveryState;
  recoveryReason?: string;
  recoverySeq?: number;
  completionId?: string;
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

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "UNKNOWN";

export interface JobRecord {
  id: string;
  capabilityId: string;
  operation: string;
  backendId: string;
  backendVersion: string;
  args: Record<string, unknown>;
  argsRedacted?: boolean;
  replayPolicy: ReplayPolicy;
  status: JobStatus;
  lane: Lane;
  generation: number;
  timeoutMs?: number;
  createdSeq: number;
  startedAt?: string;
  finishedAt?: string;
  effectId?: string;
  artifactId?: string;
  externalId?: string;
  outcome?: "success" | "error" | "timeout" | "unknown";
  error?: string;
  outputTier?: "small" | "medium" | "large";
  /** Monotonic byte cursor for monitor_job; old jobs begin at zero. */
  progressCursor?: number;
  heartbeatAt?: string;
}

/**
 * A persistent interaction session (pwn tube / web session) modeled as durable
 * control state.  The raw byte transcript lives in an Artifact; the model only
 * ever sees a bounded viewport plus the artifact id.  A session is owned by a
 * single lane and bound to a generation, so recovery can supersede sessions
 * whose underlying host process cannot survive a restart rather than pretend to
 * revive a dead socket.
 */
export type SessionKind = "pwn-local" | "pwn-remote" | "http" | "browser";

export type SessionStatus = "OPEN" | "CLOSED" | "EXITED" | "ERROR" | "SUPERSEDED";

/**
 * Cross-ledger binding phase for broker-owned sessions.  It is optional so
 * legacy session records replay as READY without a migration event.
 */
export type SessionBindingState = "FINALIZING" | "BOUND";

export type SessionWaitReason = "idle" | "timeout" | "exit";

export interface SessionRecord {
  id: string;
  runId: string;
  kind: SessionKind;
  ownerLane: Lane;
  generation: number;
  status: SessionStatus;
  /** remote: host:port; http: baseUrl; browser: start URL. */
  endpoint?: string;
  /** Runtime handle id (e.g. the docker-exec session id) reused as JobRecord.externalId. */
  externalId?: string;
  /** Stable cross-ledger marker shared with ExternalResourceRegistry. */
  bindingTxnId?: string;
  /** Hash of the immutable session/resource handoff identity. */
  bindingIdentityHash?: string;
  /** Durable fence for the final Control Store ↔ external-ledger handoff. */
  bindingState?: SessionBindingState;
  /** Immutable broker request identity needed to rebuild a wire resource after restart. */
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  /** Full transcript accumulates here; the model reads a bounded window only. */
  transcriptArtifactId?: string;
  /** cookie/storage/session state hash used for clean-reproduce comparison. */
  stateHash?: string;
  lastWaitReason?: SessionWaitReason;
  /** Number of send/recv interactions recorded against this session. */
  interactions: number;
  exitCode?: number | null;
  closeReason?: string;
  createdSeq: number;
  updatedSeq: number;
}

export type HandoffStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "REJECTED";

export interface HandoffAction {
  id: string;
  /** The durable WorkItem this action advances, when one exists. */
  workItemId?: string;
  title: string;
  description: string;
  expectedEvidence: string[];
  resourceKeys: string[];
  estimatedToolCalls: number;
}

export interface HandoffRecord {
  id: string;
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sourceLane: "planner";
  targetLane: "executor";
  knowledgeVersion: string;
  phase: Phase;
  domainPhase: DomainPhase;
  objective: string;
  confirmedFacts: Array<{ id: string; summary: string; evidenceIds: string[] }>;
  hypotheses: Array<{ id: string; statement: string; evidenceIds: string[] }>;
  rejectedHypotheses: Array<{ id: string; statement: string; evidenceIds: string[] }>;
  nextActions: HandoffAction[];
  budget: { remainingMs: number; remainingToolCalls: number };
  requiredArtifacts: string[];
  prohibitedRepeats: string[];
  expectedOutputSchema: string;
  status: HandoffStatus;
  createdSeq: number;
  acceptedSeq?: number;
  reason?: string;
  hash: string;
}

export type ReplayPolicy = ReplayPolicyAtom;

export type RunEventSource = "user" | "provider" | "tool" | "job" | "external" | "timer" | "maintenance" | "verifier";
export type RunEventPriority = "urgent" | "normal" | "background";
export type RunEventStatus = "queued" | "admitted" | "deferred" | "applied" | "coalesced" | "failed";
export type RunEventReplayPolicy = "pure" | "idempotent" | "unknown" | "never";

/** Stable metadata shared by all external and internal Run event sources. */
export interface RunEventEnvelope {
  id: string;
  runId: string;
  generation: number;
  source: RunEventSource;
  kind: string;
  priority: RunEventPriority;
  status: RunEventStatus;
  sequence: number;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  coalescingKey?: string;
  operationId?: string;
  requestEpochId?: string;
  deadlineAt?: string;
  replayPolicy: RunEventReplayPolicy;
  payloadRef?: { artifactId?: string; eventType: string; hash: string };
  createdAt: string;
}

export type ArtifactRole = "supporting" | "intermediate" | "debug" | "result";

export interface ArtifactSemanticMetadata {
  name: string;
  summary: string;
  tags: string[];
  role: ArtifactRole;
  relatedIds: string[];
  annotatedBy: "harness" | "agent" | "user";
  updatedSeq: number;
}

export interface ArtifactRef extends ArtifactAtom {
  id: string;
  runId: string;
  generation: number;
  /** Registration-time classification; annotations may not rewrite it. */
  origin: {
    schemaVersion: 1;
    /** Derived by the ControlStore capability that registered the Artifact. */
    registeredBy: "agent" | "verifier";
    operation?: string;
    tags: string[];
  };
  sensitivity: "public" | "secret" | "flag_candidate";
  sourceEffectId?: string;
  truncated?: boolean;
  semantic?: ArtifactSemanticMetadata;
}

export interface VerificationVerdict {
  schemaVersion: 1;
  valid: boolean;
  accepted: boolean;
  operation: "fixture_score" | "claim_reproduction" | "pwn_reproduce" | "web_reproduce" | "browser_reproduce";
  runId: string;
  taskId: string;
  taskHash: string;
  generation: number;
  completionId: string;
  candidateHash: string;
  candidateArtifactId: string;
  attemptId: string;
  sessionId: string;
  resultArtifactId: string;
  resultArtifactSha256: string;
  transcriptHash: string;
}

export interface Effect extends EffectAtom<ReplayPolicy> {
  id: string;
  runId: string;
  generation: number;
  producerLane: Lane;
  command?: string;
  commandHash?: string;
  sessionId?: string;
  cwd?: string;
  timeoutMs?: number;
  status: "PROPOSED" | "STARTED" | "FINISHED" | "UNKNOWN" | "RECONCILED";
  outcome?: "success" | "error" | "timeout" | "unknown";
  artifactId?: string;
  externalId?: string;
  durationMs?: number;
  outputBytes?: number;
  exitCode?: number | null;
  errorSignature?: string;
  verification?: VerificationVerdict;
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
  taskHash: string;
  /** Hash of the in-memory control authority that created this Run. */
  authorityHash: string;
  status: RunStatus;
  phase: Phase;
  domainPhase: DomainPhase;
  generation: number;
  lastSeq: number;
  startedAt?: string;
  finishedAt?: string;
  facts: Record<string, Fact>;
  observations: Record<string, Observation>;
  evidence: Record<string, Evidence>;
  domainRecords: Record<string, DomainRecord>;
  reasoningNodes: Record<string, ReasoningNode>;
  reasoningEdges: Record<string, ReasoningEdge>;
  reasoningTrees: Record<string, ReasoningTree>;
  hypotheses: Record<string, Hypothesis>;
  intents: Record<string, Intent>;
  schedulerIntents: Record<string, import("./intent.js").Intent>;
  completions: Record<string, CompletionProposal>;
  verificationRequests: Record<string, VerificationRequest>;
  checkpoints: Record<string, CheckpointRef>;
  jobs: Record<string, JobRecord>;
  handoffs: Record<string, HandoffRecord>;
  workItems: Record<string, WorkItem>;
  sessions: Record<string, SessionRecord>;
  requestEpochs: Record<string, RequestEpoch>;
  experiments: Record<string, ExperimentRecord>;
  /** Replans are durable control decisions, not an in-memory turn counter. */
  replans: Record<string, ReplanRecord>;
  updateProposals: Record<string, UpdateProposal>;
  replanCount: number;
  contextOverflowRecoveries: number;
  artifacts: Record<string, ArtifactRef>;
  effects: Record<string, Effect>;
  leases: Record<string, Lease>;
  /** Direction-specific tool readiness captured before the first model turn. */
  toolPreparation?: RunToolPreparation;
  /** Monotonic per-resource lease epochs; stale Intent completion cannot release a newer claim. */
  leaseEpochs: Record<string, number>;
  activeLanes: Lane[];
  terminalReason?: string;
  failureCategory?: PrimaryFailureCategory;
  versionSnapshot?: RunVersionSnapshot;
  projectionHash?: string;
  finalResult?: {
    completionId: string;
    candidateHash: string;
    artifactId: string;
    evidenceIds: string[];
    generation: number;
  };
}

export type EventType =
  | "run_started"
  | "run_authority_migrated"
  | "phase_started"
  | "phase_finished"
  | "domain_phase_changed"
  | "tool_preparation_recorded"
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
  | "scheduler_intent_changed"
  | "hypothesis_added"
  | "evidence_added"
  | "domain_record_added"
  | "reasoning_node_upserted"
  | "reasoning_edge_added"
  | "reasoning_tree_upserted"
  | "artifact_registered"
  | "artifact_annotated"
  | "lease_acquired"
  | "lease_heartbeat"
  | "lease_released"
  | "checkpoint_created"
  | "job_queued"
  | "job_started"
  | "job_finished"
  | "job_cancelled"
  | "job_reconciled"
  | "handoff_proposed"
  | "handoff_accepted"
  | "handoff_superseded"
  | "handoff_rejected"
  | "work_item_created"
  | "work_item_ready"
  | "work_item_claimed"
  | "work_item_blocked"
  | "work_item_completed"
  | "work_item_failed"
  | "work_item_cancelled"
  | "work_item_superseded"
  | "session_opened"
  | "session_binding_completed"
  | "session_interacted"
  | "session_signaled"
  | "session_closed"
  | "session_superseded"
  | "request_epoch_started"
  | "request_epoch_context"
  | "context_overflow_recovered"
  | "completion_proposed"
  | "verification_requested"
  | "verification_recovery_required"
  | "verification_recovery_resolved"
  | "completion_verified"
  | "provider_request_started"
  | "provider_request_queued"
  | "provider_request_slot_acquired"
  | "provider_request_queue_cancelled"
  | "provider_request_retried"
  | "provider_request_first_event"
  | "provider_request_first_token"
  | "provider_request_inter_event_idle"
  | "provider_request_stalled"
  | "provider_recovery_required"
  | "provider_response_received"
  | "tool_call_recorded"
  | "tool_result_recorded"
  | "experiment_recorded"
  | "replan_requested"
  | "update_proposal_created"
  | "update_proposal_evaluated"
  | "update_proposal_approved"
  | "update_proposal_activated"
  | "update_proposal_rejected"
  | "update_proposal_rolled_back"
  | "consolidate_started"
  | "consolidate_summary"
  | "consolidate_finished"
  | "consolidate_failed"
  | "compaction_recorded"
  | "model_usage"
  | "event_ingress_received"
  | "event_ingress_processed"
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
  /** Optional for legacy events; present on events created by the unified ingress. */
  envelope?: RunEventEnvelope;
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
  sessionId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ContextMessage extends MessageAtom<"system" | "user" | "assistant" | "tool", string> {}

export type ContextBand = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";
export type ContextLayer = "L0" | "L1" | "L2" | "L3A" | "L3B" | "L4" | "L5" | "K0" | "K1" | "K2";

/** Deterministic unit used for local context budgeting and replay diagnostics. */
export interface ContextBlock {
  id: string;
  band: ContextBand;
  layer: ContextLayer;
  content: string;
  required: boolean;
  volatility: "immutable" | "run_stable" | "low" | "medium" | "high" | "very_high";
  sourceIds: string[];
  contentHash: string;
  estimatedTokens: number;
  compressible: boolean;
}

export type KnowledgeLevel = "L0" | "L1" | "L2";
export type KnowledgeKind = "task" | "forest" | "tree" | "evidence" | "fact" | "hypothesis" | "artifact" | "session" | "skill";

export interface KnowledgeProjection {
  uri: string;
  kind: KnowledgeKind;
  runId?: string;
  generation?: number;
  sourceIds: string[];
  contentHash: string;
  knowledgeVersion: string;
  levels: { L0: string; L1: string; L2?: { uri: string; bytes?: number; truncated?: boolean } };
  links: { forward: string[]; backlinks: string[] };
  trust: "untrusted" | "observed" | "proposed" | "verified";
  stale: boolean;
}

export interface ContextManifest {
  version: 1;
  runId: string;
  lane: Lane;
  phase: Phase;
  compilerVersion: string;
  layerTokens: Record<"L0" | "L1" | "L2" | "L3A" | "L3B" | "L4" | "L5", number>;
  factIds: string[];
  hypothesisIds: string[];
  observationIds: string[];
  evidenceIds: string[];
  domainRecordIds: string[];
  reasoningTreeIds: string[];
  completionIds: string[];
  jobIds: string[];
  handoffIds: string[];
  artifactIds: string[];
  resources: RuntimeResourceSnapshot;
  memory: {
    standingInstructionHash: string;
    confirmedFactIds: string[];
    rejectedHypothesisIds: string[];
    recalledObservationIds: string[];
    recalledEvidenceIds: string[];
  };
  cache: {
    strategy: "stable-prefix";
    prefixHash: string;
    dynamicHash: string;
    prefixLayerIds: string[];
    dynamicLayerIds: string[];
    prefixTokens: number;
    dynamicTokens: number;
  };
  maintenance: {
    stage: "stable" | "notice" | "snip" | "prune" | "compact";
    ratio: number;
    targetRatio?: number;
    hardRatio?: number;
    shouldCompact: boolean;
    forceCompact: boolean;
    target?: "tool-results" | "recent-transcript" | "ledger" | "all";
    nextAction?: "none" | "compact" | "consolidate";
  };
  /** Optional in schema v1 so old manifests remain readable. */
  blocks?: ContextBlock[];
  firstChangedBlock?: string;
  compressionTarget?: ContextBand;
  sourceIds?: string[];
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

export interface RuntimeResourceSnapshot {
  version: 1;
  skillCatalogHash: string;
  skills: Array<{ name: string; description: string; contentHash: string }>;
  mcpCatalogHash: string;
  mcpServers: Array<{ name: string; description: string; configHash: string }>;
  toolCatalogHash: string;
  toolCatalog: Array<{ id: string; name: string; kind: ToolKind; path: string; description: string }>;
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
  resources?: RuntimeResourceSnapshot;
  previousBlocks?: ContextBlock[];
  maintenancePolicy?: ContextMaintenancePolicy;
}

export interface ContextMaintenancePolicy {
  targetRatio: number;
  hardRatio: number;
  autoConsolidate: boolean;
  keepRecentTurns: number;
  selectedTarget?: "tool-results" | "recent-transcript" | "ledger" | "all";
}

export interface ContextBuildOutput {
  messages: ContextMessage[];
  manifest: ContextManifest;
  estimatedTokens: number;
}
