import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ProofBladeConfig } from "../src/config.js";
import type { CompetitionApi, CompetitionChallengeSummary } from "../src/competition/api.js";
import { CompetitionChallengeSolver } from "../src/competition/solver.js";
import type { CompetitionLaneFactory } from "../src/competition/loop.js";
import type { ContainerCreateRequest, ContainerRef, ContainerRuntimePort, ContainerSessionHandle, ContainerSessionResult } from "../src/container/contracts.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { PwnSession } from "../src/pwn/pwn-session.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { createPlatformFlagSubmitter } from "../src/runtime/coding-lane.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  execution: { backend: "docker", requireFor: ["pwn"], networkPolicy: "target-only" },
  modelProfiles: { executor: { provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test", modelDiscoveryPath: "/models", apiKeyEnv: "TEST", contextWindow: 4096, maxTokens: 512, requestTimeoutMs: 1000, maxRetries: 0, input: ["text"] } },
};

class PwnRuntime implements Partial<ContainerRuntimePort> {
  public created?: ContainerRef;
  public destroyed = false;
  async prewarm() {}
  async doctor() { return { backend: "docker" as const, installed: true, daemon: true, image: { name: "pwn", available: true } }; }
  async create(request: ContainerCreateRequest): Promise<ContainerRef> {
    this.created = { runId: request.runId, generation: request.generation, containerId: "fake-pwn", name: "fake-pwn", profile: request.profile, image: request.image, imageDigest: "sha256:test", workspaceHostPath: request.workspaceHostPath, workspaceContainerPath: "/workspace", networkPolicy: request.networkPolicy };
    return this.created;
  }
  executionEnv(ref: ContainerRef) { return new NodeExecutionEnv(ref.workspaceHostPath); }
  async destroy() { this.destroyed = true; }
  async openSession(ref: ContainerRef): Promise<ContainerSessionHandle> { return { sessionId: "tube-1", ref }; }
  async sessionWrite(_handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    const text = Buffer.isBuffer(data) || data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : data;
    const echo = /^echo (.+)\n$/.exec(text);
    const delta = echo ? `${echo[1]}\n` : /^cat '?\/flag'?\n$/.test(text) ? "flag{pwn-e2e}\n" : text;
    return { delta, waitReason: "idle", exited: false, exitCode: null, truncated: false };
  }
  async sessionRead(): Promise<ContainerSessionResult> { return { delta: "menu> ", waitReason: "idle", exited: false, exitCode: null, truncated: false }; }
  async sessionSignal() { return true; }
  async closeSession() { return { exitCode: 0 }; }
}

test("competition pwn path provisions the pwn profile, uses a durable tube, reproduces, and submits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-e2e-"));
  try {
    const api: CompetitionApi & { submitted: string[] } = {
      submitted: [],
      async listChallenges() { return []; },
      async getChallenge() { return { summary: challenge, attachments: [] }; },
      async startEnvironment() { return { instanceId: "inst-pwn", connectionInfo: "nc 127.0.0.1 31337" }; },
      async submitFlag(_id, flag) { this.submitted.push(flag); return { correct: flag === "flag{pwn-e2e}" }; },
      async stopEnvironment() {},
    };
    const challenge: CompetitionChallengeSummary = { challengeId: "PWN-E2E", title: "tube", category: "Pwn", normalizedCategory: "pwn", value: 100 };
    const runtime = new PwnRuntime();
    const lane: CompetitionLaneFactory = async (options) => {
      assert.ok(options.executionEnv, "competition must pass the container execution environment");
      const ref = runtime.created!;
      const registry = new SessionRegistry(options.runId, runtime as unknown as ContainerRuntimePort, options.controlStore);
      const snapshot = await options.controlStore.snapshot(options.runId);
      const fixture = { fixtureId: options.runId, generation: snapshot.generation, path: options.projectRoot, privatePath: join(options.projectRoot, ".proofblade") };
      const toolRuntime = new ProofBladeToolRuntime(options.runId, fixture, join(options.runDir, ".."), options.controlStore, options.artifactStore, options.journal, options.installRoot ?? options.projectRoot, { includeMcp: false });
      const submit = createPlatformFlagSubmitter({ runId: options.runId, runtime: toolRuntime, fixture, controlStore: options.controlStore, artifactStore: options.artifactStore, journal: options.journal, runsRoot: join(options.runDir, ".."), mode: options.mode });
      return {
        async prompt() {
          const tube = await PwnSession.openRemote(registry, { ref, ownerLane: "executor", command: ["nc", "127.0.0.1", "31337"], endpoint: "127.0.0.1:31337" });
          await tube.recvUntil("menu> ");
          assert.equal((await tube.shellProbe()).ok, true);
          const found = await tube.readFlag("/flag", /flag\{[^}]+\}/);
          await tube.close();
          if (!found.flag) throw new Error("flag was not reproduced");
          const verdict = await submit(found.flag);
          return { text: `submitted=${verdict.accepted}`, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        },
        async compact() {}, async abort() {}, async isIdle() { return true; }, async close() { await registry.disposeAll("lane-close"); await toolRuntime.close(); },
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config, api, containerRuntime: runtime as unknown as ContainerRuntimePort, createLane: lane, maxTurns: 1 });
    const result = await solver.solve({ challenge, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.deepEqual(api.submitted, ["flag{pwn-e2e}"]);
    assert.equal(runtime.created?.profile, "pwn");
    assert.equal(runtime.destroyed, true);
    const run = (await readdir(join(root, "runs")))[0]!;
    const events = (await readFile(join(root, "runs", run, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    for (const type of ["session_opened", "session_interacted", "session_closed", "domain_phase_changed"]) assert.ok(events.some((event) => event.type === type), `missing ${type}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
