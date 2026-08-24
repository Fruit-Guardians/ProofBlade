# Evaluation protocol

The baseline is deterministic and offline. A fixture is reset before each run, the event stream is replayed from zero, and the projection hash must match. Add live provider evaluations only after the adapter contract tests pass.

The durability suite injects failure immediately after effect proposal, start, execution and artifact persistence. Every replayable case must converge to one finished effect with one registered result artifact. It also checks concurrent event sequence allocation, lease ownership and fixture generation persistence.

The interruption suite covers the six design windows explicitly: start-before-launch, artifact-before-finish, assistant-before-preflight, a partially completed parallel Tool batch, checkpoint-before-Pi-append, and heartbeat/Fixture loss. It asserts fenced lease reaping, old-generation isolation, legal Tool pairs in original call order, one Pi compaction entry, retained Facts, no active stale jobs, and an unchanged projection hash after a second recovery pass. The complete matrix is in `docs/recovery.en.md` and `docs/recovery.md`.

The workflow suite runs all six local profiles through the same Tool Runtime, Observer, phase machine and verifier used by the Pi lane. A deterministic lane replaces only provider decisions so the suite remains stable. It asserts two reproduction records, one accepted completion, a final report and absence of candidate plaintext from the event log. A separate grounding test rejects fabricated candidates, and an Assist test resumes a durable proposal without another model turn.

The context suite forces a 20%-of-normal window and checks that confirmed facts and rejected hypotheses remain in the manifest, old tool exchanges are pruned as pairs, and artifact retrieval is bounded. It also reopens a mechanical checkpoint, verifies prompt-injection text stays inside an untrusted observation tag, and injects two context overflows to assert one recovery followed by explicit `context_overflow` failure.

The capability/job suite checks that manifest and core solver-tool hashes are stable, unknown operations and escaping paths fail closed, target capability results produce artifact/evidence anchors, and output tiers are bounded. It runs background list/delay jobs through success, timeout, cancellation and durable recovery, then compares the replayed job projection with the persisted snapshot.

The handoff suite checks planner/executor lane gates, knowledge-version invalidation, deterministic supersession, context handoff indexing and replay parity. The workflow suite also prepares an accepted handoff before each executor turn without adding a second model request.

The local holdout runner uses the same deterministic lane across all 27 checked-in cases (12 Web, 12 Pwn, and one each for Reverse, Crypto and Forensics; Forensics uses the `misc` wire kind). Provider-backed evaluation repeats every corpus case three times by default. A case passes only when it reaches verifier-gated `SUCCEEDED/report`, has the required reproduction evidence, matches the replayed projection hash, and keeps the expected candidate out of the event log.

Schema version 3 includes aggregate duration (total/average/p95), Provider requests, tokens, cost per solve, Effect counts, evidence-producing action ratio, time to first evidence, confirmed-Fact evidence coverage and primary failure-category counts. It also records a canonical snapshot of the selected Fixture Catalog: target kind, description hash, expected-value hash and path-sorted input-file hashes. The Catalog snapshot exposes no expected plaintext. The deterministic lane does not emit Pi Tool calls, so its effective action ratio is derived from Effects referenced by Evidence. Provider-backed evaluation can retain the same report fields while supplying real token and cost values.

When a deadline or Provider error interrupts a lane before it returns its normal outcome, the evaluator counts durable executor `work_item_claimed` events so an already-started model turn is not reported as zero. This keeps deadline/budget tuning data aligned with the replayable WorkItem graph.

Live reports also include replay-derived Provider diagnostics: request and completed-request counts, token totals, Evidence count and phase list per executor turn, aggregate requests by phase, the phase where first Evidence appeared, and whether the deadline arrived before completion. These fields make a budget failure actionable without retaining prompts, tool arguments, candidate plaintext or provider response bodies.

The provider-backed machine-readable gate requires two or more variants, exact coverage of every corpus case for every requested attempt, the configured minimum success rate, baseline regression protection, bounded case cost, and zero candidate leaks. The checked-in local gate intentionally uses one attempt and a 100% minimum success rate because it is a deterministic framework/replay check. Fixture ids are deduplicated and sorted before execution so equivalent sets produce the same case order. The report records the per-case turn budget and canonical Fixture Catalog hash and includes both in the stable hash. The hash excludes run ids, wall-clock timing and raw error text so equivalent runs can be compared across machines while different budgets or Fixture contents remain distinguishable. It retains behavioral counters, gate results and stable per-case outcomes. Failures that have no Control/Telemetry classification are reported as `unclassified`; they are not inferred to be permission or environment failures.

`proofblade eval` prints a report even when the gate fails, which permits intentional fixture subsets during development. `proofblade eval --enforce-gate` also exits nonzero on a failed gate. The root `npm run verify` command uses enforcement and is the merge-time baseline check.

The 27-case multi-direction corpus is available through `proofblade eval-holdout`; it uses the deterministic provider-free lane and is a framework/replay gate, not a model-intelligence score. Use `eval-real` only with explicit Provider credentials and budgeted variants. Its live gate requires at least 20 cases and each Variant to emit Provider telemetry, so a tiny corpus or provider-free fallback cannot be reported as a real-model pass. Historical summaries can be anonymized with the exported evaluation replay helper before sharing.

Each run also carries a hashed Prompt/Tool/Skill/MCP/Runtime version snapshot. Provider-backed runs append per-request usage and latency events, while Tool and Effect events retain timing, byte counts, error signatures and evidence contribution without raw arguments. `proofblade cost RUN` produces a deterministic telemetry report with cost/cache totals, p95 Provider latency, effective action ratio, time to first evidence and one primary terminal failure category.

Useful commands:

```text
proofblade run demo
proofblade replay DEMO-001
proofblade cost DEMO-001
proofblade run-anonymize DEMO-001
proofblade ledger DEMO-001
proofblade fixtures
proofblade eval-holdout fixtures/holdout/manifest.json --enforce-gate
npm run eval
npm run eval -- --enforce-gate
proofblade solve web-source-1 --run-id WEB-001 --mode auto --max-turns 2
proofblade checkpoint WEB-001 manual
proofblade compact WEB-001 manual
proofblade history WEB-001 CP
proofblade capabilities
proofblade handoff WEB-001 show
proofblade jobs WEB-001 list
proofblade competition-api inspect runs/competition-api-<timestamp>.jsonl
# requests.json contains the exact non-secret request sequence and candidate supplied for replay
proofblade competition-api replay runs/competition-api-<timestamp>.jsonl --script requests.json
npm run test:atoms
npm run test:molecules
npm test
```
