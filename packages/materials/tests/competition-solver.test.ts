import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofBladeConfig } from "../src/config.js";
import type { RunSnapshot } from "../src/domain/types.js";
import { readdir, readFile } from "node:fs/promises";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import { createPlatformExternalSubmitter } from "../src/runtime/coding-lane.js";
import { hasAcceptedPlatformSubmission, type CompetitionLaneFactory } from "../src/competition/loop.js";
import type { ContainerRuntimePort } from "../src/container/contracts.js";
import {
  CompetitionChallengeSolver,
  CompetitionEnvironmentJanitor,
  ApprovalPolicy,
  CompetitionChallengeError,
  CompetitionHttpError,
  FleetScheduler,
  JsonlControlStore,
  normalizeCategory,
  competitionTask,
  type CompetitionApi,
  type CompetitionAttachment,
  type CompetitionChallengeSummary,
  type CompetitionEnvironment,
  type CompetitionEnvironmentInspection,
} from "../src/index.js";
import type { BrowserVerifierFactory } from "../src/web/browser-session.js";

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
 * a result value, and submit it through the SAME submitter the production
 * lane installs as `external_submit` — so this exercises the real
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
  const submitResult = createPlatformExternalSubmitter({
    runId: options.runId,
    runtime,
    fixture,
    controlStore: options.controlStore,
    verifier: options.platformVerifier!,
    artifactStore: options.artifactStore,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.onApprovalRequired ? { onApprovalRequired: options.onApprovalRequired } : {}),
  });
  return {
    async prompt() {
      let text: string;
      try {
        text = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
      } catch {
        text = await readFile(join(options.projectRoot, "platform-provided-result.txt"), "utf8");
      }
      const candidate = text.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0];
      if (!candidate) throw new Error("no candidate in workspace");
      const verdict = await submitResult({ target: "competition", payload: candidate });
      return { text: `submitted accepted=${verdict.accepted}`, stopReason: "stop", usage: zeroUsage() };
    },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {
      await runtime.close();
    },
  };
};

/**
 * Production-shaped lane wrapper used by the composition replay test. The
 * flag submission remains deterministic, while one coding artifact is routed
 * through the real observer so replay covers both the work graph and the
 * evidence graph in the same run stream.
 */
const observedFlagLane: CompetitionLaneFactory = async (options) => {
  const inner = await flagLane(options);
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
  let observed = false;
  return {
    ...inner,
    async prompt(text: string) {
      if (!observed) {
        const content = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
        const artifact = await options.artifactStore.putText(options.runId, content, { filename: "observed-flag.txt" });
        await runtime.observeArtifact({ operation: "fixture_read", artifactId: artifact.id });
        observed = true;
      }
      return await inner.prompt(text);
    },
    async close() {
      await inner.close();
      await runtime.close();
    },
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
  category?: string;
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
  /** Optional short environment expiry used by deadline/abort regression tests. */
  expiresAt?: number;
  /** Compute the expiry when the platform environment is actually created. */
  expiresInMs?: number;
  /** Number of initial stop calls that should fail before cleanup recovers. */
  stopFailures?: number;
}

class FakeApi implements CompetitionApi {
  /** The fake exposes the same stable key that inspectEnvironment echoes. */
  public readonly environmentIdentity = { strategy: "idempotency-key" as const, stableAcrossRestart: true };
  public submitted: Array<{ id: string; flag: string }> = [];
  public started: string[] = [];
  public startKeys: Array<{ id: string; key?: string }> = [];
  public stopped: string[] = [];
  private readonly environmentExpiries = new Map<string, number>();
  public constructor(private readonly specs: FakeChallengeSpec[]) {}
  private spec(id: string): FakeChallengeSpec {
    const found = this.specs.find((s) => s.id === id);
    if (!found) throw new Error(`unknown challenge ${id}`);
    return found;
  }
  private expiry(spec: FakeChallengeSpec): number | undefined {
    if (spec.expiresInMs === undefined) return spec.expiresAt;
    const existing = this.environmentExpiries.get(spec.id);
    if (existing !== undefined) return existing;
    const expiry = Date.now() + spec.expiresInMs;
    this.environmentExpiries.set(spec.id, expiry);
    return expiry;
  }
  async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.specs.map((s) => ({ challengeId: s.id, title: `T-${s.id}`, category: s.category ?? "Misc", normalizedCategory: normalizeCategory(s.category ?? "Misc"), value: s.value }));
  }
  async getChallenge(id: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    const s = this.spec(id);
    if (s.detailError) throw s.detailError;
    const attachments = s.dynamic ? [] : [{ name: "flag.txt", base64: Buffer.from(`the flag is ${s.attachmentFlag ?? s.flag}`).toString("base64") }];
    return {
      summary: { challengeId: s.id, title: `T-${s.id}`, category: s.category ?? "Misc", normalizedCategory: normalizeCategory(s.category ?? "Misc"), value: s.value },
      attachments,
    };
  }
  async startEnvironment(id: string, options: { idempotencyKey?: string } = {}): Promise<CompetitionEnvironment> {
    const s = this.spec(id);
    const expiresAt = this.expiry(s);
    this.started.push(id);
    this.startKeys.push({ id, ...(options.idempotencyKey ? { key: options.idempotencyKey } : {}) });
    if (s.startError) throw new Error(s.startError);
    return s.dynamic
      ? { instanceId: `inst-${id}`, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}), teamFlag: s.flag, ...(expiresAt === undefined ? {} : { expiresAt }) }
      : { instanceId: `inst-${id}`, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}), connectionInfo: "nc host 1337", ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  async inspectEnvironment(id: string, instanceId?: string, options: { idempotencyKey?: string } = {}): Promise<CompetitionEnvironmentInspection> {
    const s = this.spec(id);
    const expiresAt = this.expiry(s);
    if (this.stopped.includes(id)) return { status: "ABSENT", challengeId: id, instanceId };
    return {
      status: "ACTIVE",
      challengeId: id,
      instanceId: instanceId ?? `inst-${id}`,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  async submitFlag(id: string, flag: string) {
    this.submitted.push({ id, flag });
    const s = this.spec(id);
    if (s.submitError) throw new Error(s.submitError);
    return { correct: flag === s.flag };
  }
  async stopEnvironment(id: string): Promise<void> {
    const s = this.spec(id);
    if ((s.stopFailures ?? 0) > 0) {
      s.stopFailures = (s.stopFailures ?? 0) - 1;
      throw new Error("platform stop unavailable");
    }
    this.stopped.push(id);
  }
}

test("real solver drives a security target to SOLVED on the coding lane via external_submit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-"));
  try {
    const api = new FakeApi([{ id: "CH1", value: 100, flag: "flag{solver_ok}" }]);
    let legacyOptions: { legacyClaimVerification?: boolean; legacySubmissionAlias?: boolean } | undefined;
    const genericLane: CompetitionLaneFactory = async (options) => {
      legacyOptions = { legacyClaimVerification: options.legacyClaimVerification, legacySubmissionAlias: options.legacySubmissionAlias };
      return await flagLane(options);
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: genericLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, true, result.status);
    assert.equal(legacyOptions?.legacyClaimVerification, undefined, "competition lanes do not force the legacy verification alias");
    assert.equal(legacyOptions?.legacySubmissionAlias, undefined, "competition lanes do not force the legacy submission alias");
    assert.equal(result.status, "SOLVED");
    assert.equal(result.submissions, 1, "exactly one submission may be spent on a first-try solve");
    assert.match(api.startKeys[0]?.key ?? "", /^proofblade-env-/);
    assert.ok(api.submitted.some((s) => s.id === "CH1" && s.flag === "flag{solver_ok}"));
    assert.ok(api.stopped.includes("CH1"), "environment must be released");
    const runIds = await readdir(join(root, "runs"));
    const events = (await readFile(join(root, "runs", runIds[0]!, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; payload?: { domainPhase?: string; status?: string } });
    assert.equal(events.filter((event) => event.type === "work_item_claimed").length, 1);
    assert.equal(events.filter((event) => event.type === "work_item_completed").length, 1);
    assert.deepEqual(events.filter((event) => event.type === "domain_phase_changed").map((event) => event.payload?.domainPhase), ["RECON", "REPORT", "SUBMIT"]);
    const runId = (await readdir(join(root, "runs")))[0]!;
    const projection = JSON.parse(await readFile(join(root, "runs", runId, "projection.json"), "utf8")) as RunSnapshot;
    assert.equal(hasAcceptedPlatformSubmission(projection), true);
    assert.equal(projection.status, "SUCCEEDED", "a platform solve must commit a durable terminal result");
    assert.equal(projection.finalResult?.completionId, Object.values(projection.completions).find((item) => item.status === "ACCEPTED")?.id);
    assert.deepEqual(projection.finalResult?.evidenceIds, Object.values(projection.completions).find((item) => item.status === "ACCEPTED")?.evidenceIds);

    const unrelatedAccepted = structuredClone(projection);
    const acceptedCompletion = Object.values(unrelatedAccepted.completions).find((item) => item.status === "ACCEPTED")!;
    acceptedCompletion.purpose = "claim_reproduction";
    assert.equal(hasAcceptedPlatformSubmission(unrelatedAccepted), false, "a non-submission completion cannot combine with an unrelated scorer Effect");

    const mismatchedVerdict = structuredClone(projection);
    const submittedCompletion = Object.values(mismatchedVerdict.completions).find((item) => item.status === "ACCEPTED")!;
    const evidence = mismatchedVerdict.evidence[submittedCompletion.evidenceIds[0]!]!;
    const sourceEffectId = evidence.provenance.effect!.id;
    const sourceEffect = mismatchedVerdict.effects[sourceEffectId]!;
    mismatchedVerdict.effects["EF-UNRELATED-REJECTION"] = {
      ...sourceEffect,
      id: "EF-UNRELATED-REJECTION",
      verification: { ...sourceEffect.verification!, accepted: false, completionId: "C-UNRELATED" },
    };
    evidence.provenance.effect!.id = "EF-UNRELATED-REJECTION";
    assert.equal(hasAcceptedPlatformSubmission(mismatchedVerdict), false, "an accepted Completion must bind its own accepted scorer verdict");
    assert.deepEqual(events.filter((event) => event.type === "run_finished").map((event) => event.payload?.status), ["SUCCEEDED"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition solver registers and releases environments through the durable janitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-janitor-"));
  try {
    const api = new FakeApi([{ id: "JANITOR", value: 100, flag: "flag{janitor}" }]);
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "runs", "environment-ledger.json") });
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, environmentJanitor: janitor, mode: "auto", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.status);
    assert.deepEqual(await janitor.active(), []);
    const records = await janitor.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "STOPPED");
    assert.equal(records[0]?.instanceId, "inst-JANITOR");
    assert.deepEqual(api.stopped, ["JANITOR"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Fleet -> run actor -> observer -> verifier replays one atomic terminal commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-composition-"));
  try {
    const api = new FakeApi([{ id: "COMPOSE", value: 100, flag: "flag{compose}" }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "auto", maxTurns: 1, createLane: observedFlagLane });
    const snapshot = await new FleetScheduler({ api, solver, concurrency: 1 }).run();

    assert.equal(snapshot.totals.solved, 1);
    assert.equal(snapshot.totals.failed, 0);
    const runIds = await readdir(join(root, "runs"));
    assert.equal(runIds.length, 1, "the fleet must create one run for one challenge");
    const runId = runIds[0]!;
    const eventStore = new JsonlControlStore(join(root, "runs"));
    const events = await eventStore.events(runId);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("observation_added"), "the observer event must be durable");
    assert.ok(types.includes("evidence_added"), "the evidence event must be durable");

    const submitPhaseIndex = events.findIndex((event) => event.type === "domain_phase_changed" && event.payload?.domainPhase === "SUBMIT");
    assert.ok(submitPhaseIndex >= 0, "the terminal commit must enter SUBMIT");
    const reportPhaseIndex = events.findIndex((event) => event.type === "domain_phase_changed" && event.payload?.domainPhase === "REPORT");
    assert.ok(reportPhaseIndex >= 0 && reportPhaseIndex < submitPhaseIndex, "the report phase must precede SUBMIT");
    assert.deepEqual(types.slice(submitPhaseIndex, submitPhaseIndex + 3), ["domain_phase_changed", "work_item_completed", "run_finished"]);

    const replayed = await eventStore.replay(runId);
    assert.equal(replayed.status, "SUCCEEDED");
    assert.equal(replayed.domainPhase, "SUBMIT");
    assert.ok(Object.values(replayed.workItems).some((item) => item.status === "SUCCEEDED"));
    assert.ok(Object.keys(replayed.observations).length >= 1);
    assert.ok(Object.keys(replayed.evidence).length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition deadline aborts a prompt already inside the Pi loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-deadline-"));
  let aborted = false;
  try {
    const api = new FakeApi([{ id: "DEADLINE", value: 100, flag: "flag{never_reached}", expiresInMs: 3_000 }]);
    const hangingLane: CompetitionLaneFactory = async () => {
      let resolvePrompt: ((outcome: { text: string; stopReason: string; usage: ReturnType<typeof zeroUsage> }) => void) | undefined;
      return {
        prompt: async () => await new Promise((resolve) => { resolvePrompt = resolve; }),
        compact: async () => undefined,
        abort: async () => {
          aborted = true;
          resolvePrompt?.({ text: "deadline", stopReason: "aborted", usage: zeroUsage() });
        },
        isIdle: async () => true,
        close: async () => undefined,
      };
    };
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 4, createLane: hangingLane });
    const started = Date.now();
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, false);
    assert.equal(result.status, "DEADLINE");
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 5_000, "in-flight prompt must not outlive the challenge deadline");
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
    assert.equal(events.filter((event) => event.type === "work_item_blocked").length, 1, "approval wait must remain resumable in the work graph");
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

test("platform-provided result uses the normal agent loop and remains journaled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dyn-"));
  try {
    const api = new FakeApi([{ id: "DYN", value: 50, flag: "flag{dynamic}", dynamic: true }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
    assert.equal(result.solved, true);
    assert.equal(result.status, "SOLVED");
    assert.deepEqual(api.submitted, [{ id: "DYN", flag: "flag{dynamic}" }]);
    assert.ok(api.stopped.includes("DYN"));
    const runIds = await readdir(join(root, "runs"));
    const events = (await readFile(join(root, "runs", runIds[0]!, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; payload?: { domainPhase?: string; status?: string } });
    assert.ok(events.some((event) => event.type === "effect_finished"), "external submission must be journaled");
    assert.ok(events.some((event) => event.type === "work_item_claimed"), "the normal agent loop must claim a work item");
    assert.ok(events.some((event) => event.type === "domain_phase_changed" && event.payload?.domainPhase === "REPORT"), "the normal loop must report before submitting");
    assert.equal(events.find((event) => event.type === "run_finished")?.payload?.status, "SUCCEEDED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition solver forwards the Browser verifier and required runtime flag to its lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-browser-runtime-"));
  const browserVerifierFactory: BrowserVerifierFactory = {
    name: "test-browser-runtime",
    async createContext() {
      throw new Error("browser context is not needed by this forwarding test");
    },
  };
  let received: Parameters<CompetitionLaneFactory>[0] | undefined;
  const lane: CompetitionLaneFactory = async (options) => {
    received = options;
    return await flagLane(options);
  };
  const config = {
    ...CONFIG,
    runtime: {
      ...CONFIG.runtime,
      browserBroker: { baseUrl: "http://127.0.0.1:43121", tokenEnv: "TEST_BROWSER_RUNTIME_TOKEN" },
    },
  } satisfies ProofBladeConfig;
  try {
    const api = new FakeApi([{ id: "BROWSER-RUNTIME", value: 100, flag: "flag{browser_runtime}" }]);
    const solver = new CompetitionChallengeSolver({ root, config, api, mode: "auto", maxTurns: 1, createLane: lane, browserVerifierFactory });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.status);
    assert.equal(received?.browserVerifierFactory, browserVerifierFactory);
    assert.equal(received?.browserRuntimeRequired, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition solver preflights only the runtime required by the challenge direction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-runtime-preflight-"));
  try {
    const api = new FakeApi([{ id: "RUNTIME-PREFLIGHT", value: 100, flag: "flag{runtime_preflight}", category: "Pwn" }]);
    const config = {
      ...CONFIG,
      runtime: {
        ...CONFIG.runtime,
        sessionBroker: { baseUrl: "http://127.0.0.1:1", tokenEnv: "PATH" },
      },
    } satisfies ProofBladeConfig;
    const solver = new CompetitionChallengeSolver({ root, config, api, mode: "auto", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, false);
    assert.equal(result.status, "PLATFORM_ERROR");
    assert.match(result.reason ?? "", /runtime preflight/i);
    assert.deepEqual(api.started, ["RUNTIME-PREFLIGHT"], "the platform must be provisioned before dynamic-vs-model-solvable is known");
    assert.deepEqual(api.stopped, ["RUNTIME-PREFLIGHT"], "runtime failure must release the already-provisioned environment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition solver probes one required broker and forwards that result to the lane", async () => {
  let healthRequests = 0;
  const requestUrls: string[] = [];
  const server = createServer((request, response) => {
    requestUrls.push(request.url ?? "");
    if (request.url !== "/v1/session/health") {
      response.writeHead(404).end();
      return;
    }
    healthRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      operation: "health",
      status: "READY",
      capabilities: {
        kinds: ["pwn-session", "http-session"],
        maxRequestBytes: 1_048_576,
        maxResponseBytes: 1_048_576,
        stableAcrossRestart: true,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "pb-solver-runtime-preflight-once-"));
  let received: Parameters<CompetitionLaneFactory>[0] | undefined;
  const lane: CompetitionLaneFactory = async (options) => {
    received = options;
    return await flagLane(options);
  };
  try {
    const api = new FakeApi([{ id: "RUNTIME-PREFLIGHT-ONCE", value: 100, flag: "flag{runtime_preflight_once}", category: "Pwn" }]);
    // The broker only needs a non-empty test credential. PATH can contain
    // non-ByteString characters on Windows, so use the platform's stable ASCII
    // shell path there and PATH elsewhere.
    const tokenEnv = process.platform === "win32" ? "ComSpec" : "PATH";
    const config = {
      ...CONFIG,
      runtime: {
        ...CONFIG.runtime,
        sessionBroker: { baseUrl: `http://127.0.0.1:${address.port}`, tokenEnv },
      },
    } satisfies ProofBladeConfig;
    const solver = new CompetitionChallengeSolver({ root, config, api, mode: "auto", maxTurns: 1, createLane: lane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, `${result.reason ?? result.status}; healthRequests=${healthRequests}; urls=${requestUrls.join(",")}`);
    assert.equal(healthRequests, 1, "the direction-scoped preflight must make one health request");
    assert.deepEqual(received?.sessionRuntimePreflight?.brokers.map((broker) => broker.kind), ["pwn-session"]);
    assert.deepEqual(received?.sessionRuntimeBrokers?.map((broker) => broker.kind), ["pwn-session"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("competition solver ignores an unrelated unavailable session kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-runtime-preflight-unrelated-"));
  try {
    const api = new FakeApi([{ id: "RUNTIME-PREFLIGHT-CRYPTO", value: 100, flag: "flag{runtime_preflight_crypto}", category: "Crypto" }]);
    const config = {
      ...CONFIG,
      runtime: {
        ...CONFIG.runtime,
        sessionBroker: { baseUrl: "http://127.0.0.1:1", tokenEnv: "PATH" },
      },
    } satisfies ProofBladeConfig;
    const solver = new CompetitionChallengeSolver({ root, config, api, mode: "auto", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.deepEqual(api.submitted, [{ id: "RUNTIME-PREFLIGHT-CRYPTO", flag: "flag{runtime_preflight_crypto}" }]);
    assert.deepEqual(api.stopped, ["RUNTIME-PREFLIGHT-CRYPTO"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform-provided result does not require an unused session broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-runtime-preflight-dynamic-"));
  try {
    const api = new FakeApi([{ id: "RUNTIME-PREFLIGHT-DYNAMIC", value: 100, flag: "flag{runtime_preflight_dynamic}", dynamic: true }]);
    const config = {
      ...CONFIG,
      runtime: {
        ...CONFIG.runtime,
        sessionBroker: { baseUrl: "http://127.0.0.1:1", tokenEnv: "PATH" },
      },
    } satisfies ProofBladeConfig;
    const solver = new CompetitionChallengeSolver({ root, config, api, mode: "auto", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.deepEqual(api.submitted, [{ id: "RUNTIME-PREFLIGHT-DYNAMIC", flag: "flag{runtime_preflight_dynamic}" }]);
    assert.deepEqual(api.stopped, ["RUNTIME-PREFLIGHT-DYNAMIC"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired competition environment receives an immediate deadline", () => {
  const task = competitionTask(
    "EXPIRED",
    { challengeId: "EXPIRED", title: "Expired", category: "Misc", normalizedCategory: "misc", value: 1 },
    { instanceId: "inst-expired", connectionInfo: "nc host 1337", expiresAt: Date.now() - 1_000 },
    ".",
    CONFIG,
  );
  assert.equal(task.constraints.deadline_ms, 1);
});

test("solver default janitor retries a failed platform stop on the next fleet reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-default-janitor-"));
  try {
    const api = new FakeApi([{ id: "DYN-RETRY-STOP", value: 100, flag: "flag{retry_stop}", dynamic: true, stopFailures: 1 }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.solved, true, result.reason ?? result.status);
    assert.deepEqual(api.stopped, [], "the first cleanup failure must not be reported as a successful stop");
    await solver.reconcile();
    assert.deepEqual(api.stopped, ["DYN-RETRY-STOP"], "the default durable janitor must retry the recorded failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform-provided result assist records a proposal without contacting the platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dyn-assist-"));
  try {
    const api = new FakeApi([{ id: "DYN-ASSIST", value: 50, flag: "flag{dynamic_assist}", dynamic: true }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, mode: "assist", maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.equal(result.submissions, 0);
    assert.deepEqual(api.submitted, []);
    const runIds = await readdir(join(root, "runs"));
    const events = (await readFile(join(root, "runs", runIds[0]!, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.filter((event) => event.type === "completion_proposed").length, 1);
    assert.equal(events.filter((event) => event.type === "work_item_blocked").length, 1);
    assert.equal(events.filter((event) => event.type === "effect_finished").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured approval policy holds a platform submission before contact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-approval-"));
  try {
    const api = new FakeApi([{ id: "DYN-APPROVAL", value: 50, flag: "flag{approval_required}", dynamic: true }]);
    const approvals = new ApprovalPolicy({ ledgerPath: join(root, "runs", "approvals.json") });
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, approvalPolicy: approvals, maxTurns: 1, createLane: flagLane });
    const result = await solver.solve({ challenge: (await api.listChallenges())[0]!, signal: new AbortController().signal });
    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.equal(api.submitted.length, 0);
    assert.equal((await approvals.pending()).length, 1);
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

test("platform-provided result still requires Docker preflight for a Pwn target", async () => {
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
    assert.equal(result.solved, false);
    assert.equal(result.status, "CONTAINER_ERROR");
    assert.equal(prewarmCalls, 1);
    assert.equal(doctorCalls, 0);
    assert.deepEqual(api.submitted, []);
    assert.deepEqual(api.stopped, ["DYN-DOCKER"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker preflight failure releases the durable environment lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-docker-janitor-"));
  try {
    const api = new FakeApi([{ id: "DOCKER-JANITOR", value: 100, flag: "flag{unused}" }]);
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "runs", "environment-ledger.json") });
    const unavailableRuntime = {
      async prewarm() { throw new Error("docker unavailable"); },
      async doctor() { throw new Error("docker unavailable"); },
    } as unknown as ContainerRuntimePort;
    const dockerConfig: ProofBladeConfig = { ...CONFIG, execution: { backend: "docker", requireFor: ["pwn"] } };
    const challenge = { ...(await api.listChallenges())[0]!, normalizedCategory: "pwn" as const };
    const solver = new CompetitionChallengeSolver({ root, config: dockerConfig, api, environmentJanitor: janitor, containerRuntime: unavailableRuntime });
    const result = await solver.solve({ challenge, signal: new AbortController().signal });

    assert.equal(result.status, "CONTAINER_ERROR");
    assert.deepEqual(await janitor.active(), []);
    assert.equal((await janitor.records())[0]?.status, "STOPPED");
    assert.deepEqual(api.stopped, ["DOCKER-JANITOR"]);
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

test("a platform submission failure trips the fleet circuit and leaves later targets pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-dyn-platform-error-"));
  try {
    const api = new FakeApi([
      { id: "DYN-FAIL", value: 100, flag: "flag{dynamic}", dynamic: true, submitError: "DASCTF API unavailable" },
      { id: "DYN-PENDING", value: 50, flag: "flag{unused}", dynamic: true },
    ]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
    const scheduler = new FleetScheduler({ api, solver, concurrency: 1 });
    const snapshot = await scheduler.run();

    assert.deepEqual(api.submitted, [{ id: "DYN-FAIL", flag: "flag{dynamic}" }], "the pending challenge must not reach submitFlag");
    assert.equal(snapshot.totals.failed, 1);
    assert.equal(snapshot.totals.pending, 1);
    assert.match(snapshot.challenges.find((item) => item.challengeId === "DYN-FAIL")?.reason ?? "", /provider|submit|platform/i);
    assert.ok(api.stopped.includes("DYN-FAIL"), "the failed platform environment must still be released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a provisioning failure performs best-effort teardown and returns a platform terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-solver-provision-error-"));
  try {
    const api = new FakeApi([{ id: "BUILD-FAIL", value: 100, flag: "flag{unused}", startError: "readiness poll timed out" }]);
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
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
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
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
    const solver = new CompetitionChallengeSolver({ root, config: CONFIG, api, maxTurns: 1, createLane: flagLane });
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
      const verifier = options.claimVerifier;
      return {
        async prompt() {
          const text = await readFile(join(options.projectRoot, "flag.txt"), "utf8");
          const candidate = text.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0] ?? "";
          await verifier.record({
            candidate,
            command: `grep -o 'flag{[^}]*}' flag.txt`,
            cwd: options.projectRoot,
            toolCallId: `vc-${snapshot.generation}`,
            execute: async () => ({ stdout: candidate, stderr: "", exitCode: 0, durationMs: 1 }),
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
    const claimEffect = events.find((event) => event.type === "effect_proposed" && (event.payload.effect as { operation?: string } | undefined)?.operation === "claim_observation");
    const claimEvidence = events.find((event) => event.type === "evidence_added")?.payload.evidence as { kind?: string; provenance?: { recordedBy?: string } } | undefined;
    assert.equal(proposed.length, 1, "verify_claim must still record its candidate as a proposal");
    assert.deepEqual(verified, [], "verify_claim must not mark a completion ACCEPTED when the platform is the judge");
    assert.equal((claimEffect?.payload.effect as { producerLane?: string } | undefined)?.producerLane, "executor", "a model-selected command must not run as a verifier Effect");
    assert.equal(claimEvidence?.kind, "observation");
    assert.equal(claimEvidence?.provenance?.recordedBy, "agent", "a model-selected command must not receive verifier provenance");
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
      const verifier = options.claimVerifier;
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
            toolCallId: `vc-${snapshot.generation}`,
            execute: async () => ({ stdout: candidate, stderr: "", exitCode: 0, durationMs: 1 }),
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
      const verifier = options.claimVerifier;
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
              toolCallId: `vc-${i}`,
              execute: async () => ({ stdout: candidate, stderr: "", exitCode: 0, durationMs: 1 }),
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
