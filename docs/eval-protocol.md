# Evaluation protocol

The baseline is deterministic and offline. A fixture is reset before each run, the event stream is replayed from zero, and the projection hash must match. Add live provider evaluations only after the adapter contract tests pass.

The durability suite injects failure immediately after effect proposal, start, execution and artifact persistence. Every replayable case must converge to one finished effect with one registered result artifact. It also checks concurrent event sequence allocation, lease ownership and fixture generation persistence.

Useful commands:

```text
proofblade run demo
proofblade replay DEMO-001
proofblade ledger DEMO-001
npm run test:atoms
npm run test:molecules
npm test
```
