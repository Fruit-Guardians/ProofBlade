import type { ReducerAtom } from "@proofblade/atoms";

export interface ProjectableEvent {
  seq: number;
}

export class EventProjector<TState, TEvent extends ProjectableEvent> {
  public constructor(
    private readonly initial: () => TState,
    private readonly reducer: ReducerAtom<TState, TEvent>,
  ) {}

  public replay(events: readonly TEvent[]): TState {
    let state = this.initial();
    let expected = 1;
    for (const event of events) {
      if (event.seq !== expected) throw new Error(`Event sequence gap: expected ${expected}, got ${event.seq}`);
      state = this.reducer(state, event);
      expected += 1;
    }
    return state;
  }
}
