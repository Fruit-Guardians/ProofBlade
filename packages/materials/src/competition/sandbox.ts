import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Effect, EffectRequest, RawEffectResult, ReplayPolicy, TaskContract } from "../domain/types.js";
import {
  LocalFixtureSandbox,
  type FixtureHealth,
  type FixtureReconcileResult,
  type FixtureRef,
  type ReconcileResult,
  type SandboxPort,
} from "../sandbox/fixture.js";
import type { CompetitionApi, CompetitionAttachment, CompetitionEnvironment } from "./api.js";

export interface CompetitionSandboxInit {
  api: CompetitionApi;
  challengeId: string;
  /** Root under which per-run workspaces are created (usually runs/). */
  workspaceRoot: string;
  /** Attachments already fetched from the platform for this challenge. */
  attachments: CompetitionAttachment[];
  /** Provisioned environment (connection info, dynamic flag, expiry). */
  environment: CompetitionEnvironment;
}

/**
 * A SandboxPort backed by the live competition platform.
 *
 * Local tool effects (bash, file reads, inspect) run in the run workspace where
 * attachments are unpacked — delegated to an internal LocalFixtureSandbox. Only
 * three things diverge from the local sandbox, all because the platform is the
 * judge:
 *  - build() unpacks attachments and records connection info instead of writing
 *    a synthetic fixture + local scorer.
 *  - the `fixture_score` effect submits the candidate to the platform and maps
 *    the verdict back into the {accepted, candidateHash} shape the verifier reads.
 *  - destroy()/close() release the provisioned environment.
 */
export class CompetitionSandbox implements SandboxPort {
  private readonly local: LocalFixtureSandbox;
  private environment: CompetitionEnvironment;
  private stopped = false;

  public constructor(private readonly init: CompetitionSandboxInit) {
    this.local = new LocalFixtureSandbox(init.workspaceRoot);
    this.environment = init.environment;
  }

  public get connectionInfo(): string | undefined {
    return this.environment.connectionInfo;
  }

  /** The platform-provided flag for dynamic-flag challenges, if any. */
  public get dynamicFlag(): string | undefined {
    return this.environment.teamFlag;
  }

  public resolveReplayPolicy(operation: string, requested: ReplayPolicy): ReplayPolicy {
    // A platform submission is externally irreversible and the platform API has
    // no query-by-idempotency-key contract. A crash after submitFlag returns but
    // before the local artifact is committed must therefore stop for review,
    // never spend another attempt by replaying a nominally "pure" Effect.
    return operation === "fixture_score" ? "forbidden-replay" : requested;
  }

  public async build(task: TaskContract): Promise<FixtureRef> {
    const path = join(this.init.workspaceRoot, task.task_id);
    const privatePath = join(path, ".proofblade");
    await mkdir(path, { recursive: true });
    await mkdir(privatePath, { recursive: true });
    for (const attachment of this.init.attachments) {
      const target = safeJoin(path, attachment.name);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, Buffer.from(attachment.base64, "base64"));
    }
    if (this.environment.connectionInfo) {
      await writeFile(join(path, "connection-info.txt"), `${this.environment.connectionInfo}\n`, "utf8");
    }
    return { fixtureId: task.task_id, generation: 1, path, privatePath };
  }

  public async reset(fixture: FixtureRef): Promise<number> {
    // Release the current platform instance before provisioning its replacement.
    if (!(await this.stopEnvironment())) throw new Error("Cannot reset competition environment: teardown failed");
    this.environment = await this.init.api.startEnvironment(this.init.challengeId);
    this.stopped = false;
    return fixture.generation + 1;
  }

  public async execute(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult> {
    if (effect.operation === "fixture_score") {
      if (effect.replayPolicy !== "forbidden-replay") {
        throw new Error("Competition fixture_score requires forbidden-replay");
      }
      return this.executeScore(effect);
    }
    return this.local.execute(effect, signal);
  }

  public async reconcile(effect: Effect): Promise<ReconcileResult> {
    // Defense in depth for legacy/in-flight records that were incorrectly
    // persisted as pure: without a durable platform receipt, the outcome is
    // ambiguous and submitting again could consume an attempt twice.
    if (effect.operation === "fixture_score") return { action: "unknown", outcome: "unknown" };
    return this.local.reconcile(effect);
  }

  public async health(fixture: FixtureRef, expectedGeneration: number): Promise<FixtureHealth> {
    // Attachments are local and static; treat a present workspace as healthy.
    return { status: "healthy", expectedGeneration, actualGeneration: fixture.generation };
  }

  public async reconcileFixture(task: TaskContract, expectedGeneration: number): Promise<FixtureReconcileResult> {
    const path = join(this.init.workspaceRoot, task.task_id);
    const fixture: FixtureRef = { fixtureId: task.task_id, generation: expectedGeneration, path, privatePath: join(path, ".proofblade") };
    return { fixture, health: await this.health(fixture, expectedGeneration), action: "none", generation: expectedGeneration };
  }

  public async destroy(_fixture: FixtureRef): Promise<void> {
    await this.stopEnvironment();
  }

  public async close(): Promise<void> {
    await this.stopEnvironment();
  }

  private async executeScore(effect: EffectRequest): Promise<RawEffectResult> {
    const started = Date.now();
    const candidatePath = String(effect.args.candidatePath ?? "");
    if (!isAbsolute(candidatePath)) throw new Error("fixture_score requires an absolute candidate artifact path");
    const candidate = (await readFile(candidatePath, "utf8")).trim();
    const result = await this.init.api.submitFlag(this.init.challengeId, candidate);
    return {
      stdout: JSON.stringify({
        accepted: result.correct,
        candidateHash: hash(candidate),
        alreadySolved: result.alreadySolved ?? false,
        message: result.message ?? "",
        remainingAttempts: result.remainingAttempts,
      }),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  }

  private async stopEnvironment(): Promise<boolean> {
    if (this.stopped) return true;
    try {
      await this.init.api.stopEnvironment(this.init.challengeId, this.environment.instanceId);
      this.stopped = true;
      return true;
    } catch {
      // Best-effort teardown; the platform janitor reclaims on expiry.
      return false;
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJoin(root: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (isAbsolute(name) || parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error(`Unsafe attachment name: ${name}`);
  return join(root, ...parts);
}
