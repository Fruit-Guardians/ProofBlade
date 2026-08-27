import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execPath } from "node:process";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPwnSessionSupervisor, createPwnSessionRuntimeHost } from "../session-runtime-pwn-host.ts";
import { startSessionRuntimeService } from "../session-runtime-service.ts";

const validSupervisor = `
export function createPwnSessionSupervisor() {
  return {
    actions: {
      async pwnWrite() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; },
      async pwnRead() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; },
      async pwnSignal() { return true; },
      async pwnClose() { return { exitCode: 0 }; },
    },
    async create() { return { sessionId: 'pwn-script-session', externalId: 'pwn-script-external', stateHash: '${"a".repeat(64)}' }; },
    async inspect(externalId) { return { status: 'PRESENT', externalId }; },
    async adopt() { return true; },
    async release() { return true; },
  };
}
`;

test("Pwn host loader accepts only a deployment supervisor and wraps it as Pwn-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-loader-"));
  const modulePath = join(root, "supervisor.mjs");
  await writeFile(modulePath, validSupervisor, "utf8");
  try {
    const supervisor = await loadPwnSessionSupervisor(modulePath);
    assert.equal(typeof supervisor.create, "function");
    const host = await createPwnSessionRuntimeHost(modulePath);
    assert.equal((await host.health()).status, "DEGRADED", "without health/idempotency the wrapper must not claim restart stability");
    await assert.rejects(host.actions.httpRequest({ schemaVersion: 1, id: "session:x", kind: "http-session", runId: "run", generation: 0, ownerLane: "executor", externalId: "opaque" }, { method: "GET", url: "http://target.test", headers: {} }), /does not expose HTTP actions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn host loader rejects a generic or incomplete module", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-loader-invalid-"));
  const modulePath = join(root, "invalid.mjs");
  await writeFile(modulePath, "export default { create() {} };\n", "utf8");
  try {
    await assert.rejects(loadPwnSessionSupervisor(modulePath), /complete PwnSessionSupervisor/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn runtime service resumes the same worker after the service process is recreated", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-runtime-service-"));
  const saved = Object.fromEntries(["PROOFBLADE_PWN_SUPERVISOR_MODULE", "PROOFBLADE_PWN_SUPERVISOR_STATE", "PROOFBLADE_PWN_WORKER_SCRIPT", "PROOFBLADE_PWN_ALLOW_LOCAL_COMMANDS"].map((key) => [key, process.env[key]]));
  process.env.PROOFBLADE_PWN_SUPERVISOR_MODULE = join(process.cwd(), "scripts", "pwn-supervisor-host.ts");
  process.env.PROOFBLADE_PWN_SUPERVISOR_STATE = join(root, "pwn-supervisor.json");
  process.env.PROOFBLADE_PWN_WORKER_SCRIPT = join(process.cwd(), "scripts", "pwn-session-worker.mjs");
  process.env.PROOFBLADE_PWN_ALLOW_LOCAL_COMMANDS = "1";
  const requestKey = "c".repeat(64);
  const request = { kind: "pwn-session", runId: "RUN-PWN-SERVICE", generation: 2, ownerLane: "executor", requestKey, pwn: { mode: "local", command: [execPath, "-e", "process.stdin.on('data', chunk => process.stdout.write('service:' + chunk.toString()))"], cwd: process.cwd(), waitTimeoutMs: 2_000, idleSilenceMs: 100 } };
  const auth = { authorization: "Bearer pwn-runtime-service-token", "content-type": "application/json" };
  let first;
  let second;
  let created;
  try {
    first = await startSessionRuntimeService({ hostModule: join(process.cwd(), "scripts", "session-runtime-pwn-host.ts"), ledgerPath: join(root, "service.json"), port: 0, authToken: "pwn-runtime-service-token" });
    const create = await fetch(`http://${first.host}:${first.port}/v1/session/create`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: 1, operation: "create", idempotencyKey: requestKey, request }) });
    assert.equal(create.status, 200);
    created = await create.json();
    assert.equal(created.state, "CREATED");
    await first.close();
    first = undefined;

    second = await startSessionRuntimeService({ hostModule: join(process.cwd(), "scripts", "session-runtime-pwn-host.ts"), ledgerPath: join(root, "service.json"), port: 0, authToken: "pwn-runtime-service-token" });
    const resource = { schemaVersion: 1, id: `session:${created.sessionId}`, kind: "pwn-session", runId: request.runId, generation: request.generation, ownerLane: request.ownerLane, externalId: created.externalId, requestKey };
    const inspect = await fetch(`http://${second.host}:${second.port}/v1/session/inspect`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: 1, operation: "inspect", resource }) });
    assert.equal(inspect.status, 200);
    assert.deepEqual(await inspect.json(), { schemaVersion: 1, operation: "inspect", status: "PRESENT", binding: "MATCH", externalId: created.externalId });
    const action = await fetch(`http://${second.host}:${second.port}/v1/session/action`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: 1, operation: "pwn_write", resource, data: "resume\\n", encoding: "utf8" }) });
    assert.equal(action.status, 200);
    assert.equal((await action.json()).delta, "service:resume\\n");
    const release = await fetch(`http://${second.host}:${second.port}/v1/session/release`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: 1, operation: "release", resource, reason: "test cleanup" }) });
    assert.equal(release.status, 200);
    assert.equal((await release.json()).released, true);
  } finally {
    const cleanupService = second ?? first;
    if (cleanupService && created) await fetch(`http://${cleanupService.host}:${cleanupService.port}/v1/session/release`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: 1, operation: "release", resource: { schemaVersion: 1, id: `session:${created.sessionId}`, kind: "pwn-session", runId: request.runId, generation: request.generation, ownerLane: request.ownerLane, externalId: created.externalId, requestKey }, reason: "test cleanup" }) }).catch(() => undefined);
    await second?.close().catch(() => undefined);
    await first?.close().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
