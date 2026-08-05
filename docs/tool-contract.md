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

The Pi solver lane exposes fourteen sequential tools. The capability and Skill proxy tools have stable schemas; operation details or full Skill content are loaded only when requested.

Every contract records `version`, `readOnly`, `sideEffect`, `timeoutMs`, `outputPolicy`, `replay`, `executionMode`, `resourceKeys`, `sensitivity`, and `evidenceKinds` in addition to its Provider-visible name, description, and TypeBox schema. Resource keys may contain argument templates such as `artifact:{artifactId}` or `job:{jobId}`; they are stable policy metadata for preflight and future multi-worker lease routing. The current single solver lane executes every core Tool sequentially, while Run recovery fences actual Fixture and target leases. The canonical contract snapshot includes this complete metadata in fixed tool order. A policy-only change therefore changes `solverToolContractHash()` even when the Provider-visible schema is unchanged.

| Tool | Information role |
| --- | --- |
| `inspect_target` | Acquire every visible synthetic target file through one zero-argument, journaled effect. |
| `list_capabilities` | Acquire the bundled capability manifest and canonical catalog hash. |
| `invoke_capability` | Route one manifest operation through scope validation and the Effect Journal. Target output becomes an untrusted observation with an artifact anchor. |
| `run_background` | Queue a durable, cancellable capability job and return a JobRecord id. |
| `read_job_output` | Poll a job and retrieve its bounded artifact output. |
| `stop_job` | Cancel a queued or running job and persist the reason. |
| `load_skill` | Load one model-visible project Skill by stable name with a bounded result; Skill metadata remains resident while its body is on demand. |
| `propose_intent` | Propose and deduplicate an evidence-seeking action. |
| `propose_hypothesis` | Process observations into a falsifiable statement linked to evidence ids. |
| `propose_fact` | Propose a ledger fact; it remains unconfirmed until verifier action. |
| `submit_candidate` | Transmit one observed `PB{...}` value as a completion proposal. |
| `read_artifact` | Retrieve a bounded head/tail window from a referenced immutable artifact. |
| `search_history` | Query durable facts, hypotheses, observations, evidence and checkpoints by id or text. |
| `report_status` | Read authoritative phase, ids, proposals and remaining budget. |

`submit_candidate` checks the exact candidate against successful current-generation observation artifacts before writing a proposal. It returns a hash and completion id to the model and requests early turn termination. Hidden scoring is not model-visible and executes as separate `fixture_score` effects.

## Structured failures

An execution failure is returned to Pi as `isError: true` with this stable payload instead of being disguised as successful text:

```json
{
  "ok": false,
  "error": {
    "code": "TOOL_TIMEOUT",
    "message": "operation timed out",
    "retryable": true,
    "signature": "sha256...",
    "phase": "execute",
    "partial_artifact_ref": { "id": "artifact-partial", "sha256": "..." },
    "next_hint": "Read the partial artifact before retrying."
  }
}
```

The failure phase is one of `validate`, `lease`, `preflight`, `execute`, `normalize`, `redact`, `artifact`, `evidence`, or `finish`. Known abort, timeout, missing-resource, bad-argument, and permission errors receive deterministic codes and retry guidance. Candidate-shaped values and configured secrets are removed before an error message and signature reach the model or event stream. A tool that produced useful partial output must register it first and throw `ProofBladeToolError` with `partialArtifactRef`.

## Capability and job invariants

Capability manifests are sorted before hashing; adding a manifest changes the catalog hash but never changes the core tool schema. Bundled capabilities include target and artifact readers plus `proofblade.web.request`. Every invocation creates normal effect and artifact records. Successful target, Web, MCP-call, and background capability results additionally create deterministic Observation/Evidence records.

`proofblade.web.request` accepts only `GET`, `HEAD`, and `POST` with an origin-relative path. The host chooses the target origin from the active Fixture endpoint or the immutable task target; model input cannot replace it. Task `allowed_hosts`, `allowed_ports`, and `external_network` are enforced before an Effect is proposed. Redirects are returned without being followed, credentials and host-controlled request headers are rejected, request bodies and response reads are bounded, and authentication/cookie response headers are redacted. Control events retain only the origin, pathname, query/header names, byte counts, limits, and a canonical request hash, not raw query, header, or body values.

Network requests use `replay: "manual"`. A completed result remains available through its immutable Artifact, but an interrupted request is never sent again automatically and reconciles to `UNKNOWN`.

Each enabled project MCP server is represented as one `mcp.<name>` capability with fixed `describe` and `call` operations. Listing capabilities only reads `.mcp.json`; describe/call starts stdio lazily. MCP effects use conservative manual replay by default, persist sensitive arguments as hashes, redact known secret values before artifact registration, and create Observation/Evidence for successful calls.

Jobs persist capability id, operation, arguments, generation, replay policy, effect/artifact references and terminal status. Pure, idempotent and resumable jobs restart from their durable record after a process restart; manual or otherwise unsafe replay policies become `UNKNOWN`. Cancellation aborts the active controller, leaves the effect journal intact and prevents a late result from changing a `CANCELLED` job. Run teardown stops active jobs so no unexpected child process remains.

`RunRecoveryService` runs before a solver resumes. It reaps expired leases with owner/generation fencing, reconciles Fixture health, advances the generation after a rebuild, marks stale queued/running jobs `UNKNOWN`, and only then reconciles Effects. An Effect whose recorded argument generation differs from the current Fixture becomes `UNKNOWN`, even when its replay policy is `pure`. See `docs/recovery.en.md` and `docs/recovery.md` for the six fault windows.

## Planner handoff contract

The planner lane emits a versioned `HandoffRecord`; the executor receives ids and bounded summaries instead of planner chat history. The record carries `knowledgeVersion`, confirmed/rejected references, ranked `nextActions`, `prohibitedRepeats`, required artifact ids and remaining tool/time budget. `handoff_proposed` is planner-only, `handoff_accepted` is executor-only, and acceptance fails when the shared knowledge hash is stale. `handoff_superseded` preserves the old record for audit while the next turn receives a fresh handoff through the context compiler.
