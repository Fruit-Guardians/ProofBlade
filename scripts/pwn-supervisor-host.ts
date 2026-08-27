import { isAbsolute, resolve } from "node:path";
import { DurablePwnSessionSupervisor } from "@proofblade/materials";

/** Build the deployment-owned detached-worker supervisor used by the Pwn host adapter. */
export function createPwnSessionSupervisor(): DurablePwnSessionSupervisor {
  const statePath = process.env.PROOFBLADE_PWN_SUPERVISOR_STATE ?? ".proofblade/pwn-supervisor.json";
  const workerScript = process.env.PROOFBLADE_PWN_WORKER_SCRIPT ?? "scripts/pwn-session-worker.mjs";
  const timeoutMs = process.env.PROOFBLADE_PWN_SUPERVISOR_TIMEOUT_MS === undefined
    ? undefined
    : Number(process.env.PROOFBLADE_PWN_SUPERVISOR_TIMEOUT_MS);
  return new DurablePwnSessionSupervisor({
    statePath: isAbsolute(statePath) ? statePath : resolve(process.cwd(), statePath),
    workerScript: isAbsolute(workerScript) ? workerScript : resolve(process.cwd(), workerScript),
    allowLocalCommands: process.env.PROOFBLADE_PWN_ALLOW_LOCAL_COMMANDS === "1",
    docker: parseDockerPolicy(),
    remoteScope: parseRemoteScope(),
    timeoutMs,
  });
}

function parseDockerPolicy(): { containerId: string; allowedCommands: string[]; executable?: string; allowShellCommands?: boolean } | undefined {
  const containerId = process.env.PROOFBLADE_PWN_DOCKER_CONTAINER?.trim();
  const allowedCommands = (process.env.PROOFBLADE_PWN_DOCKER_ALLOWED_COMMANDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!containerId || allowedCommands.length === 0) return undefined;
  return {
    containerId,
    allowedCommands,
    ...(process.env.PROOFBLADE_PWN_DOCKER_EXECUTABLE?.trim() ? { executable: process.env.PROOFBLADE_PWN_DOCKER_EXECUTABLE.trim() } : {}),
    ...(process.env.PROOFBLADE_PWN_DOCKER_ALLOW_SHELL === "1" ? { allowShellCommands: true } : {}),
  };
}

function parseRemoteScope(): { allowedHosts: string[]; allowedPorts: number[] } | undefined {
  const hosts = (process.env.PROOFBLADE_PWN_REMOTE_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const ports = (process.env.PROOFBLADE_PWN_REMOTE_ALLOWED_PORTS ?? "").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 1 && value <= 65_535);
  return hosts.length > 0 && ports.length > 0 ? { allowedHosts: hosts, allowedPorts: ports } : undefined;
}

export default createPwnSessionSupervisor;
