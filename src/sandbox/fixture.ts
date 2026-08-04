import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Effect, EffectRequest, RawEffectResult, ReplayPolicy, TaskContract } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export interface ReconcileResult {
  outcome: "success" | "error" | "timeout" | "unknown";
}

export interface SandboxPort {
  build(task: TaskContract): Promise<{ fixtureId: string; generation: number; path: string }>;
  reset(fixture: { fixtureId: string; generation: number; path: string }): Promise<number>;
  execute(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult>;
  reconcile(effect: Effect): Promise<ReconcileResult>;
  destroy(fixture: { fixtureId: string; generation: number; path: string }): Promise<void>;
}

export class LocalFixtureSandbox implements SandboxPort {
  private readonly generations = new Map<string, number>();

  public constructor(private readonly root: string) {}

  public async build(task: TaskContract): Promise<{ fixtureId: string; generation: number; path: string }> {
    const fixtureId = task.task_id;
    const path = join(this.root, fixtureId);
    await mkdir(path, { recursive: true });
    if (!(await exists(join(path, "challenge.txt")))) {
      await writeFile(join(path, "challenge.txt"), "ProofBlade demo target\nFLAG=PB{evidence_first}\n", "utf8");
    }
    const generation = this.generations.get(fixtureId) ?? 0;
    this.generations.set(fixtureId, generation);
    return { fixtureId, generation, path };
  }

  public async reset(fixture: { fixtureId: string; generation: number; path: string }): Promise<number> {
    const generation = (this.generations.get(fixture.fixtureId) ?? fixture.generation) + 1;
    this.generations.set(fixture.fixtureId, generation);
    await writeFile(join(fixture.path, "generation.txt"), `${generation}\n`, "utf8");
    return generation;
  }

  public async execute(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult> {
    if (!effect.command) return { stdout: JSON.stringify(effect.args), stderr: "", exitCode: 0, durationMs: 0 };
    const started = Date.now();
    const cwd = effect.cwd ?? this.root;
    const command = process.platform === "win32" ? "cmd.exe" : "bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", effect.command] : ["-lc", effect.command];
    const timeoutMs = effect.timeoutMs ?? 30_000;
    try {
      const child = execFileAsync(command, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
      const onAbort = () => child.child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const output = await child;
      signal.removeEventListener("abort", onAbort);
      return { stdout: output.stdout, stderr: output.stderr, exitCode: 0, durationMs: Date.now() - started };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      return {
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? String(error),
        exitCode: typeof value.code === "number" ? value.code : null,
        durationMs: Date.now() - started,
      };
    }
  }

  public async reconcile(effect: Effect): Promise<ReconcileResult> {
    if (effect.replayPolicy === "pure" || effect.replayPolicy === "idempotent") return { outcome: "success" };
    return { outcome: "unknown" };
  }

  public async destroy(_fixture: { fixtureId: string; generation: number; path: string }): Promise<void> {
    // Local fixtures are retained for replay and inspection.
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
