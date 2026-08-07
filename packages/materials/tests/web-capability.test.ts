import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { prepareWebRequest } from "../src/capabilities/web.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { TaskContract } from "../src/domain/types.js";
import type { FixtureRef } from "../src/sandbox/fixture.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
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

test("web capability enforces scope, bounds output, and keeps request values out of durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-web-"));
  const services = createServices(root, config);
  const runId = "WEB-CAPABILITY-001";
  const task = fixtureTask(runId, "web-source-1", root, config);
  let fixture: FixtureRef | undefined;
  try {
    await services.control.createRun(runId, task);
    fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);

    assert.deepEqual(runtime.listCapabilities().capabilities.map((item) => item.id), ["proofblade.artifact", "proofblade.target", "proofblade.web"]);
    const fetched = await runtime.invokeCapability({
      capabilityId: "proofblade.web",
      operation: "request",
      input: { path: "/debug?token=query-secret", headers: { "x-trace": "header-secret" } },
    });
    assert.match(fetched.output, /PB\{web_source_trace\}/);
    assert.ok(fetched.observationId);
    assert.ok(fetched.evidenceId);

    const headed = await runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { method: "HEAD", path: "/debug" } });
    assert.match(headed.output, /"status":200/);
    assert.match(headed.output, /"body":""/);

    const posted = await runtime.invokeCapability({
      capabilityId: "proofblade.web",
      operation: "request",
      input: { method: "POST", path: "/submit", body: "body-secret" },
    });
    assert.match(posted.output, /"status":202/);
    assert.match(posted.output, /\[REDACTED\]/);
    assert.doesNotMatch(posted.output, /fixture_session=private/);

    const redirected = await runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "/redirect" } });
    assert.match(redirected.output, /"status":302/);
    assert.doesNotMatch(redirected.output, /PB\{web_source_trace\}/);

    const bounded = await runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "/large", maxBytes: 256 } });
    assert.match(bounded.output, /"bodyBytes":256/);
    assert.match(bounded.output, /"truncated":true/);

    const repeated = await runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "/redirect" } });
    assert.notEqual(repeated.effectId, redirected.effectId);

    const backgroundStart = await runtime.runBackground({
      capabilityId: "proofblade.web",
      operation: "request",
      input: { path: "/debug?background=background-secret", headers: { "x-background": "background-header-secret" } },
    });
    const queued = await runtime.jobStatus(String(backgroundStart.jobId));
    assert.equal(queued.argsRedacted, true);
    assert.doesNotMatch(JSON.stringify(queued.args), /background-secret|background-header-secret/);
    const completed = await runtime.waitJob(String(backgroundStart.jobId), 10_000);
    assert.equal(completed.status, "SUCCEEDED");

    await assert.rejects(
      runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "/debug", headers: { authorization: "Bearer private" } } }),
      /controlled by the host/,
    );
    await assert.rejects(
      runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "//outside.invalid/debug" } }),
      /origin-relative/,
    );
    await assert.rejects(
      runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: "/\\outside.invalid/debug" } }),
      /escapes the target origin/,
    );

    const snapshot = await services.control.snapshot(runId);
    const webEffects = Object.values(snapshot.effects).filter((effect) => effect.operation === "web_request");
    assert.equal(webEffects.length, 7);
    assert.equal(webEffects.every((effect) => effect.replayPolicy === "manual"), true);
    assert.equal(webEffects.every((effect) => typeof effect.args.requestHash === "string" && String(effect.args.requestHash).length === 64), true);
    assert.doesNotMatch(JSON.stringify({ jobs: snapshot.jobs, effects: snapshot.effects, artifacts: snapshot.artifacts }), /query-secret|header-secret|body-secret|background-secret|background-header-secret|fixture_session=private/);
    assert.equal(snapshot.artifacts[fetched.artifactId]?.sensitivity, "flag_candidate");
    assert.equal(snapshot.artifacts[posted.artifactId]?.sensitivity, "target");
    assert.ok(Object.values(snapshot.evidence).some((item) => item.source.effectId === completed.effectId));

    const events = await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /query-secret|header-secret|body-secret|background-secret|background-header-secret|fixture_session=private/);
    const artifact = snapshot.artifacts[fetched.artifactId];
    assert.ok(artifact);
    assert.match(await services.artifacts.readText(runId, artifact), /PB\{web_source_trace\}/);
    await runtime.close();
  } finally {
    if (fixture) await services.sandbox.destroy(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

test("web capability rejects missing endpoints and out-of-scope targets before an effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-web-scope-"));
  try {
    const task = fixtureTask("WEB-SCOPE-001", "reverse-strings-1", root, config);
    const fixture: FixtureRef = { fixtureId: task.task_id, profileId: "reverse-strings-1", generation: 1, path: root, privatePath: join(root, ".proofblade") };
    assert.throws(() => prepareWebRequest(task, fixture, { path: "/" }), /does not expose an HTTP endpoint/);

    const remoteTask: TaskContract = {
      ...task,
      target: "https://example.com",
      scope: { ...task.scope, allowed_hosts: ["example.net"], allowed_ports: [443], external_network: true },
    };
    assert.throws(() => prepareWebRequest(remoteTask, fixture, { path: "/" }), /outside task scope/);
    assert.throws(
      () => prepareWebRequest({ ...remoteTask, scope: { ...remoteTask.scope, allowed_hosts: ["example.com"], allowed_ports: [] } }, fixture, { path: "/" }),
      /port is outside task scope/,
    );
    assert.throws(
      () => prepareWebRequest({ ...remoteTask, target: "https://user:secret@example.net" }, fixture, { path: "/" }),
      /must not contain credentials/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live HTTP fixtures restart with a new generation after process state is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-web-recovery-"));
  const first = createServices(root, config);
  const second = createServices(root, config);
  const task = fixtureTask("WEB-RECOVERY-001", "web-route-2", root, config);
  let firstFixture: FixtureRef | undefined;
  let recoveredFixture: FixtureRef | undefined;
  try {
    firstFixture = await first.sandbox.build(task);
    const firstGeneration = await first.sandbox.reset(firstFixture);
    assert.equal((await first.sandbox.health(firstFixture, firstGeneration)).status, "healthy");

    const recovered = await second.sandbox.reconcileFixture(task, firstGeneration);
    recoveredFixture = recovered.fixture;
    assert.equal(recovered.action, "reset");
    assert.equal(recovered.health.status, "unhealthy");
    assert.equal(recovered.generation, firstGeneration + 1);
    assert.ok(recovered.fixture.endpoint);
    assert.equal((await second.sandbox.health(recovered.fixture, recovered.generation)).status, "healthy");
  } finally {
    if (firstFixture) await first.sandbox.destroy(firstFixture);
    if (recoveredFixture) await second.sandbox.destroy(recoveredFixture);
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox close releases every active HTTP fixture and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-web-close-"));
  const services = createServices(root, config);
  try {
    const first = await services.sandbox.build(fixtureTask("WEB-CLOSE-001", "web-source-1", root, config));
    const second = await services.sandbox.build(fixtureTask("WEB-CLOSE-002", "web-route-2", root, config));
    assert.ok(first.endpoint);
    assert.ok(second.endpoint);
    assert.equal((await fetch(`${first.endpoint}/.proofblade/health`)).status, 200);
    assert.equal((await fetch(`${second.endpoint}/.proofblade/health`)).status, 200);

    await services.sandbox.close();
    await assert.rejects(fetch(`${first.endpoint}/.proofblade/health`, { signal: AbortSignal.timeout(1_000) }));
    await assert.rejects(fetch(`${second.endpoint}/.proofblade/health`, { signal: AbortSignal.timeout(1_000) }));
    await services.sandbox.close();
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});
