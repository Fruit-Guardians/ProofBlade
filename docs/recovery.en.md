# Interruption recovery protocol

ProofBlade treats recovery as deterministic Orchestrator work. `RunRecoveryService` reaps expired leases, checks the Fixture lifecycle, advances the generation when rebuilding, reconciles stale jobs, and then coordinates unfinished Effects. `proofblade reconcile RUN_ID` uses this same path.

## Six fault windows

| # | Interruption window | Recovery | Required invariant |
| --- | --- | --- | --- |
| 1 | After `effect_started`, before execution | Replay eligible work under the original effect id | One Effect; a second recovery is a no-op |
| 2 | After artifact registration, before `effect_finished` | Adopt the artifact and finish the Effect | No repeated execution or duplicate artifact |
| 3 | After an assistant Tool call reaches Pi Session, before preflight | Insert a deterministic error Tool result in the Provider view | Every call has one adjacent result |
| 4 | After part of a parallel Tool batch completes | Keep completed results, fill missing results, restore original call order | No missing, orphaned, duplicated, or misplaced result |
| 5 | After checkpoint persistence, before Pi Session append | Reuse the same checkpoint and append one compaction entry | Facts survive and no duplicate summary is generated |
| 6 | After lease heartbeat loss or unexpected Fixture disappearance | Reap the lease, rebuild with a newer generation, mark stale work `UNKNOWN` | No active stale lease/job and no old-generation replay |

Executable coverage lives in `packages/materials/tests/interruption-recovery.test.ts`. Each scenario also proves convergence by running recovery again and checking that the projection hash remains unchanged.

## Commit boundaries

Effect results cross a durable artifact barrier before `effect_finished`. Reconciliation adopts an artifact with the matching `sourceEffectId`. An in-flight Effect whose argument generation differs from the current Run generation becomes `UNKNOWN`, including otherwise pure work.

Lease release carries owner and generation fencing. Expired leases reject late heartbeats. Fixture health distinguishes `healthy`, `missing`, `unhealthy`, and `generation-drift`; rebuilding always advances beyond the recorded generation.

`DurableCompactionCoordinator` runs from Pi's `session_before_compact` hook. It persists a mechanical checkpoint first, then returns that exact content for Pi to append. A retry while the checkpoint is the latest domain event reuses its id and artifact.

`repairAgentMessages()` runs before every Provider context, independently of context pressure. `toolPairViolations()` detects missing, orphaned, duplicate, and misplaced Tool results. Repairs affect the Provider view while the original Pi Session and Control Store remain available for audit.
