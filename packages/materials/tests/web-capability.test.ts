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

test("web capability journals bounded same-origin requests and creates evidence", async () => {
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
    assert.equal(webEffects.length, 5);
    const firstArgs = JSON.stringify(webEffects[0]!.args);
    assert.doesNotMatch(firstArgs, /query-secret|header-secret/);
    assert.equal(typeof webEffects[0]!.args.requestHash, "string");
    assert.equal(String(webEffects[0]!.args.requestHash).length, 64);
    assert.equal(webEffects.every((effect) => effect.replayPolicy === "manual"), true);
    assert.equal(Object.values(snapshot.observations).length, 5);
    assert.equal(Object.values(snapshot.evidence).length, 5);

    await services.control.dispatch(runId, {
      type: "effect_proposed",
      effect: {
        id: "EF-WEB-MANUAL",
        idempotencyKey: "web-manual-recovery",
        replayPolicy: "manual",
        operation: "web_request",
        args: { generation },
        cwd: fixture.path,
        status: "PROPOSED",
      },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "effect_started", effectId: "EF-WEB-MANUAL", lane: "executor" });
    assert.deepEqual(await services.journal.reconcile(runId), ["EF-WEB-MANUAL"]);
    const reconciled = await services.control.snapshot(runId);
    assert.equal(reconciled.effects["EF-WEB-MANUAL"]?.status, "UNKNOWN");
    assert.equal(reconciled.effects["EF-WEB-MANUAL"]?.outcome, "unknown");

    const events = await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /query-secret|header-secret|body-secret|fixture_session=private/);
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
