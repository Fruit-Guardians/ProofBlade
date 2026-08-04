# ProofBlade / 证锋

ProofBlade is an evidence-driven CTF agent harness built on the Pi AgentHarness runtime. It keeps Pi sessions and the CTF control store separate, records every state transition as an append-only event, and makes completion a verifier-gated decision.

## Current scope

- Pi `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` locked to `0.83.0`.
- JSONL Control Store with deterministic replay and projection hashing.
- Run/phase state machine, facts, evidence, hypotheses, intents, effects, leases and immutable artifacts.
- Six-layer context compiler with deterministic manifests and untrusted-observation boundaries.
- Local fixture sandbox and a self-contained demo run.
- Pi JSONL Session adapter that is activated when a configured model is available.

Provider and model selection live in `proofblade.config.json`. The checked-in profile uses `model: "auto"` to discover the active LM Studio chat model; source code contains no concrete model id. Pi 0.83.0 declares Node.js 22.19 or newer.

## Quick start

```powershell
npm install
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm test
```

Runs and artifacts are written below `runs/`. Downloads and source snapshots belong in `tmp/`; the repository ignores that directory by default.

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id>
proofblade reconcile <run-id>
proofblade agent <run-id> [prompt]
```

See `docs/architecture.md`, `docs/task-contract.md`, `docs/tool-contract.md`, and `docs/eval-protocol.md` for the contracts implemented by this first milestone.
