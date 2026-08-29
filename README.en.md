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
- Provider-neutral stable-prefix cache fingerprints split reusable L0/L1 from dynamic L2-L5 in every ContextManifest.
- Reasonix-style append-only context keeps each Solver turn's changing state as a persisted suffix instead of rewriting the history prefix; `cacheRetention` remains configurable per model profile.
- Config-driven Coding `bash` output rewriting (`builtin | rtk`) preserves one Tool schema and records adapter version, command hashes, raw/visible bytes, measured reduction, and an Artifact reference.
- Model-driven single-agent Drive Loop with Auto and Assist execution modes.
- Deterministic Observer, grounded completion proposals and an independent hidden-scorer verifier.
- Six local workflow fixtures: three synthetic Web tasks and three synthetic Reverse tasks.
- Budgeted six-layer context manifests, standing-instruction/task-memory separation, staged 55/60/75/80/90% maintenance, artifact head/tail retrieval, tool-pair repair, idle compaction, mechanical checkpoints and overflow recovery.
- Pi JSONL Session adapter that is activated when a configured model is available.
- Stable capability catalog with canonical hashes, journaled `invoke_capability`, and durable cancellable background jobs.
- Project Skill Registry with resident ContextManifest metadata and on-demand bodies through `load_skill` or native Pi Skill turns.
- Project MCP stdio with `.mcp.json`, lazy discovery, one stable `mcp_call` proxy, capability mapping, effect journaling, redaction and process cleanup.
- Full Tool Contract hashes covering versions, timeouts, resource keys, sensitivity and replay policy; failures return structured errors with Pi `isError` semantics.
- Durable run telemetry for Provider/Tool/Effect metrics, cost and cache tokens, primary failure classification, and Prompt/Tool/Skill/MCP/Runtime version snapshots.
- A conversational coding-agent GUI that streams the configured real model over SSE, renders text, thinking and Tool lifecycle events live, and opens each call into correlated Pi/Control JSON and browser-Worker processing.
- Recovery for all six fault windows, including expired-lease reaping, Fixture lifecycle reconciliation, old-generation Effect isolation, Tool-batch repair, and two-phase Pi compaction.
- Deterministic planner lane with versioned planner-to-executor handoffs; stale plans are superseded before execution and the active handoff is indexed in context.
- Machine-readable `baseline-v3` evaluator that runs all six fixtures three times by default and adds 12 provider-free runtime scenarios, aggregates latency, tokens, cost, effective actions, first-evidence time, Fact evidence coverage and replay parity, and binds the stable report hash to canonical Fixture/Scenario Catalog snapshots and the execution budget.

Base Provider, model, thinking-level, and OpenAI compatibility settings live in `proofblade.config.json`. The checked-in profile uses `model: "auto"` to discover the active LM Studio chat model; other Providers may configure `thinkingLevel`, `reasoning`, `supportsReasoningEffort`, and `maxTokensField`. The CLI reads the environment variable named by `apiKeyEnv`. The GUI manages multiple relay or local-model profiles and lets each conversation select its provider, model, and thinking level. Profiles and keys stay in the user's `.proofblade/gui-provider.json`; folders and conversation preferences stay in `.proofblade/gui-workspace.json`. Neither file enters the repository, and API responses never expose key values. Pi 0.83.0 declares Node.js 22.19 or newer.

## Quick start

```powershell
npm ci
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- fixtures
npm run cli -- solve web-source-1 WEB-001 auto 2
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- cost DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm run gui -- --port 4173
npm test
npm run test:atoms
npm run test:molecules
npm run eval
```

Start from a clean checkout with `npm ci`; it installs exactly what `package-lock.json` records. When dependencies change, commit both `package.json` and the lockfile, then run `npm run verify` before merging.

Runs and artifacts are written below `runs/`. Downloads and source snapshots belong in `tmp/`; the repository ignores that directory by default.

## Project plans and maintenance status

`project-status.json` is the single source for current plans, update history, completion results, and maintenance work. It deterministically generates four reports:

- `docs/project/PLAN.md` lists priorities, dependencies, progress, deliverables, and acceptance criteria;
- `docs/project/UPDATE_LOG.md` records what changed, the related plans, branch, commit, and validation;
- `docs/project/COMPLETION_REPORT.md` records completed plans, actual deliverables, and verification evidence;
- `docs/project/MAINTENANCE_REPORT.md` records maintenance work and summarizes version and audit metadata for all 25 components.

```powershell
npm run reports:project
npm run check:project-reports
```

Do not edit generated Markdown directly. `npm run verify` rejects stale reports, and CI requires meaningful changes to add an update-log entry in `project-status.json`.

## Live debugging GUI

```powershell
npm run gui -- --port 4173
npm run gui -- --config proofblade.config.json --port 4173
```

Open `http://127.0.0.1:4173`; the default view is the Agent conversation. "New conversation" accepts or browses to an absolute working directory and creates an ordinary coding-agent session with no Fixture. Every turn starts its Coding Lane in that directory, with `read`, `bash`, `edit`, and `write` available on demand. "Fixture test" remains a separate entry point for interactive debugging or automatic execution. Text, thinking, and Tool lifecycle events render while the turn is running, then the durable Pi Session replaces the temporary stream.

The gear button opens the relay and model manager. It can create multiple OpenAI-compatible profiles, each with its own name, Base URL, API key, optional proxy URL, discovered model list, and default thinking level. Model discovery and real conversations share the profile proxy. On Windows, the local file defaults to `%USERPROFILE%\.proofblade\gui-provider.json`. API responses expose only `hasApiKey`, never the key value. The controls below the composer switch provider, model, and thinking level per conversation.

Conversations can be grouped into custom folders, filtered from the sidebar, and switched to another working directory below the composer. The capability dialog lists built-in Tools, Skills, and MCP servers and persists a separate enabled set for each conversation. The `load_skill` and `mcp_call` schemas remain present and stable; the enabled sets enforce which resources they may access at execution time. Working directory, folder, and conversation settings live in `%USERPROFILE%\.proofblade\gui-workspace.json`.

The context panel separates provider-reported input, output, reasoning, cache-read, and cache-write tokens from the visible request estimate. Some relays report several thousand input tokens even for a tiny prompt because of gateway or model-template overhead. When the upstream response omits cache fields, the UI shows zero instead of estimating a cache hit.

Choose cache retention per Provider in the GUI: `short` (the default), `long` (request a stable session cache key and longer TTL), or `none`. Headless runs can set `modelProfiles.executor.cacheRetention` directly. Cache reporting remains provider-specific; each assistant turn shows prompt total, cache reads, and hit rate, while the metrics panel shows cumulative values.

The metrics panel also fingerprints the System/Developer instructions and Tool Schema from the final Provider payload without retaining prompt text. Prefix stability detects changes in instructions, tool names, ordering, schemas, or rewrite version; it does not claim an upstream cache hit. Actual hit rate remains `cacheRead / (input + cacheRead + cacheWrite)` from Provider usage. Read both together: a stable prefix with flat `cacheRead` points to relay/model cache behavior, while an unstable prefix reports `system`, `tools`, or `rewrite` as the change reason.

### RTK tool-output rewriting

The checked-in config requests [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk). With `fallback: "builtin"`, a missing binary or unmatched command retains Pi's existing behavior. Install RTK in the same shell used by Coding `bash`; when Pi selects WSL on Windows, verify it with `wsl rtk --version`, or set `rtkCommand` to a path executable from that shell.

```json
{
  "tools": {
    "outputRewrite": {
      "provider": "rtk",
      "rtkCommand": "rtk",
      "fallback": "builtin",
      "rewriteTimeoutMs": 5000,
      "maxRawBytes": 1048576
    }
  }
}
```

RTK wraps only ordinary Coding-Agent `bash`; `read/edit/write` and Solver Effect/Capability execution retain their existing paths. A Run uses one rewrite chain. When an RTK handler emits a tee capture, ProofBlade registers it as an Artifact before returning compact output. Handlers without a tee capture archive Pi's bounded visible output and record `rawCapture: "visible-output"`. Tool debug data exposes provider/version/hash, byte counts, measured reduction, and Artifact id under `details.outputRewrite`. This lowers dynamic Tool-result input on later turns; it does not directly raise Provider `cacheRead`.

- real-model multi-turn conversation, streaming output, and Tool calls inside assistant messages;
- readable Tool cards with the actual instruction/arguments, returned result, duration, and Artifact/Evidence/Effect references, with complete JSON one action away;
- a merged user/AI/Tool/Control execution trace plus dedicated Tool-result, structured-evidence, and artifact views for ordinary conversations;
- `Run -> Pi Session -> assistant turn -> Tool call` drill-down;
- tree and raw views for Arguments, Result, Pi Entry, Telemetry, and the complete correlated object;
- correlation of Pi and Control Store records by `toolCallId`, including Artifact, Evidence, and Effect references;
- a browser Web Worker Script Lab with JSON, table, and text result views;
- separate ordinary coding-agent and Fixture-test paths; both expose artifacts, while Fixture runs add recovery, checkpoints, and verification gates;
- multiple relay profiles, per-conversation model selection, conversation folders, and Tool/Skill/MCP switches;
- separate provider-token, visible-context, and cache-field accounting.

Script Lab receives the selected complete Tool debug object as `input`. Scripts return a value with normal JavaScript `return`, run for at most 1500 ms, and remain inside a temporary browser Worker. See `docs/gui.md` for the object shape and local API.

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade eval [--attempts N] [--max-turns N] [--run-prefix ID] [--enforce-gate]
proofblade doctor
proofblade capabilities
proofblade mcp [list|describe|call] [run-id] [server] [tool] [json-arguments]
proofblade skills [list|show] [skill-name] [max-chars]
proofblade skill <run-id> <skill-name> [additional instructions]
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id> [projection|protocol|tools|stats|shadow]
proofblade replay compare <baseline-run-id> <candidate-run-id>
proofblade reconcile <run-id>
proofblade cost <run-id>
proofblade checkpoint <run-id> [reason]
proofblade compact <run-id> [reason]
proofblade history <run-id> <query>
proofblade knowledge <run-id> [search|inspect] [query|pb://uri] [L0|L1|L2]
proofblade consolidate <run-id> [deduplicate|summarize|all]
proofblade handoff <run-id> [show|prepare]
proofblade jobs <run-id> [list|recover|monitor|read|stop] [job-id] [max-chars]
proofblade artifact <run-id> <artifact-id> [max-chars]
proofblade fixture-build <run-id>
proofblade fixture-reset <run-id>
proofblade fixture-score <run-id> <candidate>
proofblade agent <run-id> [prompt]
```

## Package funnel

```text
apps/cli + apps/gui          user intent, debugging and delivery
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

Every maintainable component has a versioned `COMPONENT.md`. See `docs/components.md` for the 25-component index and the enforced rule requiring a SemVer bump and updated timestamp whenever related source changes.

See `docs/architecture.md`, `docs/task-contract.md`, `docs/tool-contract.md`, `docs/eval-protocol.md`, `docs/recovery.en.md`, `docs/gui.md`, `docs/project/PLAN.md`, `docs/project/UPDATE_LOG.md`, `docs/project/COMPLETION_REPORT.md`, `docs/project/MAINTENANCE_REPORT.md`, and `pi-ctf-agent-harness-design.md` for the implemented contracts, current work, maintenance state, and design basis.
