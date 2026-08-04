# ProofBlade architecture

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

The first implementation uses one JSONL file per run. `replay` rebuilds the snapshot from events and compares its canonical hash with the persisted projection hash. This gives a storage-independent contract before a SQLite adapter is introduced.

## Pi 0.83.0 package note

The GitHub snapshot at commit `0524d6897f171d63a79e00946df8ce7f53c605fe` and the npm package carrying version `0.83.0` expose slightly different names. ProofBlade targets the installed npm surface (`JsonlSessionRepo`) and protects session reopen behavior with an adapter contract test. Source commit and tarball integrity are recorded in `package-manifest.lock.json`.
