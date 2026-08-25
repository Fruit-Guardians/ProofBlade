import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@proofblade/atoms";
import { CompetitionSandbox } from "../src/competition/sandbox.js";
import { competitionTask } from "../src/competition/task.js";
import { normalizeCategory, type CompetitionApi, type CompetitionChallengeSummary } from "../src/competition/api.js";
import { createServices } from "../src/app/demo.js";
import { IndependentVerifier } from "../src/verification/verifier.js";
import type { ProofBladeConfig } from "../src/config.js";

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

class FakeCompetitionApi implements CompetitionApi {
  public submissions: string[] = [];
  public stopped = 0;
  public starts = 0;
  public stoppedInstances: string[] = [];
  public failStop = false;
  public constructor(private readonly acceptFlag: string) {}
  async listChallenges() {
    return [];
  }
  async getChallenge() {
    return { summary: {} as CompetitionChallengeSummary, attachments: [] };
  }
  async startEnvironment() {
    this.starts += 1;
    return { instanceId: `inst-${this.starts}`, connectionInfo: "nc host 1337" };
  }
  async submitFlag(_challengeId: string, flag: string) {
    this.submissions.push(flag);
    return { correct: flag === this.acceptFlag };
  }
  async stopEnvironment(_challengeId: string, instanceId?: string) {
    this.stopped += 1;
    this.stoppedInstances.push(instanceId ?? "none");
    if (this.failStop) throw new Error("teardown failed");
  }
}

function summary(): CompetitionChallengeSummary {
  return {
    challengeId: "CH-1",
    title: "Sample",
    category: "Web",
    normalizedCategory: normalizeCategory("Web"),
    value: 100,
  };
}

test("normalizeCategory maps common platform labels", () => {
  assert.equal(normalizeCategory("Web"), "web");
  assert.equal(normalizeCategory("Cryptography"), "crypto");
  assert.equal(normalizeCategory("Reversing"), "reverse");
  assert.equal(normalizeCategory("something else"), "unknown");
});

test("competitionTask uses platform_submission with a single reproduction", () => {
  const task = competitionTask("RUN-1", summary(), { connectionInfo: "nc host 1337" }, "/root", CONFIG, [
    { name: "challenge.bin", base64: Buffer.from("binary fixture").toString("base64") },
  ]);
  assert.equal(task.verification.kind, "platform_submission");
  assert.equal(task.verification.required_reproductions, 1);
  assert.equal(task.scope.external_network, true);
  assert.equal(task.scope.allowed_workspace, join("/root", "fixtures/runtime", "RUN-1"));
  assert.deepEqual(task.scope.allowed_endpoints, [{ host: "host", port: 1337 }]);
  assert.equal(task.target, "REMOTE:nc host 1337");
  assert.equal(task.target_kind, "web");
  assert.deepEqual(task.inputs, [
    { path: "challenge.bin", sha256: sha256("binary fixture"), read_only: true },
    { path: "connection-info.txt", sha256: sha256("nc host 1337\n"), read_only: true },
  ]);
});

test("competitionTask binds exact endpoint tuples without allowing host-port cross products", () => {
  const task = competitionTask(
    "RUN-ENDPOINTS",
    summary(),
    { connectionInfo: "tcp://pwn-a.example:31337 udp://pwn-b.example:4444" },
    "/root",
    CONFIG,
  );

  assert.deepEqual(task.scope.allowed_hosts, ["pwn-a.example", "pwn-b.example"]);
  assert.deepEqual(task.scope.allowed_ports, [31337, 4444]);
  assert.deepEqual(task.scope.allowed_endpoints, [
    { host: "pwn-a.example", port: 31337 },
    { host: "pwn-b.example", port: 4444 },
  ]);
  assert.equal(task.scope.allowed_endpoints?.some((endpoint) => endpoint.host === "pwn-a.example" && endpoint.port === 4444), false);
  assert.equal(task.scope.allowed_workspace, join("/root", "fixtures/runtime", "RUN-ENDPOINTS"));
});

test("CompetitionSandbox unpacks attachments and writes connection info", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-"));
  try {
    const api = new FakeCompetitionApi("flag{ok}");
    const sandbox = new CompetitionSandbox({
      api,
      challengeId: "CH-1",
      workspaceRoot: root,
      attachments: [{ name: "notes.txt", base64: Buffer.from("hello").toString("base64") }],
      environment: { instanceId: "inst-1", connectionInfo: "nc host 1337" },
    });
    const ref = await sandbox.build({ task_id: "RUN-1" } as never);
    assert.equal(await readFile(join(ref.path, "notes.txt"), "utf8"), "hello");
    assert.equal((await readFile(join(ref.path, "connection-info.txt"), "utf8")).trim(), "nc host 1337");
    await sandbox.close();
    assert.equal(api.stopped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CompetitionSandbox rejects traversal-shaped attachment names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-unsafe-"));
  try {
    const sandbox = new CompetitionSandbox({
      api: new FakeCompetitionApi("flag{ok}"),
      challengeId: "CH-1",
      workspaceRoot: root,
      attachments: [{ name: "../outside.txt", base64: Buffer.from("escape").toString("base64") }],
      environment: { connectionInfo: "nc host 1337" },
    });
    const task = competitionTask("RUN-UNSAFE", summary(), { connectionInfo: "nc host 1337" }, root, CONFIG, [{ name: "../outside.txt", base64: Buffer.from("escape").toString("base64") }]);
    await assert.rejects(() => sandbox.build(task), /Unsafe attachment name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CompetitionSandbox reset releases the old environment before replacing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-"));
  try {
    const api = new FakeCompetitionApi("flag{ok}");
    const sandbox = new CompetitionSandbox({
      api,
      challengeId: "CH-1",
      workspaceRoot: root,
      attachments: [],
      environment: { instanceId: "inst-0", connectionInfo: "nc old 1337" },
    });
    await sandbox.reset({ fixtureId: "RUN-1", generation: 1, path: root, privatePath: join(root, ".proofblade") });
    assert.equal(api.starts, 1);
    assert.deepEqual(api.stoppedInstances, ["inst-0"]);
    await sandbox.close();
    assert.deepEqual(api.stoppedInstances, ["inst-0", "inst-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CompetitionSandbox reset does not create a replacement after teardown failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-"));
  try {
    const api = new FakeCompetitionApi("flag{ok}");
    api.failStop = true;
    const sandbox = new CompetitionSandbox({
      api,
      challengeId: "CH-1",
      workspaceRoot: root,
      attachments: [],
      environment: { instanceId: "inst-0", connectionInfo: "nc old 1337" },
    });
    await assert.rejects(
      () => sandbox.reset({ fixtureId: "RUN-1", generation: 1, path: root, privatePath: join(root, ".proofblade") }),
      /teardown failed/,
    );
    assert.equal(api.starts, 0);
    assert.deepEqual(api.stoppedInstances, ["inst-0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture_score submits to the platform and maps the verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-"));
  try {
    const api = new FakeCompetitionApi("flag{ok}");
    const sandbox = new CompetitionSandbox({
      api,
      challengeId: "CH-1",
      workspaceRoot: root,
      attachments: [],
      environment: {},
    });
    const candidatePath = join(root, "candidate.txt");
    await writeFile(candidatePath, "  flag{ok}\n", "utf8");

    await assert.rejects(
      sandbox.execute(
        { id: "E0", idempotencyKey: "k0", operation: "fixture_score", replayPolicy: "pure", args: { candidatePath } } as never,
        new AbortController().signal,
      ),
      /requires forbidden-replay/,
    );
    assert.deepEqual(api.submissions, [], "a remotely submitted score must never execute under a pure replay policy");
    assert.deepEqual(
      await sandbox.reconcile({ operation: "fixture_score", replayPolicy: "pure" } as never),
      { action: "unknown", outcome: "unknown" },
      "legacy pure platform effects must also reconcile fail-closed",
    );

    const good = await sandbox.execute(
      { id: "E1", idempotencyKey: "k1", operation: "fixture_score", replayPolicy: "forbidden-replay", args: { candidatePath } } as never,
      new AbortController().signal,
    );
    const goodParsed = JSON.parse(good.stdout) as { accepted: boolean; candidateHash: string };
    assert.equal(goodParsed.accepted, true);
    assert.equal(goodParsed.candidateHash, sha256("flag{ok}"));

    await writeFile(candidatePath, "flag{wrong}", "utf8");
    const bad = await sandbox.execute(
      { id: "E2", idempotencyKey: "k2", operation: "fixture_score", replayPolicy: "forbidden-replay", args: { candidatePath } } as never,
      new AbortController().signal,
    );
    assert.equal((JSON.parse(bad.stdout) as { accepted: boolean }).accepted, false);

    // Exactly the two candidates were submitted — no duplicate reproduction.
    assert.deepEqual(api.submissions, ["flag{ok}", "flag{wrong}"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash after a competition submit never replays fixture_score", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-comp-replay-"));
  try {
    const runId = "RUN-CRASH-AFTER-SUBMIT";
    const api = new FakeCompetitionApi("flag{ok}");
    const sandbox = new CompetitionSandbox({
      api,
      challengeId: "CH-1",
      workspaceRoot: join(root, CONFIG.storage.fixturesDir),
      attachments: [],
      environment: {},
    });
    let injectCrash = true;
    const services = createServices(root, CONFIG, {
      sandbox,
      effectFault: (point) => {
        if (injectCrash && point === "after_execute") {
          injectCrash = false;
          throw new Error("simulated crash after remote submit");
        }
      },
    });
    const task = competitionTask(runId, summary(), {}, root, CONFIG);
    await services.control.createRun(runId, task);
    const fixture = await sandbox.build(task);
    const candidateArtifact = await services.artifacts.putText(runId, "flag{ok}", {
      mime: "text/plain",
      filename: "candidate.txt",
      sensitivity: "flag_candidate",
    });
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: {
        id: "C-REMOTE",
        purpose: "submission",
        candidateHash: candidateArtifact.sha256,
        artifactId: candidateArtifact.id,
      },
      lane: "executor",
    });
    const verifier = new IndependentVerifier(
      services.control,
      services.artifacts,
      services.verifierJournal,
      services.runsRoot,
      services.verifier,
    );

    await assert.rejects(verifier.verify(runId, fixture, "C-REMOTE"), /simulated crash after remote submit/);
    assert.deepEqual(api.submissions, ["flag{ok}"], "the platform was contacted exactly once before the crash");
    const interrupted = await services.control.snapshot(runId);
    const effect = Object.values(interrupted.effects).find((item) => item.operation === "fixture_score")!;
    assert.equal(effect.status, "STARTED");
    assert.equal(effect.replayPolicy, "forbidden-replay", "the durable Effect must describe the real external side effect");

    assert.deepEqual(await services.journal.reconcile(runId), [effect.id]);
    const reconciled = await services.control.snapshot(runId);
    assert.equal(reconciled.effects[effect.id]?.status, "UNKNOWN", "an ambiguous platform result must fail closed");
    assert.deepEqual(api.submissions, ["flag{ok}"], "recovery must not submit the flag a second time");

    await assert.rejects(verifier.verify(runId, fixture, "C-REMOTE"), /idempotency key already exists/);
    assert.deepEqual(api.submissions, ["flag{ok}"], "a later verifier call cannot bypass the ambiguous durable Effect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
