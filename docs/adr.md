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

## ADR-009 Model output is a proposal

Pi tools expose proposal commands, not terminal state mutation. Model facts remain `PROPOSED`, candidates must occur verbatim in a successful current-generation observation artifact, and only the verifier lane can confirm facts, accept completions or commit a successful run.

## ADR-010 Small-model tools stay atomic

Prefer a zero-argument target inspection tool over an optional path that mixes target, run and artifact namespaces. Keep target acquisition, knowledge proposals and result transmission as separate tools with sequential execution.

## ADR-011 Context pruning is deterministic first

Before asking an LLM to summarize, preserve stable task and ledger anchors, snip old tool results, remove complete old tool exchanges and write a mechanical checkpoint. Pi compaction receives that checkpoint through `session_before_compact`; one overflow recovery is allowed per Run and the next overflow becomes an explicit failure.

## ADR-012 Context memory has separate authority and retrieval paths

Standing instructions are a stable prompt-prefix contract. Confirmed facts and rejected hypotheses are task memory with explicit ids and evidence links; episode history and raw tool output remain retrieval-only artifacts. The context manifest records the hash and ids for each layer. Maintenance is staged at 50/60/80/90% pressure, preserves complete tool-call/result pairs, and leaves a checkpoint anchor before any Pi compaction. Target text is always wrapped as untrusted data and cannot alter the task contract, tool registry, budget or terminal state.

## ADR-013 Capability schemas are stable; operations are discovered and journaled

Keep one fixed `invoke_capability` contract in the provider-visible tool surface. A canonical capability manifest and catalog hash describe available operations without changing the core schema. The router validates operation-specific arguments and maps them to the existing Effect Journal, artifact store and trust boundary. Background work is represented by durable JobRecords and lifecycle events; recovery is replay-policy driven, cancellation is explicit, and run teardown cleans up active controllers.

## ADR-014 Planner handoffs are structured and version-checked

Planner and executor do not share a chat transcript. The planner lane writes a bounded `HandoffRecord` with references, next actions, budget and a hash of the shared knowledge projection. The executor lane can accept only a current handoff; new knowledge supersedes old handoffs before the next turn. Handoff lifecycle events are reducer-owned and the active record is included in the context manifest. The initial planner is deterministic to keep local-model runs affordable; a configured planner model may be added behind the same contract.
