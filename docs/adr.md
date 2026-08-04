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

## ADR-006 Layers follow information scope

Use a four-level dependency funnel instead of treating three layers as a fixed count. Atoms represent information without external knowledge. Molecules acquire and process generic information. Materials add ProofBlade, CTF, Pi and provider semantics. The CLI transmits user intent and results. Higher levels extend lower contracts, and imports never point toward a higher-information level.

## ADR-007 One durable writer per run

Serialize control-store operations by run id. Validate a transition before append, flush the JSONL record before publishing an atomically replaced projection, and recover projections through deterministic replay.

## ADR-008 Effect recovery preserves identity

Persist the operation, arguments, execution location, timeout, generation and replay policy before execution. Recovery keeps the original effect id and either adopts its existing artifact, reruns replayable work, or records an unknown outcome.
