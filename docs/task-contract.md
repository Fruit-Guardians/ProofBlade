# Task contract

`TaskContract` is immutable for the life of a run. It records the target, objective, success criteria, verification mode, scope, pause policy and budgets. A model can propose clarification, but it cannot mutate the contract or mark a run successful.

The reducer accepts `run_finished` only when the payload contains `verified: true` and at least one evidence id. The demo uses a local reproduction verifier; platform submission and hidden scorer adapters can implement the same gate later.
