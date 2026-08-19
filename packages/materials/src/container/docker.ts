import { spawn } from "node:child_process";
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
        if (options.signal.aborted) { kill(); finish({ exitCode: null, spawnError: new Error("docker command aborted") }); }
        else options.signal.addEventListener("abort", () => { kill(); finish({ exitCode: null, spawnError: new Error("docker command aborted") }); }, { once: true });
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
    const labels = ["--label", "proofblade.managed=true", "--label", `proofblade.run_id=${request.runId}`, "--label", `proofblade.generation=${request.generation}`, "--label", `proofblade.profile=${request.profile}`];
    let networkName: string | undefined;
    let gatewayContainerId: string | undefined;
    let containerId: string | undefined;
    try {
      if (request.networkPolicy === "target-only") {
        networkName = `proofblade-${slug}-g${request.generation}-net`;
        await this.runChecked(["network", "create", "--label", "proofblade.managed=true", "--label", `proofblade.run_id=${request.runId}`, "--ipv6=false", networkName]);
        const gatewayImage = request.gatewayImage ?? this.config.images.gateway;
        await this.ensureImage(gatewayImage);
        const gateway = await this.runChecked(["run", "-d", "--name", `${name}-gateway`, ...labels, "--network", networkName, "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW", "--security-opt", "no-new-privileges", gatewayImage, "sleep", "infinity"]);
        gatewayContainerId = gateway.stdout.trim();
        const targets = await resolveTargets(request.targets);
        await this.runChecked(["exec", gatewayContainerId, "/usr/local/bin/pb-egress-init", ...targets.map((target) => `${target.address}:${target.port}`)]);
      }
      const limits = request.limits;
      const args = ["run", "-d", "--name", name, ...labels, "--user", "1001:1001", "--workdir", "/workspace", "--mount", `type=bind,source=${request.workspaceHostPath},destination=/workspace`, ...(request.skillLibraryHostPath ? ["--mount", `type=bind,source=${request.skillLibraryHostPath},destination=/opt/proofblade/skills,readonly`] : []), "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g", "--tmpfs", "/run:rw,noexec,nosuid,size=64m", "--pids-limit", String(limits?.pids ?? 512), "--cpus", limits?.cpus ?? "2", "--memory", limits?.memory ?? "4g", "--shm-size", limits?.shmSize ?? "1g", "--ulimit", "nofile=4096:4096", "--ulimit", "fsize=1073741824:1073741824", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
      if (request.profile === "pwn" || request.profile === "pwn-kernel") args.push("--cap-add", "SYS_PTRACE");
      if (request.networkPolicy === "none") args.push("--network", "none");
      else if (request.networkPolicy === "bridge") args.push("--network", "bridge");
      else if (gatewayContainerId) args.push("--network", `container:${gatewayContainerId}`);
      args.push(request.image, "sleep", "infinity");
      const created = await this.runChecked(args);
      containerId = created.stdout.trim();
      const inspected = await this.runChecked(["image", "inspect", "--format", "{{.Id}}", request.image]);
      return { runId: request.runId, generation: request.generation, containerId, name, profile: request.profile, image: request.image, imageDigest: inspected.stdout.trim(), workspaceHostPath: request.workspaceHostPath, workspaceContainerPath: "/workspace", networkPolicy: request.networkPolicy, ...(gatewayContainerId ? { gatewayContainerId } : {}), ...(networkName ? { networkName } : {}) };
    } catch (error) {
      if (containerId) await this.removeContainer(containerId);
      if (gatewayContainerId) await this.removeContainer(gatewayContainerId);
      if (networkName) await this.removeNetwork(networkName);
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
    await this.removeContainer(ref.containerId);
    if (ref.gatewayContainerId) await this.removeContainer(ref.gatewayContainerId);
    if (ref.networkName) await this.removeNetwork(ref.networkName);
  }

  public async reapStale(options: { olderThanMs?: number; runId?: string } = {}): Promise<number> {
    // Reaping without an explicit run id is intentionally disabled: a stale
    // local process must never delete another active user's challenge.
    if (!options.runId) return 0;
    const listed = await this.runner.run(["ps", "-aq", "--filter", "label=proofblade.managed=true", "--filter", `label=proofblade.run_id=${options.runId}`], { timeoutMs: configTimeout(this.config) });
    if (listed.exitCode !== 0) return 0;
    let removed = 0;
    for (const id of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) { await this.removeContainer(id); removed += 1; }
    return removed;
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

  private async removeContainer(id: string): Promise<void> { await this.runner.run(["rm", "-f", id], { timeoutMs: configTimeout(this.config) }); }
  private async removeNetwork(name: string): Promise<void> { await this.runner.run(["network", "rm", name], { timeoutMs: configTimeout(this.config) }); }
}

function configTimeout(config: ResolvedExecutionConfig): number { return Math.min(config.commandWaitMs, config.commandHardTimeoutMs); }
function compactError(value: string, fallback: string): string { return value.trim().replace(/\s+/g, " ").slice(0, 500) || fallback; }
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run"; }
function containerCwd(workspace: string, requested?: string): string {
  if (!requested) return "/workspace";
  const rel = relative(workspace, isAbsolute(requested) ? requested : resolve(workspace, requested));
  if (!rel || rel === ".") return "/workspace";
  if (rel.startsWith("..") || rel.includes(":") || isAbsolute(rel)) throw new Error(`Container command cwd escapes workspace: ${requested}`);
  return `/workspace/${rel.replaceAll("\\", "/")}`;
}

async function resolveTargets(targets: ContainerTarget[]): Promise<Array<{ address: string; port: number }>> {
  const result: Array<{ address: string; port: number }> = [];
  for (const target of targets) {
    const addresses = await lookup(target.host, { all: true });
    for (const address of addresses) if (address.family === 4) result.push({ address: address.address, port: target.port });
  }
  if (result.length === 0 && targets.length > 0) throw new Error("No IPv4 addresses resolved for target-only container network");
  return [...new Map(result.map((item) => [`${item.address}:${item.port}`, item])).values()];
}
