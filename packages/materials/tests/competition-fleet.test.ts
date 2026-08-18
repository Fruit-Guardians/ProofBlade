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

function challenge(id: string, value: number, solved = false): CompetitionChallengeSummary {
  return { challengeId: id, title: `T-${id}`, category: "Web", normalizedCategory: normalizeCategory("Web"), value, solved };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("scheduler never exceeds the concurrency cap and processes all pending", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => challenge(`C${i}`, i));
  let live = 0;
  let peak = 0;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      live += 1;
      peak = Math.max(peak, live);
      await delay(5 + Math.floor(Math.random() * 10));
      live -= 1;
      return { solved: true, status: "SOLVED" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 4 });
  const snapshot = await scheduler.run();
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded cap 4`);
  assert.equal(snapshot.totals.solved, 20);
  assert.equal(snapshot.totals.pending, 0);
});

test("higher-value challenges start first at concurrency 1", async () => {
  const ids = [challenge("low", 10), challenge("mid", 50), challenge("high", 100)];
  const order: string[] = [];
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      order.push(request.challenge.challengeId);
      await delay(2);
      return { solved: true, status: "SOLVED" };
    },
  };
  await new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 }).run();
  assert.deepEqual(order, ["high", "mid", "low"]);
});

test("a thrown solve is isolated and marked failed without stopping others", async () => {
  const ids = [challenge("a", 1), challenge("boom", 2), challenge("c", 3)];
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      if (request.challenge.challengeId === "boom") throw new Error("solver blew up");
      return { solved: true, status: "SOLVED" };
    },
  };
  const snapshot = await new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 2 }).run();
  assert.equal(snapshot.totals.solved, 2);
  assert.equal(snapshot.totals.failed, 1);
  const boom = snapshot.challenges.find((c) => c.challengeId === "boom");
  assert.equal(boom?.state, "failed");
  assert.equal(boom?.reason, "solver blew up");
});

test("already-solved challenges are skipped, not resolved", async () => {
  const ids = [challenge("done", 10, true), challenge("todo", 20)];
  let solves = 0;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      solves += 1;
      return { solved: true, status: "SOLVED" };
    },
  };
  const snapshot = await new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 4 }).run();
  assert.equal(solves, 1);
  assert.equal(snapshot.totals.skipped, 1);
  assert.equal(snapshot.totals.solved, 1);
  assert.equal(snapshot.solvedValue, 20);
});

test("abort stops the scheduler from pulling new work", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => challenge(`C${i}`, i));
  const controller = new AbortController();
  let solves = 0;
  const solver: ChallengeSolver = {
    async solve(): Promise<ChallengeSolveResult> {
      solves += 1;
      if (solves === 2) controller.abort();
      await delay(3);
      return { solved: true, status: "SOLVED" };
    },
  };
  const snapshot = await new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 2, signal: controller.signal }).run();
  assert.ok(solves < 12, `expected early stop, but ran ${solves}`);
  assert.ok(snapshot.totals.pending > 0, "expected pending challenges left after abort");
});

test("onUpdate fires with live snapshots and reprioritize reorders pending", async () => {
  const ids = [challenge("a", 10), challenge("b", 20), challenge("c", 30)];
  const order: string[] = [];
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      order.push(request.challenge.challengeId);
      await delay(2);
      return { solved: true, status: "SOLVED" };
    },
  };
  let updates = 0;
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1, onUpdate: () => { updates += 1; } });
  await scheduler.load();
  scheduler.reprioritize("a", 999); // bump the lowest-value challenge to the front
  await scheduler.run();
  assert.equal(order[0], "a");
  assert.ok(updates > 0, "onUpdate never fired");
});

test("a Provider failure trips the fleet circuit and leaves later challenges pending", async () => {
  const ids = [challenge("first", 30), challenge("second", 20), challenge("third", 10)];
  const attempted: string[] = [];
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      attempted.push(request.challenge.challengeId);
      return { solved: false, status: "PROVIDER_ERROR", reason: "402 Insufficient Balance" };
    },
  };
  const scheduler = new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 });
  const snapshot = await scheduler.run();

  assert.deepEqual(attempted, ["first"]);
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.totals.pending, 2);
  assert.match(snapshot.challenges.find((item) => item.challengeId === "first")?.reason ?? "", /Insufficient Balance/);
});

test("a competition-platform failure trips the same fleet circuit", async () => {
  const ids = [challenge("first", 30), challenge("second", 20)];
  const attempted: string[] = [];
  const solver: ChallengeSolver = {
    async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
      attempted.push(request.challenge.challengeId);
      return { solved: false, status: "PLATFORM_ERROR", reason: "DASCTF auth failed" };
    },
  };
  const snapshot = await new FleetScheduler({ api: new FakeApi(ids), solver, concurrency: 1 }).run();

  assert.deepEqual(attempted, ["first"]);
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.totals.pending, 1);
});
