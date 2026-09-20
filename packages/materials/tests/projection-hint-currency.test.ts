import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

/**
 * Currency of the fast projection hint.
 *
 * `loadProjectionHint()` exists to serve GUI list reads without parsing the event
 * stream. Its seal proves a projection is authentic and internally consistent --
 * but NOT that it covers the whole log: a projection sealed at `lastSeq` 1 stays
 * perfectly valid after 10,000 more events. Its only staleness guard used to be
 * "projection mtime >= events mtime", a temporal heuristic that compares EQUAL
 * when timestamp granularity is coarse or a clock moves.
 *
 * With `persistProjection: false` on the hot path, a projection left behind by
 * design is the normal case, so that window is reachable rather than exotic.
 * Currency is now established from content, and these tests pin it.
 */

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

const secret = "projection-currency-secret-0123456789";

async function run(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "proofblade-currency-"));
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await control.createRun(runId, demoTask(runId, root, config));
  return {
    root,
    control,
    eventsPath: join(runsRoot, runId, "events.jsonl"),
    projectionPath: join(runsRoot, runId, "projection.json"),
  };
}

function deferred(control: ControlStore, runId: string, count: number, offset = 0) {
  return control.append(runId, Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1 as const,
    lane: "executor" as const,
    correlationId: `currency-${offset + index}`,
    actor: "tool" as const,
    type: "tool_result_recorded" as const,
    payload: { toolCallId: `c${offset + index}`, toolName: "read", outputBytes: 64, isError: false },
  })), { persistProjection: false });
}

test("a fresh projection is served by the fast hint", async () => {
  const { root, control } = await run("CURRENCY-1");
  try {
    const snapshot = await control.snapshot("CURRENCY-1");
    const hinted = await control.loadProjectionHint("CURRENCY-1");

    assert.ok(hinted, "a just-created projection must be servable");
    assert.equal(hinted.lastSeq, snapshot.lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] the hint withholds a projection that is behind the log", async () => {
  const { root, control } = await run("CURRENCY-2");
  try {
    await deferred(control, "CURRENCY-2", 40);

    const hinted = await control.loadProjectionHint("CURRENCY-2");
    const snapshot = await control.snapshot("CURRENCY-2");

    // Either it is withheld, or it is genuinely current. What must never happen
    // is a returned projection whose lastSeq trails the log.
    if (hinted) assert.equal(hinted.lastSeq, snapshot.lastSeq, "a served hint must not trail the event log");
    assert.ok(snapshot.lastSeq > 1, "the log must actually have moved for this test to mean anything");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] equal mtimes do not make a stale projection look current", async () => {
  // The regression this pins: mtime granularity can make projection and log
  // compare equal while the projection is still behind, and the old
  // mtime-only guard accepted that.
  const { root, control, eventsPath, projectionPath } = await run("CURRENCY-3");
  try {
    await deferred(control, "CURRENCY-3", 60);

    const second = Math.floor(Date.now() / 1000);
    await utimes(projectionPath, second, second);
    await utimes(eventsPath, second, second);

    const hinted = await control.loadProjectionHint("CURRENCY-3");
    const snapshot = await control.snapshot("CURRENCY-3");
    assert.ok(snapshot.lastSeq > 1, "the log must have moved");

    assert.equal(hinted, undefined, "equal mtimes must not let a trailing projection through");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a barrier restores the fast hint after deferred writes", async () => {
  const { root, control } = await run("CURRENCY-4");
  try {
    await deferred(control, "CURRENCY-4", 30);
    await control.flushProjection("CURRENCY-4");

    const snapshot = await control.snapshot("CURRENCY-4");
    const hinted = await control.loadProjectionHint("CURRENCY-4");

    assert.ok(hinted, "after a barrier the projection is current and must be servable again");
    assert.equal(hinted.lastSeq, snapshot.lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hint still refuses a tampered projection", async () => {
  const { root, control, projectionPath } = await run("CURRENCY-5");
  try {
    const { readFile, writeFile } = await import("node:fs/promises");
    const original = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
    await writeFile(projectionPath, JSON.stringify({ ...original, status: "FINISHED" }), "utf8");

    const hinted = await control.loadProjectionHint("CURRENCY-5");
    // The content hash check must still reject the edited body.
    assert.equal(hinted, undefined, "a tampered projection body must not be served");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
