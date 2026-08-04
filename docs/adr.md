# Architecture decisions

## ADR-001 Pi is the runtime base

Use Pi AgentHarness and its JSONL Session repository for provider-visible state. ProofBlade owns CTF domain state in a separate store.

## ADR-002 The two stores are independent

Pi Session is a view of what the model saw. The CTF store is the authority for facts, evidence, effects and completion.

## ADR-003 Context is a compiled view

The context compiler never rewrites the append-only session. It builds a deterministic six-layer view and records a manifest hash.

## ADR-004 Reducers own state changes

Model text can propose an action; only a validated event reduced by the control store changes the run state.

## ADR-005 External effects are journaled

All sandbox and capability calls have an effect id, replay policy, idempotency key and persisted result artifact.
