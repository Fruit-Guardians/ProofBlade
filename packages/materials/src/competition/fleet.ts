import type { ExecutionMode } from "../domain/types.js";
import type { CompetitionApi, CompetitionCategory, CompetitionChallengeSummary } from "./api.js";

/**
 * The fleet orchestrator runs many challenges concurrently. It owns scheduling
 * only — bounded concurrency, priority ordering, lifecycle, and an aggregate
 * snapshot for the human supervisor. HOW a single challenge is solved is behind
 * the ChallengeSolver seam so the scheduler can be validated with a fake solver
 * before the real SingleAgentCtfLoop-backed one is wired in.
 */
export interface ChallengeSolveRequest {
  challenge: CompetitionChallengeSummary;
  signal: AbortSignal;
  /** Live per-challenge mode getter (tier-2). Re-read each turn by the loop. */
  mode?: () => ExecutionMode;
}

export interface ChallengeSolveResult {
  solved: boolean;
  flag?: string;
  /** Terminal run status or a fleet-level label, surfaced to the supervisor. */
  status: string;
  submissions?: number;
  reason?: string;
}

export interface ChallengeSolver {
  solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult>;
}

export type FleetChallengeState =
  | "pending"
  | "running"
  | "solved"
  /** A flag is derived and recorded but assist mode is holding it for approval. */
  | "awaiting_approval"
  | "failed"
  | "skipped"
  | "cancelled";

export interface FleetChallengeStatus {
  challengeId: string;
  title: string;
  category: string;
  normalizedCategory: CompetitionCategory;
  value: number;
  /** Higher runs first; defaults to `value`, adjustable by the supervisor. */
  priority: number;
  /** Live per-challenge execution mode (supervisor-controlled). */
  mode: ExecutionMode;
  state: FleetChallengeState;
  startedAt?: number;
  finishedAt?: number;
  flag?: string;
  submissions?: number;
  reason?: string;
}

export interface FleetTotals {
  total: number;
  pending: number;
  running: number;
  solved: number;
  awaiting_approval: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface FleetSnapshot {
  concurrency: number;
  active: number;
  solvedValue: number;
  totals: FleetTotals;
  challenges: FleetChallengeStatus[];
}

export interface FleetSchedulerInit {
  api: CompetitionApi;
  solver: ChallengeSolver;
  /** Max challenges solved simultaneously. Clamped to 1..32. */
  concurrency?: number;
  /** Default execution mode for every challenge. Defaults to "auto". */
  defaultMode?: ExecutionMode;
  signal?: AbortSignal;
  /** Called after every state transition so a GUI can render live progress. */
  onUpdate?: (snapshot: FleetSnapshot) => void;
}

function clampConcurrency(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(32, Math.floor(value)));
}

export class FleetScheduler {
  private readonly api: CompetitionApi;
  private readonly solver: ChallengeSolver;
  private concurrency: number;
  private readonly signal?: AbortSignal;
  private readonly onUpdate?: (snapshot: FleetSnapshot) => void;
  private readonly defaultMode: ExecutionMode;
  private readonly states = new Map<string, FleetChallengeStatus>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly workers = new Set<Promise<void>>();
  private active = 0;
  private workerCount = 0;
  private running = false;
  private loaded = false;

  public constructor(init: FleetSchedulerInit) {
    this.api = init.api;
    this.solver = init.solver;
    this.concurrency = clampConcurrency(init.concurrency);
    this.defaultMode = init.defaultMode ?? "auto";
    this.signal = init.signal;
    this.onUpdate = init.onUpdate;
  }

  /** Pull the challenge list and seed per-challenge state. Idempotent. */
  public async load(): Promise<void> {
    if (this.loaded) return;
    const challenges = await this.api.listChallenges();
    for (const challenge of challenges) {
      const value = challenge.value ?? 0;
      this.states.set(challenge.challengeId, {
        challengeId: challenge.challengeId,
        title: challenge.title,
        category: challenge.category,
        normalizedCategory: challenge.normalizedCategory,
        value,
        priority: value,
        mode: this.defaultMode,
        state: challenge.solved ? "skipped" : "pending",
        reason: challenge.solved ? "Already solved on the platform" : undefined,
      });
    }
    this.loaded = true;
    this.emit();
  }

  /** Raise or lower a challenge's scheduling priority (supervisor control). */
  public reprioritize(challengeId: string, priority: number): void {
    const status = this.states.get(challengeId);
    if (status && status.state === "pending") {
      status.priority = priority;
      this.emit();
    }
  }

  /** Flip a challenge's mode. A running challenge in "assist" pauses before its next submission. */
  public setChallengeMode(challengeId: string, mode: ExecutionMode): void {
    const status = this.states.get(challengeId);
    if (status) {
      status.mode = mode;
      this.emit();
    }
  }

  /** Cancel a challenge: drop it if pending, abort its run if in flight. */
  public cancelChallenge(challengeId: string): void {
    const status = this.states.get(challengeId);
    if (!status) return;
    if (status.state === "pending") {
      status.state = "cancelled";
      status.reason = "Cancelled by supervisor before start";
      status.finishedAt = Date.now();
      this.emit();
      return;
    }
    if (status.state === "running") this.controllers.get(challengeId)?.abort(new Error("Cancelled by supervisor"));
  }

  /** Change the live concurrency cap; grows or shrinks the worker pool. */
  public setConcurrency(concurrency: number): void {
    this.concurrency = clampConcurrency(concurrency);
    if (this.running) this.fillWorkers();
    this.emit();
  }

  public snapshot(): FleetSnapshot {
    const challenges = [...this.states.values()].map((status) => ({ ...status }));
    const totals: FleetTotals = { total: challenges.length, pending: 0, running: 0, solved: 0, awaiting_approval: 0, failed: 0, skipped: 0, cancelled: 0 };
    let solvedValue = 0;
    for (const status of challenges) {
      totals[status.state] += 1;
      if (status.state === "solved") solvedValue += status.value;
    }
    challenges.sort((a, b) => b.priority - a.priority || a.challengeId.localeCompare(b.challengeId));
    return { concurrency: this.concurrency, active: this.active, solvedValue, totals, challenges };
  }

  /** Run every pending challenge through the solver under the live concurrency cap. */
  public async run(): Promise<FleetSnapshot> {
    await this.load();
    this.running = true;
    this.fillWorkers();
    // Drain: await workers as they settle, re-reading the set so workers added
    // later by setConcurrency() are awaited too.
    while (this.workers.size > 0) await Promise.race([...this.workers]);
    this.running = false;
    return this.snapshot();
  }

  /** Spawn workers until the live pool matches the concurrency target. */
  private fillWorkers(): void {
    while (this.workerCount < this.concurrency && this.hasPending() && !this.signal?.aborted) {
      this.workerCount += 1;
      const promise = this.worker().finally(() => {
        this.workerCount -= 1;
        this.workers.delete(promise);
      });
      this.workers.add(promise);
    }
  }

  private hasPending(): boolean {
    for (const status of this.states.values()) if (status.state === "pending") return true;
    return false;
  }

  private async worker(): Promise<void> {
    for (;;) {
      if (this.signal?.aborted) return;
      // Retire this worker if the live concurrency target dropped below the pool
      // size. The check + the finally-decrement run synchronously in this
      // microtask, so concurrent workers cannot all over-retire.
      if (this.workerCount > this.concurrency) return;
      const next = this.takeNextPending();
      if (!next) return;
      await this.solveOne(next);
    }
  }

  /** Highest-priority pending challenge; re-scanned each pick so reprioritize() applies live. */
  private takeNextPending(): FleetChallengeStatus | undefined {
    let best: FleetChallengeStatus | undefined;
    for (const status of this.states.values()) {
      if (status.state !== "pending") continue;
      if (!best || status.priority > best.priority || (status.priority === best.priority && status.challengeId < best.challengeId)) {
        best = status;
      }
    }
    if (best) {
      best.state = "running";
      best.startedAt = Date.now();
      this.active += 1;
      this.emit();
    }
    return best;
  }

  private async solveOne(status: FleetChallengeStatus): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(status.challengeId, controller);
    const onAbort = () => controller.abort(this.signal?.reason);
    if (this.signal) {
      if (this.signal.aborted) controller.abort(this.signal.reason);
      else this.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const result = await this.solver.solve({
        challenge: { challengeId: status.challengeId, title: status.title, category: status.category, normalizedCategory: status.normalizedCategory, value: status.value },
        signal: controller.signal,
        // Live per-challenge mode: the loop re-reads this every turn, so a
        // supervisor flip to "assist" pauses before the next submission.
        mode: () => this.states.get(status.challengeId)?.mode ?? this.defaultMode,
      });
      // An assist-mode hold is a waiting decision, not a failure: the flag is
      // derived and recorded, and the operator still has to release it.
      status.state = result.solved ? "solved" : result.status === "AWAITING_APPROVAL" ? "awaiting_approval" : "failed";
      status.flag = result.flag;
      status.submissions = result.submissions;
      status.reason = result.reason ?? result.status;
    } catch (error) {
      status.state = controller.signal.aborted ? "cancelled" : "failed";
      status.reason = error instanceof Error ? error.message : String(error);
    } finally {
      this.signal?.removeEventListener("abort", onAbort);
      this.controllers.delete(status.challengeId);
      status.finishedAt = Date.now();
      this.active -= 1;
      this.emit();
    }
  }

  private emit(): void {
    this.onUpdate?.(this.snapshot());
  }
}

