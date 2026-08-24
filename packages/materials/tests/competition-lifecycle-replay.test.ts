import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompetitionSandbox } from "../src/competition/sandbox.js";
import { CompetitionApiJournal } from "../src/competition/api-journal.js";
import { replayCompetitionApiScript } from "../src/competition/api-replay.js";
import { createServices } from "../src/app/demo.js";
import { IndependentVerifier } from "../src/verification/verifier.js";
import type { ProofBladeConfig } from "../src/config.js";
import type {
  CompetitionApi,
  CompetitionAttachment,
  CompetitionChallengeSummary,
  CompetitionEnvironment,
  CompetitionSubmitResult,
} from "../src/competition/api.js";
import { NotConfiguredCompetitionApi } from "../src/competition/api.js";

type LifecycleCall =
  | { method: "listChallenges" }
  | { method: "getChallenge"; challengeId: string }
  | { method: "startEnvironment"; challengeId: string }
  | { method: "submitFlag"; challengeId: string; flag: string }
  | { method: "stopEnvironment"; challengeId: string; instanceId?: string };

const challenge: CompetitionChallengeSummary = {
  challengeId: "REPLAY-1",
  title: "offline replay",
  category: "Pwn",
  normalizedCategory: "pwn",
  value: 100,
};

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

/** Deterministic platform double: every exchange is serializable and replayable. */
class ScriptedCompetitionApi implements CompetitionApi {
  public readonly calls: LifecycleCall[] = [];
  public readonly submissions: string[] = [];

  public constructor(private readonly replay: readonly LifecycleCall[] = []) {}

  public async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    this.expect({ method: "listChallenges" });
    return [structuredClone(challenge)];
  }

  public async getChallenge(challengeId: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    this.expect({ method: "getChallenge", challengeId });
    return { summary: structuredClone(challenge), attachments: [{ name: "flag.txt", base64: Buffer.from("PB{replay_flag}\n").toString("base64") }] };
  }

  public async startEnvironment(challengeId: string): Promise<CompetitionEnvironment> {
    this.expect({ method: "startEnvironment", challengeId });
    return { instanceId: "instance-replay-1", connectionInfo: "nc replay 31337" };
  }

  public async submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult> {
    this.expect({ method: "submitFlag", challengeId, flag });
    this.submissions.push(flag);
    return { correct: flag === "PB{replay_flag}", message: "offline verdict" };
  }

  public async stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    this.expect({ method: "stopEnvironment", challengeId, ...(instanceId ? { instanceId } : {}) });
  }

  private expect(call: LifecycleCall): void {
    const expected = this.replay[this.calls.length];
    if (expected && !sameCall(expected, call)) throw new Error(`Replay divergence at ${this.calls.length}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(call)}`);
    this.calls.push(structuredClone(call));
  }
}

test("competition API and environment lifecycle replay without contacting a platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-competition-replay-"));
  try {
    const live = new ScriptedCompetitionApi();
    const listed = await live.listChallenges();
    const detail = await live.getChallenge(listed[0]!.challengeId);
    const environment = await live.startEnvironment(listed[0]!.challengeId);
    const sandbox = new CompetitionSandbox({ api: live, challengeId: listed[0]!.challengeId, workspaceRoot: root, attachments: detail.attachments, environment });
    const fixture = await sandbox.build({
      task_id: "REPLAY-1",
      objective: "offline lifecycle replay",
      target: "nc replay 31337",
      target_kind: "pwn",
      mode: "auto",
      scope: { allowed_hosts: ["replay"], allowed_ports: [31337], external_network: false, allowed_workspace: root },
      constraints: { max_tool_calls: 10, deadline_ms: 30_000, max_output_bytes: 10_000, max_artifact_bytes: 10_000, max_context_tokens: 4_000 },
      verification: { kind: "platform_submission" },
    });
    const candidatePath = join(fixture.path, "candidate.txt");
    await writeFile(candidatePath, "PB{replay_flag}\n", "utf8");
    const result = await sandbox.execute({ id: "E-REPLAY", idempotencyKey: "K-REPLAY", operation: "fixture_score", replayPolicy: "forbidden-replay", args: { candidatePath } } as never, new AbortController().signal);
    assert.equal(JSON.parse(result.stdout).accepted, true);
    await sandbox.close();
    await sandbox.close();

    const journal = live.calls;
    assert.deepEqual(journal.map((call) => call.method), ["listChallenges", "getChallenge", "startEnvironment", "submitFlag", "stopEnvironment"]);
    assert.deepEqual(live.submissions, ["PB{replay_flag}"]);

    const replay = new ScriptedCompetitionApi(journal);
    const replayedList = await replay.listChallenges();
    const replayedDetail = await replay.getChallenge(replayedList[0]!.challengeId);
    const replayedEnvironment = await replay.startEnvironment(replayedList[0]!.challengeId);
    const replaySandbox = new CompetitionSandbox({ api: replay, challengeId: replayedList[0]!.challengeId, workspaceRoot: join(root, "replay"), attachments: replayedDetail.attachments, environment: replayedEnvironment });
    const replayFixture = await replaySandbox.build({
      task_id: "REPLAY-1",
      objective: "offline lifecycle replay",
      target: "nc replay 31337",
      target_kind: "pwn",
      mode: "auto",
      scope: { allowed_hosts: ["replay"], allowed_ports: [31337], external_network: false, allowed_workspace: join(root, "replay") },
      constraints: { max_tool_calls: 10, deadline_ms: 30_000, max_output_bytes: 10_000, max_artifact_bytes: 10_000, max_context_tokens: 4_000 },
      verification: { kind: "platform_submission" },
    });
    const replayCandidatePath = join(replayFixture.path, "candidate.txt");
    await writeFile(replayCandidatePath, "PB{replay_flag}\n", "utf8");
    const replayResult = await replaySandbox.execute({ id: "E-REPLAY", idempotencyKey: "K-REPLAY", operation: "fixture_score", replayPolicy: "forbidden-replay", args: { candidatePath: replayCandidatePath } } as never, new AbortController().signal);
    assert.deepEqual(JSON.parse(replayResult.stdout), JSON.parse(result.stdout));
    await replaySandbox.close();
    assert.deepEqual(replay.calls, journal, "replay must consume the exact lifecycle journal");
    assert.deepEqual(replay.submissions, ["PB{replay_flag}"], "the replay verdict is local and never invokes a live API");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition scoring is verifier-owned and leaves replayable Evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-verifier-owned-score-"));
  try {
    const api = new ScriptedCompetitionApi();
    const environment = await api.startEnvironment(challenge.challengeId);
    const sandbox = new CompetitionSandbox({ api, challengeId: challenge.challengeId, workspaceRoot: join(root, "workspace"), attachments: [], environment });
    const services = createServices(root, config, { sandbox });
    const runId = "VERIFIER-OWNED-SCORE";
    const task = {
      schema_version: 1,
      task_id: runId,
      objective: "verifier-owned competition score",
      target: "nc replay 31337",
      target_kind: "pwn" as const,
      mode: "auto" as const,
      inputs: [],
      success_criteria: ["The platform verifier accepts the candidate."],
      scope: { allowed_hosts: ["replay"], allowed_ports: [31337], external_network: false, allowed_workspace: join(root, "workspace", runId) },
      constraints: { max_tool_calls: 10, deadline_ms: 30_000, max_output_bytes: 10_000, max_artifact_bytes: 10_000, max_context_tokens: 4_000, max_submissions: 2 },
      verification: { kind: "platform_submission" as const, required_reproductions: 1 },
      pause_policy: ["irreversible_external_effect" as const],
    };
    await services.control.createRun(runId, task);
    const fixture = await sandbox.build(task);
    const candidate = "PB{replay_flag}";
    const artifact = await services.artifacts.putText(runId, candidate, { filename: "candidate.txt", sensitivity: "flag_candidate" });
    const completionId = "C-VERIFIER-OWNED";
    const candidateHash = createHash("sha256").update(candidate).digest("hex");
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "submission", candidateHash, artifactId: artifact.id },
      lane: "executor",
    });
    const verified = await new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, services.runsRoot, services.verifier)
      .verify(runId, fixture, completionId);
    assert.equal(verified.accepted, true);
    const snapshot = await services.control.snapshot(runId);
    const evidence = snapshot.evidence[verified.evidenceIds[0]!];
    assert.equal(evidence?.kind, "reproduction");
    assert.equal(evidence?.provenance.recordedBy, "verifier");
    const effectId = evidence?.provenance.effect?.id;
    assert.equal(snapshot.effects[effectId!]?.producerLane, "verifier");
    assert.equal(snapshot.effects[effectId!]?.operation, "fixture_score");
    assert.deepEqual(api.submissions, [candidate]);
    assert.equal(api.calls.filter((call) => call.method === "submitFlag").length, 1);
    await sandbox.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable CompetitionApiJournal replays requests, responses, and failures offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-api-journal-"));
  try {
    const path = join(root, "competition-api.jsonl");
    const live = new ScriptedCompetitionApi();
    const recorder = CompetitionApiJournal.record(live, path);
    assert.deepEqual(await recorder.listChallenges(), [challenge]);
    assert.deepEqual((await recorder.getChallenge("REPLAY-1")).summary, challenge);
    assert.deepEqual(await recorder.startEnvironment("REPLAY-1"), { instanceId: "instance-replay-1", connectionInfo: "nc replay 31337" });
    assert.deepEqual(await recorder.submitFlag("REPLAY-1", "PB{replay_flag}"), { correct: true, message: "offline verdict" });
    await recorder.stopEnvironment("REPLAY-1", "instance-replay-1");
    const summary = await CompetitionApiJournal.inspect(path);
    assert.deepEqual(summary.operations, { listChallenges: 1, getChallenge: 1, startEnvironment: 1, submitFlag: 1, stopEnvironment: 1 });
    assert.equal(summary.failed, 0);

    const replay = await CompetitionApiJournal.replay(path);
    const scripted = await replayCompetitionApiScript(replay, [
      { operation: "listChallenges" },
      { operation: "getChallenge", challengeId: "REPLAY-1" },
      { operation: "startEnvironment", challengeId: "REPLAY-1" },
      { operation: "submitFlag", challengeId: "REPLAY-1", flag: "PB{replay_flag}" },
      { operation: "stopEnvironment", challengeId: "REPLAY-1", instanceId: "instance-replay-1" },
    ]);
    assert.deepEqual(scripted.map((item) => item.operation), ["listChallenges", "getChallenge", "startEnvironment", "submitFlag", "stopEnvironment"]);
    assert.deepEqual(scripted[0]?.result, [challenge]);
    await assert.rejects(() => replay.listChallenges(), /replay exhausted/);
    await assert.rejects(() => CompetitionApiJournal.replay(path).then((journal) => journal.submitFlag("REPLAY-1", "different")), /replay mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CompetitionApiJournal records an API failure and replays the same failure without a delegate", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-api-journal-error-"));
  try {
    const path = join(root, "competition-api.jsonl");
    const recorder = CompetitionApiJournal.record(new NotConfiguredCompetitionApi("offline test platform"), path);
    await assert.rejects(() => recorder.listChallenges(), /offline test platform/);
    const summary = await CompetitionApiJournal.inspect(path);
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.count, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.operations, { listChallenges: 1, getChallenge: 0, startEnvironment: 0, submitFlag: 0, stopEnvironment: 0 });
    const replay = await CompetitionApiJournal.replay(path);
    await assert.rejects(() => replay.listChallenges(), /offline test platform/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sameCall(left: LifecycleCall, right: LifecycleCall): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
