# Evaluation protocol

The baseline is deterministic and offline. A fixture is reset before each run, the event stream is replayed from zero, and the projection hash must match. Add live provider evaluations only after the adapter contract tests pass.

The durability suite injects failure immediately after effect proposal, start, execution and artifact persistence. Every replayable case must converge to one finished effect with one registered result artifact. It also checks concurrent event sequence allocation, lease ownership and fixture generation persistence.

The interruption suite covers the six design windows explicitly: start-before-launch, artifact-before-finish, assistant-before-preflight, a partially completed parallel Tool batch, checkpoint-before-Pi-append, and heartbeat/Fixture loss. It asserts fenced lease reaping, old-generation isolation, legal Tool pairs in original call order, one Pi compaction entry, retained Facts, no active stale jobs, and an unchanged projection hash after a second recovery pass. The complete matrix is in `docs/recovery.en.md` and `docs/recovery.md`.

The workflow suite runs all six local profiles through the same Tool Runtime, Observer, phase machine and verifier used by the Pi lane. A deterministic lane replaces only provider decisions so the suite remains stable. It asserts two reproduction records, one accepted completion, a final report and absence of candidate plaintext from the event log. A separate grounding test rejects fabricated candidates, and an Assist test resumes a durable proposal without another model turn.

The context suite forces a 20%-of-normal window and checks that confirmed facts and rejected hypotheses remain in the manifest, old tool exchanges are pruned as pairs, and artifact retrieval is bounded. It also reopens a mechanical checkpoint, verifies prompt-injection text stays inside an untrusted observation tag, and injects two context overflows to assert one recovery followed by explicit `context_overflow` failure.

The capability/job suite checks that manifest and core solver-tool hashes are stable, unknown operations and escaping paths fail closed, target capability results produce artifact/evidence anchors, and output tiers are bounded. It runs background list/delay jobs through success, timeout, cancellation and durable recovery, then compares the replayed job projection with the persisted snapshot.

The handoff suite checks planner/executor lane gates, knowledge-version invalidation, deterministic supersession, context handoff indexing and replay parity. The workflow suite also prepares an accepted handoff before each executor turn without adding a second model request.

The evaluation runner uses the same deterministic lane across all six fixtures. A case passes only when it reaches verifier-gated `SUCCEEDED/report`, has the required reproduction evidence, matches the replayed projection hash, and keeps the expected candidate out of the event log. The JSON report includes per-case timing and a `reportHash` for CI or pre-push comparison.

Each run also carries a hashed Prompt/Tool/Skill/MCP/Runtime version snapshot. Provider-backed runs append per-request usage and latency events, while Tool and Effect events retain timing, byte counts, error signatures and evidence contribution without raw arguments. `proofblade cost RUN` produces a deterministic telemetry report with cost/cache totals, p95 Provider latency, effective action ratio, time to first evidence and one primary terminal failure category.

Useful commands:

```text
proofblade run demo
proofblade replay DEMO-001
proofblade cost DEMO-001
proofblade ledger DEMO-001
proofblade fixtures
npm run eval
proofblade solve web-source-1 --run-id WEB-001 --mode auto --max-turns 2
proofblade checkpoint WEB-001 manual
proofblade compact WEB-001 manual
proofblade history WEB-001 CP
proofblade capabilities
proofblade handoff WEB-001 show
proofblade jobs WEB-001 list
npm run test:atoms
npm run test:molecules
npm test
```
