import { canonicalJson, sha256 } from "./utils.js";
import type { TaskContract } from "./types.js";

/**
 * The execution loop is domain-agnostic. A task kind describes the shape of
 * the user's work, while optional domain tags are only metadata for templates,
 * capability discovery, and evaluation grouping.
 */
export type TaskKind = "conversation" | "coding" | "research" | "analysis" | "automation" | "evaluation" | "custom";

export type TaskDomainTag = "web" | "binary" | "pwn" | "crypto" | "forensics" | "mobile" | "data" | "documentation" | "unknown";

export type VerificationPolicyKind = "none" | "command" | "state" | "http" | "browser" | "platform" | "rubric";

export type CognitivePolicy = "advisory" | "off" | "hard";

export interface CapabilitySelection {
  enabled: string[];
  disabled?: string[];
}

export interface ContextPolicy {
  scope: "run" | "run_history" | "explicit";
  recallMode: "summary_first" | "direct";
}

export interface VerificationPolicy {
  kind: VerificationPolicyKind;
  required: boolean;
  command?: string;
  maxAttempts?: number;
  successCriteria?: string[];
}

export interface GeneralTaskScope {
  allowedHosts: string[];
  allowedPorts: number[];
  allowedEndpoints?: Array<{ host: string; port: number }>;
  externalNetwork: boolean;
  allowedWorkspace: string;
}

export interface GeneralTaskConstraints {
  deadlineMs: number;
  maxCostUsd: number;
  maxToolCalls: number;
}

/**
 * The immutable, domain-neutral task description used by the generic agent
 * harness. Domain tags intentionally do not appear in safety or cognitive
 * snapshots, so a tag cannot silently relax an execution boundary.
 */
export interface GeneralTaskContract {
  schemaVersion: 1;
  taskId: string;
  title: string;
  kind: TaskKind;
  domainTags: TaskDomainTag[];
  objective: string;
  inputs: Array<{ path: string; sha256: string; readOnly: boolean }>;
  successCriteria: string[];
  scope: GeneralTaskScope;
  pausePolicy: string[];
  constraints: GeneralTaskConstraints;
  verification: VerificationPolicy;
  enabledCapabilities: CapabilitySelection;
  contextPolicy: ContextPolicy;
  cognitivePolicy: CognitivePolicy;
}

export interface SafetySnapshot {
  schemaVersion: 1;
  scope: GeneralTaskScope;
  pausePolicy: string[];
  constraints: GeneralTaskConstraints;
  fingerprint: string;
}

export interface CognitiveSnapshot {
  schemaVersion: 1;
  policy: CognitivePolicy;
  contextPolicy: ContextPolicy;
  fingerprint: string;
}

const TASK_KINDS = new Set<TaskKind>(["conversation", "coding", "research", "analysis", "automation", "evaluation", "custom"]);
const DOMAIN_TAGS = new Set<TaskDomainTag>(["web", "binary", "pwn", "crypto", "forensics", "mobile", "data", "documentation", "unknown"]);
const VERIFICATION_KINDS = new Set<VerificationPolicyKind>(["none", "command", "state", "http", "browser", "platform", "rubric"]);
const COGNITIVE_POLICIES = new Set<CognitivePolicy>(["advisory", "off", "hard"]);

export function createSafetySnapshot(task: Pick<GeneralTaskContract, "scope" | "pausePolicy" | "constraints">): SafetySnapshot {
  const unsigned = {
    schemaVersion: 1 as const,
    scope: copyScope(task.scope),
    pausePolicy: [...task.pausePolicy],
    constraints: { ...task.constraints },
  };
  return { ...unsigned, fingerprint: sha256(canonicalJson(unsigned)) };
}

export function createCognitiveSnapshot(task: Pick<GeneralTaskContract, "cognitivePolicy" | "contextPolicy">): CognitiveSnapshot {
  const unsigned = {
    schemaVersion: 1 as const,
    policy: task.cognitivePolicy,
    contextPolicy: { ...task.contextPolicy },
  };
  return { ...unsigned, fingerprint: sha256(canonicalJson(unsigned)) };
}

export function assertGeneralTaskContract(task: GeneralTaskContract): void {
  if (task.schemaVersion !== 1) throw new Error("Unsupported general task contract schema version");
  if (!isIdentifier(task.taskId)) throw new Error("General task id is invalid");
  if (!isText(task.title, 256)) throw new Error("General task title is invalid");
  if (!TASK_KINDS.has(task.kind)) throw new Error(`Unsupported general task kind: ${String(task.kind)}`);
  if (!isText(task.objective, 8_000)) throw new Error("General task objective is invalid");
  assertUniqueBoundedText(task.domainTags, "domain tags", 32, 32, DOMAIN_TAGS);
  assertInputs(task.inputs);
  assertUniqueBoundedText(task.successCriteria, "success criteria", 512, 32);
  assertScope(task.scope);
  assertUniqueBoundedText(task.pausePolicy, "pause policy", 256, 32);
  assertConstraints(task.constraints);
  assertVerification(task.verification);
  assertCapabilities(task.enabledCapabilities);
  assertContextPolicy(task.contextPolicy);
  if (!COGNITIVE_POLICIES.has(task.cognitivePolicy)) throw new Error(`Unsupported cognitive policy: ${String(task.cognitivePolicy)}`);
}

/**
 * Projects a legacy CTF-era task into the new generic representation. The
 * adapter is deliberately read-only: old runs remain replayable until their
 * execution path is migrated in a later PR.
 */
export function generalTaskFromLegacy(task: TaskContract): GeneralTaskContract {
  const verification = legacyVerificationPolicy(task);
  const general: GeneralTaskContract = {
    schemaVersion: 1,
    taskId: task.task_id,
    title: task.objective.slice(0, 256) || task.task_id,
    kind: legacyTaskKind(task.mode),
    domainTags: legacyDomainTags(task.target_kind),
    objective: task.objective,
    inputs: task.inputs.map((input) => ({ path: input.path, sha256: input.sha256, readOnly: input.read_only })),
    successCriteria: [...task.success_criteria],
    scope: {
      allowedHosts: [...task.scope.allowed_hosts],
      allowedPorts: [...task.scope.allowed_ports],
      ...(task.scope.allowed_endpoints ? { allowedEndpoints: task.scope.allowed_endpoints.map((endpoint) => ({ ...endpoint })) } : {}),
      externalNetwork: task.scope.external_network,
      allowedWorkspace: task.scope.allowed_workspace,
    },
    pausePolicy: [...task.pause_policy],
    constraints: {
      deadlineMs: task.constraints.deadline_ms,
      maxCostUsd: task.constraints.max_cost_usd,
      maxToolCalls: task.constraints.max_tool_calls,
    },
    verification,
    enabledCapabilities: { enabled: [] },
    contextPolicy: { scope: "run", recallMode: "summary_first" },
    cognitivePolicy: "advisory",
  };
  assertGeneralTaskContract(general);
  return general;
}

function legacyTaskKind(mode: TaskContract["mode"]): TaskKind {
  if (mode === "coding_assistant") return "coding";
  if (mode === "vulnerability_discovery") return "analysis";
  return "evaluation";
}

function legacyDomainTags(targetKind: TaskContract["target_kind"]): TaskDomainTag[] {
  switch (targetKind) {
    case "reverse": return ["binary"];
    case "web": return ["web"];
    case "pwn": return ["pwn"];
    case "crypto": return ["crypto"];
    default: return ["unknown"];
  }
}

function legacyVerificationPolicy(task: TaskContract): VerificationPolicy {
  if (task.verification.kind === "platform_submission") {
    return { kind: "platform", required: true, maxAttempts: task.constraints.max_submissions, successCriteria: [...task.success_criteria] };
  }
  if (task.verification.kind === "hidden_scorer") {
    return { kind: "rubric", required: true, successCriteria: [...task.success_criteria] };
  }
  if (task.verification.web?.transport === "browser") return { kind: "browser", required: true, successCriteria: [...task.success_criteria] };
  if (task.verification.web) return { kind: "http", required: true, successCriteria: [...task.success_criteria] };
  if (task.verification.command) return { kind: "command", required: true, command: task.verification.command, successCriteria: [...task.success_criteria] };
  return { kind: "state", required: task.verification.required_reproductions > 0, successCriteria: [...task.success_criteria] };
}

function assertInputs(inputs: GeneralTaskContract["inputs"]): void {
  if (!Array.isArray(inputs) || inputs.length > 256) throw new Error("General task inputs are invalid");
  const paths = new Set<string>();
  for (const input of inputs) {
    if (!isText(input.path, 1_024) || paths.has(input.path) || !/^[a-f0-9]{64}$/i.test(input.sha256) || typeof input.readOnly !== "boolean") {
      throw new Error("General task input is invalid");
    }
    paths.add(input.path);
  }
}

function assertScope(scope: GeneralTaskScope): void {
  if (!isText(scope.allowedWorkspace, 4_096) || typeof scope.externalNetwork !== "boolean") throw new Error("General task scope is invalid");
  assertUniqueBoundedText(scope.allowedHosts, "allowed hosts", 256, 128);
  if (!Array.isArray(scope.allowedPorts) || scope.allowedPorts.length > 128 || new Set(scope.allowedPorts).size !== scope.allowedPorts.length || scope.allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("General task allowed ports are invalid");
  }
  const endpoints = scope.allowedEndpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length > 128 || endpoints.some((endpoint) => !isText(endpoint.host, 256) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535)) {
    throw new Error("General task allowed endpoints are invalid");
  }
}

function assertConstraints(constraints: GeneralTaskConstraints): void {
  if (!Number.isInteger(constraints.deadlineMs) || constraints.deadlineMs < 1 || constraints.deadlineMs > 86_400_000) throw new Error("General task deadline is invalid");
  if (!Number.isFinite(constraints.maxCostUsd) || constraints.maxCostUsd < 0 || constraints.maxCostUsd > 1_000_000) throw new Error("General task max cost is invalid");
  if (!Number.isInteger(constraints.maxToolCalls) || constraints.maxToolCalls < 0 || constraints.maxToolCalls > 100_000) throw new Error("General task max tool calls is invalid");
}

function assertVerification(verification: VerificationPolicy): void {
  if (!VERIFICATION_KINDS.has(verification.kind) || typeof verification.required !== "boolean") throw new Error("General task verification policy is invalid");
  if (verification.kind === "none" && verification.required) throw new Error("Verification kind none cannot be required");
  if (verification.kind === "command" && !isText(verification.command ?? "", 8_000)) throw new Error("Command verification requires a command");
  if (verification.command !== undefined && !isText(verification.command, 8_000)) throw new Error("General task verification command is invalid");
  if (verification.maxAttempts !== undefined && (!Number.isInteger(verification.maxAttempts) || verification.maxAttempts < 1 || verification.maxAttempts > 1_000)) throw new Error("General task verification max attempts is invalid");
  if (verification.successCriteria !== undefined) assertUniqueBoundedText(verification.successCriteria, "verification success criteria", 512, 32);
}

function assertCapabilities(selection: CapabilitySelection): void {
  assertUniqueBoundedText(selection.enabled, "enabled capabilities", 128, 128);
  if (selection.disabled !== undefined) {
    assertUniqueBoundedText(selection.disabled, "disabled capabilities", 128, 128);
    if (selection.disabled.some((id) => selection.enabled.includes(id))) throw new Error("A capability cannot be both enabled and disabled");
  }
}

function assertContextPolicy(policy: ContextPolicy): void {
  if (policy.scope !== "run" && policy.scope !== "run_history" && policy.scope !== "explicit") throw new Error("General task context scope is invalid");
  if (policy.recallMode !== "summary_first" && policy.recallMode !== "direct") throw new Error("General task context recall mode is invalid");
}

function assertUniqueBoundedText(values: unknown, label: string, maxLength: number, maxItems: number, allowed?: ReadonlySet<string>): asserts values is string[] {
  if (!Array.isArray(values) || values.length > maxItems || new Set(values).size !== values.length || values.some((value) => !isText(value, maxLength) || (allowed !== undefined && !allowed.has(value)))) {
    throw new Error(`General task ${label} are invalid`);
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function copyScope(scope: GeneralTaskScope): GeneralTaskScope {
  return {
    allowedHosts: [...scope.allowedHosts],
    allowedPorts: [...scope.allowedPorts],
    ...(scope.allowedEndpoints ? { allowedEndpoints: scope.allowedEndpoints.map((endpoint) => ({ ...endpoint })) } : {}),
    externalNetwork: scope.externalNetwork,
    allowedWorkspace: scope.allowedWorkspace,
  };
}
