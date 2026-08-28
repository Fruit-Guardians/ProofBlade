import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "@proofblade/atoms";
import {
  BindingTransactionCoordinator,
  ControlStore,
  demoTask,
  DurablePwnSessionSupervisor,
  ExternalResourceRegistry,
  JsonlControlStore,
  sessionRuntimeWireResource,
  SpawnDockerCommandRunner,
} from "@proofblade/materials";
import type { ExternalResourceRecord, ProofBladeConfig, SessionRuntimeCreateRequest } from "@proofblade/materials";

/**
 * Run the deployment-owned Docker Pwn handoff fault matrix without a CTF
 * service. The target image is supplied by deployment and must contain /bin/sh.
 * The ordinary command reports SKIPPED when Docker is unavailable; --required
 * is intended for a release environment and turns that condition into exit 2.
 */
const required = process.argv.includes("--required");
const image = process.env.PROOFBLADE_PWN_SMOKE_IMAGE?.trim();
const dockerCommand = process.env.PROOFBLADE_PWN_DOCKER_EXECUTABLE?.trim() || "docker";
const reportPath = process.env.PROOFBLADE_PWN_FAULT_MATRIX_REPORT?.trim();
const faultPoints = ["after_external_started", "after_intent", "after_external_confirmed", "after_control_commit", "after_finalize"] as const;

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
};

async function main(): Promise<void> {
  if (!image) {
    skip("PROOFBLADE_PWN_SMOKE_IMAGE is not set; use a pinned image or digest in the deployment environment");
    return;
  }
  if (required && !isPinnedImage(image)) {
    skip("required Docker fault matrix needs an immutable image digest (for example registry.example/pwn-fixture@sha256:<digest>)");
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
    skip(`Docker fault matrix image is not available locally: ${image}`);
    return;
  }

  const imageId = inspected.stdout.trim().split(/\r?\n/)[0]!;
  const containerName = `proofblade-pwn-fault-${process.pid}-${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-docker-fault-matrix-"));
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
    if (started.spawnError || started.exitCode !== 0) throw new Error(`Docker fault matrix container failed to start: ${compact(started.stderr || started.stdout)}`);
    assert.match(started.stdout.trim(), /^[a-f0-9]{12,64}$/i);
    containerStarted = true;
    const containerImage = await runner.run(["inspect", "--format", "{{.Image}}", containerName], { timeoutMs: 10_000 });
    if (containerImage.spawnError || containerImage.exitCode !== 0) throw new Error(`Docker fault matrix container could not be inspected: ${compact(containerImage.stderr)}`);
    assert.equal(containerImage.stdout.trim(), imageId, "fault matrix container must use the inspected fixed image");

    for (const [index, faultPoint] of faultPoints.entries()) {
      await runCase(root, containerName, faultPoint, index, dockerCommand);
    }
    await report({ status: "passed", image, imageId, container: containerName, faultPoints });
  } finally {
    if (containerStarted) await runner.run(["rm", "-f", containerName], { timeoutMs: 15_000 });
    await rm(root, { recursive: true, force: true });
  }
}

async function runCase(root: string, containerName: string, faultPoint: (typeof faultPoints)[number], index: number, dockerExecutable: string): Promise<void> {
  const runId = `PWN-DOCKER-FAULT-${index}`;
  const requestKey = `${"d".repeat(63)}${index.toString(16)}`;
  const request: SessionRuntimeCreateRequest = {
    kind: "pwn-session",
    runId,
    generation: 0,
    ownerLane: "executor",
    requestKey,
    pwn: {
      mode: "local",
      command: ["/bin/sh", "-c", "printf 'matrix-ready\\n'; while IFS= read -r line; do printf 'matrix-echo:%s\\n' \"$line\"; done"],
      cwd: "/",
      waitTimeoutMs: 5_000,
      idleSilenceMs: 100,
    },
  };
  const statePath = join(root, `supervisor-${index}.json`);
  const supervisorOptions = {
    statePath,
    workerScript: resolve(process.cwd(), "scripts", "pwn-session-worker.mjs"),
    timeoutMs: 15_000,
    docker: { containerId: containerName, allowedCommands: ["/bin/sh"], executable: dockerExecutable, allowShellCommands: true },
  } as const;
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  const externalResources = new ExternalResourceRegistry(join(root, `external-resources-${index}.json`));
  const supervisor = new DurablePwnSessionSupervisor(supervisorOptions);
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  try {
    created = await supervisor.create(request, requestKey);
    const resourceInput = {
      id: `session:${created.sessionId}`,
      kind: "pwn-session" as const,
      runId,
      generation: 0,
      ownerLane: "executor" as const,
      externalId: created.externalId,
      requestKey,
    };
    const coordinator = new BindingTransactionCoordinator(control, externalResources);
    const faulting = new BindingTransactionCoordinator(control, externalResources, {
      fault: (point) => point === faultPoint ? (() => { throw new Error(`injected Docker fault: ${faultPoint}`); })() : undefined,
    });

    if (faultPoint === "after_external_started") {
      await assert.rejects(() => faulting.prepare({ sessionId: created!.sessionId, resource: resourceInput }), /injected Docker fault: after_external_started/);
      assert.deepEqual(await coordinator.intents(runId), []);
      assert.equal(await supervisor.release(created.externalId, request, "Docker matrix cleanup"), true);
      created = undefined;
      return;
    }

    let intent = await coordinator.prepare({ sessionId: created.sessionId, resource: resourceInput });
    if (faultPoint === "after_intent") {
      await assert.rejects(() => faulting.prepare({ sessionId: created.sessionId, resource: resourceInput }), /injected Docker fault: after_intent/);
      assert.equal((await coordinator.intents(runId)).length, 1);
      assert.deepEqual(await coordinator.recover(runId, 0), { repaired: [], bound: [], releaseCandidates: [intent.bindingTxnId], manual: [] });
      assert.equal(await supervisor.release(created.externalId, request, "Docker matrix cleanup"), true);
      created = undefined;
      return;
    }

    await externalResources.markConfirmed(resourceInput.id, "Docker matrix host confirmation");
    if (faultPoint === "after_external_confirmed") {
      await assert.rejects(() => faulting.markExternalConfirmed(intent), /injected Docker fault: after_external_confirmed/);
      intent = await coordinator.get(intent.bindingTxnId) as typeof intent;
      assert.equal(intent.state, "EXTERNAL_CONFIRMED");
      assert.deepEqual(await coordinator.recover(runId, 0), { repaired: [], bound: [], releaseCandidates: [intent.bindingTxnId], manual: [] });
      assert.equal(await supervisor.release(created.externalId, request, "Docker matrix cleanup"), true);
      created = undefined;
      return;
    }

    const session = {
      id: created.sessionId,
      runId,
      kind: "pwn-local" as const,
      ownerLane: "executor" as const,
      generation: 0,
      externalId: created.externalId,
      requestKey,
    };
    if (faultPoint === "after_control_commit") {
      await assert.rejects(() => faulting.commitControl(intent, session), /injected Docker fault: after_control_commit/);
      const restarted = new DurablePwnSessionSupervisor(supervisorOptions);
      assert.deepEqual(await restarted.inspectByIdempotency(request, requestKey), { status: "PRESENT", created });
      assert.equal(await restarted.adopt(created.externalId, request), true);
      const recovery = await coordinator.recover(runId, 0);
      assert.deepEqual(recovery, { repaired: [intent.bindingTxnId], bound: [], releaseCandidates: [], manual: [] });
      const bound = await externalResources.get(resourceInput.id);
      await assertRoundTrip(restarted, bound!, "matrix-control");
      assert.equal(await restarted.release(created.externalId, request, "Docker matrix cleanup"), true);
      created = undefined;
      return;
    }

    const committed = await coordinator.commitControl(intent, session);
    await assert.rejects(() => faulting.finalize(committed), /injected Docker fault: after_finalize/);
    assert.deepEqual(await coordinator.recover(runId, 0), { repaired: [], bound: [intent.bindingTxnId], releaseCandidates: [], manual: [] });
    const restarted = new DurablePwnSessionSupervisor(supervisorOptions);
    assert.deepEqual(await restarted.inspectByIdempotency(request, requestKey), { status: "PRESENT", created });
    assert.equal(await restarted.adopt(created.externalId, request), true);
    const bound = await externalResources.get(resourceInput.id);
    assert.equal(bound?.controlSessionId, created.sessionId);
    await assertRoundTrip(restarted, bound!, "matrix-finalize");
    assert.equal(await restarted.release(created.externalId, request, "Docker matrix cleanup"), true);
    created = undefined;
  } finally {
    if (created) await new DurablePwnSessionSupervisor(supervisorOptions).release(created.externalId, request, "Docker matrix cleanup").catch(() => undefined);
  }
}

async function assertRoundTrip(supervisor: DurablePwnSessionSupervisor, record: ExternalResourceRecord, payload: string): Promise<void> {
  const wire = sessionRuntimeWireResource(record);
  assert.deepEqual(await supervisor.actions.pwnRead(wire, { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
    delta: "matrix-ready\n",
    waitReason: "data",
    exited: false,
    truncated: false,
  });
  assert.deepEqual(await supervisor.actions.pwnWrite(wire, `${payload}\n`, { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
    delta: `matrix-echo:${payload}\n`,
    waitReason: "data",
    exited: false,
    truncated: false,
  });
}

async function skip(reason: string): Promise<void> {
  await report({ status: "skipped", reason });
  if (required) process.exitCode = 2;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 512) || "unknown Docker error";
}

function isPinnedImage(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value) || /@sha256:[a-f0-9]{64}$/i.test(value);
}

async function report(value: Record<string, unknown>): Promise<void> {
  const payload = { smoke: "pwn-docker-fault-matrix", ...value };
  console.log(JSON.stringify(payload));
  if (!reportPath) return;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...payload,
  };
  await atomicWriteFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
