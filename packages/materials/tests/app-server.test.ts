import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalPolicy, ProofBladeAppServer, createServices, demoTask } from "../src/index.js";
import type { ProofBladeConfig } from "../src/config.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("App Server exposes paginated replay and resumable event subscriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-app-server-"));
  try {
    const services = createServices(root, config);
    const server = new ProofBladeAppServer({ control: services.control, approvals: new ApprovalPolicy({ ledgerPath: join(root, "runs", "approvals.json") }) });
    await services.control.createRun("RUN-APP", demoTask("RUN-APP", root, config));
    await services.control.dispatch("RUN-APP", { type: "start_phase", phase: "reconnaissance" });
    await services.control.dispatch("RUN-APP", { type: "set_domain_phase", domainPhase: "RECON" });

    const page = await server.request({ method: "run/events", params: { runId: "RUN-APP", afterSeq: 0, limit: 2 } });
    assert.equal((page.result as { data: unknown[]; nextCursor?: string }).data.length, 2);
    assert.equal((page.result as { nextCursor?: string }).nextCursor, "2");
    const snapshot = await server.request({ method: "run/read", params: { runId: "RUN-APP" } });
    assert.equal((snapshot.result as { domainPhase: string }).domainPhase, "RECON");

    const received: string[] = [];
    const unsubscribe = server.subscribe("RUN-APP", (events) => { received.push(...events.map((event) => event.type)); }, { afterSeq: 3, pollMs: 25 });
    await services.control.dispatch("RUN-APP", { type: "pause", reason: "operator" });
    await waitFor(() => received.includes("run_paused"));
    unsubscribe();
    assert.deepEqual(received, ["run_paused"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App Server approval endpoint grants and denies durable effects without exposing ControlStore writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-app-approval-"));
  try {
    const services = createServices(root, config);
    const approvals = new ApprovalPolicy({ ledgerPath: join(root, "runs", "approvals.json") });
    const server = new ProofBladeAppServer({ control: services.control, approvals });
    const pending = await approvals.request({ runId: "RUN-APPROVAL", operation: "platform.submit", resource: "flag{secret}", reason: "submit candidate" });
    const listed = await server.request({ method: "run/approvals", params: { runId: "RUN-APPROVAL" } });
    assert.equal((listed.result as { data: Array<{ id: string }> }).data[0]?.id, pending.id);
    const granted = await server.request({ method: "run/approve", params: { approvalId: pending.id, decision: "grant", actor: "tester" } });
    assert.equal((granted.result as { status: string }).status, "GRANTED");
    const replay = await server.request({ method: "run/approve", params: { approvalId: pending.id, decision: "grant", actor: "tester" } });
    assert.equal((replay.result as { status: string }).status, "GRANTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(predicate(), true, "timed out waiting for App Server subscription event");
}
