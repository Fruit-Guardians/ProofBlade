# ProofBlade / 证锋

[中文](README.md)

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
- Budgeted six-layer context manifests, standing-instruction/task-memory separation, staged 50/60/80/90% maintenance, artifact head/tail retrieval, tool-pair repair, idle compaction, mechanical checkpoints and overflow recovery.
- Pi JSONL Session adapter that is activated when a configured model is available.
- Stable capability catalog with canonical hashes, journaled `invoke_capability`, and durable cancellable background jobs.
- Project Skill Registry with resident ContextManifest metadata and on-demand bodies through `load_skill` or native Pi Skill turns.
- Project MCP stdio with `.mcp.json`, lazy discovery, capability mapping, effect journaling, redaction and process cleanup.
- Full Tool Contract hashes covering versions, timeouts, resource keys, sensitivity and replay policy; failures return structured errors with Pi `isError` semantics.
- Durable run telemetry for Provider/Tool/Effect metrics, cost and cache tokens, primary failure classification, and Prompt/Tool/Skill/MCP/Runtime version snapshots.
- Recovery for all six fault windows, including expired-lease reaping, Fixture lifecycle reconciliation, old-generation Effect isolation, Tool-batch repair, and two-phase Pi compaction.
- Deterministic planner lane with versioned planner-to-executor handoffs; stale plans are superseded before execution and the active handoff is indexed in context.
- Machine-readable six-fixture evaluation runner with success, evidence-backed, replay-parity and candidate-leak gates.

Provider, model, thinking level and OpenAI compatibility settings live in `proofblade.config.json`. The checked-in profile uses `model: "auto"` to discover the active LM Studio chat model; other Providers may configure `thinkingLevel`, `reasoning`, `supportsReasoningEffort` and `maxTokensField`. API keys are read only from the environment variable named by `apiKeyEnv`, and source code contains no concrete model id. Pi 0.83.0 declares Node.js 22.19 or newer.

## Quick start

```powershell
npm install
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- fixtures
npm run cli -- solve web-source-1 WEB-001 auto 2
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- cost DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm test
npm run test:atoms
npm run test:molecules
npm run eval
```

Runs and artifacts are written below `runs/`. Downloads and source snapshots belong in `tmp/`; the repository ignores that directory by default.

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade eval [--attempts N] [--max-turns N] [--run-prefix ID]
proofblade capabilities
proofblade mcp [list|describe|call] [run-id] [server] [tool] [json-arguments]
proofblade skills [list|show] [skill-name] [max-chars]
proofblade skill <run-id> <skill-name> [additional instructions]
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id>
proofblade reconcile <run-id>
proofblade cost <run-id>
proofblade checkpoint <run-id> [reason]
proofblade compact <run-id> [reason]
proofblade history <run-id> <query>
proofblade handoff <run-id> [show|prepare]
proofblade jobs <run-id> [list|recover|read|stop] [job-id] [max-chars]
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

## Extension paths

- Add business-agnostic primitives to `packages/atoms`.
- Add generic acquisition, processing or transport compositions to `packages/molecules`.
- Add journaled ProofBlade tools and capability adapters to `packages/materials`.
- Connect isolated local services through project-level `.mcp.json` configuration.
- Put on-demand procedures and domain knowledge in `skills/<name>/SKILL.md`.

Built-in tools, the Capability Router, the Effect Journal, the project Skill Registry and MCP stdio are implemented. Skill and MCP metadata enter the ContextManifest while full instructions and tool schemas load on demand. MCP calls follow the same `Tool -> Capability Router -> Effect Journal -> Artifact/Evidence` audit path. See `docs/extensions.md` for implementation status, contracts, examples and the verification checklist.

See `docs/architecture.md`, `docs/task-contract.md`, `docs/tool-contract.md`, `docs/eval-protocol.md`, `docs/recovery.en.md`, and `pi-ctf-agent-harness-design.md` for the implemented contracts and design basis.
