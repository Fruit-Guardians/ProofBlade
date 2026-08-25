# Real Model Evaluation

`eval-real` compares two or more configured providers on one private local corpus. It never runs in CI. Use `--preflight` first to validate the corpus, Web/Pwn coverage, priced variants, credential environment variables, and budget without creating a Run or sending a Provider request; the actual comparison requires `--allow-live`.

The CLI's live gate also requires observable Provider traffic from every Variant, at least 20 corpus cases, and both Web and Pwn target kinds. A deterministic injected lane, a tiny corpus, or a run that fails before the first Provider request cannot satisfy `eval-real --enforce-gate`, even if it produces a locally accepted candidate. The provider-free local holdout explicitly disables these checks because its purpose is to exercise Run/verifier/replay plumbing.

Strict live preflight also rejects a case when its expected answer appears
literally in one of the target input files. Such a corpus can exercise the
control plane, but it cannot measure model solving ability; keep those cases in
the provider-free holdout or replace them with private, non-leaking inputs.

The checked-in multi-direction holdout is intentionally separate: `proofblade eval-holdout fixtures/holdout/manifest.json --enforce-gate` runs 27 deterministic cases without Provider traffic (12 Web, 12 Pwn, and Reverse/Crypto/Forensics smoke cases). It validates the shared Run, verifier, replay, and metric pipeline; it does not establish real model solving quality. Use `eval-real` for that measurement only after configuring two priced model variants.

Do not pass that checked-in holdout to strict `eval-real`: its expected literals
are intentionally present to make the provider-free plumbing lane deterministic,
so strict preflight rejects all of those cases. A live comparison must use a
private corpus whose target inputs do not contain their expected answers.

Keep the corpus, samples, and expected values under `.proofblade/evaluation/`; that directory is ignored by Git. Copy `examples/real-evaluation-corpus.example.json` there, replace every placeholder, and calculate each sample hash in PowerShell:

```powershell
(Get-FileHash .\samples\pe-check-1\challenge.exe -Algorithm SHA256).Hash.ToLower()
```

Each corpus file path is relative to the Manifest directory. The loader rejects absolute paths, directory escapes, symlinks, files over 128 MiB, and hash mismatches. Every evaluation attempt copies the verified files into a fresh Fixture; the expected value is only written to that Fixture's private scorer.

Create one ordinary ProofBlade config per provider/model. API keys remain environment variables referenced by each config. Real evaluation requires a published USD token price for every Variant; without it, `eval-real` refuses to start. Prices are per one million tokens and should include the Provider's cache-read and cache-write rates when it reports them:

Ready-to-copy config skeletons are available at `examples/real-evaluation-provider.openai.example.json` and `examples/real-evaluation-provider.anthropic.example.json`. For a single-key paired comparison, use `examples/real-evaluation-provider.deepseek-flash.example.json` and `examples/real-evaluation-provider.deepseek-pro.example.json`; both reference `PROOFBLADE_EVAL_DEEPSEEK_API_KEY` and the official OpenAI-compatible DeepSeek endpoint. The DeepSeek examples use the currently published peak rates as a conservative reservation (cache miss for input, cache hit for `cacheRead`, and zero `cacheWrite` because the published table has no separate write rate). Copy the selected files into the ignored `.proofblade/evaluation/` directory, replace the model names only if the Provider has changed them, verify the currently published prices, and export the referenced environment variables. Prices can change and the live run must be rechecked against the Provider's current pricing page.

The checked-in DeepSeek pair uses `deepseek-v4-flash` and `deepseek-v4-pro` with text input. DeepSeek's legacy `deepseek-chat` and `deepseek-reasoner` identifiers are not suitable for a new evaluation because the Provider scheduled them for retirement on 2026-07-24; consult the [official model list](https://api-docs.deepseek.com/api/list-models/) and [current pricing](https://api-docs.deepseek.com/quick_start/pricing/) before a live run. Do not advertise image support for these profiles unless the Provider's current API contract and a separate vision model are configured.

```json
{
  "modelProfiles": {
    "executor": {
      "pricing": {
        "inputUsdPerMillion": 0.44,
        "outputUsdPerMillion": 1.32,
        "cacheReadUsdPerMillion": 0.014,
        "cacheWriteUsdPerMillion": 0
      }
    }
  }
}
```

`--max-cost-usd` is enforced per Run, not merely reported afterwards. Before each Provider request, ProofBlade reserves the maximum charge permitted by that model's context window and output limit. If the next reservation would exceed the cap, no HTTP request is sent. Any Run with a positive `max_cost_usd` requires explicit positive input and output pricing; missing pricing fails closed before a Provider request. Requests already in flight receive the Run deadline through their abort signal. Provider-internal retries are disabled for these budgeted requests, because every retry is a separate potential charge. A Provider that omits usage is charged the reserved maximum, so incomplete billing metadata cannot make a comparison look free. On pause or process restart, the budget is rebuilt from persisted provider telemetry; a started request without terminal usage retains its full reservation.

When `--enforce-gate` is present, every Variant must reach `--min-success-rate` (default `0.5`). The selected `--baseline ID` defaults to the first canonical Variant id, and every other Variant may trail it by at most `--max-success-rate-drop` (default `0.1`). Set a rate to `0` only for exploratory reports where that corresponding gate should not constrain the comparison.

Run prefixes and corpus case ids must be safe Run ID segments (`[A-Za-z0-9][A-Za-z0-9._-]{0,95}`); this keeps Fixture staging within the configured Fixture root. First run the no-network preflight:

```powershell
npm run cli -- eval-real .proofblade/evaluation/corpus.json --preflight `
  --variant deepseek=.proofblade/evaluation/deepseek.config.json `
  --variant gpt=.proofblade/evaluation/gpt.config.json
```

`--preflight` reports only credential environment variable names and whether
they are present; it never prints their values. A normal `eval-real` invocation
repeats this check and refuses to start before any Provider request when it is
not ready. After it passes, run the paired comparison:

Never paste an API key into chat, an issue, a commit, a config file, or a
captured command log. If a key is exposed, revoke it at the Provider and create
a replacement before setting the environment variable locally. The two
DeepSeek example Variants intentionally reference one environment variable, so
one rotated key can authenticate both model profiles without duplicating the
secret.

```powershell
npm run cli -- eval-real .proofblade/evaluation/corpus.json --allow-live `
  --variant deepseek=.proofblade/evaluation/deepseek.config.json `
  --variant gpt=.proofblade/evaluation/gpt.config.json `
  --attempts 3 --max-turns 12 --max-cost-usd 5 `
  --min-success-rate 0.5 --baseline deepseek --max-success-rate-drop 0.1 --enforce-gate
```

The report contains one section per Variant plus paired success-rate, cost, and p95-latency deltas. Each Variant also exposes `categoryMetrics` keyed by the corpus `targetKind`, including success rate, Provider requests/tokens/cost, first-Evidence latency, repeated experiments, submissions, context tokens, and failure categories. Its stable hash binds the corpus content hashes, expected-value hashes, selected model configuration fingerprints, budgets, and behavioral results. Wall-clock durations and first-Evidence latency remain visible but are deliberately excluded from the stable hash.

For budget/deadline tuning, each case carries a replay-derived `providerDiagnostics` projection. It shows Provider requests and completed requests per durable executor turn, token totals, Evidence count, phases, aggregate requests by phase, the first-Evidence phase, the last Provider phase, and `deadlineBeforeCompletion`. Variant metrics expose first-turn request/token totals and the count of deadlines that arrived before completion. This is derived from the append-only event sequence and does not copy prompts or response bodies.
