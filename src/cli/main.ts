#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contextText, snapshotContext } from "../context/compiler.js";
import { projectionHash } from "../control/reducer.js";
import { canonicalJson } from "../domain/utils.js";
import { PiAgentLane } from "../runtime/pi-adapter.js";
import { createServices, demoTask, runDemo } from "./demo.js";
import { loadConfig } from "../config.js";

const root = resolve(process.cwd());

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const configPath = option(rawArgs, "--config") ?? "proofblade.config.json";
  const args = withoutOption(rawArgs, "--config");
  const [command = "help", arg, ...rest] = args;
  const config = await loadConfig(root, configPath);
  const services = createServices(root, config);
  switch (command) {
    case "init": {
      const runId = required(arg, "task id");
      const snapshot = await services.control.createRun(runId, demoTask(runId, root, config));
      print({ runId, status: snapshot.status, phase: snapshot.phase });
      break;
    }
    case "run": {
      if (arg !== "demo") throw new Error("The first fixture profile is named 'demo'");
      const runId = option(rest, "--run-id") ?? rest.find((value) => !value.startsWith("--")) ?? `DEMO-${Date.now()}`;
      const outcome = await runDemo(root, runId, config);
      print(outcome);
      break;
    }
    case "show": {
      const snapshot = await services.control.snapshot(required(arg, "run id"));
      print({ runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase, generation: snapshot.generation, lastSeq: snapshot.lastSeq, facts: Object.keys(snapshot.facts).length, evidence: Object.keys(snapshot.evidence).length, effects: Object.keys(snapshot.effects).length, artifacts: Object.keys(snapshot.artifacts).length, projectionHash: snapshot.projectionHash });
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
      const runId = required(arg, "run id");
      const replayed = await services.control.replay(runId);
      const persisted = await new (await import("../storage/jsonl-store.js")).JsonlControlStore(services.runsRoot).loadProjection(runId);
      const replayHash = projectionHash(replayed);
      const persistedHash = persisted ? projectionHash(persisted) : undefined;
      print({ runId, eventCount: replayed.lastSeq, replayHash, persistedHash, match: replayHash === persistedHash });
      break;
    }
    case "reconcile": {
      const runId = required(arg, "run id");
      print({ runId, reconciled: await services.journal.reconcile(runId) });
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

function withoutOption(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function helpText(): string {
  return [
    "ProofBlade / 证锋",
    "",
    "Commands:",
    "  init <run-id>",
    "  run demo [--run-id ID]",
    "  show <run-id>",
    "  timeline <run-id>",
    "  ledger <run-id>",
    "  context <run-id>",
    "  replay <run-id>",
    "  reconcile <run-id>",
    "  agent <run-id> [prompt]  Run a Pi AgentHarness turn through LM Studio",
    "  --config <path>           Select a project configuration file",
  ].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
