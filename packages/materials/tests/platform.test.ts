import assert from "node:assert/strict";
import test from "node:test";
import { CompetitionPlatformError } from "../src/platform/contracts.js";
import { CompetitionPlatformSimulator } from "../src/platform/simulator.js";

test("contest simulator exposes bounded challenge data without hidden answers", async () => {
  const simulator = createSimulator();
  const contest = await simulator.snapshot();
  assert.equal(contest.status, "RUNNING");
  assert.equal(contest.score, 0);

  const challenges = await simulator.listChallenges();
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0]?.status, "OPEN");
  assert.equal(challenges[0]?.attachments[0]?.name, "challenge.txt");
  assert.doesNotMatch(JSON.stringify(challenges), /PB\{platform_simulator\}/);

  const opened = await simulator.openAttachment("REV-001", "challenge.txt");
  const chunks: Uint8Array[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  assert.equal(body, "analyze me\n");
  assert.equal(opened.attachment.bytes, Buffer.byteLength(body));
  assert.match(opened.attachment.sha256, /^[a-f0-9]{64}$/);
});

test("contest simulator distinguishes scheduled, running, and ended challenge states", async () => {
  let nowMs = Date.parse("2026-08-06T08:59:59.000Z");
  const simulator = createSimulator({ now: () => new Date(nowMs) });

  assert.equal((await simulator.snapshot()).status, "SCHEDULED");
  assert.equal((await simulator.listChallenges())[0]?.status, "LOCKED");
  await assert.rejects(
    () => simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{platform_simulator}", attemptKey: "ATTEMPT-EARLY" }),
    (error: unknown) => error instanceof CompetitionPlatformError && error.code === "CONTEST_NOT_RUNNING",
  );

  nowMs = Date.parse("2026-08-06T12:00:00.000Z");
  assert.equal((await simulator.snapshot()).status, "ENDED");
  assert.equal((await simulator.listChallenges())[0]?.status, "CLOSED");
});

test("contest simulator models wrong answers, cooldown, acceptance, and duplicate submissions", async () => {
  let nowMs = Date.parse("2026-08-06T10:00:00.000Z");
  const simulator = createSimulator({ now: () => new Date(nowMs) });

  const wrong = await simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{wrong}", attemptKey: "ATTEMPT-1" });
  assert.equal(wrong.status, "WRONG");
  assert.equal(wrong.cooldownUntil, "2026-08-06T10:00:30.000Z");

  nowMs += 10_000;
  const cooled = await simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{platform_simulator}", attemptKey: "ATTEMPT-2" });
  assert.equal(cooled.status, "COOLDOWN");
  assert.equal(cooled.cooldownUntil, wrong.cooldownUntil);

  nowMs += 21_000;
  const accepted = await simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{platform_simulator}", attemptKey: "ATTEMPT-3" });
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.scoreAwarded, 100);
  assert.equal((await simulator.snapshot()).score, 100);

  const duplicate = await simulator.submitCandidate({ challengeId: "REV-001", candidate: "anything", attemptKey: "ATTEMPT-4" });
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal((await simulator.listChallenges())[0]?.status, "SOLVED");
});

test("contest simulator reconciles a submission committed before response loss", async () => {
  const simulator = createSimulator({ disconnectAfterCommit: ({ attemptKey }) => attemptKey === "ATTEMPT-LOST" });
  const input = { challengeId: "REV-001", candidate: "PB{platform_simulator}", attemptKey: "ATTEMPT-LOST" };

  await assert.rejects(
    () => simulator.submitCandidate(input),
    (error: unknown) => error instanceof CompetitionPlatformError && error.code === "PLATFORM_UNAVAILABLE" && error.retryable,
  );

  const reconciled = await simulator.reconcileSubmission(input.attemptKey, input.challengeId);
  assert.equal(reconciled.status, "CONFIRMED");
  assert.equal(reconciled.receipt?.status, "ACCEPTED");
  assert.equal(reconciled.challengeStatus, "SOLVED");

  const retried = await simulator.submitCandidate(input);
  assert.deepEqual(retried, reconciled.receipt);
  assert.equal((await simulator.snapshot()).score, 100);
});

test("contest simulator fails closed when an attempt key is reused for different content", async () => {
  const simulator = createSimulator();
  await simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{wrong}", attemptKey: "ATTEMPT-COLLISION" });
  await assert.rejects(
    () => simulator.submitCandidate({ challengeId: "REV-001", candidate: "PB{other}", attemptKey: "ATTEMPT-COLLISION" }),
    (error: unknown) => error instanceof CompetitionPlatformError && error.code === "PLATFORM_PROTOCOL_ERROR" && !error.retryable,
  );
});

function createSimulator(options: ConstructorParameters<typeof CompetitionPlatformSimulator>[2] = {}): CompetitionPlatformSimulator {
  return CompetitionPlatformSimulator.create({
    contestId: "CONTEST-001",
    name: "Synthetic unattended contest",
    startsAt: "2026-08-06T09:00:00.000Z",
    endsAt: "2026-08-06T12:00:00.000Z",
    challenges: [
      {
        id: "REV-001",
        title: "Synthetic reverse",
        category: "reverse",
        description: "Recover the hidden candidate from the attachment.",
        points: 100,
        answer: "PB{platform_simulator}",
        cooldownMs: 30_000,
        attachments: { "challenge.txt": "analyze me\n" },
      },
    ],
  }, { now: options.now ?? (() => new Date("2026-08-06T10:00:00.000Z")), disconnectAfterCommit: options.disconnectAfterCommit });
}
