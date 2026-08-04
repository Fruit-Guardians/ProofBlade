# ProofBlade / 证锋

ProofBlade is an evidence-driven CTF agent harness built on the Pi AgentHarness runtime. It keeps Pi sessions and the CTF control store separate, records every state transition as an append-only event, and makes completion a verifier-gated decision.

## Current scope

- Pi `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` locked to `0.83.0`.
- Four-level dependency funnel: reusable atoms, generic molecules, ProofBlade materials and the delivery CLI.
- JSONL Control Store with deterministic replay and projection hashing.
- Single-writer event sequencing, durable atomic projections and crash-recoverable effect journaling.
- Run/phase state machine, facts, evidence, hypotheses, intents, leases, fixture generations and immutable artifacts.
- Six-layer context compiler with deterministic manifests and untrusted-observation boundaries.
- Model-driven single-agent Drive Loop with Auto and Assist execution modes.
- Deterministic Observer, grounded completion proposals and an independent hidden-scorer verifier.
- Six local workflow fixtures: three synthetic Web tasks and three synthetic Reverse tasks.
- Budgeted six-layer context manifests, artifact head/tail retrieval, mechanical checkpoints and overflow recovery.
- Pi JSONL Session adapter that is activated when a configured model is available.

Provider and model selection live in `proofblade.config.json`. The checked-in profile uses `model: "auto"` to discover the active LM Studio chat model; source code contains no concrete model id. Pi 0.83.0 declares Node.js 22.19 or newer.

## Quick start

```powershell
npm install
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- fixtures
npm run cli -- solve web-source-1 WEB-001 auto 2
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm test
npm run test:atoms
npm run test:molecules
```

Runs and artifacts are written below `runs/`. Downloads and source snapshots belong in `tmp/`; the repository ignores that directory by default.

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id>
proofblade reconcile <run-id>
proofblade checkpoint <run-id> [reason]
proofblade compact <run-id> [reason]
proofblade history <run-id> <query>
proofblade artifact <run-id> <artifact-id> [max-chars]
proofblade fixture-build <run-id>
proofblade fixture-reset <run-id>
proofblade fixture-score <run-id> <candidate>
proofblade agent <run-id> [prompt]
```

## Package funnel

```text
apps/cli                     user intent and delivery
   -> packages/materials     ProofBlade, CTF, Pi and provider knowledge
      -> packages/molecules  generic acquisition/processing composition
         -> packages/atoms   minimal types, values and storage primitives
```

Imports only point downward in this diagram. Each package adds information instead of changing lower-level contracts. `atoms` and `molecules` have independent build and test commands, so deleting every layer above either package does not prevent that package from working.

See `docs/architecture.md`, `docs/task-contract.md`, `docs/tool-contract.md`, and `docs/eval-protocol.md` for the implemented contracts.
