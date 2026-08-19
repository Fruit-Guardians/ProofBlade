import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import type { ResolvedExecutionConfig } from "../config.js";
import { ContainerExecutionEnv } from "./execution-env.js";
import type {
  ContainerCommandOptions,
  ContainerCommandResult,
  ContainerCreateRequest,
  ContainerDoctorReport,
  ContainerRef,
  ContainerRuntimePort,
  ContainerTarget,
} from "./contracts.js";

const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

export interface DockerProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: Error;
  truncated: boolean;
  durationMs: number;
}

export interface DockerCommandRunner {
  run(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; stdin?: string | Uint8Array; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }): Promise<DockerProcessResult>;
}

/** Direct-spawn Docker CLI runner. It never invokes a host shell and never forwards process.env. */
export class SpawnDockerCommandRunner implements DockerCommandRunner {
  public constructor(private readonly command = "docker") {}

  public async run(args: string[], options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; stdin?: string | Uint8Array; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {}): Promise<DockerProcessResult> {
    const started = Date.now();
    const limit = options.maxOutputBytes ?? 50_000;
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const child = spawn(this.command, args, { shell: false, windowsHide: true, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const append = (kind: "stdout" | "stderr", chunk: string): void => {
        if (kind === "stdout") options.onStdout?.(chunk); else options.onStderr?.(chunk);
        const current = kind === "stdout" ? stdout : stderr;
        const remaining = Math.max(0, limit - current.length);
        const kept = chunk.slice(0, remaining);
        if (chunk.length > kept.length) truncated = true;
        if (kind === "stdout") stdout += kept; else stderr += kept;
      };
      const finish = (result: Pick<DockerProcessResult, "exitCode" | "spawnError">): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
        resolve({ ...result, stdout, stderr, truncated, durationMs: Date.now() - started });
      };
      child.stdout!.on("data", (chunk: Buffer) => append("stdout", chunk.toString("utf8")));
      child.stderr!.on("data", (chunk: Buffer) => append("stderr", chunk.toString("utf8")));
      child.once("error", (error) => finish({ exitCode: null, spawnError: error }));
      child.once("close", (code) => finish({ exitCode: code }));
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.end(options.stdin);
      }
      const kill = (): void => {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      };
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => { kill(); finish({ exitCode: null, spawnError: new Error("docker command timed out") }); }, options.timeoutMs);
      }
      if (options.signal) {
        abortListener = () => { kill(); finish({ exitCode: null, spawnError: new Error("docker command aborted") }); };
        if (options.signal.aborted) abortListener();
        else options.signal.addEventListener("abort", abortListener, { once: true });
      }
    });
  }
}

export class DockerContainerRuntime implements ContainerRuntimePort {
  private readonly runner: DockerCommandRunner;

  public constructor(private readonly config: ResolvedExecutionConfig, runner?: DockerCommandRunner) {
    this.runner = runner ?? new SpawnDockerCommandRunner(config.dockerCommand);
  }

  public async doctor(profile?: ContainerRef["profile"]): Promise<ContainerDoctorReport> {
    const version = await this.runner.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: configTimeout(this.config) });
    if (version.spawnError) return { backend: "docker", installed: !/\bENOENT\b/i.test(version.spawnError.message), daemon: false, reason: version.spawnError.message };
    if (version.exitCode !== 0) return { backend: "docker", installed: true, daemon: false, reason: compactError(version.stderr, "Docker daemon is unavailable") };
    if (!profile) return { backend: "docker", installed: true, daemon: true };
    const image = this.imageFor(profile);
    const inspected = await this.runner.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: configTimeout(this.config) });
    return { backend: "docker", installed: true, daemon: true, image: { name: image, available: inspected.exitCode === 0, ...(inspected.exitCode === 0 && inspected.stdout.trim() ? { digest: inspected.stdout.trim() } : {}) } };
  }

  public async prewarm(profiles: ContainerRef["profile"][]): Promise<void> {
    const images = new Set(profiles.map((profile) => this.imageFor(profile)));
    if (this.config.networkPolicy === "target-only") images.add(this.config.images.gateway);
    for (const image of images) await this.ensureImage(image);
  }

  public async create(request: ContainerCreateRequest): Promise<ContainerRef> {
    if (!isAbsolute(request.workspaceHostPath)) throw new Error("Container workspace path must be absolute");
    const workspace = await fs.stat(request.workspaceHostPath);
    if (!workspace.isDirectory()) throw new Error(`Container workspace is not a directory: ${request.workspaceHostPath}`);
    if (request.skillLibraryHostPath) {
      const skills = await fs.stat(request.skillLibraryHostPath);
      if (!skills.isDirectory()) throw new Error(`Container skill library is not a directory: ${request.skillLibraryHostPath}`);
    }
    await this.ensureImage(request.image);
    const slug = safeName(request.runId);
    const name = `proofblade-${slug}-g${request.generation}-${request.profile}`;
    const identityLabels = {
      "proofblade.managed": "true",
      "proofblade.run_id": request.runId,
      "proofblade.generation": String(request.generation),
      "proofblade.profile": request.profile,
    };
    const ownerLabels = {
      ...identityLabels,
      "proofblade.owner_pid": String(process.pid),
      "proofblade.owner_started_at": String(PROCESS_STARTED_AT),
      // PID/start-time identify the process, not this individual create()
      // attempt.  A unique token prevents a losing concurrent creator from
      // claiming the winner's deterministically named network.
      "proofblade.owner_token": createOwnerToken(),
    };
    const labels = Object.entries(ownerLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    const containerUser = await prepareWorkspace(request.workspaceHostPath);
    let networkName: string | undefined;
    let networkCandidate: string | undefined;
    let networkPreexisted = false;
    let gatewayContainerId: string | undefined;
    let containerId: string | undefined;
    let gatewayCreateAttempted = false;
    let solverCreateAttempted = false;
    try {
      if (request.networkPolicy === "target-only") {
        networkCandidate = `proofblade-${slug}-g${request.generation}-net`;
        // A name conflict must never turn cleanup into a delete of a network
        // that existed before this attempt. Remember matching ownership before
        // create; if create fails, only a newly observed, owned network may be
        // used as a partial-create fallback.
        networkPreexisted = (await this.ownedNetworkName(networkCandidate, ownerLabels)) !== undefined;
        await this.runChecked(["network", "create", ...labels, "--ipv6=false", networkCandidate]);
        networkName = networkCandidate;
        const gatewayImage = request.gatewayImage ?? this.config.images.gateway;
        await this.ensureImage(gatewayImage);
        const gatewayName = `${name}-gateway`;
        gatewayCreateAttempted = true;
        const gateway = await this.runChecked(["run", "-d", "--name", gatewayName, ...labels, "--network", networkName, "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW", "--security-opt", "no-new-privileges", gatewayImage, "sleep", "infinity"]);
        gatewayContainerId = gateway.stdout.trim();
        const targets = await resolveTargets(request.targets);
        // Invoke through /bin/sh instead of relying on the script's shebang;
        // this remains robust if a host checkout rewrites executable bits or
        // line endings before the image build.
        await this.runChecked(["exec", gatewayContainerId, "/bin/sh", "/usr/local/bin/pb-egress-init", ...targets.map((target) => `${target.protocol}:${target.address}:${target.port}`)]);
      }
      const limits = request.limits;
      const args = ["run", "-d", "--name", name, ...labels, "--user", containerUser, "--workdir", "/workspace", "--mount", `type=bind,source=${request.workspaceHostPath},destination=/workspace`, ...(request.skillLibraryHostPath ? ["--mount", `type=bind,source=${request.skillLibraryHostPath},destination=/opt/proofblade/skills,readonly`] : []), "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g", "--tmpfs", "/run:rw,noexec,nosuid,size=64m", "--pids-limit", String(limits?.pids ?? 512), "--cpus", limits?.cpus ?? "2", "--memory", limits?.memory ?? "4g", "--shm-size", limits?.shmSize ?? "1g", "--ulimit", "nofile=4096:4096", "--ulimit", "fsize=1073741824:1073741824", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
      if (request.profile === "pwn" || request.profile === "pwn-kernel") args.push("--cap-add", "SYS_PTRACE");
      if (request.networkPolicy === "none") args.push("--network", "none");
      else if (request.networkPolicy === "bridge") args.push("--network", "bridge");
      else if (gatewayContainerId) args.push("--network", `container:${gatewayContainerId}`);
      args.push(request.image, "sleep", "infinity");
      solverCreateAttempted = true;
      const created = await this.runChecked(args);
      containerId = created.stdout.trim();
      await this.runChecked(["exec", containerId, "/bin/sh", "-lc", "test -w /workspace && touch /workspace/.proofblade-write-test && rm -f /workspace/.proofblade-write-test"]);
      const inspected = await this.runChecked(["image", "inspect", "--format", "{{.Id}}", request.image]);
      return { runId: request.runId, generation: request.generation, containerId, name, profile: request.profile, image: request.image, imageDigest: inspected.stdout.trim(), workspaceHostPath: request.workspaceHostPath, workspaceContainerPath: "/workspace", networkPolicy: request.networkPolicy, ...(gatewayContainerId ? { gatewayContainerId } : {}), ...(networkName ? { networkName } : {}) };
    } catch (error) {
      const cleanupNetworkName = networkName ?? (!networkPreexisted && networkCandidate
        ? await this.ownedNetworkName(networkCandidate, ownerLabels)
        : undefined);
      const cleanupErrors = await this.cleanupResources(
        containerId,
        gatewayContainerId,
        cleanupNetworkName,
        solverCreateAttempted ? name : undefined,
        gatewayCreateAttempted ? `${name}-gateway` : undefined,
        // The deterministic fallback names are shared by attempts with the
        // same run identity.  Keep the per-create owner token in this check;
        // identityLabels alone would let a name-conflicting attempt delete a
        // gateway created by a different attempt.
        ownerLabels,
      );
      if (cleanupErrors.length > 0) throw new AggregateError([toError(error, "Docker create"), ...cleanupErrors], "Docker create failed and cleanup also failed");
      throw error;
    }
  }

  public executionEnv(ref: ContainerRef): ContainerExecutionEnv {
    return new ContainerExecutionEnv(this, ref, ref.workspaceHostPath);
  }

  public async exec(ref: ContainerRef, command: string, options: ContainerCommandOptions = {}): Promise<ContainerCommandResult> {
    const cwd = containerCwd(ref.workspaceHostPath, options.cwd);
    const args = ["exec", "-i", "--workdir", cwd];
    // Docker Desktop can start the image with a host/locale combination that
    // is not UTF-8.  Always provide a deterministic baseline for tool output;
    // explicit per-command values still win.
    const env = {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      ...options.env,
    };
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push(ref.containerId, "/bin/sh", "-lc", command);
    const result = await this.runner.run(args, { timeoutMs: Math.min(options.timeoutMs ?? this.config.commandHardTimeoutMs, this.config.commandHardTimeoutMs), signal: options.signal, stdin: options.stdin, maxOutputBytes: this.config.outputPreviewBytes, onStdout: options.onStdout, onStderr: options.onStderr });
    if (result.spawnError) throw new Error(`Docker exec failed: ${result.spawnError.message}`);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated, durationMs: result.durationMs };
  }

  public async health(ref: ContainerRef): Promise<boolean> {
    const result = await this.runner.run(["inspect", "--format", "{{.State.Running}}", ref.containerId], { timeoutMs: configTimeout(this.config) });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  public async destroy(ref: ContainerRef): Promise<void> {
    const failures = await this.cleanupResources(
      ref.containerId,
      ref.gatewayContainerId,
      ref.networkName,
      ref.name,
      ref.networkName ? `${ref.name}-gateway` : undefined,
      { "proofblade.managed": "true", "proofblade.run_id": ref.runId, "proofblade.generation": String(ref.generation), "proofblade.profile": ref.profile },
    );
    if (failures.length > 0) throw new AggregateError(failures, `Docker cleanup failed for run ${ref.runId}`);
  }

  public async reapStale(options: { olderThanMs?: number; runId?: string; protectedRunIds?: string[]; includeRunning?: boolean } = {}): Promise<number> {
    const olderThanMs = options.olderThanMs ?? this.config.staleContainerTtlMs;
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new Error("olderThanMs must be a non-negative finite number");
    const protectedRunIds = new Set(options.protectedRunIds ?? []);
    const filters = ["label=proofblade.managed=true"];
    if (options.runId) filters.push(`label=proofblade.run_id=${options.runId}`);
    const listed = await this.runner.run(["ps", "-aq", ...filters.flatMap((filter) => ["--filter", filter])], { timeoutMs: configTimeout(this.config) });
    if (listed.exitCode !== 0) return 0;
    const ids = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let removed = 0;
    const failures: Error[] = [];
    for (const id of ids) {
      const details = await this.inspectResource(id);
      if (!details || !isStale(details.created, olderThanMs)) continue;
      const runId = details.labels["proofblade.run_id"];
      if (!runId || protectedRunIds.has(runId)) continue;
      if (details.running) {
        if (options.includeRunning !== true) continue;
        if (await isLiveProcess(details.labels["proofblade.owner_pid"], details.labels["proofblade.owner_started_at"])) continue;
      }
      try {
        await this.removeContainer(id);
        removed += 1;
      } catch (error) {
        failures.push(toError(error, `container ${id}`));
      }
    }
    const networks = await this.runner.run(["network", "ls", "-q", ...filters.flatMap((filter) => ["--filter", filter])], { timeoutMs: configTimeout(this.config) });
    if (networks.exitCode === 0) {
      for (const network of networks.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const details = await this.inspectNetwork(network);
        if (!details || !isStale(details.created, olderThanMs)) continue;
        const runId = details.labels["proofblade.run_id"];
        if (!runId || protectedRunIds.has(runId)) continue;
        if (details.containerCount > 0) continue;
        try {
          await this.removeNetwork(network);
        } catch (error) {
          failures.push(toError(error, `network ${network}`));
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Docker stale-resource cleanup failed");
    return removed;
  }

  private async inspectResource(id: string): Promise<{ created: string; running: boolean; labels: Record<string, string> } | undefined> {
    const result = await this.runner.run(["inspect", "--format", "{{json .}}", id], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    if (result.exitCode !== 0) return undefined;
    try {
      const value = JSON.parse(result.stdout.trim()) as { Created?: string; State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } };
      return { created: value.Created ?? "", running: value.State?.Running === true, labels: value.Config?.Labels ?? {} };
    } catch { return undefined; }
  }

  private async inspectNetwork(id: string): Promise<{ created: string; labels: Record<string, string>; containerCount: number } | undefined> {
    const result = await this.runner.run(["network", "inspect", "--format", "{{json .}}", id], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    if (result.exitCode !== 0) return undefined;
    try {
      const value = JSON.parse(result.stdout.trim()) as { Created?: string; Labels?: Record<string, string>; Containers?: Record<string, unknown> };
      return { created: value.Created ?? "", labels: value.Labels ?? {}, containerCount: Object.keys(value.Containers ?? {}).length };
    } catch { return undefined; }
  }

  private imageFor(profile: ContainerRef["profile"]): string { return this.config.images[profile]; }

  private async ensureImage(image: string): Promise<void> {
    const inspect = await this.runner.run(["image", "inspect", image], { timeoutMs: configTimeout(this.config) });
    if (this.config.pullPolicy !== "always" && inspect.exitCode === 0) return;
    if (this.config.pullPolicy === "never") throw new Error(`Docker image is unavailable and pullPolicy=never: ${image}`);
    await this.runChecked(["pull", image], this.config.commandHardTimeoutMs);
  }

  private async runChecked(args: string[], timeoutMs = this.config.commandHardTimeoutMs): Promise<DockerProcessResult> {
    const result = await this.runner.run(args, { timeoutMs, maxOutputBytes: this.config.outputPreviewBytes });
    if (result.spawnError) throw new Error(`Docker command failed (${args.join(" ")}): ${result.spawnError.message}`);
    if (result.exitCode !== 0) throw new Error(`Docker command failed (${args.join(" ")}): ${compactError(result.stderr || result.stdout, `exit ${String(result.exitCode)}`)}`);
    return result;
  }

  private async cleanupResources(containerId?: string, gatewayContainerId?: string, networkName?: string, solverName?: string, gatewayName?: string, expectedLabels?: Record<string, string>): Promise<Error[]> {
    const failures: Error[] = [];
    const attempt = async (label: string, operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(toError(error, label)); }
    };
    const solverTarget = containerId ?? await this.ownedContainerName(solverName, expectedLabels);
    const gatewayTarget = gatewayContainerId ?? await this.ownedContainerName(gatewayName, expectedLabels);
    if (solverTarget) await attempt(`solver container ${solverTarget}`, () => this.removeContainer(solverTarget));
    if (gatewayTarget) await attempt(`gateway container ${gatewayTarget}`, () => this.removeContainer(gatewayTarget));
    if (networkName) await attempt(`network ${networkName}`, () => this.removeNetwork(networkName));
    return failures;
  }

  private async removeContainer(id: string): Promise<void> {
    const result = await this.runner.run(["rm", "-f", id], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    assertCleanupResult(result, `docker rm -f ${id}`);
  }

  private async removeNetwork(name: string): Promise<void> {
    const result = await this.runner.run(["network", "rm", name], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    assertCleanupResult(result, `docker network rm ${name}`);
  }

  /** Resolve a deterministic fallback name only after proving ownership. */
  private async ownedContainerName(name: string | undefined, expectedLabels: Record<string, string> | undefined): Promise<string | undefined> {
    if (!name || !expectedLabels) return undefined;
    const result = await this.runner.run(["inspect", "--format", "{{json .Config.Labels}}", name], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    if (result.spawnError || result.exitCode !== 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const labels = parsed as Record<string, unknown>;
      return Object.entries(expectedLabels).every(([key, value]) => labels[key] === value) ? name : undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve a deterministic network name only after proving ownership. */
  private async ownedNetworkName(name: string | undefined, expectedLabels: Record<string, string> | undefined): Promise<string | undefined> {
    if (!name || !expectedLabels) return undefined;
    const result = await this.runner.run(["network", "inspect", "--format", "{{json .Labels}}", name], { timeoutMs: configTimeout(this.config), maxOutputBytes: this.config.outputPreviewBytes });
    if (result.spawnError || result.exitCode !== 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const labels = parsed as Record<string, unknown>;
      return Object.entries(expectedLabels).every(([key, value]) => labels[key] === value) ? name : undefined;
    } catch {
      return undefined;
    }
  }
}

function configTimeout(config: ResolvedExecutionConfig): number { return Math.min(config.commandWaitMs, config.commandHardTimeoutMs); }
function compactError(value: string, fallback: string): string { return value.trim().replace(/\s+/g, " ").slice(0, 500) || fallback; }
function toError(error: unknown, label: string): Error { return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
function assertCleanupResult(result: DockerProcessResult, command: string): void {
  if (result.spawnError) throw new Error(`${command} failed: ${result.spawnError.message}`);
  if (result.exitCode !== 0 && !/\b(no such|not found)\b/i.test(result.stderr || result.stdout)) {
    throw new Error(`${command} failed: ${compactError(result.stderr || result.stdout, `exit ${String(result.exitCode)}`)}`);
  }
}
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run"; }
function createOwnerToken(): string { return `${process.pid}-${Date.now()}-${randomUUID()}`; }
function containerCwd(workspace: string, requested?: string): string {
  if (!requested) return "/workspace";
  const rel = relative(workspace, isAbsolute(requested) ? requested : resolve(workspace, requested));
  if (!rel || rel === ".") return "/workspace";
  if (rel.startsWith("..") || rel.includes(":") || isAbsolute(rel)) throw new Error(`Container command cwd escapes workspace: ${requested}`);
  return `/workspace/${rel.replaceAll("\\", "/")}`;
}

async function resolveTargets(targets: ContainerTarget[]): Promise<Array<{ address: string; port: number; protocol: ContainerTarget["protocol"] }>> {
  const result: Array<{ address: string; port: number; protocol: ContainerTarget["protocol"] }> = [];
  for (const target of targets) {
    const addresses = await lookup(target.host, { all: true });
    for (const address of addresses) if (address.family === 4) result.push({ address: address.address, port: target.port, protocol: target.protocol });
  }
  if (result.length === 0 && targets.length > 0) throw new Error("No IPv4 addresses resolved for target-only container network");
  return [...new Map(result.map((item) => [`${item.protocol}:${item.address}:${item.port}`, item])).values()];
}

function isStale(created: string, olderThanMs: number): boolean {
  const timestamp = Date.parse(created);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= olderThanMs;
}

async function isLiveProcess(rawPid: string | undefined, rawStartedAt: string | undefined): Promise<boolean> {
  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // The current process has an exact startup marker; avoid an external
  // process query when a stale container claims this PID with another time.
  if (pid === process.pid) {
    const marker = Number(rawStartedAt);
    return Number.isFinite(marker) && Math.abs(marker - PROCESS_STARTED_AT) <= 2_000;
  }
  const expectedStartedAt = Number(rawStartedAt);
  const actualStartedAt = await processStartTimeMs(pid);
  if (actualStartedAt !== undefined && Number.isFinite(expectedStartedAt)) {
    return Math.abs(actualStartedAt - expectedStartedAt) <= 2_000;
  }
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the process exists but is not signalable by this user; keep
    // the resource rather than risking deletion of another active run.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a process creation time where the host exposes one, preventing PID reuse from protecting stale runs. */
async function processStartTimeMs(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      const [stat, uptimeText] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile("/proc/uptime", "utf8"),
      ]);
      const closingParen = stat.lastIndexOf(")");
      const fields = closingParen >= 0 ? stat.slice(closingParen + 1).trim().split(/\s+/) : [];
      const startTicks = Number(fields[19]); // field 22, after the comm field
      const uptimeSeconds = Number(uptimeText.trim().split(/\s+/)[0]);
      if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return undefined;
      return Date.now() - uptimeSeconds * 1_000 + startTicks * 10;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    return await windowsProcessStartTimeMs(pid);
  }
  return undefined;
}

async function windowsProcessStartTimeMs(pid: number): Promise<number | undefined> {
  return await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `try { ([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds() } catch { exit 1 }`], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => { clearTimeout(timer); resolve(undefined); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const value = Number(stdout.trim());
      resolve(code === 0 && Number.isFinite(value) ? value : undefined);
    });
  });
}

async function prepareWorkspace(workspace: string): Promise<string> {
  if (process.platform !== "win32" && typeof process.getuid === "function" && typeof process.getgid === "function" && process.getuid() !== 0) {
    return `${process.getuid()}:${process.getgid()}`;
  }
  // Root-created Linux bind mounts otherwise appear owned by root inside the
  // fixed non-root image user. Chown the exact per-run tree to that user and
  // grant only owner/group access; never make challenge credentials world-readable.
  if (process.platform !== "win32") await makeWorkspaceWritable(workspace, 1001, 1001);
  return "1001:1001";
}

async function makeWorkspaceWritable(root: string, uid: number, gid: number): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) return;
    const existingMode = stat.mode & 0o7777;
    await fs.chown(path, uid, gid);
    const executable = existingMode & 0o111;
    await fs.chmod(path, stat.isDirectory() ? 0o770 : (0o660 | executable));
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(path, { withFileTypes: true })) await visit(resolve(path, entry.name));
  };
  await visit(root);
}
