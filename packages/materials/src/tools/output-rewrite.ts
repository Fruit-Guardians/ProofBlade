import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { OutputRewritePort, OutputRewriteResult, OutputRewriteTicket } from "@proofblade/molecules";
import type { ResolvedOutputRewriteConfig } from "../config.js";
import { sha256 } from "../domain/utils.js";

const MINIMUM_RTK_VERSION = [0, 23, 0] as const;

export interface RtkProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export type RtkProcessRunner = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<RtkProcessResult>;

export function createOutputRewritePort(config: ResolvedOutputRewriteConfig, runtimeRoot: string, runner: RtkProcessRunner = runRtkProcess): OutputRewritePort {
  return config.provider === "rtk"
    ? new RtkOutputRewriteAdapter(config, runtimeRoot, runner)
    : new BuiltinOutputRewriteAdapter();
}

export function createExecutionEnvRtkProcessRunner(env: ExecutionEnv): RtkProcessRunner {
  return async (input) => {
    const command = [input.executable, ...input.args].map(shellQuote).join(" ");
    const result = await env.exec(command, {
      cwd: input.cwd,
      env: input.env,
      inheritEnv: true,
      timeout: input.timeoutMs / 1_000,
      abortSignal: input.signal,
    });
    if (!result.ok) return { stdout: "", stderr: result.error.message, exitCode: null, errorCode: result.error.code };
    return { stdout: result.value.stdout, stderr: result.value.stderr, exitCode: result.value.exitCode };
  };
}

export class BuiltinOutputRewriteAdapter implements OutputRewritePort {
  public async prepare(request: { command: string }): Promise<OutputRewriteTicket> {
    const hash = sha256(request.command);
    return {
      requestedProvider: "builtin",
      provider: "builtin",
      providerVersion: "1",
      applied: false,
      command: request.command,
      originalCommandHash: hash,
      rewrittenCommandHash: hash,
      executionEnv: {},
    };
  }

  public async finalize(ticket: OutputRewriteTicket, visibleOutput: string): Promise<OutputRewriteResult> {
    const bytes = Buffer.byteLength(visibleOutput);
    return { ticket, rawOutput: visibleOutput, rawCapture: "visible-output", rawBytes: bytes, visibleBytes: bytes, rawTruncated: false };
  }
}

export class RtkOutputRewriteAdapter implements OutputRewritePort {
  private probePromise?: Promise<{ ok: true; version: string } | { ok: false; reason: string }>;

  public constructor(
    private readonly config: ResolvedOutputRewriteConfig,
    private readonly runtimeRoot: string,
    private readonly runner: RtkProcessRunner = runRtkProcess,
  ) {}

  public async prepare(request: { toolCallId: string; command: string; cwd: string }, signal?: AbortSignal): Promise<OutputRewriteTicket> {
    const originalCommandHash = sha256(request.command);
    const probe = await (this.probePromise ??= this.probe(request.cwd));
    if (!probe.ok) return this.fallback(request.command, originalCommandHash, probe.reason);

    const callRoot = join(this.runtimeRoot, "rtk", `${sanitizeSegment(request.toolCallId)}-${sha256(request.toolCallId).slice(0, 12)}`);
    const configRoot = join(callRoot, "config");
    const teeRoot = join(callRoot, "tee");
    await Promise.all([mkdir(join(configRoot, "rtk"), { recursive: true }), mkdir(teeRoot, { recursive: true })]);
    await writeFile(join(configRoot, "rtk", "config.toml"), rtkConfig(this.config.maxRawBytes), "utf8");
    const executionEnv = runtimeEnvironment(configRoot, teeRoot);
    const rewritten = await this.runner({
      executable: this.config.rtkCommand,
      args: ["rewrite", request.command],
      cwd: request.cwd,
      env: executionEnv,
      timeoutMs: this.config.rewriteTimeoutMs,
      signal,
    });
    if (rewritten.exitCode === 1 && rewritten.stdout.trim().length === 0) {
      await rm(callRoot, { recursive: true, force: true });
      return {
        requestedProvider: "rtk",
        provider: "rtk",
        providerVersion: probe.version,
        applied: false,
        command: request.command,
        originalCommandHash,
        rewrittenCommandHash: originalCommandHash,
        executionEnv: {},
        fallbackReason: "no-match",
      };
    }
    if (rewritten.exitCode === 2) {
      await rm(callRoot, { recursive: true, force: true });
      throw new Error("RTK denied the command rewrite");
    }
    if ((rewritten.exitCode !== 0 && rewritten.exitCode !== 3) || rewritten.stdout.trim().length === 0) {
      await rm(callRoot, { recursive: true, force: true });
      return this.fallback(request.command, originalCommandHash, `rewrite-${rewritten.errorCode ?? rewritten.exitCode ?? "failed"}`);
    }

    const command = materializeRtkCommand(rewritten.stdout.trim(), this.config.rtkCommand);
    return {
      requestedProvider: "rtk",
      provider: "rtk",
      providerVersion: probe.version,
      applied: command !== request.command,
      command,
      originalCommandHash,
      rewrittenCommandHash: sha256(command),
      executionEnv,
      metadata: { callRoot, teeRoot },
    };
  }

  public async finalize(ticket: OutputRewriteTicket, visibleOutput: string): Promise<OutputRewriteResult> {
    const visibleBytes = Buffer.byteLength(visibleOutput);
    const callRoot = stringMetadata(ticket, "callRoot");
    const teeRoot = stringMetadata(ticket, "teeRoot");
    try {
      if (!ticket.applied || !teeRoot) {
        return { ticket, rawOutput: visibleOutput, rawCapture: "visible-output", rawBytes: visibleBytes, visibleBytes, rawTruncated: false };
      }
      const capture = await readRtkCapture(teeRoot, this.config.maxRawBytes);
      if (!capture) {
        return { ticket, rawOutput: visibleOutput, rawCapture: "visible-output", rawBytes: visibleBytes, visibleBytes, rawTruncated: false };
      }
      return {
        ticket,
        rawOutput: capture.text,
        rawCapture: "rtk-tee",
        rawBytes: capture.originalBytes,
        visibleBytes,
        rawTruncated: capture.truncated,
      };
    } finally {
      if (callRoot) await rm(callRoot, { recursive: true, force: true });
    }
  }

  private async probe(cwd: string): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    const result = await this.runner({ executable: this.config.rtkCommand, args: ["--version"], cwd, env: {}, timeoutMs: this.config.rewriteTimeoutMs });
    if (result.exitCode !== 0) return { ok: false, reason: `probe-${result.errorCode ?? result.exitCode ?? "failed"}` };
    const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { ok: false, reason: "version-invalid" };
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    if (compareVersion(parts, MINIMUM_RTK_VERSION) < 0) return { ok: false, reason: `version-${version}` };
    return { ok: true, version };
  }

  private fallback(command: string, commandHash: string, reason: string): OutputRewriteTicket {
    if (this.config.fallback === "fail") throw new Error(`RTK output rewrite failed (${reason})`);
    return {
      requestedProvider: "rtk",
      provider: "builtin",
      providerVersion: "1",
      applied: false,
      command,
      originalCommandHash: commandHash,
      rewrittenCommandHash: commandHash,
      executionEnv: {},
      fallbackReason: reason,
    };
  }
}

export async function runRtkProcess(input: Parameters<RtkProcessRunner>[0]): Promise<RtkProcessResult> {
  return await new Promise((resolve) => {
    execFile(input.executable, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: input.timeoutMs,
      signal: input.signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === "number" ? (error as NodeJS.ErrnoException).code as unknown as number : error ? null : 0;
      const errorCode = error && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : undefined;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code, errorCode });
    });
  });
}

async function readRtkCapture(directory: string, maxBytes: number): Promise<{ text: string; originalBytes: number; truncated: boolean } | undefined> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort();
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const chunks: Buffer[] = [];
  for (const name of names) chunks.push(await readFile(join(directory, name)));
  const combined = chunks.length === 1
    ? chunks[0]!
    : Buffer.concat(chunks.flatMap((chunk, index) => [Buffer.from(`${index === 0 ? "" : "\n"}[rtk raw part ${index + 1}]\n`), chunk]));
  const bounded = boundBuffer(combined, maxBytes);
  return { text: bounded.text, originalBytes: combined.byteLength, truncated: bounded.truncated };
}

function boundBuffer(value: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (value.byteLength <= maxBytes) return { text: value.toString("utf8"), truncated: false };
  const provisionalMarker = Buffer.from("\n...[bytes omitted by ProofBlade]...\n");
  const contentBytes = Math.max(0, maxBytes - provisionalMarker.byteLength - 24);
  const marker = Buffer.from(`\n...[${value.byteLength - contentBytes} bytes omitted by ProofBlade]...\n`);
  const headBytes = Math.ceil(contentBytes * 0.65);
  const tailBytes = contentBytes - headBytes;
  return {
    text: `${decodePrefix(value, headBytes)}${marker.toString("utf8")}${decodeSuffix(value, tailBytes)}`,
    truncated: true,
  };
}

function decodePrefix(value: Buffer, bytes: number): string {
  let end = Math.min(bytes, value.byteLength);
  while (end > 0 && end < value.byteLength && (value[end]! & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end).toString("utf8");
}

function decodeSuffix(value: Buffer, bytes: number): string {
  let start = Math.max(0, value.byteLength - bytes);
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}

function runtimeEnvironment(configRoot: string, teeRoot: string): Record<string, string> {
  const bridge = [
    process.env.WSLENV,
    "APPDATA/p",
    "XDG_CONFIG_HOME/p",
    "RTK_TEE_DIR/p",
    "NO_COLOR/u",
    "CLICOLOR/u",
  ].filter(Boolean).join(":");
  return {
    APPDATA: configRoot,
    XDG_CONFIG_HOME: configRoot,
    RTK_TEE_DIR: teeRoot,
    NO_COLOR: "1",
    CLICOLOR: "0",
    WSLENV: bridge,
  };
}

function rtkConfig(maxRawBytes: number): string {
  return `[tracking]\nenabled = false\nhistory_days = 90\n\n[display]\ncolors = false\nemoji = false\nmax_width = 120\n\n[tee]\nenabled = true\nmode = "always"\nmax_files = 100\nmax_file_size = ${maxRawBytes}\n`;
}

function materializeRtkCommand(command: string, executable: string): string {
  if (!isAbsolute(executable) && executable === "rtk") return command;
  const quoted = shellQuote(executable);
  return command.replace(/(^|(?:&&|\|\||;|\|)\s*)rtk(?=\s)/g, (_match, prefix: string) => `${prefix}${quoted}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

function stringMetadata(ticket: OutputRewriteTicket, key: string): string | undefined {
  const value = ticket.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "tool-call";
}
