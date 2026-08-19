import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ContainerNetworkPolicy } from "../config.js";

export type { ContainerNetworkPolicy };

export interface ContainerTarget {
  host: string;
  port: number;
  protocol?: string;
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

export interface ContainerRuntimePort {
  doctor(profile?: ContainerRef["profile"]): Promise<ContainerDoctorReport>;
  prewarm(profiles: ContainerRef["profile"][]): Promise<void>;
  create(request: ContainerCreateRequest): Promise<ContainerRef>;
  executionEnv(ref: ContainerRef): ExecutionEnv;
  exec(ref: ContainerRef, command: string, options?: ContainerCommandOptions): Promise<ContainerCommandResult>;
  health(ref: ContainerRef): Promise<boolean>;
  destroy(ref: ContainerRef): Promise<void>;
  reapStale(options?: { olderThanMs?: number; runId?: string }): Promise<number>;
}
