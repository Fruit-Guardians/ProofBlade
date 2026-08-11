# Real Model Evaluation

`eval-real` compares two or more configured providers on one private local corpus. It never runs in CI and requires `--allow-live` because it sends real Provider requests.

Keep the corpus, samples, and expected values under `.proofblade/evaluation/`; that directory is ignored by Git. Copy `examples/real-evaluation-corpus.example.json` there, replace every placeholder, and calculate each sample hash in PowerShell:

```powershell
(Get-FileHash .\samples\pe-check-1\challenge.exe -Algorithm SHA256).Hash.ToLower()
```

Each corpus file path is relative to the Manifest directory. The loader rejects absolute paths, directory escapes, symlinks, files over 128 MiB, and hash mismatches. Every evaluation attempt copies the verified files into a fresh Fixture; the expected value is only written to that Fixture's private scorer.

Create one ordinary ProofBlade config per provider/model. API keys remain environment variables referenced by each config. Real evaluation requires a published USD token price for every Variant; without it, `eval-real` refuses to start. Prices are per one million tokens and should include the Provider's cache-read and cache-write rates when it reports them:

```json
{
  "modelProfiles": {
    "executor": {
      "pricing": {
        "inputUsdPerMillion": 0.28,
        "outputUsdPerMillion": 0.42,
        "cacheReadUsdPerMillion": 0.028,
        "cacheWriteUsdPerMillion": 0.28
      }
    }
  }
}
```

`--max-cost-usd` is enforced per Run, not merely reported afterwards. Before each Provider request, ProofBlade reserves the maximum charge permitted by that model's context window and output limit. If the next reservation would exceed the cap, no HTTP request is sent. Requests already in flight receive the Run deadline through their abort signal. Provider-internal retries are disabled for these budgeted requests, because every retry is a separate potential charge. A Provider that omits usage is charged the reserved maximum, so incomplete billing metadata cannot make a comparison look free. On pause or process restart, the budget is rebuilt from persisted provider telemetry; a started request without terminal usage retains its full reservation.

When `--enforce-gate` is present, every Variant must reach `--min-success-rate` (default `0.5`). The selected `--baseline ID` defaults to the first canonical Variant id, and every other Variant may trail it by at most `--max-success-rate-drop` (default `0.1`). Set a rate to `0` only for exploratory reports where that corresponding gate should not constrain the comparison.

Run prefixes and corpus case ids must be safe Run ID segments (`[A-Za-z0-9][A-Za-z0-9._-]{0,95}`); this keeps Fixture staging within the configured Fixture root. Then run a paired comparison:

```powershell
npm run cli -- eval-real .proofblade/evaluation/corpus.json --allow-live `
  --variant deepseek=.proofblade/evaluation/deepseek.config.json `
  --variant gpt=.proofblade/evaluation/gpt.config.json `
  --attempts 3 --max-turns 12 --max-cost-usd 5 `
  --min-success-rate 0.5 --baseline deepseek --max-success-rate-drop 0.1 --enforce-gate
```

The report contains one section per Variant plus paired success-rate, cost, and p95-latency deltas. Its stable hash binds the corpus content hashes, expected-value hashes, selected model configuration fingerprints, budgets, and behavioral results. Wall-clock durations remain visible but are deliberately excluded from the stable hash.
