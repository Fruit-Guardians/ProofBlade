# Tool contract

Every capability is wrapped as an effect:

1. Normalize arguments and compute an idempotency key.
2. Append `effect_proposed` and `effect_started`.
3. Execute through the sandbox adapter.
4. Persist stdout/stderr as an artifact with a SHA-256 digest.
5. Append `effect_finished` and derive evidence candidates.

Tool output is marked as an untrusted observation when it came from a target. It is never interpreted as a control command.
