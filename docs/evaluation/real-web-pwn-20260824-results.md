# Real Web/Pwn Evaluation Snapshot — 2026-08-24

This is a sanitized report derived from the local ignored evaluation snapshots
under `.proofblade/evaluation/real-web-pwn-20260824-profile-*.json`. It records
metrics only; it does not include flags, sample contents, absolute paths, API
keys, prompts, or Provider response bodies.

Each snapshot uses the `real-model-eval-v2` protocol and the same 24-case
private corpus: 12 Web cases and 12 Pwn cases. Every Variant made observable
Provider requests, every case had `replayParity=true`, and no case reported a
candidate leak. The snapshots therefore validate the live evaluation and
replay pipeline, while the success-rate spread shows that one run is not a
stable model-quality estimate.

| Snapshot | Variant | Overall | Web | Pwn | Provider requests | Provider tokens | Budget-exhausted cases | Avg. first Evidence (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| profile-rerun | dasctf-deepseek | 6/24 (25.0%) | 3/12 | 3/12 | 201 | 2,235,021 | 18 | 3,817 |
| profile-rerun | default | 16/24 (66.7%) | 6/12 | 10/12 | 209 | 2,756,316 | 8 | 2,798 |
| profile-latest | dasctf-deepseek | 8/24 (33.3%) | 5/12 | 3/12 | 177 | 1,922,507 | 16 | 4,368 |
| profile-latest | default | 13/24 (54.2%) | 7/12 | 6/12 | 187 | 1,938,427 | 11 | 3,637 |
| profile-escape | dasctf-deepseek | 5/24 (20.8%) | 2/12 | 3/12 | 179 | 2,274,923 | 19 | 4,184 |
| profile-escape | default | 7/24 (29.2%) | 6/12 | 1/12 | 205 | 2,295,158 | 17 | 3,199 |

## Interpretation

- The framework invariants hold across all six Variant snapshots: Provider
  traffic is observable, successful cases are Evidence-backed, replay parity is
  preserved, and candidate leakage is zero.
- The current model/profile choice is a larger factor than the framework
  overhead. The same 24-case corpus ranges from 20.8% to 66.7% across the
  snapshots, so a single run must not be used to claim a general capability
  improvement.
- Pwn is the main weakness for the `default` Variant in the latest snapshot
  (6/12), while `dasctf-deepseek` remains low on both directions (3/12 and
  5/12). The dominant non-success outcome is budget exhaustion, not replay or
  verifier corruption.
- The next useful experiment is a fixed corpus/profile/turn budget with at
  least three attempts per Variant, followed by a controlled comparison of
  preflight/tool-profile changes. Planner/Refiner model calls should remain
  disabled until that comparison demonstrates a durable gain.

This report is intentionally not a CI fixture. The corpus and raw run reports
remain local and ignored; publish only a similarly sanitized aggregate after
review.
