# Tool contract

Every capability is wrapped as an effect:

1. Normalize arguments and compute an idempotency key.
2. Append `effect_proposed` and `effect_started`.
3. Execute through the sandbox adapter.
4. Persist stdout/stderr as an artifact with a SHA-256 digest.
5. Append `effect_finished` and derive evidence candidates.

Tool output is marked as an untrusted observation when it came from a target. It is never interpreted as a control command.

The effect record also stores the fixture generation and enough execution data to reconcile interrupted work. Pure and idempotent effects may resume under the same effect id. If execution produced and registered an artifact before interruption, reconciliation adopts that artifact without running the command again. Other in-flight effects become `UNKNOWN` for explicit handling.

## Solver tools

The Pi solver lane exposes thirteen sequential tools. The capability tools have stable schemas; operation details are discovered only when requested.

| Tool | Information role |
| --- | --- |
| `inspect_target` | Acquire every visible synthetic target file through one zero-argument, journaled effect. |
| `list_capabilities` | Acquire the bundled capability manifest and canonical catalog hash. |
| `invoke_capability` | Route one manifest operation through scope validation and the Effect Journal. Target output becomes an untrusted observation with an artifact anchor. |
| `run_background` | Queue a durable, cancellable capability job and return a JobRecord id. |
| `read_job_output` | Poll a job and retrieve its bounded artifact output. |
| `stop_job` | Cancel a queued or running job and persist the reason. |
| `propose_intent` | Propose and deduplicate an evidence-seeking action. |
| `propose_hypothesis` | Process observations into a falsifiable statement linked to evidence ids. |
| `propose_fact` | Propose a ledger fact; it remains unconfirmed until verifier action. |
| `submit_candidate` | Transmit one observed `PB{...}` value as a completion proposal. |
| `read_artifact` | Retrieve a bounded head/tail window from a referenced immutable artifact. |
| `search_history` | Query durable facts, hypotheses, observations, evidence and checkpoints by id or text. |
| `report_status` | Read authoritative phase, ids, proposals and remaining budget. |

`submit_candidate` checks the exact candidate against successful current-generation observation artifacts before writing a proposal. It returns a hash and completion id to the model and requests early turn termination. Hidden scoring is not model-visible and executes as separate `fixture_score` effects.

## Capability and job invariants

Capability manifests are sorted before hashing; adding a manifest changes the catalog hash but never changes the core tool schema. Bundled capabilities are read-only target and artifact readers in this milestone. Every invocation creates the normal effect and artifact records, and target operations additionally create deterministic Observation/Evidence records.

Jobs persist capability id, operation, arguments, generation, replay policy, effect/artifact references and terminal status. Pure, idempotent and resumable jobs restart from their durable record after a process restart; forbidden-replay jobs become `UNKNOWN`. Cancellation aborts the active controller, leaves the effect journal intact and prevents a late result from changing a `CANCELLED` job. Run teardown stops active jobs so no unexpected child process remains.

## Planner handoff contract

The planner lane emits a versioned `HandoffRecord`; the executor receives ids and bounded summaries instead of planner chat history. The record carries `knowledgeVersion`, confirmed/rejected references, ranked `nextActions`, `prohibitedRepeats`, required artifact ids and remaining tool/time budget. `handoff_proposed` is planner-only, `handoff_accepted` is executor-only, and acceptance fails when the shared knowledge hash is stale. `handoff_superseded` preserves the old record for audit while the next turn receives a fresh handoff through the context compiler.
