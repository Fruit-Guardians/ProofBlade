# Task contract

`TaskContract` is immutable for the life of a run. It records the target, objective, success criteria, verification mode, scope, pause policy and budgets. A model can propose clarification, but it cannot mutate the contract or mark a run successful.

The reducer accepts a successful `run_finished` only when the payload contains `verified: true`. The command boundary additionally requires the verifier lane, an accepted completion, known evidence ids, at least one reproduction record and the task contract's configured evidence count. The demo uses a local reproduction verifier; workflow fixtures use the hidden scorer adapter.

The workflow fixtures use `verification.kind: "hidden_scorer"` and require two reproduction records. Their visible target files are separate from `.proofblade/scorer.json`. Web fixture files expose only route hints; candidate material is available only from the live local HTTP response. A completion proposal stores a candidate hash and sensitive artifact reference; the event stream does not contain the candidate text. A successful command is valid only when it comes from the verifier lane, references an accepted completion and includes the required evidence records.

`scope.allowed_hosts` and `scope.allowed_ports` define the network boundary, while `scope.external_network` decides whether non-local traffic is permitted. `LOCAL_FIXTURE` authorizes only the host-managed ephemeral endpoint for the current Fixture generation, so a random local port does not have to be written into the immutable contract. The model supplies an origin-relative path and cannot choose another origin.

ProofBlade currently ships three synthetic live-HTTP Web profiles and three synthetic Reverse profiles. `proofblade fixtures` lists their public metadata without exposing scorer values.
