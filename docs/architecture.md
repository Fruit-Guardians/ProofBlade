# ProofBlade architecture

## Dependency funnel

The package boundary follows how much information a component is allowed to know, rather than forcing every feature into exactly three layers.

| Level | Package | Information position | Knowledge boundary |
| --- | --- | --- | --- |
| 1 | `@proofblade/atoms` | represent and persist information | Generic contracts, hashes, ids, atomic file operations and keyed serialization. It knows nothing about CTF, Pi or the CLI. |
| 2 | `@proofblade/molecules` | acquire and process information | Generic tool composition, event projection, layered context and file artifacts. It knows atoms, but no ProofBlade business rules. |
| 3 | `@proofblade/materials` | turn information into ProofBlade behavior | CTF state, reducers, effects, leases, fixtures, provider resolution and Pi integration. It knows atoms and molecules. |
| 4 | `@proofblade/cli` | transmit user intent and results | Commands, argument parsing and display. It consumes only the public materials API. |

```text
CLI (delivery)
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
CLI -> Control Store -> Reducer -> Run Snapshot
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

## Context and recovery

The context compiler keeps six information layers explicit. L0/L1 hold stable instructions and the immutable task contract; L2 holds phase gates; L3 holds confirmed facts, proposed facts, rejected hypotheses, observations, evidence, completions, in-flight effects and leases; L4 holds recent messages; L5 holds artifact references. A `ContextManifest` records layer tokens, included ids, dropped ids, budget arithmetic and a deterministic hash.

Before a Pi provider request, the context hook snips old tool results and removes complete old tool exchanges while keeping the latest call/result pair. Full output remains in the immutable artifact store. `read_artifact` performs bounded head/tail retrieval by id and `search_history` queries the durable ledger without loading raw history. When pruning or compaction occurs, a fixed-format checkpoint records task, confirmed facts, rejected hypotheses, artifacts, completed actions, next intents and blockers.

The first context overflow creates one mechanical checkpoint and invokes Pi compaction. A second overflow in the same Run is classified as `context_overflow` and fails explicitly; it never loops on compression indefinitely. Checkpoint and overflow counters are replayed from the Control Store, while the Pi Session remains the provider-facing transcript.


## Pi 0.83.0 package note

The GitHub snapshot at commit `0524d6897f171d63a79e00946df8ce7f53c605fe` and the npm package carrying version `0.83.0` expose slightly different names. ProofBlade targets the installed npm surface (`JsonlSessionRepo`) and protects session reopen behavior with an adapter contract test. Source commit and tarball integrity are recorded in `package-manifest.lock.json`.
