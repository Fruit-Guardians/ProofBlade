import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Effect, EffectRequest, RawEffectResult, ReplayPolicy, TaskContract } from "../domain/types.js";
import { fixtureProfileFromTarget, getFixtureProfile, type FixtureHttpProfile } from "./fixture-catalog.js";

const execFileAsync = promisify(execFile);

export interface ReconcileResult {
  action: "finished" | "rerun" | "unknown";
  outcome: "success" | "error" | "timeout" | "unknown";
}

export interface FixtureRef {
  fixtureId: string;
  profileId?: string;
  generation: number;
  path: string;
  privatePath: string;
  endpoint?: string;
}

export type FixtureHealthStatus = "healthy" | "missing" | "unhealthy" | "generation-drift";

export interface FixtureHealth {
  status: FixtureHealthStatus;
  expectedGeneration: number;
  actualGeneration: number;
  reason?: string;
}

export interface FixtureReconcileResult {
  fixture: FixtureRef;
  health: FixtureHealth;
  action: "none" | "reset";
  generation: number;
}

export interface SandboxPort {
  build(task: TaskContract): Promise<FixtureRef>;
  reset(fixture: FixtureRef): Promise<number>;
  score(fixture: FixtureRef, candidate: string): Promise<{ accepted: boolean; candidateHash: string }>;
  execute(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult>;
  reconcile(effect: Effect): Promise<ReconcileResult>;
  health(fixture: FixtureRef, expectedGeneration: number): Promise<FixtureHealth>;
  reconcileFixture(task: TaskContract, expectedGeneration: number): Promise<FixtureReconcileResult>;
  destroy(fixture: FixtureRef): Promise<void>;
}

export class LocalFixtureSandbox implements SandboxPort {
  private readonly generations = new Map<string, number>();
  private readonly httpServers = new Map<string, ActiveHttpFixture>();

  public constructor(private readonly root: string) {}

  public async build(task: TaskContract): Promise<FixtureRef> {
    const fixtureId = task.task_id;
    const path = join(this.root, fixtureId);
    const privatePath = join(path, ".proofblade");
    await mkdir(path, { recursive: true });
    await mkdir(privatePath, { recursive: true });
    const profile = fixtureProfileFromTarget(task.target);
    if (profile) await writeProfile(path, privatePath, profile);
    else if (!(await exists(join(path, "challenge.txt")))) await writeFile(join(path, "challenge.txt"), "ProofBlade demo target\nFLAG=PB{evidence_first}\n", "utf8");
    if (!profile && !(await exists(join(privatePath, "scorer.json")))) {
      await writeFile(join(privatePath, "scorer.json"), JSON.stringify({ expected: "PB{evidence_first}" }), "utf8");
    }
    const generation = await readGeneration(path);
    this.generations.set(fixtureId, generation);
    const endpoint = profile?.http ? await this.ensureHttpFixture(fixtureId, profile.id, profile.http, generation) : undefined;
    return { fixtureId, profileId: profile?.id, generation, path, privatePath, ...(endpoint ? { endpoint } : {}) };
  }

  public async reset(fixture: FixtureRef): Promise<number> {
    const generation = Math.max(this.generations.get(fixture.fixtureId) ?? 0, await readGeneration(fixture.path), fixture.generation) + 1;
    this.generations.set(fixture.fixtureId, generation);
    if (fixture.profileId) await writeProfile(fixture.path, fixture.privatePath, getFixtureProfile(fixture.profileId));
    await writeFile(join(fixture.path, "generation.txt"), `${generation}\n`, "utf8");
    const active = this.httpServers.get(fixture.fixtureId);
    if (active) {
      active.generation = generation;
      active.requestCounts.clear();
    }
    return generation;
  }

  public async score(fixture: FixtureRef, candidate: string): Promise<{ accepted: boolean; candidateHash: string }> {
    const { createHash } = await import("node:crypto");
    const scorer = JSON.parse(await readFile(join(fixture.privatePath, "scorer.json"), "utf8")) as { expected?: string };
    const expected = scorer.expected;
    return {
      accepted: expected !== undefined && candidate.trim() === expected,
      candidateHash: createHash("sha256").update(candidate.trim()).digest("hex"),
    };
  }

  public async execute(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult> {
    const native = await this.executeNative(effect, signal);
    if (native) return native;
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
    if (effect.replayPolicy === "pure" || effect.replayPolicy === "idempotent") return { action: "rerun", outcome: "unknown" };
    return { action: "unknown", outcome: "unknown" };
  }

  public async health(fixture: FixtureRef, expectedGeneration: number): Promise<FixtureHealth> {
    try {
      await access(fixture.path);
    } catch {
      return { status: "missing", expectedGeneration, actualGeneration: 0, reason: "fixture directory is missing" };
    }
    const actualGeneration = await readGeneration(fixture.path);
    const files = await visibleFiles(fixture.path).catch(() => []);
    const scorerPresent = await exists(join(fixture.privatePath, "scorer.json"));
    if (files.length === 0 || !scorerPresent || actualGeneration < 1) {
      return { status: "unhealthy", expectedGeneration, actualGeneration, reason: "fixture files, scorer, or generation marker are incomplete" };
    }
    const profile = fixture.profileId ? getFixtureProfile(fixture.profileId) : undefined;
    if (profile?.http) {
      const active = this.httpServers.get(fixture.fixtureId);
      if (!active?.server.listening || active.profileId !== profile.id || active.generation !== actualGeneration) {
        return { status: "unhealthy", expectedGeneration, actualGeneration, reason: "fixture HTTP service is missing or stale" };
      }
      if (!(await httpFixtureHealthy(active.endpoint, actualGeneration))) {
        return { status: "unhealthy", expectedGeneration, actualGeneration, reason: "fixture HTTP service health check failed" };
      }
    }
    if (actualGeneration !== expectedGeneration) {
      return { status: "generation-drift", expectedGeneration, actualGeneration, reason: "fixture generation differs from the control projection" };
    }
    return { status: "healthy", expectedGeneration, actualGeneration };
  }

  public async reconcileFixture(task: TaskContract, expectedGeneration: number): Promise<FixtureReconcileResult> {
    const profile = fixtureProfileFromTarget(task.target);
    const fixture: FixtureRef = {
      fixtureId: task.task_id,
      profileId: profile?.id,
      generation: expectedGeneration,
      path: join(this.root, task.task_id),
      privatePath: join(this.root, task.task_id, ".proofblade"),
      ...(this.httpServers.get(task.task_id)?.endpoint ? { endpoint: this.httpServers.get(task.task_id)!.endpoint } : {}),
    };
    const health = await this.health(fixture, expectedGeneration);
    if (health.status === "healthy") return { fixture, health, action: "none", generation: expectedGeneration };
    const rebuilt = await this.build(task);
    const generation = await this.reset({ ...rebuilt, generation: Math.max(expectedGeneration, health.actualGeneration) });
    return { fixture: { ...rebuilt, generation }, health, action: "reset", generation };
  }

  public async destroy(fixture: FixtureRef): Promise<void> {
    const active = this.httpServers.get(fixture.fixtureId);
    if (active) {
      this.httpServers.delete(fixture.fixtureId);
      await closeServer(active.server);
    }
    // Fixture files are retained for replay and inspection.
  }

  private async ensureHttpFixture(fixtureId: string, profileId: string, profile: FixtureHttpProfile, generation: number): Promise<string> {
    const existing = this.httpServers.get(fixtureId);
    if (existing?.server.listening && existing.profileId === profileId) {
      existing.generation = generation;
      return existing.endpoint;
    }
    if (existing) await closeServer(existing.server);
    const requestCounts = new Map<string, number>();
    const server = createServer((request, response) => {
      const active = this.httpServers.get(fixtureId);
      if (!active) {
        response.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("fixture unavailable\n");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://fixture.local");
      if (requestUrl.pathname === "/.proofblade/health") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, generation: active.generation }));
        return;
      }
      const method = (request.method ?? "GET").toUpperCase();
      const route = active.profile.routes.find((item) => {
        const routeMethod = item.method ?? "GET";
        return item.path === requestUrl.pathname && (routeMethod === method || (method === "HEAD" && routeMethod === "GET"));
      });
      if (!route) {
        response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("not found\n");
        return;
      }
      const key = `${method} ${route.path}`;
      active.requestCounts.set(key, (active.requestCounts.get(key) ?? 0) + 1);
      response.writeHead(route.status ?? 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...route.headers });
      response.end(method === "HEAD" ? undefined : route.body ?? "");
    });
    server.unref();
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolveListen();
      });
    });
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}`;
    this.httpServers.set(fixtureId, { profileId, profile, generation, requestCounts, server, endpoint });
    return endpoint;
  }

  private async executeNative(effect: EffectRequest, signal: AbortSignal): Promise<RawEffectResult | undefined> {
    const started = Date.now();
    if (effect.operation === "fixture_list") {
      const files = await visibleFiles(effect.cwd ?? this.root);
      return { stdout: files.join("\n"), stderr: "", exitCode: 0, durationMs: Date.now() - started };
    }
    if (effect.operation === "fixture_read" || effect.operation === "artifact_read") {
      const path = resolveInside(effect.cwd ?? this.root, String(effect.args.path ?? ""));
      return { stdout: await readFile(path, "utf8"), stderr: "", exitCode: 0, durationMs: Date.now() - started };
    }
    if (effect.operation === "fixture_inspect") {
      const cwd = effect.cwd ?? this.root;
      const requested = typeof effect.args.path === "string" && effect.args.path.length > 0 ? effect.args.path : undefined;
      const files = requested ? [requested] : await visibleFiles(cwd);
      const sections: string[] = [];
      for (const file of files) sections.push(`--- ${file}\n${await readFile(resolveInside(cwd, file), "utf8")}`);
      return { stdout: sections.join("\n"), stderr: "", exitCode: 0, durationMs: Date.now() - started };
    }
    if (effect.operation === "fixture_score") {
      const candidatePath = String(effect.args.candidatePath ?? "");
      if (!isAbsolute(candidatePath)) throw new Error("fixture_score requires an absolute candidate artifact path");
      const candidate = await readFile(candidatePath, "utf8");
      const scorer = JSON.parse(await readFile(join(effect.cwd ?? this.root, ".proofblade", "scorer.json"), "utf8")) as { expected?: string };
      const { createHash } = await import("node:crypto");
      const normalized = candidate.trim();
      return {
        stdout: JSON.stringify({ accepted: normalized === scorer.expected, candidateHash: createHash("sha256").update(normalized).digest("hex") }),
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - started,
      };
    }
    if (effect.operation === "fixture_delay") {
      const milliseconds = Number(effect.args.milliseconds ?? 0);
      await waitForDelay(milliseconds, signal);
      return signal.aborted
        ? { stdout: "", stderr: "aborted", exitCode: null, durationMs: Date.now() - started }
        : { stdout: JSON.stringify({ milliseconds }), stderr: "", exitCode: 0, durationMs: Date.now() - started };
    }
    return undefined;
  }
}

interface ActiveHttpFixture {
  profileId: string;
  profile: FixtureHttpProfile;
  generation: number;
  requestCounts: Map<string, number>;
  server: Server;
  endpoint: string;
}

async function httpFixtureHealthy(endpoint: string, generation: number): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/.proofblade/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const value = await response.json() as { ok?: boolean; generation?: number };
    return value.ok === true && value.generation === generation;
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function writeProfile(path: string, privatePath: string, profile: ReturnType<typeof getFixtureProfile>): Promise<void> {
  for (const [name, content] of Object.entries(profile.files)) {
    const target = resolveInside(path, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await writeFile(join(privatePath, "profile.json"), JSON.stringify({ id: profile.id, targetKind: profile.targetKind }), "utf8");
  await writeFile(join(privatePath, "scorer.json"), JSON.stringify({ expected: profile.expected }), "utf8");
}

async function visibleFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".proofblade" || entry.name === "generation.txt") continue;
    if (entry.isFile()) output.push(entry.name);
  }
  return output.sort();
}

function resolveInside(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new Error("Fixture paths must be non-empty and relative");
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes(".proofblade")) throw new Error("Fixture path escapes the visible target");
  return resolved;
}

async function readGeneration(path: string): Promise<number> {
  try {
    const value = Number((await readFile(join(path, "generation.txt"), "utf8")).trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
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

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
