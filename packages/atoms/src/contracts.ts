export interface ToolAtom<TParameters = unknown> {
  name: string;
  description: string;
  parameters: TParameters;
}

export type ToolSideEffectAtom = "none" | "workspace" | "process" | "network" | "platform";
export type ToolOutputPolicyAtom = "inline" | "summary" | "artifact";
export type ToolExecutionModeAtom = "parallel" | "sequential";
export type ToolSensitivityAtom = "public" | "target" | "secret";
export type ToolErrorPhaseAtom = "validate" | "lease" | "preflight" | "execute" | "normalize" | "redact" | "artifact" | "evidence" | "finish";

export interface ToolErrorAtom<TArtifactRef = ArtifactAtom & { id?: string }> {
  code: string;
  message: string;
  retryable: boolean;
  signature: string;
  phase: ToolErrorPhaseAtom;
  partial_artifact_ref?: TArtifactRef;
  next_hint?: string;
}

export interface ToolFailureAtom<TArtifactRef = ArtifactAtom & { id?: string }> {
  ok: false;
  error: ToolErrorAtom<TArtifactRef>;
}

export interface MessageAtom<TRole extends string = string, TContent = string> {
  role: TRole;
  content: TContent;
}

export interface EventAtom<TType extends string = string, TPayload = Record<string, unknown>> {
  type: TType;
  payload?: TPayload;
}

export interface SequencedEventAtom<
  TType extends string = string,
  TPayload = Record<string, unknown>,
  TLane extends string = string,
  TActor extends string = string,
> extends EventAtom<TType, TPayload> {
  id: string;
  streamId: string;
  seq: number;
  ts: string;
  lane: TLane;
  actor: TActor;
  correlationId: string;
  causationId?: string;
}

export type ReplayPolicyAtom = "pure" | "idempotent" | "resumable" | "reconcile" | "manual" | "forbidden-replay";

export interface ArtifactAtom {
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}

export interface EffectAtom<TPolicy extends string = ReplayPolicyAtom, TArgs = Record<string, unknown>> {
  idempotencyKey: string;
  replayPolicy: TPolicy;
  operation: string;
  args: TArgs;
}

export type ReducerAtom<TState, TEvent> = (state: TState, event: TEvent) => TState;

export interface AppendOnlyLogAtom<TEvent> {
  append(events: readonly TEvent[]): Promise<void>;
  read(streamId: string): Promise<readonly TEvent[]>;
}
