import {
  ExecutionError,
  NodeExecutionEnv,
  err,
  ok,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core/node";
import type { ContainerCommandOptions, ContainerRef, ContainerRuntimePort } from "./contracts.js";

/**
 * Host-backed filesystem plus container-backed process execution.
 *
 * Keeping the workspace filesystem on the host is intentional: ProofBlade's
 * artifact store, session journal and fixture verifier all address the same
 * host path, while every shell command from the coding lane crosses the Docker
 * boundary. No host environment variables are copied into the container.
 */
export class ContainerExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
  public constructor(
    private readonly runtime: ContainerRuntimePort,
    private readonly ref: ContainerRef,
    hostCwd: string,
  ) {
    super({ cwd: hostCwd });
  }

  public override async exec(command: string, options: ShellExecOptions = {}): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    try {
      const result = await this.runtime.exec(this.ref, command, {
        cwd: options.cwd,
        env: options.env,
        inheritEnv: options.inheritEnv,
        stdin: undefined,
        timeoutMs: options.timeout === undefined ? undefined : Math.max(1, options.timeout * 1000),
        signal: options.abortSignal,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      } satisfies ContainerCommandOptions);
      return ok({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const code: "aborted" | "timeout" | "spawn_error" = options.abortSignal?.aborted ? "aborted" : /timed out/i.test(cause.message) ? "timeout" : "spawn_error";
      return err(new ExecutionError(code, cause.message, cause));
    }
  }

  /** Solver owns container teardown; cleaning this env must never remove it. */
  public override async cleanup(): Promise<void> {
    return;
  }
}
