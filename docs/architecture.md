# ProofBlade architecture

## Dependency funnel

The package boundary follows how much information a component is allowed to know, rather than forcing every feature into exactly three layers.

| Level | Package | Information position | Knowledge boundary |
| --- | --- | --- | --- |
| 1 | `@proofblade/atoms` | represent and persist information | Generic contracts, hashes, ids, atomic file operations and keyed serialization. It knows nothing about CTF, Pi or the CLI. |
| 2 | `@proofblade/molecules` | acquire and process information | Generic tool composition, event projection, layered context and file artifacts. It knows atoms, but no ProofBlade business rules. |
| 3 | `@proofblade/materials` | turn information into ProofBlade behavior | CTF state, reducers, effects, leases, fixtures, provider resolution and Pi integration. It knows atoms and molecules. |
| 4 | `@proofblade/cli`, `@proofblade/gui` | transmit user intent, debug state and results | Commands, HTTP orchestration, browser state and display. Both consume the public materials API; neither is imported below the application layer. |

```text
CLI / GUI (delivery and debugging)
  -> materials (business processing)
      -> molecules (generic processing)
          -> atoms (data and deterministic primitives)
```

Dependency arrows always point toward a lower-information package. Lower packages never import a higher package. The boundary is enforced by `dependency-funnel.test.ts`, package dependency assertions and TypeScript project references.

The type hierarchy grows in the same direction: `ToolAtom` becomes `AgentTool` and then `ToolDefinition`; `ArtifactAtom`, `EffectAtom`, `MessageAtom` and `SequencedEventAtom` are extended by domain types without adding business knowledge to atoms. `npm run test:atoms` and `npm run test:molecules` prove the bottom two levels work when their upper levels are absent.

## Durable domains

ProofBlade has two durable domains:

1. Pi Session stores provider-visible messages, model changes and compaction entries.
2. The CTF Control Store stores task, run, phase, knowledge, effects, leases and submission state.

The control store is the authority for completion. Models and tools emit events or commands; the reducer is the only component that derives a run snapshot. Large tool output is stored as an immutable artifact and referenced by hash from the event log.

```text
CLI / GUI -> Control Store -> Reducer -> Run Snapshot
           |              -> Knowledge ledger
           |              -> Effect journal -> Sandbox
           -> Context Compiler -> Pi AgentHarness adapter
```

The first implementation uses one JSONL file per run. A keyed operation queue gives each run a single writer. Each event is reduced before append, the append is flushed to stable storage, and the derived projection is replaced atomically. `replay` rebuilds the snapshot from events and compares its canonical hash with the persisted projection hash. This gives a storage-independent contract before a SQLite adapter is introduced.

Effects are recorded as `PROPOSED`, `STARTED` and `FINISHED`. Recovery reruns pure or idempotent work under the original effect id, adopts a result artifact that was already persisted, and marks work with an unsafe replay policy as `UNKNOWN`. Fixture generations and leases are durable control-store facts, so stale work can be rejected after reset or ownership change.

## Single-agent loop

The single-agent path keeps active control outside the model:

```text
Drive Loop -> Pi solver lane -> ProofBlade tools -> Effect Journal -> Sandbox
     |                                  |               |
     |                                  -> Observer -> Observation/Evidence
     -> Phase machine -> Completion proposal -> Independent verifier
                                              -> Report -> verifier-gated finish
```

Pi owns the provider turn and its JSONL Session. The solver tools can inspect the target, propose intents/hypotheses/facts and propose one candidate. A proposed fact remains `PROPOSED`; a candidate is accepted only when its exact value occurs in a successful current-generation observation artifact. The candidate itself is kept in a sensitive artifact while the event log stores only its SHA-256 and artifact id.

The Drive Loop is the sole active phase coordinator. In Auto mode it sends a proposed candidate directly to the hidden scorer. In Assist mode it pauses with a durable proposal and verifies it when the same run is resumed. The verifier executes the configured number of reproduction attempts through the Effect Journal. Only the verifier lane can confirm a fact, verify a completion or commit `SUCCEEDED`.

## Capabilities and background jobs

The provider sees a fixed `invoke_capability` schema rather than a changing list of every plugin operation. `list_capabilities` returns the bundled manifest and canonical catalog hash; the router validates the capability id, operation, argument keys and replay policy before mapping it to a journaled sandbox operation. Target results are wrapped as untrusted observations and linked to deterministic Observation/Evidence records; artifact reads remain retrieval-only.

`run_background` creates a durable `JobRecord` before starting work. Job lifecycle events (`job_queued`, `job_started`, `job_finished`, `job_cancelled`, `job_reconciled`) are reduced beside effects and artifacts. Pure/idempotent/resumable jobs can be restarted after a process boundary under the same deterministic effect key; forbidden replay becomes `UNKNOWN`. Timeouts and cancellation abort the controller, while the effect journal remains the source of truth. Run teardown stops active jobs so in-process or child execution does not outlive the run unexpectedly.

## Planner and executor handoff

The planner lane currently uses a deterministic coordinator rather than an additional model call. It emits an immutable `HandoffRecord` containing a knowledge-version hash, bounded fact/hypothesis references, ranked next actions, prohibited repeats and remaining budget. The executor accepts the handoff through the Control Store before its Pi turn. An observation, fact, hypothesis, intent, completion, artifact or job change alters the knowledge hash; the next turn supersedes the stale handoff and creates a fresh one. Handoff events are serialized by the same per-run writer, and the context compiler injects only a bounded `<planner-handoff>` index. A configured planner model can later replace the draft builder without changing the handoff or reducer contract.

## Evaluation gate

`FixtureEvaluationRunner` runs the six synthetic profiles through the production loop with a deterministic lane. It reports per-case status, evidence-backed completion, replay projection parity and candidate plaintext leakage, then hashes the complete report. `proofblade eval` and `npm run eval` are provider-free pre-push checks; LM Studio is reserved for a separate live smoke run.

## Durable observability

Pi lifecycle subscriptions append low-sensitivity Provider and Tool telemetry to the same durable run log. Provider payloads and raw Tool arguments are not persisted: requests record the selected provider/model, phase, estimated context, retry limit and timing; Tool calls record an argument hash, execution policy, wait time and sensitivity. Results record byte counts, structured error signatures, artifact hashes and whether evidence was added. Effect completion separately records duration, output bytes, exit code and error signature so direct runtime calls remain observable even without a Pi turn.

`RunTelemetry` is a read-only projection over events and the run snapshot. `proofblade cost RUN` reports input/output/reasoning/cache tokens, Provider cost and latency, cache/context efficiency, Tool and Effect outcomes, time to first evidence, compaction/checkpoint counts and the primary failure category. A zero-cost LM Studio response remains a valid measured request rather than being treated as missing data.

Every new Run stores one hashed version snapshot in `run_started`: ProofBlade, Pi and Node versions; prompt and context compiler versions/hashes; the full Tool Contract hash; router policy; project Skill content hashes; and MCP configuration hashes. Provider URLs, keys, prompt payloads, Tool arguments and target content stay outside this snapshot.

Provider-specific reasoning behavior is configuration data. `thinkingLevel` selects Pi's level, while `reasoning`, `supportsReasoningEffort` and `maxTokensField` describe the OpenAI-compatible endpoint. API credentials are resolved only through the environment variable named by `apiKeyEnv`; neither the version snapshot nor telemetry records the variable value.

## Debugging application

`@proofblade/gui` is an application adapter above materials. Its Node server reads snapshots, events, telemetry, Artifacts and Pi JSONL sessions through the existing public repositories. It does not add a third durable state model. Ordinary conversations reopen `PiCodingLane`, whose information scope is limited to the configured model, Pi Session, current workspace and Pi's built-in coding tools. Fixture conversations reopen `PiSolverLane`, which additionally knows the target sandbox, Control Snapshot, evidence protocol and solver tools. Both stream normalized AgentHarness events as SSE and persist completed turns through Pi Session and Control Store. A Tool debug projection correlates an assistant `toolCall`, the following Pi `toolResult`, Control Store `tool_call_recorded`/`tool_result_recorded` events with the same `toolCallId`, and referenced Artifact/Evidence/Effect records when those records exist.

The browser owns only selection, presentation and temporary transformations. Script Lab creates a dedicated Web Worker for one invocation, passes the selected Tool projection as structured-clone data, enforces a 1500 ms termination timer and destroys the Worker after a result or error. User script source is never evaluated by the Node server and is not added to the Run, Pi Session, event log or project configuration.

Run list polling first checks `events.jsonl` modification time and reuses unchanged summaries. The selected Run is reloaded every two seconds so active turns and Tool calls appear without a page reload. Fixture-only mutations call the same `SingleAgentCtfLoop`, `RunRecoveryService` and `CheckpointService` used by the CLI.

## Context and recovery

The context compiler keeps six information layers explicit. L0/L1 hold stable instructions and the immutable task contract; L2 holds phase gates; L3 holds confirmed facts, proposed facts, rejected hypotheses, observations, evidence, completions, in-flight effects and leases; L4 holds recent messages; L5 holds artifact references. A `ContextManifest` records layer tokens, included ids, dropped ids, budget arithmetic, a standing-instruction hash, memory-layer ids and a deterministic hash. Confirmed facts and rejected hypotheses keep their ids even when older prose is reduced to an indexed retrieval hint, so compaction cannot silently turn task memory into a fresh search.

Before a Pi provider request, a deterministic maintenance plan uses soft, snip, prune and force-compaction bands (50%, 60%, 80% and 90% of the available input budget). The first band only reports pressure; the next band head/tail snips stale medium/large tool results and keeps their artifact/evidence references; pruning removes only complete old tool exchanges. Interrupted calls receive a deterministic placeholder result and orphan results are removed, so the provider never receives a dangling tool pair. Full output remains in the immutable artifact store. `read_artifact` performs bounded head/tail retrieval by id and `search_history` queries the durable ledger without loading raw history. When pruning or compaction occurs, a fixed-format checkpoint records task, the standing-memory boundary, confirmed facts, rejected hypotheses, observation/evidence index, artifacts, completed and in-flight actions, leases, next intents, budget and blockers.

When a completed turn reaches the compact band, the lane performs idle-time Pi compaction after the provider is idle; the compaction hook supplies the durable checkpoint as the summary anchor. A provider overflow creates one mechanical checkpoint and invokes Pi compaction. A second overflow in the same Run is classified as `context_overflow` and fails explicitly; it never loops on compression indefinitely. Checkpoint and overflow counters are replayed from the Control Store, while the Pi Session remains the provider-facing transcript.

Recovery is coordinated by `RunRecoveryService`: expired leases are fenced and reaped, Fixture health is compared with the projected generation, stale jobs are reconciled, and unfinished Effects are handled only after the environment decision. `DurableCompactionCoordinator` persists the mechanical checkpoint before Pi Session append and reuses it after an interruption. Tool-pair validation runs for every Provider context, including low-pressure contexts. The six executable interruption scenarios and convergence rules are documented in `docs/recovery.en.md` (with the Chinese primary guide in `docs/recovery.md`).


## Pi 0.83.0 package note

The GitHub snapshot at commit `0524d6897f171d63a79e00946df8ce7f53c605fe` and the npm package carrying version `0.83.0` expose slightly different names. ProofBlade targets the installed npm surface (`JsonlSessionRepo`) and protects session reopen behavior with an adapter contract test. Source commit and tarball integrity are recorded in `package-manifest.lock.json`.
