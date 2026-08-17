import {
  FleetScheduler,
  normalizeCategory,
  type ChallengeSolveRequest,
  type ChallengeSolveResult,
  type ChallengeSolver,
  type CompetitionApi,
  type CompetitionAttachment,
  type CompetitionChallengeSummary,
  type CompetitionEnvironment,
  type CompetitionSubmitResult,
  type ExecutionMode,
  type FleetSnapshot,
} from "@proofblade/materials";

/**
 * Demo backend for FleetView. Until the real platform API spec lands, this lets
 * the whole fleet dashboard — live streaming, priority, cancel, mode, concurrency
 * — be exercised in the browser with no model and no network.
 *
 * `CompetitionChallengeSolver` is real (it drives the coding lane and submits
 * through `submit_flag`) and so is the HTTP `CompetitionApi`. The live pair is
 * built by CompetitionSettingsStore from ~/.proofblade/competition.json (see
 * server.ts) and injected into FleetController; with no baseUrl configured the
 * Demo pair below keeps the dashboard working offline.
 */
const DEMO_CATEGORIES = ["Web", "Crypto", "Misc", "Reverse", "Script"] as const;

function demoChallenges(count: number): CompetitionChallengeSummary[] {
  return Array.from({ length: count }, (_, i) => {
    const category = DEMO_CATEGORIES[i % DEMO_CATEGORIES.length];
    return {
      challengeId: `DEMO-${String(i + 1).padStart(2, "0")}`,
      title: `${category} challenge ${i + 1}`,
      category,
      normalizedCategory: normalizeCategory(category),
      value: 50 + ((i * 37) % 400),
      solved: false,
    };
  });
}

export class DemoCompetitionApi implements CompetitionApi {
  private readonly challenges: CompetitionChallengeSummary[];
  public constructor(count = 12) {
    this.challenges = demoChallenges(count);
  }
  async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.challenges.map((c) => ({ ...c }));
  }
  async getChallenge(challengeId: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    const summary = this.challenges.find((c) => c.challengeId === challengeId);
    if (!summary) throw new Error(`unknown challenge ${challengeId}`);
    return { summary: { ...summary }, attachments: [] };
  }
  async startEnvironment(): Promise<CompetitionEnvironment> {
    return { connectionInfo: "demo://sandbox", expiresAt: Date.now() + 600_000 };
  }
  async submitFlag(): Promise<CompetitionSubmitResult> {
    return { correct: true };
  }
  async stopEnvironment(): Promise<void> {}
}

/**
 * Fake solver: simulates a bounded solve with jittered latency and a mostly-solved
 * outcome, while honoring cancellation and the live per-challenge mode getter (so
 * flipping a running challenge to "assist" is observable in the dashboard).
 */
export class DemoChallengeSolver implements ChallengeSolver {
  public async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
    const totalMs = 1500 + Math.floor(Math.random() * 3500);
    const step = 150;
    let elapsed = 0;
    while (elapsed < totalMs) {
      if (request.signal.aborted) return { solved: false, status: "CANCELLED", reason: "aborted" };
      if (request.mode?.() === "assist") {
        // Mirror the real loop: assist pauses before submission and waits.
        return { solved: false, status: "PAUSED", reason: "Waiting for supervisor approval (assist mode)" };
      }
      await delay(Math.min(step, totalMs - elapsed), request.signal);
      elapsed += step;
    }
    if (request.signal.aborted) return { solved: false, status: "CANCELLED", reason: "aborted" };
    const solved = Math.random() < 0.8;
    return solved
      ? { solved: true, flag: `flag{${request.challenge.challengeId.toLowerCase()}}`, status: "SUCCEEDED", submissions: 1 }
      : { solved: false, status: "EXHAUSTED", submissions: 1, reason: "demo miss" };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export type FleetSubscriber = (snapshot: FleetSnapshot) => void;

/**
 * Holds one FleetScheduler and fans its onUpdate snapshots out to all connected
 * SSE subscribers, caching the latest so a new subscriber renders immediately.
 * Control methods proxy straight to the scheduler.
 */
export class FleetController {
  private scheduler?: FleetScheduler;
  private readonly subscribers = new Set<FleetSubscriber>();
  private latest?: FleetSnapshot;
  private runPromise?: Promise<FleetSnapshot>;
  private abortController?: AbortController;
  private readonly api: CompetitionApi;
  private readonly solver: ChallengeSolver;

  public constructor(api: CompetitionApi = new DemoCompetitionApi(), solver: ChallengeSolver = new DemoChallengeSolver()) {
    this.api = api;
    this.solver = solver;
  }

  private ensureScheduler(): FleetScheduler {
    if (!this.scheduler) {
      this.abortController = new AbortController();
      this.scheduler = new FleetScheduler({
        api: this.api,
        solver: this.solver,
        concurrency: 3,
        defaultMode: "auto",
        signal: this.abortController.signal,
        onUpdate: (snapshot) => this.broadcast(snapshot),
      });
    }
    return this.scheduler;
  }

  public subscribe(subscriber: FleetSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.latest) subscriber(this.latest);
    return () => this.subscribers.delete(subscriber);
  }

  private broadcast(snapshot: FleetSnapshot): void {
    this.latest = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  /** Load challenges (idempotent) so the dashboard populates before Start. */
  public async load(): Promise<FleetSnapshot> {
    const scheduler = this.ensureScheduler();
    await scheduler.load();
    return scheduler.snapshot();
  }

  /** Kick off the run once; returns the current snapshot immediately. */
  public async start(): Promise<FleetSnapshot> {
    const scheduler = this.ensureScheduler();
    if (!this.runPromise) {
      this.runPromise = scheduler.run().finally(() => { this.runPromise = undefined; });
    }
    await scheduler.load();
    return scheduler.snapshot();
  }

  public setConcurrency(concurrency: number): FleetSnapshot {
    this.ensureScheduler().setConcurrency(concurrency);
    return this.snapshot();
  }
  public cancelChallenge(challengeId: string): FleetSnapshot {
    this.ensureScheduler().cancelChallenge(challengeId);
    return this.snapshot();
  }
  public setChallengeMode(challengeId: string, mode: ExecutionMode): FleetSnapshot {
    this.ensureScheduler().setChallengeMode(challengeId, mode);
    return this.snapshot();
  }
  public reprioritize(challengeId: string, priority: number): FleetSnapshot {
    this.ensureScheduler().reprioritize(challengeId, priority);
    return this.snapshot();
  }

  public snapshot(): FleetSnapshot {
    return this.latest ?? this.ensureScheduler().snapshot();
  }

  public async close(): Promise<void> {
    this.abortController?.abort(new Error("GUI shutting down"));
    if (this.runPromise) await this.runPromise.catch(() => undefined);
  }
}
