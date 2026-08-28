import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurablePwnSessionSupervisor } from "../src/recovery/pwn-session-supervisor.js";
import type { SessionRuntimeCreateRequest } from "../src/recovery/session-runtime-wire.js";
import { sessionRuntimeWireResource } from "../src/recovery/session-runtime-wire.js";
import type { ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

const KEY = "b".repeat(64);
const WORKER = join(process.cwd(), "scripts", "pwn-session-worker.mjs");

function createRequest(): SessionRuntimeCreateRequest {
  return {
    kind: "pwn-session",
    runId: "PWN-SUPERVISOR-REAL",
    generation: 1,
    ownerLane: "executor",
    requestKey: KEY,
    pwn: {
      mode: "local",
      command: [process.execPath, "-e", "process.stdin.on('data', chunk => process.stdout.write('echo:' + chunk.toString()))"],
      cwd: process.cwd(),
      waitTimeoutMs: 2_000,
      idleSilenceMs: 100,
    },
  };
}

function createRemoteRequest(endpoint: string): SessionRuntimeCreateRequest {
  return {
    kind: "pwn-session",
    runId: "PWN-SUPERVISOR-REMOTE",
    generation: 1,
    ownerLane: "executor",
    requestKey: "c".repeat(64),
    pwn: {
      mode: "remote",
      endpoint,
      // The deployment hint is part of the immutable request identity. The
      // detached worker must never execute it for a remote TCP session.
      command: ["this-command-must-not-be-executed"],
      waitTimeoutMs: 2_000,
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
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    inspectCount: 0,
  };
}

test("durable Pwn supervisor keeps one detached worker across supervisor instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-real-"));
  const statePath = join(root, "supervisor.json");
  const request = createRequest();
  const first = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 5_000, allowLocalCommands: true });
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  let released = false;
  try {
    assert.equal((await first.health()).status, "READY");
    created = await first.create(request, KEY);
    const tokenPath = `${statePath}.${created.externalId}.worker.json.token`;
    await access(tokenPath);
    const wire = sessionRuntimeWireResource(resource(created, request));
    assert.deepEqual(await first.actions.pwnWrite(wire, "ping\n"), { delta: "echo:ping\n", waitReason: "data", exited: false, truncated: false });

    const restarted = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 5_000, allowLocalCommands: true });
    assert.deepEqual(await restarted.inspectByIdempotency(request, KEY), { status: "PRESENT", created });
    assert.deepEqual(await restarted.inspect(created.externalId, request), { status: "PRESENT", externalId: created.externalId });
    assert.equal(await restarted.adopt(created.externalId, request), true);
    assert.deepEqual(await restarted.actions.pwnWrite(wire, "resume\n"), { delta: "echo:resume\n", waitReason: "data", exited: false, truncated: false });
    assert.deepEqual(await restarted.actions.pwnClose(wire), { exitCode: null });
    assert.equal(await restarted.release(created.externalId, request, "test cleanup"), true);
    released = true;
    await assert.rejects(access(tokenPath), { code: "ENOENT" });
    assert.deepEqual(await restarted.inspect(created.externalId, request), { status: "ABSENT", externalId: created.externalId });
  } finally {
    if (created && !released) await first.release(created.externalId, request, "test cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("detached Pwn worker survives the supervisor process itself exiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-process-"));
  const statePath = join(root, "supervisor.json");
  const request = createRequest();
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  const childScript = [
    "import { DurablePwnSessionSupervisor } from './packages/materials/src/recovery/pwn-session-supervisor.ts';",
    "const request = JSON.parse(process.env.PB_PWN_REQUEST);",
    "const supervisor = new DurablePwnSessionSupervisor({ statePath: process.env.PB_PWN_STATE, workerScript: process.env.PB_PWN_WORKER, timeoutMs: 5000, allowLocalCommands: true });",
    "console.log(JSON.stringify(await supervisor.create(request, process.env.PB_PWN_KEY)));",
  ].join("\n");
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      env: { ...process.env, PB_PWN_REQUEST: JSON.stringify(request), PB_PWN_STATE: statePath, PB_PWN_WORKER: WORKER, PB_PWN_KEY: KEY },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    });
    assert.equal(exitCode, 0, stderr);
    created = JSON.parse(stdout.trim()) as { sessionId: string; externalId: string; stateHash: string };
    const restarted = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 5_000, allowLocalCommands: true });
    const requestResource = sessionRuntimeWireResource(resource(created, request));
    assert.deepEqual(await restarted.inspectByIdempotency(request, KEY), { status: "PRESENT", created });
    assert.deepEqual(await restarted.actions.pwnWrite(requestResource, "after-process-restart\n"), { delta: "echo:after-process-restart\n", waitReason: "data", exited: false, truncated: false });
    assert.equal(await restarted.release(created.externalId, request, "test cleanup"), true);
  } finally {
    if (created) await new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 1_000, allowLocalCommands: true }).release(created.externalId, request, "test cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor never creates a replacement when a worker disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-unknown-"));
  const statePath = join(root, "supervisor.json");
  const request = createRequest();
  const supervisor = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 1_000, allowLocalCommands: true });
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  try {
    created = await supervisor.create(request, KEY);
    const ledger = JSON.parse(await readFile(statePath, "utf8")) as { records: Array<{ workerPort: number; state: string }> };
    const originalPort = ledger.records[0]!.workerPort;
    ledger.records[0]!.workerPort = 1;
    await writeFile(statePath, `${JSON.stringify(ledger)}\n`, "utf8");
    const second = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 300, allowLocalCommands: true });
    assert.deepEqual(await second.inspectByIdempotency(request, KEY), { status: "UNKNOWN" });
    await assert.rejects(second.create(request, KEY), /awaiting exact worker reconciliation/);
    assert.equal(await second.release(created.externalId, request, "worker temporarily unreachable"), false);
    assert.equal(created.externalId.startsWith("pwn-runtime-"), true);
    ledger.records[0]!.workerPort = originalPort;
    await writeFile(statePath, `${JSON.stringify(ledger)}\n`, "utf8");
    assert.equal(await second.release(created.externalId, request, "test cleanup after reconciliation"), true);
    created = undefined;
  } finally {
    if (created) await supervisor.release(created.externalId, request, "test cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor rejects host-local commands unless deployment opts in", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-policy-"));
  try {
    const supervisor = new DurablePwnSessionSupervisor({ statePath: join(root, "supervisor.json"), workerScript: WORKER, timeoutMs: 1_000 });
    await assert.rejects(supervisor.create(createRequest(), KEY), /local commands require an explicit deployment opt-in/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor accepts only deployment-allowlisted Docker commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-docker-policy-"));
  try {
    const request = createRequest();
    const supervisor = new DurablePwnSessionSupervisor({
      statePath: join(root, "supervisor.json"),
      workerScript: WORKER,
      docker: { containerId: "proofblade-target", allowedCommands: ["/app/challenge"] },
    });
    await assert.rejects(supervisor.create(request, KEY), /outside deployment allowlist/);
    const containerRequest = { ...request, pwn: { ...request.pwn!, command: ["/app/challenge"], cwd: "D:\\host-workspace" } };
    await assert.rejects(supervisor.create(containerRequest, KEY), /cwd must be a bounded container path/);
    await assert.rejects(access(join(root, "supervisor.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor keeps Docker shell execution explicitly disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-docker-shell-"));
  try {
    const request = { ...createRequest(), pwn: { ...createRequest().pwn!, command: ["/bin/sh"] } };
    const supervisor = new DurablePwnSessionSupervisor({
      statePath: join(root, "supervisor.json"),
      workerScript: WORKER,
      docker: { containerId: "proofblade-target", allowedCommands: ["/bin/sh"] },
    });
    await assert.rejects(supervisor.create(request, KEY), /shell commands require an explicit deployment opt-in/);
    await assert.rejects(access(join(root, "supervisor.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor owns a scoped remote TCP transport across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-remote-"));
  const fixture = createServer((socket) => {
    socket.write("ready\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
  });
  await new Promise<void>((resolveListen, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `127.0.0.1:${address.port}`;
  const request = createRemoteRequest(endpoint);
  const statePath = join(root, "supervisor.json");
  const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [address.port] };
  const first = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 5_000, remoteScope: scope });
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  try {
    created = await first.create(request, request.requestKey);
    const wire = sessionRuntimeWireResource(resource(created, request));
    assert.deepEqual(await first.actions.pwnRead(wire, { waitTimeoutMs: 2_000, idleSilenceMs: 100 }), { delta: "ready\n", waitReason: "data", exited: false, truncated: false });
    assert.deepEqual(await first.actions.pwnWrite(wire, "ping\n"), { delta: "echo:ping\n", waitReason: "data", exited: false, truncated: false });

    const restarted = new DurablePwnSessionSupervisor({ statePath, workerScript: WORKER, timeoutMs: 5_000, remoteScope: scope });
    assert.deepEqual(await restarted.inspectByIdempotency(request, request.requestKey), { status: "PRESENT", created });
    assert.equal(await restarted.adopt(created.externalId, request), true);
    assert.deepEqual(await restarted.actions.pwnWrite(wire, "resume\n"), { delta: "echo:resume\n", waitReason: "data", exited: false, truncated: false });
    assert.equal(await restarted.actions.pwnSignal(wire, "SIGTERM"), false);
    assert.equal(await restarted.release(created.externalId, request, "test cleanup"), true);
    created = undefined;
  } finally {
    if (created) await first.release(created.externalId, request, "test cleanup").catch(() => undefined);
    await new Promise<void>((resolveClose, reject) => fixture.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Pwn supervisor rejects remote TCP outside its deployment scope before reserving a worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-supervisor-remote-scope-"));
  try {
    const request = createRemoteRequest("127.0.0.1:31337");
    const supervisor = new DurablePwnSessionSupervisor({ statePath: join(root, "supervisor.json"), workerScript: WORKER, remoteScope: { allowedHosts: ["127.0.0.1"], allowedPorts: [31338] } });
    await assert.rejects(supervisor.create(request, request.requestKey), /outside deployment scope/);
    await assert.rejects(access(join(root, "supervisor.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached Pwn worker refuses to replay a command for an existing transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-worker-replay-"));
  const statePath = join(root, "worker.json");
  try {
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, transcript: "", cursor: 0, exited: false, exitCode: null })}\n`, "utf8");
    const child = spawn(process.execPath, [
      WORKER,
      "--host", "127.0.0.1",
      "--port", "1",
      "--token", "test-token",
      "--idempotency-key", KEY,
      "--session-id", "pwn-session-replay",
      "--external-id", "pwn-runtime-replay",
      "--state", statePath,
      "--command", Buffer.from(JSON.stringify([process.execPath, "-e", "process.stdout.write('replayed')"])).toString("base64url"),
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    });
    assert.equal(exitCode, 2, stderr);
    assert.match(stderr, /refusing to spawn a duplicate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
