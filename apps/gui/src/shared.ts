import type { HarnessEvent, RunSnapshot, RunTelemetryReport } from "@proofblade/materials";

export interface BootstrapData {
  projectName: string;
  configPath: string;
  storage: { runsDir: string; fixturesDir: string };
  model: { provider: string; model: string; baseUrl: string; thinkingLevel: string };
  fixtures: Array<{ id: string; targetKind: string; description: string }>;
  refreshIntervalMs: number;
}

export interface ActiveRunInfo {
  runId: string;
  startedAt: string;
  state: "running" | "failed";
  error?: string;
}

export interface RunListItem {
  runId: string;
  objective: string;
  targetKind: string;
  status: RunSnapshot["status"];
  phase: RunSnapshot["phase"];
  generation: number;
  lastSeq: number;
  updatedAt: string;
  counts: { tools: number; evidence: number; artifacts: number; effects: number };
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
  entries: unknown[];
  branchEntryIds: string[];
  assistantTurns: AssistantTurnDebug[];
  toolCalls: ToolCallDebug[];
}

export interface RunDetail {
  snapshot: RunSnapshot;
  events: HarnessEvent[];
  telemetry: RunTelemetryReport;
  sessions: PiSessionDebug[];
  active?: ActiveRunInfo;
  updatedAt: string;
}

export interface ArtifactContent {
  artifact: RunSnapshot["artifacts"][string];
  content: string;
}
