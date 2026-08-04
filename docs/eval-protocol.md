# Evaluation protocol

The baseline is deterministic and offline. A fixture is reset before each run, the event stream is replayed from zero, and the projection hash must match. Add live provider evaluations only after the adapter contract tests pass.

Useful commands:

```text
proofblade run demo
proofblade replay DEMO-001
proofblade ledger DEMO-001
```
