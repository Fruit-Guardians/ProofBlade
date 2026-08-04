# Evaluation protocol

The baseline is deterministic and offline. A fixture is reset before each run, the event stream is replayed from zero, and the projection hash must match. Add live provider evaluations only after the adapter contract tests pass.

The durability suite injects failure immediately after effect proposal, start, execution and artifact persistence. Every replayable case must converge to one finished effect with one registered result artifact. It also checks concurrent event sequence allocation, lease ownership and fixture generation persistence.

The workflow suite runs all six local profiles through the same Tool Runtime, Observer, phase machine and verifier used by the Pi lane. A deterministic lane replaces only provider decisions so the suite remains stable. It asserts two reproduction records, one accepted completion, a final report and absence of candidate plaintext from the event log. A separate grounding test rejects fabricated candidates, and an Assist test resumes a durable proposal without another model turn.

Useful commands:

```text
proofblade run demo
proofblade replay DEMO-001
proofblade ledger DEMO-001
proofblade fixtures
proofblade solve web-source-1 --run-id WEB-001 --mode auto --max-turns 2
npm run test:atoms
npm run test:molecules
npm test
```
