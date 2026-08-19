import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofBladeConfig } from "../src/config.js";
import { readdir, readFile } from "node:fs/promises";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import { createPlatformFlagSubmitter } from "../src/runtime/coding-lane.js";
import type { CompetitionLaneFactory } from "../src/competition/loop.js";
import type { ContainerRuntimePort } from "../src/container/contracts.js";
import {
  CompetitionChallengeSolver,
  CompetitionChallengeError,
  CompetitionHttpError,
  FleetScheduler,
  normalizeCategory,
  type CompetitionApi,
  type CompetitionAttachment,
  type CompetitionChallengeSummary,
  type CompetitionEnvironment,
} from "../src/index.js";

const CONFIG: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

/**
 * A deterministic coding lane: read the attachment from the real workspace, lift
 * a flag-shaped value, and submit it through the SAME submitter the production
 * lane installs as `submit_flag` — so this exercises the real
 * submitCandidate -> IndependentVerifier -> journal fixture_score -> API path
 * rather than a mock of it.
 */
const flagLane: CompetitionLaneFactory = async (options) => {
  const snapshot = await options.controlStore.snapshot(options.runId);
  const fixture = { fixtureId: options.runId, generation: snapshot.generation, path: options.projectRoot, privatePath: join(options.projectRoot, ".proofblade") };
  const runtime = new ProofBladeToolRuntime(
    options.runId,
    fixture,
    join(options.runDir, ".."),
    options.controlStore,
    options.artifactStore,
    options.journal,
    options.installRoot ?? options.projectRoot,
    { includeMcp: false },
  );
  const submitFlag = createPlatformFlagSubmitter({
    runId: options.runId,
    runtime,
    fixture,
    controlStore: options.controlStore,
    artifactStore: options.artifactStore,
    journal: options.journal,
    runsRoot: join(options.runDir, ".."),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  return {
    async prompt() {
      const text = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
      const candidate = text.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0];
      if (!candidate) throw new Error("no candidate in workspace");
      const verdict = await submitFlag(candidate);
      return { text: `submitted accepted=${verdict.accepted}`, stopReason: "stop", usage: zeroUsage() };
    },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  };
};

/** flagLane with a per-turn delay, so a live mode flip can land mid-run. */
function slowFlagLane(delayMs: number): CompetitionLaneFactory {
  return async (options) => {
    const inner = await flagLane(options);
    return {
      ...inner,
      async prompt(text: string) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return await inner.prompt(text);
      },
    };
  };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

interface FakeChallengeSpec {
  id: string;
  value: number;
  flag: string;
  /** When set, startEnvironment returns it as teamFlag (dynamic-flag path). */
  dynamic?: boolean;
  /** Put a DIFFERENT flag in the attachment, so the lane derives a wrong answer. */
  attachmentFlag?: string;
  /** Throw after environment provisioning was attempted. */
  startError?: string;
  /** Throw when the platform submission endpoint is called. */
  submitError?: string;
  /** A typed error confined to this challenge's detail/attachments. */
  detailError?: Error;
}

class FakeApi implements CompetitionApi {
  public submitted: Array<{ id: string; flag: string }> = [];
  public started: string[] = [];
  public stopped: string[] = [];
  public constructor(private readonly specs: FakeChallengeSpec[]) {}
  private spec(id: string): FakeChallengeSpec {
    const found = this.specs.find((s) => s.id === id);
    if (!found) throw new Error(`unknown challenge ${id}`);
    return found;
  }
  async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.specs.map((s) => ({ challengeId: s.id, title: `T-${s.id}`, category: "Misc", normalizedCategory: normalizeCategory("Misc"), value: s.value }));
  }
  async getChallenge(id: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    const s = this.spec(id);
    if (s.detailError) throw s.detailError;
    const attachments = s.dynamic ? [] : [{ name: "flag.txt", base64: Buffer.from(`the flag is ${s.attachmentFlag ?? s.flag}`).toString("base64") }];
    return {
      summary: { challengeId: s.id, title: `T-${s.id}`, category: "Misc", normalizedCategory: normalizeCategory("Misc"), value: s.value },
      attachments,
    };
  }
  async startEnvironment(id: string): Promise<CompetitionEnvironment> {
    const s = this.spec(id);
    this.started.push(id);
    if (s.startError) throw new Error(s.startError);
    return s.dynamic ? { instanceId: `inst-${id}`, teamFlag: s.flag } : { instanceId: `inst-${id}`, connectionInfo: "nc host 1337" };
  }
  async submitFlag(id: string, flag: string) {
    this.submitted.push({ id, flag });
    const s = this.spec(id);
    if (s.submitError) throw new Error(s.submitError);
    return { correct: flag === s.flag };
  }
  async stopEnvironment(id: string): Promise<void> {
    this.stopped.push(id);
  }
}

test("real solver drives a challenge to SOLVED on the coding lane via submit_flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-"));
  try {
    const api = new FakeApi([{ id: "CH1", value: 100, flag: "flag{solver_ok}" }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, true, result.status);
    assert.equal(result.status, "SOLVED");
    assert.equal(result.submissions, 1, "exactly one submission may be spent on a first-try solve");
    assert.ok(api.submitted.some((s) => s.id === "CH1" && s.flag === "flag{solver_ok}"));
    assert.ok(api.stopped.includes("CH1"), "environment must be released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assist mode records the flag for approval without contacting the platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-assist-"));
  try {
    const api = new FakeApi([{ id: "CH2", value: 100, flag: "flag{assist}" }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "assist", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, false);
    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.deepEqual(api.submitted, [], "assist mode must not spend a real submission");
    // submissions counts REAL platform submissions, so assist mode must report 0.
    // The candidate is still recorded as a PROPOSED completion, asserted below.
    assert.equal(result.submissions, 0, "nothing was submitted, so nothing may be counted");
    const runIds = await readdir(join(root, "runs"));
    const events = (await readFile(join(root, "runs", runIds[0]!, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.filter((event) => event.type === "completion_proposed").length, 1, "the candidate must still be recorded for approval");
    assert.equal(events.filter((event) => event.type === "completion_verified").length, 0);
    assert.ok(api.stopped.includes("CH2"), "environment must be released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated identical flag replays the stored verdict instead of a second API call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-replay-"));
  try {
    // A WRONG flag, so the loop does not stop on success and the lane really does
    // submit the same value on a second turn. Then the platform must still have
    // been contacted only once: the journal's idempotency key replays the verdict.
    const api = new FakeApi([{ id: "CH3", value: 100, flag: "flag{right}", attachmentFlag: "flag{wrong}" }]);
    const attempts: boolean[] = [];
    const repeatLane: CompetitionLaneFactory = async (options) => {
      const inner = await flagLane({ ...options });
      return {
        ...inner,
        async prompt(text: string) {
          const outcome = await inner.prompt(text);
          attempts.push(outcome.text.includes("accepted=true"));
          return outcome;
        },
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 2, createLane: repeatLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, false, "the workspace flag is wrong, so the run must not be solved");
    assert.equal(attempts.length, 2, "the lane must have submitted on both turns");
    assert.deepEqual(attempts, [false, false]);
    assert.equal(api.submitted.length, 1, "the platform must be contacted exactly once for one distinct flag");
    assert.equal(result.submissions, 1, "a repeat must not consume a second submission");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic-flag challenge is submitted directly without a model run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dyn-"));
  try {
    const api = new FakeApi([{ id: "DYN", value: 50, flag: "flag{dynamic}", dynamic: true }]);
    // No lane provided — if the solver tried to run the loop it would fail to build a real lane.
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, true);
    assert.equal(result.status, "SOLVED_DYNAMIC");
    assert.deepEqual(api.submitted, [{ id: "DYN", flag: "flag{dynamic}" }]);
    assert.ok(api.stopped.includes("DYN"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recoverable inner-turn guard triggers an evidence-first replan before the next solve attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-replan-"));
  try {
    const api = new FakeApi([{ id: "REPLAN", value: 100, flag: "flag{replanned}" }]);
    let prompts = 0;
    const replanLane: CompetitionLaneFactory = async (options) => {
      const inner = await flagLane(options);
      return {
        ...inner,
        async prompt(text: string) {
          prompts += 1;
          if (prompts === 1) return { text: "experiment budget stopped this provider turn", stopReason: "stop", termination: "experiment_budget" as const, usage: zeroUsage() };
          assert.match(text, /evidence record|replan checkpoint/i);
          return await inner.prompt(text);
        },
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 3, createLane: replanLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(prompts, 2);
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.deepEqual(api.submitted, [{ id: "REPLAN", flag: "flag{replanned}" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic flag submission skips Docker preflight when the daemon is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dynamic-no-docker-"));
  try {
    const api = new FakeApi([{ id: "DYN-DOCKER", value: 100, flag: "flag{dynamic_docker_skip}", dynamic: true }]);
    let prewarmCalls = 0;
    let doctorCalls = 0;
    const unavailableRuntime = {
      async prewarm() { prewarmCalls += 1; throw new Error("docker unavailable"); },
      async doctor() { doctorCalls += 1; throw new Error("docker unavailable"); },
    } as unknown as ContainerRuntimePort;
    const dockerConfig: ProofBladeConfig = { ...CONFIG, execution: { backend: "docker", requireFor: ["pwn"] } };
    const challenge = { ...(await api.listChallenges())[0]!, normalizedCategory: "pwn" as const };
    const solver = new CompetitionChallengeSolver({ root, config: dockerConfig, api, containerRuntime: unavailableRuntime });
    const result = await solver.solve({ challenge, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.equal(result.status, "SOLVED_DYNAMIC");
    assert.equal(prewarmCalls, 0);
    assert.equal(doctorCalls, 0);
    assert.deepEqual(api.submitted, [{ id: "DYN-DOCKER", flag: "flag{dynamic_docker_skip}" }]);
    assert.deepEqual(api.stopped, ["DYN-DOCKER"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered guard does not remain the final reason when the next turns simply exhaust", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-replan-exhausted-"));
  try {
    const api = new FakeApi([{ id: "REPLAN-EXHAUST", value: 100, flag: "flag{unused}" }]);
    let prompts = 0;
    const stalledLane: CompetitionLaneFactory = async () => ({
      async prompt() {
        prompts += 1;
        return prompts === 1
          ? { text: "guard", stopReason: "stop", termination: "experiment_budget" as const, usage: zeroUsage() }
          : { text: "no candidate yet", stopReason: "stop", usage: zeroUsage() };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 2, createLane: stalledLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(prompts, 2);
    assert.equal(result.solved, false);
    assert.equal(result.status, "UNSOLVED");
    assert.equal(result.reason, "max_turns");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dynamic-flag platform failure trips the fleet circuit and leaves later challenges pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dyn-platform-error-"));
  try {
    const api = new FakeApi([
      { id: "DYN-FAIL", value: 100, flag: "flag{dynamic}", dynamic: true, submitError: "DASCTF API unavailable" },
      { id: "DYN-PENDING", value: 50, flag: "flag{unused}", dynamic: true },
    ]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const scheduler = new FleetScheduler({ api, solver, concurrency: 1 });
    const snapshot = await scheduler.run();

    assert.deepEqual(api.submitted, [{ id: "DYN-FAIL", flag: "flag{dynamic}" }], "the pending challenge must not reach submitFlag");
    assert.equal(snapshot.totals.failed, 1);
    assert.equal(snapshot.totals.pending, 1);
    assert.match(snapshot.challenges.find((item) => item.challengeId === "DYN-FAIL")?.reason ?? "", /Platform submit dynamic flag failed/);
    assert.ok(api.stopped.includes("DYN-FAIL"), "the failed dynamic environment must still be released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a provisioning failure performs best-effort teardown and returns a platform terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-provision-error-"));
  try {
    const api = new FakeApi([{ id: "BUILD-FAIL", value: 100, flag: "flag{unused}", startError: "readiness poll timed out" }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });

    assert.deepEqual(api.started, ["BUILD-FAIL"]);
    assert.deepEqual(api.stopped, ["BUILD-FAIL"], "a build that may have started must be recovered even without an instance id");
    assert.equal(result.solved, false);
    assert.equal(result.status, "PLATFORM_ERROR");
    assert.match(result.reason ?? "", /readiness poll timed out/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a challenge-local attachment failure does not circuit-break a healthy pending challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-local-error-"));
  try {
    const api = new FakeApi([
      { id: "TOO-BIG", value: 100, flag: "flag{unused}", detailError: new CompetitionChallengeError("attachment exceeds 67108864 bytes") },
      { id: "HEALTHY", value: 50, flag: "flag{healthy}", dynamic: true },
    ]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const snapshot = await new FleetScheduler({ api, solver, concurrency: 1 }).run();

    assert.deepEqual(api.submitted, [{ id: "HEALTHY", flag: "flag{healthy}" }], "the healthy challenge must still run");
    assert.equal(snapshot.totals.failed, 1);
    assert.equal(snapshot.totals.solved, 1);
    assert.equal(snapshot.totals.pending, 0);
    assert.match(snapshot.challenges.find((item) => item.challengeId === "TOO-BIG")?.reason ?? "", /Challenge fetch challenge failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recognizable raw attachment error does not circuit-break a healthy pending challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-raw-local-error-"));
  try {
    const api = new FakeApi([
      { id: "TOO-BIG-RAW", value: 100, flag: "flag{unused}", detailError: new Error("attachment exceeds 67108864 bytes") },
      { id: "HEALTHY-RAW", value: 50, flag: "flag{healthy}", dynamic: true },
    ]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const snapshot = await new FleetScheduler({ api, solver, concurrency: 1 }).run();

    assert.deepEqual(api.submitted, [{ id: "HEALTHY-RAW", flag: "flag{healthy}" }]);
    assert.equal(snapshot.totals.failed, 1);
    assert.equal(snapshot.totals.solved, 1);
    assert.equal(snapshot.totals.pending, 0);
    assert.match(snapshot.challenges.find((item) => item.challengeId === "TOO-BIG-RAW")?.reason ?? "", /Challenge fetch challenge failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a route-level GET 404 remains a platform failure and trips the fleet circuit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-route-404-"));
  try {
    const api = new FakeApi([
      { id: "ROUTE-404", value: 100, flag: "flag{unused}", detailError: new CompetitionHttpError("GET", "https://competition.example/api/challenges/ROUTE-404", 404, "not found") },
      { id: "HEALTHY-AFTER-404", value: 50, flag: "flag{healthy}", dynamic: true },
    ]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api });
    const snapshot = await new FleetScheduler({ api, solver, concurrency: 1 }).run();

    assert.equal(snapshot.challenges.find((item) => item.challengeId === "ROUTE-404")?.reason, "Platform fetch challenge failed: Competition API GET https://competition.example/api/challenges/ROUTE-404 failed with HTTP 404: not found");
    assert.equal(snapshot.challenges.find((item) => item.challengeId === "HEALTHY-AFTER-404")?.state, "pending");
    assert.deepEqual(api.submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify_claim alone cannot report a challenge as solved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-verifyclaim-"));
  try {
    // Reproduces a real false positive: on a live e2e run the model called
    // verify_claim instead of submit_flag. verify_claim marked its own completion
    // ACCEPTED from LOCAL reproduction, so the run reported SOLVED while the
    // platform was never contacted. Local reproduction is not acceptance.
    const api = new FakeApi([{ id: "VC", value: 100, flag: "flag{needs_submit}" }]);
    const verifyOnlyLane: CompetitionLaneFactory = async (options) => {
      const snapshot = await options.controlStore.snapshot(options.runId);
      const verifier = new CodingClaimVerifier(options.runId, options.controlStore, options.artifactStore);
      return {
        async prompt() {
          const text = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
          const candidate = text.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0] ?? "";
          await verifier.record({
            candidate,
            command: `grep -o 'flag{[^}]*}' flag.txt`,
            cwd: options.projectRoot,
            output: candidate,
            toolCallId: `vc-${snapshot.generation}`,
          });
          return { text: "verified locally", stopReason: "stop", usage: zeroUsage() };
        },
        async compact() {},
        async abort() {},
        async isIdle() { return true; },
        async close() {},
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: verifyOnlyLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });

    assert.equal(result.solved, false, "a locally reproduced candidate must not count as solved");
    assert.deepEqual(api.submitted, [], "the platform was never contacted, so nothing may be reported as accepted");
    // Both guards are checked independently, because either alone would have let
    // the false positive through: (1) verify_claim must leave the completion
    // PROPOSED in a platform-judged run, and (2) the loop must require a real
    // fixture_score effect before calling anything solved.
    const runIds = await readdir(join(root, "runs"));
    assert.equal(runIds.length, 1, "exactly one run must have been created");
    const events = (await readFile(join(root, "runs", runIds[0]!, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const verified = events.filter((event) => event.type === "completion_verified");
    const proposed = events.filter((event) => event.type === "completion_proposed");
    assert.equal(proposed.length, 1, "verify_claim must still record its candidate as a proposal");
    assert.deepEqual(verified, [], "verify_claim must not mark a completion ACCEPTED when the platform is the judge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify_claim then submit_flag on the same flag still reaches the platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-collide-"));
  try {
    // The exact failure from the live e2e run: the model called verify_claim first,
    // then submit_flag on the SAME flag. submitCandidate deduped on candidateHash
    // and handed back verify_claim's completion, whose artifact is a
    // claim-reproduction JSON blob rather than the bare flag. IndependentVerifier
    // then compared sha256(blob) against candidateHash and threw "Candidate hash
    // mismatch", so a correctly derived flag never reached the platform at all.
    const api = new FakeApi([{ id: "COL", value: 100, flag: "flag{collision}" }]);
    const bothLane: CompetitionLaneFactory = async (options) => {
      const inner = await flagLane(options);
      const snapshot = await options.controlStore.snapshot(options.runId);
      const verifier = new CodingClaimVerifier(options.runId, options.controlStore, options.artifactStore);
      return {
        ...inner,
        async prompt(text: string) {
          const raw = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
          const candidate = raw.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0] ?? "";
          // 1) local reproduction first, exactly as the live run did
          await verifier.record({
            candidate,
            command: `grep -o 'flag{[^}]*}' flag.txt`,
            cwd: options.projectRoot,
            output: candidate,
            toolCallId: `vc-${snapshot.generation}`,
          });
          // 2) then the real submission
          return await inner.prompt(text);
        },
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: bothLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });

    assert.equal(result.solved, true, `a verify_claim beforehand must not block the submission: ${result.reason ?? result.status}`);
    assert.deepEqual(api.submitted, [{ id: "COL", flag: "flag{collision}" }], "the flag must reach the platform exactly once");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify_claim calls cannot exhaust the platform submission budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-budget-"));
  try {
    // max_submissions is 5. verify_claim proposes a completion each time but never
    // contacts the platform, so counting those against the budget meant a handful
    // of local reproductions could block every real submission.
    const api = new FakeApi([{ id: "BUD", value: 100, flag: "flag{budget}" }]);
    const exhaustThenSubmitLane: CompetitionLaneFactory = async (options) => {
      const inner = await flagLane(options);
      const verifier = new CodingClaimVerifier(options.runId, options.controlStore, options.artifactStore);
      return {
        ...inner,
        async prompt(text: string) {
          const raw = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
          const candidate = raw.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0] ?? "";
          // Six distinct local reproductions — more than max_submissions.
          for (let i = 0; i < 6; i += 1) {
            await verifier.record({
              candidate,
              command: `echo attempt-${i}`,
              cwd: options.projectRoot,
              output: candidate,
              toolCallId: `vc-${i}`,
            });
          }
          return await inner.prompt(text);
        },
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: exhaustThenSubmitLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });

    assert.equal(result.solved, true, `local reproductions must not consume the submission budget: ${result.reason ?? result.status}`);
    assert.deepEqual(api.submitted, [{ id: "BUD", flag: "flag{budget}" }]);
    assert.equal(result.submissions, 1, "exactly one real submission may be counted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flipping a running challenge to assist stops the next submission reaching the platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-fleet-assist-"));
  try {
    const api = new FakeApi([{ id: "LIVE", value: 100, flag: "flag{right}", attachmentFlag: "flag{wrong}" }]);
    // The lane submits a wrong flag every turn, so the loop keeps going and there
    // is always a "next submission" for the mode flip to catch.
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 6, createLane: slowFlagLane(40) });
    const scheduler = new FleetScheduler({ api, solver, concurrency: 1, defaultMode: "auto" });
    const runPromise = scheduler.run();
    // Flip on the OBSERVED first submission rather than a sleep, so the test does
    // not depend on how long lane startup takes.
    for (let i = 0; i < 200 && api.submitted.length === 0; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    scheduler.setChallengeMode("LIVE", "assist");
    const snapshot = await runPromise;

    assert.equal(api.submitted.length, 1, "only the pre-flip auto submission may reach the platform");
    assert.deepEqual(api.submitted, [{ id: "LIVE", flag: "flag{wrong}" }]);
    assert.equal(snapshot.challenges[0]?.state, "awaiting_approval", "an assist hold is a waiting decision, not a failure");
    assert.equal(snapshot.totals.failed, 0);
    assert.equal(snapshot.totals.awaiting_approval, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet runs the real solver across many challenges in priority order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-fleet-solver-"));
  try {
    const specs: FakeChallengeSpec[] = [
      { id: "A", value: 10, flag: "flag{a}" },
      { id: "B", value: 30, flag: "flag{b}" },
      { id: "C", value: 20, flag: "flag{c}", dynamic: true },
    ];
    const api = new FakeApi(specs);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: flagLane });
    const scheduler = new FleetScheduler({ api, solver, concurrency: 2 });
    const snapshot = await scheduler.run();
    assert.equal(snapshot.totals.solved, 3, JSON.stringify(snapshot.challenges));
    assert.equal(snapshot.solvedValue, 60);
    assert.equal(snapshot.totals.failed, 0);
    for (const id of ["A", "B", "C"]) assert.ok(api.stopped.includes(id), `env ${id} not released`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a terminal Provider error stops a competition challenge after one turn and preserves the cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-provider-error-"));
  try {
    const api = new FakeApi([{ id: "QUOTA", value: 100, flag: "flag{unused}" }]);
    let prompts = 0;
    const providerErrorLane: CompetitionLaneFactory = async () => ({
      async prompt() {
        prompts += 1;
        return {
          text: "",
          stopReason: "error",
          errorMessage: '402: {"message":"Insufficient Balance"}',
          usage: zeroUsage(),
        };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 24, createLane: providerErrorLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });

    assert.equal(prompts, 1, "a terminal Provider failure must not be replayed across competition turns");
    assert.equal(result.solved, false);
    assert.equal(result.status, "PROVIDER_ERROR");
    assert.match(result.reason ?? "", /Insufficient Balance/);
    assert.deepEqual(api.submitted, []);
    assert.ok(api.stopped.includes("QUOTA"), "environment must still be released after a Provider failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
