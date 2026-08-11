# Real Model Evaluation

`eval-real` compares two or more configured providers on one private local corpus. It never runs in CI and requires `--allow-live` because it sends real Provider requests.

Keep the corpus, samples, and expected values under `.proofblade/evaluation/`; that directory is ignored by Git. Copy `examples/real-evaluation-corpus.example.json` there, replace every placeholder, and calculate each sample hash in PowerShell:

```powershell
(Get-FileHash .\samples\pe-check-1\challenge.exe -Algorithm SHA256).Hash.ToLower()
```

Each corpus file path is relative to the Manifest directory. The loader rejects absolute paths, directory escapes, symlinks, files over 128 MiB, and hash mismatches. Every evaluation attempt copies the verified files into a fresh Fixture; the expected value is only written to that Fixture's private scorer.

Create one ordinary ProofBlade config per provider/model. API keys remain environment variables referenced by each config. Then run a paired comparison:

```powershell
npm run cli -- eval-real .proofblade/evaluation/corpus.json --allow-live `
  --variant deepseek=.proofblade/evaluation/deepseek.config.json `
  --variant gpt=.proofblade/evaluation/gpt.config.json `
  --attempts 3 --max-turns 12 --max-cost-usd 5 --enforce-gate
```

The report contains one section per Variant plus paired success-rate, cost, and p95-latency deltas. Its stable hash binds the corpus content hashes, expected-value hashes, selected model configuration fingerprints, budgets, and behavioral results. Wall-clock durations remain visible but are deliberately excluded from the stable hash.
