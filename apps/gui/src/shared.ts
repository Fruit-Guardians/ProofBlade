import type { HarnessEvent, RunSnapshot, RunTelemetryReport } from "@proofblade/materials";

export type RunKind = "chat" | "fixture";

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
  kind: RunKind;
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
  usage?: unknown;
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
  messages: ChatMessageDebug[];
  toolCalls: ToolCallDebug[];
}

export type ChatStreamEvent =
  | { type: "started"; runId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "done"; text: string; stopReason: string; usage: unknown }
  | { type: "error"; error: string };

export interface RunDetail {
  kind: RunKind;
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
