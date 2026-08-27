import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DurablePwnSessionSupervisor,
  SpawnDockerCommandRunner,
  sessionRuntimeWireResource,
} from "@proofblade/materials";
import type { ExternalResourceRecord } from "@proofblade/materials";
import type { SessionRuntimeCreateRequest } from "@proofblade/materials";

/**
 * Exercise the deployment-owned Docker Pwn path without connecting to a CTF
 * service. The image must be supplied by the deployment and should be pinned
 * by digest; the ordinary smoke is deliberately a no-op when Docker is not
 * available, while the required form is a release/deployment gate.
 */
const required = process.argv.includes("--required");
const image = process.env.PROOFBLADE_PWN_SMOKE_IMAGE?.trim();
const dockerCommand = process.env.PROOFBLADE_PWN_DOCKER_EXECUTABLE?.trim() || "docker";

async function main(): Promise<void> {
  if (!image) {
    skip("PROOFBLADE_PWN_SMOKE_IMAGE is not set; use a pinned image or digest in the deployment environment");
    return;
  }
  if (required && !isPinnedImage(image)) {
    skip("required Docker smoke needs an immutable image digest (for example registry.example/pwn-fixture@sha256:<digest>)");
    return;
  }

  const runner = new SpawnDockerCommandRunner(dockerCommand);
  const daemon = await runner.run(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
  if (daemon.spawnError || daemon.exitCode !== 0) {
    skip(daemon.spawnError?.message ?? "Docker daemon is unavailable");
    return;
  }

  const inspected = await runner.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 10_000 });
  if (inspected.spawnError || inspected.exitCode !== 0 || !inspected.stdout.trim()) {
    skip(`Docker smoke image is not available locally: ${image}`);
    return;
  }
  const imageId = inspected.stdout.trim().split(/\r?\n/)[0]!;
  const containerName = `proofblade-pwn-smoke-${process.pid}-${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-docker-smoke-"));
  const statePath = join(root, "supervisor.json");
  const workerScript = resolve(process.cwd(), "scripts", "pwn-session-worker.mjs");
  const supervisorOptions = {
    statePath,
    workerScript,
    timeoutMs: 15_000,
    docker: {
      containerId: containerName,
      allowedCommands: ["/bin/sh"],
      executable: dockerCommand,
      allowShellCommands: true,
    },
  } as const;
  const request = smokeRequest();
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  let containerStarted = false;

  try {
    const started = await runner.run([
      "run",
      "-d",
      "--name",
      containerName,
      image,
      "/bin/sh",
      "-c",
      "while true; do sleep 3600; done",
    ], { timeoutMs: 30_000 });
    if (started.spawnError || started.exitCode !== 0) throw new Error(`Docker smoke container failed to start: ${compact(started.stderr || started.stdout)}`);
    assert.match(started.stdout.trim(), /^[a-f0-9]{12,64}$/i);
    containerStarted = true;

    const containerImage = await runner.run(["inspect", "--format", "{{.Image}}", containerName], { timeoutMs: 10_000 });
    if (containerImage.spawnError || containerImage.exitCode !== 0) throw new Error(`Docker smoke container could not be inspected: ${compact(containerImage.stderr)}`);
    assert.equal(containerImage.stdout.trim(), imageId, "smoke container must use the inspected fixed image");

    const supervisor = new DurablePwnSessionSupervisor(supervisorOptions);
    created = await supervisor.create(request, request.requestKey);
    const wire = sessionRuntimeWireResource(resource(created, request));
    assert.deepEqual(await supervisor.actions.pwnRead(wire, { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
      delta: "ready\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });
    assert.deepEqual(await supervisor.actions.pwnWrite(wire, "ping\n", { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
      delta: "echo:ping\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });

    const restarted = new DurablePwnSessionSupervisor(supervisorOptions);
    assert.deepEqual(await restarted.inspectByIdempotency(request, request.requestKey), { status: "PRESENT", created });
    assert.equal(await restarted.adopt(created.externalId, request), true);
    assert.deepEqual(await restarted.actions.pwnWrite(wire, "resume\n", { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
      delta: "echo:resume\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });
    assert.equal(await restarted.release(created.externalId, request, "docker smoke cleanup"), true);
    created = undefined;
    report({ status: "passed", image, imageId, restarted: true, container: containerName });
  } finally {
    if (created) await new DurablePwnSessionSupervisor(supervisorOptions).release(created.externalId, request, "docker smoke failure cleanup").catch(() => undefined);
    if (containerStarted) await runner.run(["rm", "-f", containerName], { timeoutMs: 15_000 });
    await rm(root, { recursive: true, force: true });
  }
}

function smokeRequest(): SessionRuntimeCreateRequest {
  return {
    kind: "pwn-session",
    runId: `PWN-DOCKER-SMOKE-${Date.now()}`,
    generation: 1,
    ownerLane: "executor",
    requestKey: "d".repeat(64),
    pwn: {
      mode: "local",
      command: ["/bin/sh", "-c", "printf 'ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done"],
      cwd: "/",
      waitTimeoutMs: 5_000,
      idleSilenceMs: 100,
    },
  };
}

function resource(created: { sessionId: string; externalId: string }, request: SessionRuntimeCreateRequest): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: `session:${created.sessionId}`,
    kind: "pwn-session",
    runId: request.runId,
    generation: request.generation,
    ownerLane: request.ownerLane,
    state: "CONFIRMED",
    externalId: created.externalId,
    requestKey: request.requestKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inspectCount: 0,
  };
}

function skip(reason: string): void {
  report({ status: "skipped", reason });
  if (required) process.exitCode = 2;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 512) || "unknown Docker error";
}

function isPinnedImage(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value) || /@sha256:[a-f0-9]{64}$/i.test(value);
}

function report(value: Record<string, unknown>): void {
  console.log(JSON.stringify({ smoke: "pwn-docker", ...value }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
