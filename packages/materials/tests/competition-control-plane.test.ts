import assert from "node:assert/strict";
import test from "node:test";
import {
  FleetScheduler,
  normalizeCategory,
  type ChallengeSolveRequest,
  type ChallengeSolveResult,
  type ChallengeSolver,
  type CompetitionApi,
  type CompetitionChallengeSummary,
} from "../src/index.js";

function challenge(id: string, value: number): CompetitionChallengeSummary {
  return { challengeId: id, title: `T-${id}`, category: "Web", normalizedCategory: normalizeCategory("Web"), value };
}

class FakeApi implements CompetitionApi {
  public constructor(private readonly challenges: CompetitionChallengeSummary[]) {}
  async listChallenges() {
    return this.challenges;
  }
  async getChallenge() {
    return { summary: challenge("x", 0), attachments: [] };
  }
  async startEnvironment() {
    return {};
  }
  async submitFlag() {
    return { correct: true };
  }
  async stopEnvironment() {}
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("cancelChallenge drops a pending challenge before it starts", async () => {
  const ids = [challenge("a", 30), challenge("b", 20), challenge("c", 10)];
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      await delay(20);
      return { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 });
  await scheduler.load();
  scheduler.cancelChallenge("c"); // lowest priority, still pending
  const snapshot = await scheduler.run();
  const c = snapshot.challenges.find((x) => x.challengeId === "c");
  assert.equal(c?.state, "cancelled");
  assert.equal(snapshot.totals.solved, 2);
  assert.equal(snapshot.totals.cancelled, 1);
});

test("cancelChallenge aborts a running challenge", async () => {
  const ids = [challenge("solo", 10)];
  const solver: ChallengeSolver = {
    solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      return new Promise((_resolve, reject) => {
        if (request.signal.aborted) return reject(new Error("aborted"));
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 });
  const runPromise = scheduler.run();
  await delay(10); // let the worker pick up "solo"
  scheduler.cancelChallenge("solo");
  const snapshot = await runPromise;
  const solo = snapshot.challenges.find((x) => x.challengeId === "solo");
  assert.equal(solo?.state, "cancelled");
});

test("setConcurrency grows the live worker pool", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => challenge(`C${i}`, i));
  let live = 0;
  let peak = 0;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      live += 1;
      peak = Math.max(peak, live);
      await delay(30);
      live -= 1;
      return { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 });
  const runPromise = scheduler.run();
  await delay(10); // running at concurrency 1
  scheduler.setConcurrency(4);
  const snapshot = await runPromise;
  assert.ok(peak >= 2, `expected pool to grow past 1, peak was ${peak}`);
  assert.ok(peak <= 4, `expected pool capped at 4, peak was ${peak}`);
  assert.equal(snapshot.totals.solved, 12);
});

test("setConcurrency shrinks the live worker pool", async () => {
  const ids = Array.from({ length: 16 }, (_, i) => challenge(`C${i}`, i));
  let live = 0;
  const peaksAfterShrink: number[] = [];
  let shrunk = false;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      live += 1;
      if (shrunk) peaksAfterShrink.push(live);
      await delay(20);
      live -= 1;
      return { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 6 });
  const runPromise = scheduler.run();
  await delay(10);
  scheduler.setConcurrency(2);
  shrunk = true;
  await runPromise;
  // After shrinking, no new solve should observe more than 2 concurrent runs.
  assert.ok(peaksAfterShrink.every((n) => n <= 2), `post-shrink concurrency exceeded 2: ${peaksAfterShrink}`);
});

test("setChallengeMode propagates live to a running solve", async () => {
  const ids = [challenge("m", 10)];
  let observedMode: string | undefined;
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      // Poll the live mode getter until it flips or we give up.
      for (let i = 0; i < 40; i += 1) {
        if (request.mode?.() === "assist") {
          observedMode = "assist";
          break;
        }
        await delay(5);
      }
      return { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1, defaultMode: "auto" });
  const runPromise = scheduler.run();
  await delay(15);
  scheduler.setChallengeMode("m", "assist");
  await runPromise;
  assert.equal(observedMode, "assist");
});

test("switching an awaiting approval challenge back to auto requeues it", async () => {
  const ids = [challenge("approval", 10)];
  let calls = 0;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      calls += 1;
      return calls === 1
        ? { solved: false, status: "AWAITING_APPROVAL", reason: "operator review" }
        : { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1, defaultMode: "assist" });
  const held = await scheduler.run();
  assert.equal(held.challenges[0]?.state, "awaiting_approval");
  scheduler.setChallengeMode("approval", "auto");
  const resumed = await scheduler.run();
  assert.equal(resumed.challenges[0]?.state, "solved");
  assert.equal(calls, 2);
});
