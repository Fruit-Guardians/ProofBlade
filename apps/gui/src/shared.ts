import type { ClaimVerificationProjection, HarnessEvent, ObservationQueueProjection, ProviderApi, ProviderNativeCapabilityStatus, RunSnapshot, RunTelemetryReport } from "@proofblade/materials";

export type RunKind = "chat" | "fixture";

export interface BootstrapData {
  projectName: string;
  projectRoot: string;
  configPath: string;
  storage: { runsDir: string; fixturesDir: string };
  model: { provider: string; model: string; baseUrl: string; thinkingLevel: string };
  fixtures: Array<{ id: string; targetKind: string; description: string }>;
  refreshIntervalMs: number;
}

export type ProviderThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderCacheRetention = "none" | "short" | "long";
export type ProviderMaxConcurrentRequests = number;

export interface ProviderProfile {
  id: string;
  name: string;
  provider: string;
  api: ProviderApi;
  baseUrl: string;
  proxyUrl: string;
  model: string;
  models: string[];
  thinkingLevel: ProviderThinkingLevel;
  cacheRetention: ProviderCacheRetention;
  maxConcurrentRequests: ProviderMaxConcurrentRequests;
  hasApiKey: boolean;
}

export interface ProviderSettings {
  activeProfileId: string;
  profiles: ProviderProfile[];
  localPath: string;
  provider: string;
  api: ProviderApi;
  baseUrl: string;
  proxyUrl: string;
  model: string;
  thinkingLevel: ProviderThinkingLevel;
  cacheRetention: ProviderCacheRetention;
  maxConcurrentRequests: ProviderMaxConcurrentRequests;
  hasApiKey: boolean;
}

export interface ProviderSettingsInput {
  id?: string;
  name?: string;
  provider: string;
  api?: ProviderApi;
  baseUrl: string;
  proxyUrl?: string;
  model: string;
  models?: string[];
  thinkingLevel: ProviderThinkingLevel;
  cacheRetention?: ProviderCacheRetention;
  maxConcurrentRequests?: ProviderMaxConcurrentRequests;
  apiKey?: string;
  clearApiKey?: boolean;
  setActive?: boolean;
}

export interface ModelDiscoveryResult {
  models: string[];
  baseUrl: string;
}

export interface ConversationFolder {
  id: string;
  name: string;
}

export interface ConversationPreferences {
  title?: string;
  /** Percentage of the available context budget at which proactive compression starts. */
  contextCompactionThreshold?: number;
  folderId?: string;
  workspacePath: string;
  profileId: string;
  model: string;
  thinkingLevel: ProviderThinkingLevel;
  enabledTools: string[];
  enabledSkills: string[];
  enabledMcpServers: string[];
}

export interface DirectoryListing {
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

export interface ToolPresentation {
  summary: string;
  inputLabel: string;
  input: string;
  outputLabel: string;
  output: string;
}

export interface CodingToolSummary {
  name: string;
  description: string;
  schemaChars: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  disabled: boolean;
}

export interface McpSummary {
  name: string;
  description: string;
  status: "configured" | "connected" | "failed" | "disabled" | "unavailable";
  disabled: boolean;
  toolchain?: {
    kind: string;
    state: "ready" | "missing" | "invalid";
    pathEnvironment: string;
    injectEnvironment: string;
    reason?: string;
  };
}

export interface WorkspaceSettings {
  folders: ConversationFolder[];
  conversations: Record<string, ConversationPreferences>;
  capabilities: {
    tools: CodingToolSummary[];
    skills: SkillSummary[];
    mcpServers: McpSummary[];
    providerNative: Record<string, ProviderNativeCapabilityStatus[]>;
  };
  localPath: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
}

export interface ActiveRunInfo {
  runId: string;
  startedAt: string;
  state: "running" | "stopping" | "paused" | "failed";
  error?: string;
}

export interface RunControlView {
  domainPhase: RunSnapshot["domainPhase"];
  gate: { status: "pass" | "blocked" | "stale"; missing: string[]; stale: string[] };
  budget: {
    phaseActionsUsed: number;
    phaseActionsRemaining?: number;
    runToolCallsUsed: number;
    runToolCallsRemaining: number;
    submissionsUsed: number;
    submissionsRemaining: number;
    replansUsed: number;
    replanLimit: number;
    replansRemaining: number;
  };
  recovery: {
    required: number;
    items: Array<{
      requestId: string;
      kind: string;
      state: "READY" | "RECOVERY_REQUIRED" | "RECOVERED";
      reason?: string;
    }>;
  };
  nextAction?: { id: string; objective: string; toolNames: string[]; maxCalls: number };
}

export interface RunListItem {
  runId: string;
  kind: RunKind;
  objective: string;
  targetKind: string;
  status: RunSnapshot["status"];
  phase: RunSnapshot["phase"];
  generation: number;
  lastSeq: number;
  updatedAt: string;
  counts: { tools?: number; evidence: number; artifacts: number; effects: number };
  active?: ActiveRunInfo;
}

export interface AssistantTurnDebug {
  id: string;
  entryId: string;
  timestamp: string;
  ordinal: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  text: string;
  toolCallIds: string[];
  raw: unknown;
}

export interface ChatMessageDebug {
  id: string;
  entryId: string;
  role: "user" | "assistant";
  timestamp: string;
  text: string;
  thinking: string;
  toolCallIds: string[];
  provider?: string;
  model?: string;
  stopReason?: string;
  error?: string;
  usage?: TokenUsage;
  claimVerification?: ClaimVerificationProjection;
  raw: unknown;
}

export interface ToolCallDebug {
  id: string;
  name: string;
  timestamp: string;
  status: "success" | "error" | "pending";
  assistantEntryId: string;
  assistantOrdinal: number;
  callIndex: number;
  arguments: unknown;
  call: unknown;
  result?: unknown;
  completedAt?: string;
  presentation: ToolPresentation;
  assistantEntry: unknown;
  resultEntry?: unknown;
  telemetry: { call?: HarnessEvent; result?: HarnessEvent };
  links: {
    artifacts: RunSnapshot["artifacts"][string][];
    evidence: RunSnapshot["evidence"][string][];
    effects: RunSnapshot["effects"][string][];
  };
}

export interface PiSessionDebug {
  id: string;
  createdAt: string;
  path: string;
  metadata?: Record<string, unknown>;
  stats: { messageCount: number; cachedTokens: number; uncachedTokens: number; totalTokens: number; costTotal: number };
  usage: TokenUsage & { requests: number };
  entries: unknown[];
  branchEntryIds: string[];
  assistantTurns: AssistantTurnDebug[];
  messages: ChatMessageDebug[];
  toolCalls: ToolCallDebug[];
}

export type { FleetSnapshot, FleetChallengeStatus, FleetChallengeState, FleetTotals } from "@proofblade/materials";

export type ChatStreamEvent =
  | { type: "started"; runId: string }
  | { type: "stopping"; runId: string }
  | { type: "paused"; runId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "context_snapshot"; messages: number; tools: number; systemPromptChars: number; messageChars: number; toolSchemaChars: number; estimatedVisibleTokens: number }
  | { type: "done"; text: string; stopReason: string; usage: TokenUsage; claimVerification?: ClaimVerificationProjection }
  | { type: "error"; error: string };

export interface RunDetail {
  kind: RunKind;
  snapshot: RunSnapshot;
  events: HarnessEvent[];
  telemetry: RunTelemetryReport;
  sessions: PiSessionDebug[];
  controlView: RunControlView;
  active?: ActiveRunInfo;
  updatedAt: string;
  context?: ContextRuntimeInfo;
  observationQueue: ObservationQueueProjection;
}

export interface ContextRuntimeInfo {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  utilization: number;
  estimatedTokens?: number;
  lastCacheRead?: number;
  cacheReported?: boolean;
  requestBodyHash?: string;
  stablePrefixHash?: string;
  dynamicSuffixHash?: string;
  requestEpochId?: string;
  requestContextHash?: string;
  contextManifestHash?: string;
  firstChangedBlock?: string;
  compressionTarget?: string;
  droppedCount?: number;
  layerTokens?: Record<string, number>;
  blockHashes?: Record<string, string>;
  availableInput?: number;
  estimatedInput?: number;
  overBudget?: boolean;
  targetRatio?: number;
  hardRatio?: number;
  maintenanceStage?: string;
  nextMaintenanceAction?: string;
  lastConsolidationAt?: string;
  lastUpdatedAt?: string;
}

export interface ArtifactContent {
  artifact: RunSnapshot["artifacts"][string];
  content: string;
}
