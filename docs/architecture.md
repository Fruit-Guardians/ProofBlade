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

Every newly created event also carries an optional `RunEventEnvelope`. The envelope records source, kind, priority, status, generation, correlation/causation, idempotency and coalescing keys, operation/request references and replay policy. `RunEventIngress` appends immutable `event_ingress_received` facts and later appends `event_ingress_processed` facts at a bounded safe point; it never mutates an earlier event or maintains a GUI-only queue. The default application path is still one Coding lane. Multi-agent WorkItems and handoffs remain structural interfaces, but no parallel strategy is enabled by default.

Effects are recorded as `PROPOSED`, `STARTED` and `FINISHED`. Recovery reruns pure or idempotent work under the original effect id, adopts a result artifact that was already persisted, and marks work with an unsafe replay policy as `UNKNOWN`. Fixture generations and leases are durable control-store facts, so stale work can be rejected after reset or ownership change.

## Single-agent loop

The single-agent path keeps active control outside the model:

```text
RunCoordinator -> Pi coding lane -> ProofBlade tools -> Effect Journal -> Sandbox
      |                                  |               |
      |                                  -> Observer -> Observation/Evidence
      -> DomainPhase + WorkItem -> Completion proposal -> Independent verifier
                                                     -> Report -> SUBMIT -> verifier-gated finish
```

Pi owns the provider turn and its JSONL Session. The coding lane can inspect the target, propose intents/hypotheses/facts and submit a candidate for verification. A proposed fact remains `PROPOSED`; a candidate is accepted only when its exact value occurs in a successful current-generation observation artifact. The candidate itself is kept in a sensitive artifact while the event log stores only its SHA-256 and artifact id.

`RunCoordinator` is the sole active phase and WorkItem coordinator shared by
Competition, GUI and Fixture/Evaluation entrypoints. In Auto mode a proposed
candidate enters the verifier-owned Effect Journal path; in Assist mode it
pauses with a durable proposal and resumes through the same path. Dynamic flag
shortcuts use the same verifier-owned effect rather than bypassing the state
machine. The verifier executes the configured number of reproduction attempts
through the Effect Journal. Only the verifier lane can confirm a fact, verify a
completion or commit `SUCCEEDED`; recovery also repairs a phase/WorkItem gap
before the terminal event is appended.

Before the first CTF model turn, the selected `ChallengeToolProfile` contributes a durable `firstActionPlan` to `RunToolPreparation`. It names the small set of tools allowed to establish the initial observation and caps those calls; `verify_claim`, platform submission and reproduction tools remain an explicit completion escape. The Coding lane enforces this at the Pi `tool_call` boundary, and a recovered lane treats the current-generation Observation ledger as the source of truth for whether the first action already completed. This is a coordinator/tool contract, not a prompt-only instruction, so a model cannot spend its initial turn rediscovering tools or launching an unrelated experiment.

For Competition and Fixture Runs, challenge mode is derived from the durable `TaskContract` (`ctf_solve` or a non-unknown target kind), not from keywords in the generated prompt. This keeps the hard CTF experiment budget and evidence-first replan active even when an executor prompt only contains a generic WorkItem objective.

## Capabilities and background jobs

The provider sees a fixed `invoke_capability` schema rather than a changing list of every plugin operation. `list_capabilities` returns the bundled manifest and canonical catalog hash; the router validates the capability id, operation, argument keys and replay policy before mapping it to a journaled sandbox operation. Target results are wrapped as untrusted observations and linked to deterministic Observation/Evidence records; artifact reads remain retrieval-only.

The ordinary Coding lane follows the same stable-surface principle without pretending to own CTF evidence. Its Provider tool list always contains one `load_skill` proxy and one `mcp_call` proxy. Conversation settings change the runtime allowlists and one-line resource summaries, not the proxy schemas or ordering. `mcp_call` multiplexes `list`, `describe` and `call`: list is configuration-only, describe starts one enabled Server lazily, and call revalidates both the enabled Server and its allowed Tool. Coding calls remain in Pi Session and Tool telemetry; Solver calls additionally pass through the Capability Router, Effect Journal and Artifact/Evidence boundary.

Browser verification has the same boundary when the browser lives in another process. `HttpBrowserRuntimeBroker` uses a versioned create/lifecycle wire (`create`, `inspect`, `adopt`, `release`, `heartbeat`) plus a `health` capability probe: `create` is an idempotent create/open handshake bound to the target, run/generation, policy/recipe/scope and verification key, and returns only broker-owned session/external ids, the initial URL and a state hash. `HttpBrowserVerifierFactory` converts that response into the same verifier-owned `BrowserContextBackend` input shape, preserving the broker session id and using the immutable request hash as the retry key; its probe must report `READY` and `stableAcrossRestart=true` before Browser replay is registered. `DurableBrowserRuntimeService` persists the create reservation and exact binding, refuses to revive an expired lease without host reconciliation, exposes bounded capabilities and renews leases only after exact binding, and delegates the actual browser to an injected host. Lifecycle requests carry only the immutable resource binding and an opaque external id. `HttpBrowserRuntimeContextPort` uses the matching action wire (`navigate`, `click`, `fill`, `submit`, `wait`) and returns bounded content, current URL and a state hash; it never transports cookies, storage values, `Page`/`BrowserContext` objects or arbitrary script evaluation. `createBrowserRuntimeHttpHandler` owns request limits, abort propagation, route/field validation and redacted status mapping; `BrowserRuntimeContextActionService` is the small server-side adapter that invokes a resolver-owned context and derives the redacted state hash. Without a create service, an action service, a health probe, or an exact broker match, recovery remains `UNKNOWN`/`RECOVERY_REQUIRED` rather than creating a replacement context. The reference `scripts/session-runtime-combined-host.ts` can multiplex durable HTTP and Pwn hosts behind one session service; it dispatches by immutable `request.kind` and reports `READY` only when both underlying hosts are complete and restart-stable.
Pwn and stateful HTTP sessions use the same remote-runtime boundary. `HttpSessionRuntimeBroker` exposes versioned create/lifecycle/action routes plus a lease `heartbeat`; `DurableSessionRuntimeService` persists a STARTING reservation, exact immutable binding and a bounded renewable lease while an injected `SessionRuntimeHost` owns the real tube/process or HTTP client. Every brokered Pwn/HTTP action first refreshes and verifies the exact unexpired lease; an expired or ambiguous handle is rejected before touching the host, while release remains allowed to inspect and reclaim that exact handle. The service still requires `inspectByIdempotency()` before advertising `stableAcrossRestart=true`, so a protocol-compatible fake cannot be mistaken for a restart-safe production host.

If a session host has no dedicated heartbeat endpoint, the durable service uses an exact `inspect` of the same opaque handle as the renewal proof. A host may advertise `READY` only when it implements every action required by its declared session kinds; missing action capabilities force `DEGRADED` and keep the broker out of the Coding lane.

Session handoff across the Control Store and external-resource ledger is coordinated by a durable `BindingTransactionCoordinator`. `prepare` records an immutable identity and `STARTED` external handle in a companion intent journal, `commitControl` writes one `session_opened` event carrying `bindingTxnId` and `bindingIdentityHash`, and `finalize` records the owner marker before moving the intent to `BOUND`. Recovery replays the intent first: an exact open owner can repair a missing marker and then go through the broker's `inspect/adopt`; missing, stale, or mismatched identities never create a replacement session. The coordinator owns metadata only and never carries sockets, cookies, tokens, command lines, or response bodies.

`run_background` creates a durable `JobRecord` before starting work. Job lifecycle events (`job_queued`, `job_started`, `job_finished`, `job_cancelled`, `job_reconciled`) are reduced beside effects and artifacts. Pure/idempotent/resumable jobs can be restarted after a process boundary under the same deterministic effect key; forbidden replay becomes `UNKNOWN`. Timeouts and cancellation abort the controller, while the effect journal remains the source of truth. Run teardown stops active jobs so in-process or child execution does not outlive the run unexpectedly.

Runtime resources use `Scope`: child scopes dispose before parents, resources dispose in reverse registration order, disposal is idempotent, and one cleanup failure is aggregated after the remaining resources have had a chance to release. `RunCoordinator` exposes the same ingress for user control signals and maps pause/resume/cancel through normal ControlStore commands.

Experience changes are represented by `UpdateProposal` records in the same ControlStore. A proposal must be evaluated before approval or activation; rollback is explicit and checks the candidate hash before restoring the base version pointer. This is a release boundary, not a second knowledge store or an automatic self-modification path.

## Planner and executor handoff

The planner lane currently uses a deterministic coordinator rather than an additional model call. It emits an immutable `HandoffRecord` containing a knowledge-version hash, bounded fact/hypothesis references, ranked next actions, prohibited repeats and remaining budget. The executor accepts the handoff through the Control Store before its Pi turn. An observation, fact, hypothesis, intent, completion, artifact or job change alters the knowledge hash; the next turn supersedes the stale handoff and creates a fresh one. Handoff events are serialized by the same per-run writer, and the context compiler injects only a bounded `<planner-handoff>` index. A configured planner model can later replace the draft builder without changing the handoff or reducer contract.

## Evaluation gate

`FixtureEvaluationRunner` runs the six synthetic profiles through the production loop with a deterministic lane, three times each. `RuntimeScenarioEvaluator` adds twelve provider-free behavioral cases covering cache accounting and prefix stability, context monotonicity and task anchoring, convergence breakers, evidence curation and deduplication, pause/replay durability, verifier authority and lease fencing. The `baseline-v3` gate therefore requires 30/30 cases while retaining separate Fixture and scenario totals. Both catalogs and their outcomes enter the stable report hash; run ids, wall-clock duration and raw error strings do not. `proofblade eval` and `npm run eval` are pre-push checks; live Provider smoke and cache-hit measurements remain separate because they depend on external routing behavior.

## Durable observability

Pi lifecycle subscriptions append low-sensitivity Provider and Tool telemetry to the same durable run log. Provider payloads and raw Tool arguments are not persisted: requests record the selected provider/model, phase, estimated context, retry limit and timing; Tool calls record an argument hash, execution policy, wait time and sensitivity. Results record byte counts, structured error signatures, artifact hashes and whether evidence was added. Effect completion separately records duration, output bytes, exit code and error signature so direct runtime calls remain observable even without a Pi turn.

`RunTelemetry` is a read-only projection over events and the run snapshot. `proofblade cost RUN` reports input/output/reasoning/cache tokens, Provider cost and latency, cache/context efficiency, Tool and Effect outcomes, time to first evidence, compaction/checkpoint counts and the primary failure category. A zero-cost LM Studio response remains a valid measured request rather than being treated as missing data.

Every new Run stores one hashed version snapshot in `run_started`: ProofBlade, Pi and Node versions; prompt and context compiler versions/hashes; the full Tool Contract hash; router policy; project Skill content hashes; and MCP configuration hashes. Provider URLs, keys, prompt payloads, Tool arguments and target content stay outside this snapshot.

Provider-specific reasoning, cache retention and transport behavior is configuration data. `thinkingLevel` selects Pi's level, `cacheRetention` selects `none`, `short` or `long`, `reasoning`, `supportsReasoningEffort` and `maxTokensField` describe the OpenAI-compatible endpoint, and optional `proxyUrl` is shared by model discovery and provider requests. The CLI resolves credentials through the environment variable named by `apiKeyEnv`; the GUI may instead load its user-local `.proofblade` override. Neither the version snapshot nor telemetry records credential values.

## Debugging application

`@proofblade/gui` is an application adapter above materials. Its Node server reads snapshots, events, telemetry, Artifacts and Pi JSONL sessions through the existing public repositories. It does not add a third durable state model. Ordinary conversations and Fixture/CTF conversations both use `PiCodingLane`; the latter changes only the visible workspace and keeps claim acceptance deferred until the outer independent verifier. Both stream normalized AgentHarness events as SSE and persist completed turns through Pi Session and Control Store. A Tool debug projection correlates an assistant `toolCall`, the following Pi `toolResult`, Control Store `tool_call_recorded`/`tool_result_recorded` events with the same `toolCallId`, and referenced Artifact/Evidence/Effect records when those records exist.

The browser owns only selection, presentation and temporary transformations. Script Lab creates a dedicated Web Worker for one invocation, passes the selected Tool projection as structured-clone data, enforces a 1500 ms termination timer and destroys the Worker after a result or error. User script source is never evaluated by the Node server and is not added to the Run, Pi Session, event log or project configuration.

Run list polling first checks `events.jsonl` modification time and reuses unchanged summaries. The selected Run is reloaded every two seconds so active turns and Tool calls appear without a page reload. Fixture-only mutations call the same `SingleAgentCtfLoop`, `RunRecoveryService` and `CheckpointService` used by the CLI.

## Context and recovery

The context compiler keeps six information layers explicit. L0/L1 hold stable instructions and the immutable task contract; L2 holds phase gates; L3 holds confirmed facts, proposed facts, rejected hypotheses, observations, evidence, completions, in-flight effects and leases; L4 holds recent messages; L5 holds artifact references. A `ContextManifest` records layer tokens, included ids, dropped ids, budget arithmetic, a standing-instruction hash, memory-layer ids and a deterministic hash. It also records a provider-neutral `stable-prefix` cache fingerprint: the L0/L1 prefix hash is separated from the dynamic L2-L5 hash, so cache reuse can be compared against provider-reported `cacheRead` tokens without guessing from visible prompt length. In the Coding lane, L1-L5 are appended as persisted user-turn suffix messages. This preserves the complete prior provider request as the next request's prefix, matching Reasonix's cache-first session shape. Confirmed facts and rejected hypotheses keep their ids even when older prose is reduced to an indexed retrieval hint, so compaction cannot silently turn task memory into a fresh search.

Before a Pi provider request, the shared `prepareContextMaintenance()` coordinator repairs tool pairs and applies a deterministic plan using notice, snip, prune, compact and force-compaction bands (55%, 60%, 75%, 80% and 90% of the available input budget). Notice only reports pressure. Snip rewrites stale medium/large Tool results to bounded head/tail views while retaining artifact/evidence references. Prune removes only complete old Tool exchanges. After either deterministic pass, the coordinator measures the resulting payload again and requests compaction only if it is still above the compact band, or immediately at the force band. The coordinator returns a `nextAction` marker rather than calling Pi from inside a hook; the outer lane performs idle compaction after the current turn. Interrupted calls receive a deterministic placeholder result and orphan results are removed, so the provider never receives a dangling tool pair. Full output remains in the immutable artifact store. `read_artifact` performs bounded head/tail retrieval by id and `search_history` queries the durable ledger without loading raw history. When pruning or compaction occurs, a fixed-format checkpoint records task, the standing-memory boundary, confirmed facts, rejected hypotheses, observation/evidence index, artifacts, completed and in-flight actions, leases, next intents, budget and blockers.

Observability captures a second cache diagnostic from Pi's final `before_provider_payload` event. It canonicalizes only System/Developer messages and the ordered Tool Schema, then persists hashes, counts and token estimates. Reports compare consecutive requests within the same Provider/model pair and classify changes as `system`, `tools` or `rewrite`. This prefix stability metric detects client-side cache breakers; Provider-reported `cacheRead` remains the authority for actual upstream cache reuse. Prompt text and Tool arguments are not retained by this diagnostic.

## Tool output rewrite

`packages/molecules` defines the business-agnostic `OutputRewritePort`. Materials selects `builtin` or `rtk` from config and Coding Runtime wraps only the existing `bash` executor. The wrapper preserves the exact Provider-visible Tool contract and uses the same Pi `ExecutionEnv` for RTK probing, command rewriting and command execution, including WSL environments. It accepts RTK's permission-aware success exits `0` and `3`; no-match exit `1` preserves the original command, while other outcomes follow the configured builtin/fail policy.

The execution order is `prepare rewrite -> execute -> read RTK tee when present -> register Artifact -> return bounded Tool result`. RTK handlers that do not emit tee data fall back to archiving the bounded Pi-visible output, and the trace distinguishes `rtk-tee` from `visible-output`. Session details and Tool telemetry retain only adapter/version, command hashes, byte counts, reduction, and Artifact references. Solver business tools already use Effect Journal and Artifact-first output handling, so they do not enter this second rewrite chain.

When a completed turn reaches the compact band, the lane performs idle-time Pi compaction after the provider is idle; the compaction hook supplies the durable checkpoint as the summary anchor. A provider overflow creates one mechanical checkpoint and invokes Pi compaction. A second overflow in the same Run is classified as `context_overflow` and fails explicitly; it never loops on compression indefinitely. Checkpoint and overflow counters are replayed from the Control Store, while the Pi Session remains the provider-facing transcript.

Recovery is coordinated by `RunRecoveryService`: expired leases are fenced and reaped, Fixture health is compared with the projected generation, stale jobs are reconciled, and unfinished Effects are handled only after the environment decision. `DurableCompactionCoordinator` persists the mechanical checkpoint before Pi Session append and reuses it after an interruption. Tool-pair validation runs for every Provider context, including low-pressure contexts. The six executable interruption scenarios and convergence rules are documented in `docs/recovery.en.md` (with the Chinese primary guide in `docs/recovery.md`).


## Pi 0.83.0 package note

The GitHub snapshot at commit `0524d6897f171d63a79e00946df8ce7f53c605fe` and the npm package carrying version `0.83.0` expose slightly different names. ProofBlade targets the installed npm surface (`JsonlSessionRepo`) and protects session reopen behavior with an adapter contract test. Source commit and tarball integrity are recorded in `package-manifest.lock.json`.
