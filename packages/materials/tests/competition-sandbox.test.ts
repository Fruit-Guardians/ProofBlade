import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@proofblade/atoms";
import { CompetitionSandbox } from "../src/competition/sandbox.js";
import { competitionTask } from "../src/competition/task.js";
import { normalizeCategory, type CompetitionApi, type CompetitionChallengeSummary } from "../src/competition/api.js";
import type { ProofBladeConfig } from "../src/config.js";

const CONFIG = { storage: { runsDir: "runs" } } as unknown as ProofBladeConfig;

class FakeCompetitionApi implements CompetitionApi {
  public submissions: string[] = [];
  public stopped = 0;
  public constructor(private readonly acceptFlag: string) {}
  async listChallenges() {
    return [];
  }
  async getChallenge() {
    return { summary: {} as CompetitionChallengeSummary, attachments: [] };
  }
  async startEnvironment() {
    return { instanceId: "inst-1", connectionInfo: "nc host 1337" };
  }
  async submitFlag(_challengeId: string, flag: string) {
    this.submissions.push(flag);
    return { correct: flag === this.acceptFlag };
  }
  async stopEnvironment() {
    this.stopped += 1;
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
  const task = competitionTask("RUN-1", summary(), { connectionInfo: "nc host 1337" }, "/root", CONFIG);
  assert.equal(task.verification.kind, "platform_submission");
  assert.equal(task.verification.required_reproductions, 1);
  assert.equal(task.scope.external_network, true);
  assert.equal(task.target, "REMOTE:nc host 1337");
  assert.equal(task.target_kind, "web");
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(candidatePath, "  flag{ok}\n", "utf8");

    const good = await sandbox.execute(
      { id: "E1", idempotencyKey: "k1", operation: "fixture_score", replayPolicy: "pure", args: { candidatePath } } as never,
      new AbortController().signal,
    );
    const goodParsed = JSON.parse(good.stdout) as { accepted: boolean; candidateHash: string };
    assert.equal(goodParsed.accepted, true);
    assert.equal(goodParsed.candidateHash, sha256("flag{ok}"));

    await writeFile(candidatePath, "flag{wrong}", "utf8");
    const bad = await sandbox.execute(
      { id: "E2", idempotencyKey: "k2", operation: "fixture_score", replayPolicy: "pure", args: { candidatePath } } as never,
      new AbortController().signal,
    );
    assert.equal((JSON.parse(bad.stdout) as { accepted: boolean }).accepted, false);

    // Exactly the two candidates were submitted — no duplicate reproduction.
    assert.deepEqual(api.submissions, ["flag{ok}", "flag{wrong}"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
