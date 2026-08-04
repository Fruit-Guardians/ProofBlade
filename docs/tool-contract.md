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

The Pi solver lane exposes eight sequential tools:

| Tool | Information role |
| --- | --- |
| `inspect_target` | Acquire every visible synthetic target file through one zero-argument, journaled effect. |
| `propose_intent` | Propose and deduplicate an evidence-seeking action. |
| `propose_hypothesis` | Process observations into a falsifiable statement linked to evidence ids. |
| `propose_fact` | Propose a ledger fact; it remains unconfirmed until verifier action. |
| `submit_candidate` | Transmit one observed `PB{...}` value as a completion proposal. |
| `read_artifact` | Retrieve a bounded head/tail window from a referenced immutable artifact. |
| `search_history` | Query durable facts, hypotheses, observations, evidence and checkpoints by id or text. |
| `report_status` | Read authoritative phase, ids, proposals and remaining budget. |

`submit_candidate` checks the exact candidate against successful current-generation observation artifacts before writing a proposal. It returns a hash and completion id to the model and requests early turn termination. Hidden scoring is not model-visible and executes as separate `fixture_score` effects.
