#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  contextText,
  CapabilityRegistry,
  CheckpointService,
  createServices,
  demoTask,
  JsonlControlStore,
  loadConfig,
  listFixtureProfiles,
  PiAgentLane,
  PiCodingLane,
  PlannerCoordinator,
  ProofBladeToolRuntime,
  ProofBladeSkillRegistry,
  ProofBladeToolCatalogRegistry,
  bootstrapToolCatalog,
  ToolPreflightService,
  securityToolProfiles,
  securityToolCatalogSpecs,
  McpProjectRegistry,
  listBundledCapabilities,
  projectionHash,
  runDemo,
  SingleAgentLoop,
  snapshotContext,
  FixtureEvaluationRunner,
  RealModelEvaluationRunner,
  preflightRealModelEvaluation,
  AblationExperimentStore,
  preflightAblationExperiment,
  validateAblationExperiment,
  AblationRunLedger,
  loadRealEvaluationCorpus,
  buildAblationReport,
  renderAblationReportZh,
  LocalHoldoutEvaluationRunner,
  anonymizeRunReplay,
  anonymizeEvaluationSummary,
  createProtocolReplay,
  replayProtocol,
  createToolReplay,
  replayTool,
  replayStats,
  compareReplayStats,
  shadowReplay,
  fixtureTask,
  CompetitionApiJournal,
  replayCompetitionApiScript,
  RunTelemetry,
  RunRecoveryService,
  RunCoordinator,
  CodingClaimVerifier,
  IndependentVerifier,
  IntentScheduler,
  LeaseManager,
  tryCreateConfiguredBrowserVerifierFactory,
  withBrowserResourceAdapter,
  tryCreateConfiguredSessionRuntimeBrokers,
  preflightConfiguredRuntimes,
  withSessionResourceAdapters,
} from "@proofblade/materials";
import type { CompetitionApiReplayStep, RunSnapshot } from "@proofblade/materials";

const root = resolve(process.cwd());

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const configPath = option(rawArgs, "--config") ?? "proofblade.config.json";
  const args = withoutOption(rawArgs, "--config");
  const [command = "help", arg, ...rest] = args;
  const config = await loadConfig(root, configPath);
  const authoritySecret = process.env.PROOFBLADE_CONTROL_AUTHORITY;
  const sessionRuntime = tryCreateConfiguredSessionRuntimeBrokers(config);
  const services = createServices(root, config, {
    ...(authoritySecret ? { authoritySecret } : {}),
    ...(sessionRuntime.brokers.length > 0 ? { sessionRuntimeBrokers: sessionRuntime.brokers } : {}),
    ...(sessionRuntime.configured ? { sessionRuntimeRequired: !sessionRuntime.tokenAvailable } : {}),
    ...(config.runtime.browserBroker ? { browserRuntimeRequired: true } : {}),
  });
  // Playwright is an optional verifier runtime. Missing package/binary keeps
  // browser reproduction disabled instead of weakening the trust boundary.
  const browserVerifierFactory = tryCreateConfiguredBrowserVerifierFactory(config);
  const recoveryAdapters = withSessionResourceAdapters(
    withBrowserResourceAdapter(services.externalResourceAdapters, browserVerifierFactory),
    services.sessionRuntimeBrokers ?? [],
  );
  switch (command) {
    case "doctor": {
      const tools = await ProofBladeToolCatalogRegistry.load(root);
      const mcp = McpProjectRegistry.load(root);
      const profile = config.modelProfiles.executor;
      const toolProbe = await tools.probe();
      const runtime = await preflightConfiguredRuntimes(config);
      const providerReady = Boolean(profile.provider && profile.baseUrl && profile.model && process.env[profile.apiKeyEnv]);
      print({
        node: process.version,
        projectRoot: root,
        configPath,
        provider: { provider: profile.provider, api: profile.api, model: profile.model, contextWindow: profile.contextWindow, apiKeyEnv: profile.apiKeyEnv },
        tools: { catalogHash: tools.catalogHash(), count: tools.list().length, diagnostics: [...tools.diagnostics, ...toolProbe] },
        mcp: { catalogHash: mcp.catalogHash(), servers: mcp.summaries().map((server) => ({ name: server.name, status: server.status, disabled: server.disabled, toolchain: server.toolchain?.state })) },
        runtime,
        ready: tools.diagnostics.length === 0 && toolProbe.length === 0 && providerReady && runtime.ready && mcp.summaries().every((server) => !["failed", "unavailable"].includes(server.status)),
      });
      await mcp.close();
      break;
    }
    case "init": {
      const runId = required(arg, "task id");
      const snapshot = await services.control.createRun(runId, demoTask(runId, root, config));
      print({ runId, status: snapshot.status, phase: snapshot.phase });
      break;
    }
    case "task": {
      const action = arg ?? "help";
      if (action === "templates") {
        print(listFixtureProfiles().map((profile) => ({ id: profile.id, targetKind: profile.targetKind, description: profile.description })));
        break;
      }
      if (action === "create") {
        const runId = required(rest[0], "task id");
        const templateId = option(rest, "--template") ?? (rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined);
        const template = required(templateId, "task template id");
        const task = fixtureTask(runId, template, root, config);
        const objective = option(rest, "--objective");
        if (objective?.trim()) task.objective = objective.trim();
        const snapshot = await services.control.createRun(runId, task);
        print({ runId, templateId: template, status: snapshot.status, phase: snapshot.phase });
        break;
      }
      const runId = required(rest[0], "run id");
      if (action === "status") {
        const snapshot = await services.control.snapshot(runId);
        print(taskStatus(snapshot));
        break;
      }
      if (action === "cancel") {
        const snapshot = await services.control.snapshot(runId);
        if (!["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) {
          await services.control.dispatch(runId, { type: "cancel", reason: rest.slice(1).join(" ").trim() || "Cancelled by user", lane: "main" });
        }
        print(taskStatus(await services.control.snapshot(runId)));
        break;
      }
      if (action === "run") {
        const modeValue = option(rest, "--mode") ?? "assist";
        if (modeValue !== "auto" && modeValue !== "assist") throw new Error("task run --mode must be auto or assist");
        const taskSnapshot = await services.control.snapshot(runId);
        const result = await new SingleAgentLoop(root, config, services, undefined, browserVerifierFactory).run({
          runId,
          task: taskSnapshot.task,
          mode: modeValue,
          maxTurns: parsePositiveOption(rest, "--max-turns"),
        });
        print(result);
        break;
      }
      throw new Error("task action must be templates, create, run, status, or cancel");
    }
    case "run": {
      if (arg !== "demo") throw new Error("The first fixture profile is named 'demo'");
      const runId = option(rest, "--run-id") ?? rest.find((value) => !value.startsWith("--")) ?? `DEMO-${Date.now()}`;
      const outcome = await runDemo(root, runId, config);
      print(outcome);
      break;
    }
    case "fixtures": {
      print(listFixtureProfiles().map((profile) => ({ id: profile.id, targetKind: profile.targetKind, description: profile.description })));
      break;
    }
    case "runtime": {
      if (arg !== "selfcheck") throw new Error("The runtime command only supports selfcheck");
      const report = await preflightConfiguredRuntimes(config);
      print(report);
      if (!report.ready) process.exitCode = 2;
      break;
    }
    case "eval": {
      const evalArgs = arg === undefined ? rest : [arg, ...rest];
      const evalPositionals = positional(evalArgs, ["--attempts", "--max-turns", "--run-prefix", "--prefix"]);
      const attempts = parsePositiveOption(evalArgs, "--attempts") ?? parsePositiveValue(evalPositionals[0], "attempts");
      const maxTurns = parsePositiveOption(evalArgs, "--max-turns") ?? parsePositiveValue(evalPositionals[1], "max-turns");
      const runPrefix = option(evalArgs, "--run-prefix") ?? option(evalArgs, "--prefix") ?? evalPositionals[2];
      const summary = await new FixtureEvaluationRunner(root, config).run({ attempts, maxTurns, runPrefix });
      print(summary);
      if (evalArgs.includes("--enforce-gate") && !summary.gate.passed) process.exitCode = 1;
      break;
    }
  case "eval-real": {
      const corpusPath = required(arg, "real evaluation corpus path");
      const preflightOnly = rest.includes("--preflight");
      if (!preflightOnly && !rest.includes("--allow-live")) throw new Error("eval-real requires --allow-live because it sends real Provider requests");
      const variants = await Promise.all(optionValues(rest, "--variant").map(async (value) => {
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) throw new Error("--variant must use id=config-path");
        return { id: value.slice(0, separator), config: await loadConfig(root, value.slice(separator + 1)) };
      }));
      const preflight = await preflightRealModelEvaluation({
        corpusPath,
        variants,
        requireProviderTraffic: true,
        minimumCorpusCases: 20,
        attempts: parsePositiveOption(rest, "--attempts"),
        maxTurns: parsePositiveOption(rest, "--max-turns"),
        maxCostUsd: parsePositiveDecimalOption(rest, "--max-cost-usd"),
        deadlineMs: parsePositiveOption(rest, "--deadline-ms"),
      });
      if (preflightOnly) {
        print(preflight);
        if (!preflight.ready) process.exitCode = 1;
        break;
      }
      if (!preflight.ready) {
        const failed = preflight.checks.filter((item) => !item.passed).map((item) => `${item.id} (actual=${item.actual}, expected=${item.expected})`).join("; ");
        throw new Error(`eval-real preflight failed before any Provider request: ${failed}`);
      }
      const summary = await new RealModelEvaluationRunner(root).run({
        corpusPath,
        variants,
        allowLive: true,
        requireProviderTraffic: true,
        minimumCorpusCases: 20,
        attempts: parsePositiveOption(rest, "--attempts"),
        maxTurns: parsePositiveOption(rest, "--max-turns"),
        maxCostUsd: parsePositiveDecimalOption(rest, "--max-cost-usd"),
        deadlineMs: parsePositiveOption(rest, "--deadline-ms"),
        runPrefix: option(rest, "--run-prefix") ?? option(rest, "--prefix"),
        minimumSuccessRate: parseRateOption(rest, "--min-success-rate"),
        baselineVariantId: option(rest, "--baseline"),
        maxBaselineSuccessRateDrop: parseRateOption(rest, "--max-success-rate-drop"),
      });
      print(summary);
      if (rest.includes("--enforce-gate") && !summary.gate.passed) process.exitCode = 1;
      break;
    }
    case "eval-holdout": {
      const evalArgs = arg === undefined ? rest : [arg, ...rest];
      const corpusPath = positional(evalArgs, ["--attempts", "--max-turns", "--run-prefix", "--prefix", "--min-success-rate"])[0]
        ?? join(root, "fixtures", "holdout", "manifest.json");
      const summary = await new LocalHoldoutEvaluationRunner(root, config).run({
        corpusPath,
        attempts: parsePositiveOption(evalArgs, "--attempts"),
        maxTurns: parsePositiveOption(evalArgs, "--max-turns"),
        runPrefix: option(evalArgs, "--run-prefix") ?? option(evalArgs, "--prefix"),
        minimumSuccessRate: parseRateOption(evalArgs, "--min-success-rate"),
      });
      print(summary);
      if (evalArgs.includes("--enforce-gate") && !summary.gate.passed) process.exitCode = 1;
      break;
    }
    case "ablation": {
      const action = arg ?? "list";
      const store = new AblationExperimentStore(join(root, ".proofblade", "ablation"));
      if (action === "list") {
        print(await store.list());
        break;
      }
      if (action === "create") {
        const configFile = required(rest[0], "experiment config path");
        const experiment = validateAblationExperiment(JSON.parse(await readFile(resolve(root, configFile), "utf8")), config.modelProfiles.executor);
        print({ experimentId: experiment.experimentId, path: await store.save(experiment), experimentFingerprint: experiment.experimentFingerprint });
        break;
      }
      const experimentId = required(rest[0], "experiment id");
      const experiment = await store.load(experimentId);
      if (action === "preflight") {
        const result = await preflightAblationExperiment(experiment, config.modelProfiles.executor, { probe: rest.includes("--probe") });
        print(result);
        if (!result.ready) process.exitCode = 1;
        break;
      }
      if (action === "run") {
        if (!rest.includes("--allow-live")) throw new Error("ablation run requires --allow-live because it sends real Provider requests");
        const preflight = await preflightAblationExperiment(experiment, config.modelProfiles.executor, { probe: rest.includes("--probe") });
        if (!preflight.ready) {
          const failed = preflight.checks.filter((item) => !item.passed).map((item) => `${item.id} (actual=${item.actual}, expected=${item.expected})`).join("; ");
          throw new Error(`ablation preflight failed before any Provider request: ${failed}`);
        }
        const corpus = await loadRealEvaluationCorpus(resolve(root, experiment.corpus.path));
        if (corpus.snapshot.hash !== experiment.corpus.hash) throw new Error("Ablation corpus snapshot changed; create a new immutable experiment version before running");
        const ledgerPath = join(root, ".proofblade", "ablation", `${experiment.experimentId}.ledger.json`);
        let ledger: AblationRunLedger;
        try { ledger = await AblationRunLedger.load(ledgerPath, experiment); }
        catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
          ledger = await AblationRunLedger.create(ledgerPath, experiment, corpus.cases.map((item) => ({ id: item.id, targetKind: item.targetKind })));
        }
        const pending = Object.values(ledger.snapshot().attempts).filter((item) => item.status === "ready" || item.status === "unknown");
        if (ledger.summary().running > 0) throw new Error("Ablation experiment has running pairings; run `ablation resume` after confirming the previous process stopped.");
        if (pending.length === 0) throw new Error("Ablation experiment has no pending pairings; create a new immutable experiment snapshot for another run.");
        const variants = experiment.variants.map((variant) => ({
          id: variant.id,
          strategyFingerprint: variant.policySnapshot.policyFingerprint,
          config: {
            ...config,
            modelProfiles: {
              ...config.modelProfiles,
              executor: {
                ...config.modelProfiles.executor,
                model: experiment.model.model,
                ...(variant.modelSnapshot.thinkingLevel === undefined ? {} : { thinkingLevel: variant.modelSnapshot.thinkingLevel }),
              },
            },
          },
        }));
        const summary = await new RealModelEvaluationRunner(root).run({
          corpusPath: resolve(root, experiment.corpus.path),
          variants,
          allowLive: true,
          allowSharedProviderProfile: true,
          requireProviderTraffic: true,
          attempts: experiment.budget.attempts,
          maxTurns: experiment.budget.maxTurns,
          maxCostUsd: experiment.budget.maxCostUsd,
          deadlineMs: experiment.budget.deadlineMs,
          runPrefix: option(rest, "--run-prefix") ?? `ABLATION-${experiment.experimentId}`,
          requireAnswerLiteralsAbsent: true,
          baselineVariantId: experiment.variants.find((variant) => variant.baseline)?.id,
          pairingFilter: pending.map((pairing) => ({ variantId: pairing.variantId, corpusCaseId: pairing.caseId, attempt: pairing.attempt })),
          onCaseStart: async ({ variantId, corpusCaseId, attempt, runId }) => {
            await ledger.claim(`${experiment.experimentId}:${corpusCaseId}:${attempt}:${variantId}`, runId);
          },
          onCaseComplete: async (item) => {
            await ledger.complete(`${experiment.experimentId}:${item.corpusCaseId}:${item.attempt}:${item.variantId}`, item.success ? "succeeded" : "failed", item.error);
          },
        });
        print(summary);
        if (rest.includes("--enforce-gate") && !summary.gate.passed) process.exitCode = 1;
        break;
      }
      if (action === "init") {
        const corpus = await loadRealEvaluationCorpus(resolve(root, experiment.corpus.path));
        const ledgerPath = join(root, ".proofblade", "ablation", `${experiment.experimentId}.ledger.json`);
        try {
          await access(ledgerPath);
          throw new Error(`Ablation ledger already exists at ${ledgerPath}; use status/resume or create a new experiment snapshot.`);
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const ledger = await AblationRunLedger.create(ledgerPath, experiment, corpus.cases.map((item) => ({ id: item.id, targetKind: item.targetKind })));
        print({ experimentId: experiment.experimentId, ledgerPath, summary: ledger.summary() });
        break;
      }
      if (action === "status" || action === "resume") {
        const ledgerPath = join(root, ".proofblade", "ablation", `${experiment.experimentId}.ledger.json`);
        const ledger = await AblationRunLedger.load(ledgerPath, experiment);
        if (action === "resume") await ledger.markInterrupted();
        print({ experimentId: experiment.experimentId, ...(action === "resume" ? { recovered: true } : {}), next: ledger.next(), summary: ledger.summary() });
        break;
      }
      if (action === "report") {
        const resultsPath = option(rest, "--results");
        const parsed = resultsPath ? JSON.parse(await readFile(resolve(root, resultsPath), "utf8")) as unknown : [];
        const records = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records) ? (parsed as { records: unknown[] }).records : []);
        const report = buildAblationReport(experiment, records as Parameters<typeof buildAblationReport>[1]);
        if (rest.includes("--markdown")) console.log(renderAblationReportZh(report));
        else print(report);
        break;
      }
      throw new Error("ablation action must be list, create, preflight, run, init, status, resume, or report");
    }
    case "eval-anonymize": {
      const summaryPath = required(arg, "evaluation summary path");
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Parameters<typeof anonymizeEvaluationSummary>[0];
      print(anonymizeEvaluationSummary(summary));
      break;
    }
    case "run-anonymize": {
      const runId = required(arg, "run id");
      const events = await services.control.events(runId);
      print(anonymizeRunReplay(events));
      break;
    }
    case "competition-api": {
      const action = arg ?? "inspect";
      const journalPath = required(rest[0], "competition API journal path");
      if (action === "inspect") {
        print({ path: journalPath, ...(await CompetitionApiJournal.inspect(journalPath)) });
        break;
      }
      if (action === "replay") {
        const scriptPath = option(rest, "--script");
        const scriptText = await readFile(required(scriptPath, "--script path"), "utf8");
        const steps = parseCompetitionApiReplayScript(JSON.parse(scriptText));
        const journal = await CompetitionApiJournal.replay(journalPath);
        print({ path: journalPath, results: await replayCompetitionApiScript(journal, steps) });
        break;
      }
      throw new Error("competition-api action must be inspect or replay");
    }
    case "capabilities": {
      const mcp = McpProjectRegistry.load(root);
      const registry = new CapabilityRegistry([...listBundledCapabilities(), ...mcp.capabilityManifests()]);
      print({ catalogHash: registry.catalogHash(), capabilities: registry.list() });
      break;
    }
    case "mcp": {
      const action = arg ?? "list";
      const mcp = McpProjectRegistry.load(root);
      if (action === "list") {
        print({ catalogHash: mcp.catalogHash(), servers: mcp.summaries() });
        break;
      }
      if (action === "doctor") {
        const servers = mcp.summaries().map((server) => ({
          name: server.name,
          capabilityId: server.capabilityId,
          status: server.status,
          ...(server.toolchain ? { toolchain: server.toolchain } : {}),
        }));
        print({ catalogHash: mcp.catalogHash(), ready: servers.every((server) => server.status !== "unavailable" && server.status !== "failed"), servers });
        break;
      }
      const runId = required(rest[0], "run id");
      const serverName = required(rest[1], "MCP server name");
      const summary = mcp.summaries().find((item) => item.name === serverName && !item.disabled);
      if (!summary) throw new Error(`Unknown enabled MCP server: ${serverName}`);
      const runtime = await toolRuntime(runId, services);
      try {
        if (action === "describe") print(await runtime.invokeCapability({ capabilityId: summary.capabilityId, operation: "describe", input: {} }));
        else if (action === "call") {
          const tool = required(rest[2], "MCP tool name");
          const toolArgs = rest[3] === undefined ? {} : parseObject(rest[3], "MCP tool arguments");
          print(await runtime.invokeCapability({ capabilityId: summary.capabilityId, operation: "call", input: { tool, arguments: toolArgs } }));
        } else throw new Error("mcp action must be list, doctor, describe, or call");
      } finally {
        await runtime.close();
      }
      break;
    }
    case "skills": {
      const registry = await ProofBladeSkillRegistry.load(root);
      const action = arg ?? "list";
      if (action === "list") print({ catalogHash: registry.catalogHash(), skills: registry.list(), diagnostics: registry.diagnostics });
      else if (action === "show") print(registry.loadForModel(required(rest[0], "skill name"), rest[1] === undefined ? undefined : Number(rest[1])));
      else throw new Error("skills action must be list or show");
      break;
    }
    case "tools": {
      const registry = await ProofBladeToolCatalogRegistry.load(root);
      const action = arg ?? "list";
      if (action === "list") print({ catalogHash: registry.catalogHash(), tools: registry.list(), diagnostics: registry.diagnostics });
      else if (action === "probe") print({ catalogHash: registry.catalogHash(), diagnostics: [...registry.diagnostics, ...(await registry.probe())] });
      else if (action === "init") print(await bootstrapToolCatalog(root, securityToolCatalogSpecs(), { force: rest.includes("--refresh") }));
      else if (action === "preflight") {
        const requested = rest[0] ?? "all";
        const profiles = requested === "all"
          ? securityToolProfiles()
          : (() => {
            const profile = securityToolProfiles().find((item) => item.id === requested);
            if (!profile) throw new Error(`Unknown security profile: ${requested}`);
            return [profile];
          })();
        const mcp = McpProjectRegistry.load(root);
        const results = await new ToolPreflightService(root, { force: rest.includes("--refresh") }).prepareAll(profiles, registry, mcp);
        await mcp.close();
        print({ catalogHash: registry.catalogHash(), mcpCatalogHash: mcp.catalogHash(), profiles: results });
      }
      else if (action === "show") {
        const id = required(rest[0], "tool id");
        const entry = registry.get(id);
        if (!entry) throw new Error(`Unknown tool id: ${id}`);
        print({ tool: entry });
      } else throw new Error("tools action must be list, probe, init, preflight, or show");
      break;
    }
    case "intents": {
      const scheduler = new IntentScheduler(services.control, new LeaseManager(services.control), config.intentScheduler);
      const { handleIntentsCommand } = await import("./commands/intents.js");
      await handleIntentsCommand([arg ?? "", ...rest], scheduler, services.control, (message) => console.log(message));
      break;
    }
    case "show": {
      const snapshot = await services.control.snapshot(required(arg, "run id"));
      print({ runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase, generation: snapshot.generation, lastSeq: snapshot.lastSeq, facts: Object.keys(snapshot.facts).length, observations: Object.keys(snapshot.observations).length, evidence: Object.keys(snapshot.evidence).length, completions: Object.keys(snapshot.completions).length, effects: Object.keys(snapshot.effects).length, artifacts: Object.keys(snapshot.artifacts).length, checkpoints: Object.keys(snapshot.checkpoints).length, jobs: Object.keys(snapshot.jobs).length, handoffs: Object.keys(snapshot.handoffs).length, contextOverflowRecoveries: snapshot.contextOverflowRecoveries, failureCategory: snapshot.failureCategory, versionSnapshotHash: snapshot.versionSnapshot?.hash, projectionHash: snapshot.projectionHash });
      break;
    }
    case "timeline": {
      const events = await services.control.events(required(arg, "run id"));
      for (const event of events) console.log(`${String(event.seq).padStart(4)} ${event.ts} ${event.lane.padEnd(8)} ${event.type}`);
      break;
    }
    case "ledger": {
      const snapshot = await services.control.snapshot(required(arg, "run id"));
      print({ facts: Object.values(snapshot.facts), hypotheses: Object.values(snapshot.hypotheses), evidence: Object.values(snapshot.evidence), intents: Object.values(snapshot.intents) });
      break;
    }
    case "context": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      const output = snapshotContext(snapshot, runId);
      console.log(contextText(output));
      console.log("\n--- manifest ---");
      print(output.manifest);
      break;
    }
    case "replay": {
      const action = arg === "compare" ? "compare" : (rest[0] ?? "projection");
      if (action === "compare") {
        const baselineRunId = required(rest[0], "baseline run id");
        const candidateRunId = required(rest[1], "candidate run id");
        const [baselineEvents, candidateEvents] = await Promise.all([services.control.events(baselineRunId), services.control.events(candidateRunId)]);
        print(compareReplayStats(replayStats(baselineEvents), replayStats(candidateEvents), "ab"));
        break;
      }
      const runId = required(arg, "run id");
      const events = await services.control.events(runId);
      if (action === "tools") {
        print({ runId, tape: createToolReplay(events), replay: replayTool(createToolReplay(events)) });
        break;
      }
      if (action === "stats") {
        print(replayStats(events));
        break;
      }
      if (action === "shadow") {
        const ignored = optionValues(rest.slice(1), "--ignore") as Array<import("@proofblade/materials").HarnessEvent["type"]>;
        print(compareReplayStats(replayStats(events), shadowReplay(events, ignored), "shadow"));
        break;
      }
      if (action === "protocol") {
        const snapshot = await services.control.snapshot(runId);
        const tape = createProtocolReplay(events, snapshot);
        const replayed = replayProtocol(tape, snapshot.task);
        print({ runId, eventCount: replayed.lastSeq, tapeHash: tape.hash, replayHash: projectionHash(replayed), recordedHash: tape.projectionHash, match: projectionHash(replayed) === tape.projectionHash });
        break;
      }
      if (action !== "projection") throw new Error("replay action must be projection, protocol, tools, stats, shadow, or compare");
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      const replayHash = projectionHash(replayed);
      const persistedHash = persisted ? projectionHash(persisted) : undefined;
      print({ runId, eventCount: replayed.lastSeq, replayHash, persistedHash, match: replayHash === persistedHash });
      break;
    }
    case "reconcile": {
      const runId = required(arg, "run id");
      const recovery = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl, undefined, services.verificationRecovery, services.verificationRecoveryAdapters, services.externalResources, recoveryAdapters).recover(runId);
      print({
        runId,
        fixtureHealth: recovery.fixtureHealth,
        fixtureAction: recovery.fixtureAction,
        projectionRepaired: recovery.projectionRepaired,
        expiredLeases: recovery.expiredLeases.map((lease) => lease.resourceKey),
        reconciledEffects: recovery.reconciledEffects,
        reconciledJobs: recovery.reconciledJobs,
      });
      break;
    }
    case "cost": {
      print(await new RunTelemetry(services.control).report(required(arg, "run id")));
      break;
    }
    case "checkpoint": {
      const runId = required(arg, "run id");
      const reason = rest.join(" ").trim() || "manual";
      print(await new CheckpointService(services.control, services.artifacts).create(runId, reason));
      break;
    }
    case "compact": {
      const runId = required(arg, "run id");
      const compactSnapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(compactSnapshot.task);
      const lane = await PiCodingLane.create({ projectRoot: fixture.path, installRoot: root, runId, runDir: join(services.runsRoot, runId), controlStore: services.control, artifactStore: services.artifacts, journal: services.journal, claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier), config, browserVerifierFactory, ...(services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: services.sessionRuntimeBrokers } : {}), ...(services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: services.sessionRuntimeRequired }), ...(services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: services.browserRuntimeRequired }), deferClaimAcceptance: true, sessionId: `${runId}-coding` });
      try {
        await lane.compact(rest.join(" ").trim() || "Manual ProofBlade compaction");
      } finally {
        await lane.close();
      }
      const snapshot = await services.control.snapshot(runId);
      print({ runId, checkpoints: Object.values(snapshot.checkpoints) });
      break;
    }
    case "skill": {
      const runId = required(arg, "run id");
      const skillName = required(rest[0], "skill name");
      const runDir = join(services.runsRoot, runId);
      await access(runDir);
      const skillSnapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(skillSnapshot.task);
      const lane = await PiCodingLane.create({ projectRoot: fixture.path, installRoot: root, runId, runDir, controlStore: services.control, artifactStore: services.artifacts, journal: services.journal, claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier), config, browserVerifierFactory, ...(services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: services.sessionRuntimeBrokers } : {}), ...(services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: services.sessionRuntimeRequired }), ...(services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: services.browserRuntimeRequired }), deferClaimAcceptance: true, sessionId: `${runId}-coding` });
      try {
        print(await lane.prompt(`Load and apply the ProofBlade skill \"${skillName}\". ${rest.slice(1).join(" ").trim()}`));
      } finally {
        await lane.close();
      }
      break;
    }
    case "history": {
      const runId = required(arg, "run id");
      const query = required(rest.join(" ").trim(), "history query");
      const runtime = await toolRuntime(runId, services);
      print(await runtime.searchHistory(query));
      break;
    }
    case "knowledge": {
      const runId = required(arg, "run id");
      const runtime = await toolRuntime(runId, services);
      try {
        const action = rest[0] ?? "search";
        if (action === "inspect") print(await runtime.inspectKnowledge(required(rest[1], "knowledge URI"), (rest[2] as "L0" | "L1" | "L2" | undefined) ?? "L0"));
        else if (action === "search") print(await runtime.searchKnowledge(rest.slice(1).join(" "), 50));
        else throw new Error("knowledge action must be inspect or search");
      } finally {
        await runtime.close();
      }
      break;
    }
    case "consolidate": {
      const runId = required(arg, "run id");
      const runtime = await toolRuntime(runId, services);
      try {
        print(await runtime.consolidateKnowledge({ policy: (rest[0] as "deduplicate" | "summarize" | "all" | undefined) ?? "all" }));
      } finally {
        await runtime.close();
      }
      break;
    }
    case "jobs": {
      const runId = required(arg, "run id");
      const runtime = await toolRuntime(runId, services);
      try {
        const action = rest[0] ?? "list";
        if (action === "list") print(await runtime.listJobs());
        else if (action === "recover") print(await runtime.recoverJobs());
        else if (action === "monitor") {
          const triggers = optionValues(rest, "--trigger") as Array<"new_output" | "keyword" | "exit" | "error" | "heartbeat">;
          print(await runtime.monitorJob(required(rest[1], "job id"), {
            ...(option(rest, "--since") === undefined ? {} : { sinceCursor: option(rest, "--since") }),
            ...(triggers.length === 0 ? {} : { triggers }),
            ...(optionValues(rest, "--keyword").length === 0 ? {} : { keywords: optionValues(rest, "--keyword") }),
            ...(option(rest, "--wait-ms") === undefined ? {} : { waitMs: parsePositiveOption(rest, "--wait-ms") }),
            ...(option(rest, "--heartbeat-ms") === undefined ? {} : { heartbeatMs: parsePositiveOption(rest, "--heartbeat-ms") }),
          }));
        }
        else if (action === "read") print(await runtime.readJobOutput(required(rest[1], "job id"), rest[2] === undefined ? undefined : Number(rest[2])));
        else if (action === "stop") print(await runtime.stopJob(required(rest[1], "job id"), rest.slice(2).join(" ") || undefined));
        else throw new Error("jobs action must be list, recover, monitor, read, or stop");
      } finally {
        await runtime.close();
      }
      break;
    }
    case "handoff": {
      const runId = required(arg, "run id");
      const action = rest[0] ?? "show";
      if (action === "show") print(Object.values((await services.control.snapshot(runId)).handoffs));
      else if (action === "prepare") print(await new PlannerCoordinator(services.control).prepare(runId));
      else throw new Error("handoff action must be show or prepare");
      break;
    }
    case "artifact": {
      const runId = required(arg, "run id");
      const artifactId = required(rest[0], "artifact id");
      const maxChars = rest[1] === undefined ? undefined : Number(rest[1]);
      const runtime = await toolRuntime(runId, services);
      print(await runtime.readArtifact(artifactId, maxChars));
      break;
    }
    case "fixture-build": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      print(await services.sandbox.build(snapshot.task));
      break;
    }
    case "fixture-reset": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(snapshot.task);
      await services.fixtureControl.assertResetAllowed(runId);
      const generation = await services.sandbox.reset(fixture);
      await services.fixtureControl.reset(runId, generation);
      print({ runId, generation });
      break;
    }
    case "fixture-score": {
      const runId = required(arg, "run id");
      const candidate = required(rest[0], "candidate");
      const snapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(snapshot.task);
      const verifier = new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, services.runsRoot, services.verifier);
      const coordinator = new RunCoordinator(services.control, services.verifier, { verifier });
      const normalized = candidate.trim();
      const candidateArtifact = await services.artifacts.putText(runId, normalized, {
        filename: "cli-fixture-score-candidate.txt",
        sensitivity: "flag_candidate",
      });
      const completionId = `C-CLI-${randomUUID()}`;
      await services.control.dispatch(runId, {
        type: "completion_proposed",
        completion: {
          id: completionId,
          purpose: snapshot.task.verification.kind === "platform_submission" ? "submission" : "harness_verification",
          candidateHash: createHash("sha256").update(normalized).digest("hex"),
          artifactId: candidateArtifact.id,
        },
        lane: "executor",
      });
      const workItem = await coordinator.claim(runId, snapshot.task, 0);
      try {
        const verified = await coordinator.verifyCompletion(runId, fixture, completionId);
        // `fixture-score` is a verifier-backed diagnostic, not the terminal
        // solve command. Still settle its WorkItem through the shared durable
        // scheduler so a later finish/replay can account for this evidence.
        await coordinator.settle(runId, workItem.id, true, verified.evidenceIds, [candidateArtifact.id]);
        print({ completionId, accepted: verified.accepted, candidateHash: verified.candidateHash, evidenceIds: verified.evidenceIds, workItemId: workItem.id });
      } catch (error) {
        await coordinator.fail(runId, workItem.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
      break;
    }
    case "agent": {
      const runId = required(arg, "run id");
      const prompt = rest.join(" ").trim() || "Summarize the current verified facts and evidence ids in JSON.";
      const runDir = join(services.runsRoot, runId);
      await access(runDir);
      const lane = await PiAgentLane.create({ runId, runDir, controlStore: services.control, config });
      try {
        const outcome = await lane.prompt(prompt);
        print(outcome);
      } finally {
        await lane.close();
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!);
  return values;
}

function withoutOption(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function positional(args: string[], optionNames: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionNames.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (!args[index]!.startsWith("--")) values.push(args[index]!);
  }
  return values;
}

function parsePositiveOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parsePositiveDecimalOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive finite number`);
  return parsed;
}

function parseRateOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be a finite number from 0 to 1`);
  return parsed;
}

function parsePositiveValue(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function taskStatus(snapshot: RunSnapshot): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    phase: snapshot.phase,
    targetKind: snapshot.task.target_kind,
    generation: snapshot.generation,
    lastSeq: snapshot.lastSeq,
    counts: {
      facts: Object.keys(snapshot.facts).length,
      observations: Object.keys(snapshot.observations).length,
      evidence: Object.keys(snapshot.evidence).length,
      artifacts: Object.keys(snapshot.artifacts).length,
      effects: Object.keys(snapshot.effects).length,
      completions: Object.keys(snapshot.completions).length,
    },
    finalResult: snapshot.finalResult,
    failureCategory: snapshot.failureCategory,
  };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function parseCompetitionApiReplayScript(value: unknown): CompetitionApiReplayStep[] {
  if (!Array.isArray(value)) throw new Error("Competition API replay script must be a JSON array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Replay step ${index} must be an object`);
    const record = item as Record<string, unknown>;
    const operation = record.operation;
    if (typeof operation !== "string") throw new Error(`Replay step ${index} operation is required`);
    if (operation === "listChallenges") return { operation };
    if (operation === "getChallenge" || operation === "startEnvironment") {
      if (typeof record.challengeId !== "string" || !record.challengeId.trim()) throw new Error(`Replay step ${index} challengeId is required`);
      return { operation, challengeId: record.challengeId.trim() };
    }
    if (operation === "submitFlag") {
      if (typeof record.challengeId !== "string" || !record.challengeId.trim() || typeof record.flag !== "string") throw new Error(`Replay step ${index} requires challengeId and flag`);
      return { operation, challengeId: record.challengeId.trim(), flag: record.flag };
    }
    if (operation === "stopEnvironment") {
      if (typeof record.challengeId !== "string" || !record.challengeId.trim()) throw new Error(`Replay step ${index} challengeId is required`);
      if (record.instanceId !== undefined && typeof record.instanceId !== "string") throw new Error(`Replay step ${index} instanceId must be a string`);
      return { operation, challengeId: record.challengeId.trim(), ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }) };
    }
    throw new Error(`Unsupported competition API replay operation: ${operation}`);
  });
}

function helpText(): string {
  return [
    "ProofBlade / 证锋",
    "",
    "Commands:",
    "  init <run-id>",
    "  run demo [--run-id ID]",
    "  task templates",
    "  task create <task-id> --template <template-id> [--objective TEXT]",
    "  task run <task-id> [--mode auto|assist] [--max-turns N]",
    "  task status <task-id>",
    "  task cancel <task-id> [reason]",
    "  fixtures",
    "  eval [--attempts N] [--max-turns N] [--run-prefix ID] [--enforce-gate]",
    "  eval-real <corpus.json> [--preflight] [--allow-live] --variant ID=config.json --variant ID=config.json [--attempts N] [--max-turns N] [--max-cost-usd USD] [--deadline-ms N] [--min-success-rate 0..1] [--baseline ID] [--max-success-rate-drop 0..1] [--enforce-gate]",
    "  eval-holdout [manifest.json] [--attempts N] [--max-turns N] [--run-prefix ID] [--min-success-rate 0..1] [--enforce-gate]",
    "  ablation list|create <experiment.json>|preflight|run|init|status|resume|report <experiment-id> [--allow-live] [--results file] [--markdown]",
    "  eval-anonymize <summary.json>  Remove Run ids/paths before sharing history",
    "  run-anonymize <run-id>  Export a secret-free event-level Run replay",
    "  capabilities",
    "  doctor  Read-only environment, Tool catalog, MCP, and Provider diagnostics",
    "  mcp [list|doctor|describe|call] [run-id] [server] [tool] [json-arguments]",
    "  skills [list|show] [skill-name] [max-chars]",
    "  tools [list|probe|init|preflight|show] [profile|tool-id]  Host catalog/readiness",
    "  competition-api inspect <journal.jsonl>",
    "  competition-api replay <journal.jsonl> --script <requests.json>",
    "  intents list|score|graph|claim <run-id>",
    "  skill <run-id> <skill-name> [additional instructions]",
    "  show <run-id>",
    "  timeline <run-id>",
    "  ledger <run-id>",
    "  context <run-id>",
    "  replay <run-id> [projection|protocol|tools|stats|shadow]",
    "  replay compare <baseline-run-id> <candidate-run-id>",
    "  reconcile <run-id>",
    "  cost <run-id>",
    "  checkpoint <run-id> [reason]",
    "  compact <run-id> [reason]",
    "  history <run-id> <query>",
    "  knowledge <run-id> [inspect <pb://...> [L0|L1|L2]|search <query>]",
    "  consolidate <run-id> [deduplicate|summarize|all]",
    "  handoff <run-id> [show|prepare]",
    "  jobs <run-id> [list|recover|monitor|read|stop] [job-id] [max-chars]",
    "    monitor options: --since N --trigger NAME --keyword TEXT --wait-ms N --heartbeat-ms N",
    "  artifact <run-id> <artifact-id> [max-chars]",
    "  fixture-build <run-id>",
    "  fixture-reset <run-id>",
    "  fixture-score <run-id> <candidate>",
    "  agent <run-id> [prompt]  Run a Pi AgentHarness turn through LM Studio",
    "  --config <path>           Select a project configuration file",
  ].join("\n");
}

async function toolRuntime(runId: string, services: ReturnType<typeof createServices>): Promise<ProofBladeToolRuntime> {
  const snapshot = await services.control.snapshot(runId);
  const fixture = await services.sandbox.build(snapshot.task);
  return new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal, services.projectRoot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
