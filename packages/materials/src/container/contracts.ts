import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ContainerNetworkPolicy } from "../config.js";
import type { SessionWaitReason } from "../domain/types.js";

export type { ContainerNetworkPolicy };

export type ContainerTargetProtocol = "tcp" | "udp";

export interface ContainerTarget {
  host: string;
  port: number;
  protocol: ContainerTargetProtocol;
}

export interface ContainerLimits {
  memory?: string;
  cpus?: string;
  pids?: number;
  shmSize?: string;
  commandTimeoutMs?: number;
}

export interface ContainerRef {
  runId: string;
  generation: number;
  containerId: string;
  name: string;
  profile: "web" | "pwn" | "pwn-kernel";
  image: string;
  imageDigest: string;
  workspaceHostPath: string;
  workspaceContainerPath: "/workspace";
  networkPolicy: ContainerNetworkPolicy;
  gatewayContainerId?: string;
  networkName?: string;
}

export interface ContainerCreateRequest {
  runId: string;
  generation: number;
  profile: ContainerRef["profile"];
  image: string;
  workspaceHostPath: string;
  /** Optional read-only skill library mount; never mounts the ProofBlade root. */
  skillLibraryHostPath?: string;
  targets: ContainerTarget[];
  networkPolicy: ContainerNetworkPolicy;
  gatewayImage?: string;
  limits?: ContainerLimits;
}

export interface ContainerCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Optional one-shot stdin for exploit scripts that enter a spawned shell. */
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ContainerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
}

export interface ContainerDoctorReport {
  backend: "docker";
  installed: boolean;
  daemon: boolean;
  image?: { name: string; available: boolean; digest?: string };
  reason?: string;
}

/**
 * Why a session read/write returned control to the caller.  `idle` and
 * `timeout` do NOT prove the foreground command exited; only `exit` does.  The
 * distinction matters for pwn: a program blocked on read() looks the same as a
 * finished command to a pipe-based observer, so callers must treat `idle` as a
 * hint, not proof of completion.  Defined in domain/types.ts as the single
 * source of truth so the durable projection and the runtime agree.
 */
export type { SessionWaitReason };

export interface ContainerSessionHandle {
  /** Runtime-facing id for this live process, minted by the runtime. */
  readonly sessionId: string;
  readonly ref: ContainerRef;
}

export interface ContainerSessionOpenOptions {
  /** Command that becomes the long-lived process, e.g. ["/bin/bash","-i"]. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Absolute wall-clock ceiling for a single read/wait call. */
  waitTimeoutMs?: number;
  /** Silence window after which new output is treated as idle. */
  idleSilenceMs?: number;
}

export interface ContainerSessionReadOptions {
  waitTimeoutMs?: number;
  idleSilenceMs?: number;
  signal?: AbortSignal;
}

export interface ContainerSessionResult {
  /** Incremental UTF-8 output observed since the previous read, bounded. */
  delta: string;
  waitReason: SessionWaitReason;
  /** True once the underlying process has exited. */
  exited: boolean;
  exitCode?: number | null;
  /** True when the in-memory scrollback dropped older bytes. */
  truncated: boolean;
}

export interface ContainerRuntimePort {
  doctor(profile?: ContainerRef["profile"]): Promise<ContainerDoctorReport>;
  prewarm(profiles: ContainerRef["profile"][]): Promise<void>;
  create(request: ContainerCreateRequest): Promise<ContainerRef>;
  executionEnv(ref: ContainerRef): ExecutionEnv;
  exec(ref: ContainerRef, command: string, options?: ContainerCommandOptions): Promise<ContainerCommandResult>;
  health(ref: ContainerRef): Promise<boolean>;
  destroy(ref: ContainerRef): Promise<void>;
  reapStale(options?: { olderThanMs?: number; runId?: string; protectedRunIds?: string[]; includeRunning?: boolean }): Promise<number>;

  // --- P0.5 persistent session primitives ---
  /** Start a long-lived process inside the container; the handle survives across tool calls. */
  openSession(ref: ContainerRef, options: ContainerSessionOpenOptions): Promise<ContainerSessionHandle>;
  /** Write to the session stdin, then wait for a readiness signal or timeout. */
  sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array, options?: ContainerSessionReadOptions): Promise<ContainerSessionResult>;
  /** Drain output without sending input. */
  sessionRead(handle: ContainerSessionHandle, options?: ContainerSessionReadOptions): Promise<ContainerSessionResult>;
  /** Signal the session's in-container foreground process group. */
  sessionSignal(handle: ContainerSessionHandle, signal: NodeJS.Signals): Promise<boolean>;
  /** Terminate the session process; idempotent. */
  closeSession(handle: ContainerSessionHandle): Promise<{ exitCode: number | null }>;
}
