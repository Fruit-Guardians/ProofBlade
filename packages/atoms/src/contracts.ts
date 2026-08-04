export interface ToolAtom<TParameters = unknown> {
  name: string;
  description: string;
  parameters: TParameters;
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
