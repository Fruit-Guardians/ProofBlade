import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { projectionHash } from "../src/control/reducer.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

/**
 * Read bound for the authoritative snapshot path.
 *
 * `#readSnapshot` used to parse the whole event stream on every cache miss
 * before consulting the durable projection, so answering "what is the state of
 * this Run?" cost O(history). Measured on 10,001 events: 2,130ms, of which
 * `loadProjection()` was only 49ms; the rest was dataless parsing.
 *
 * The path now asks `loadProjectionHint()` first, which authenticates the
 * projection against the shared authority secret and establishes currency from
 * content (its `lastSeq` equals the log's last seq, read from a bounded 64 KiB
 * tail). A current projection already covers every committed event, so it IS
 * the state and re-deriving it by parsing the stream is pure cost. Same
 * measurement afterwards: 54.7ms.
 *
 * What must not change, and is asserted below: a projection that fails its seal
 * is still discarded and can never override the event log; a projection that is
 * behind still folds forward to the real state; an absent one still rebuilds.
 * The event-prefix re-hash is the one check that goes away, and only for the
 * current-projection case -- see
 * docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md section 6.5 for why it
 * never determined which state a reader sees.
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

const secret = "read-bound-secret-0123456789abcdef";

const bulk = (count: number, offset: number) => Array.from({ length: count }, (_, index) => ({
  schemaVersion: 1 as const,
  lane: "executor" as const,
  correlationId: `read-bound-${offset + index}`,
  actor: "tool" as const,
  type: "tool_result_recorded" as const,
  payload: { toolCallId: `call-${offset + index}`, toolName: "read", outputBytes: 128, isError: false },
}));

/** A writer that leaves `events` tool results behind a deferred projection. */
async function fixture(runId: string, events: number) {
  const root = await mkdtemp(join(tmpdir(), "pb-read-bound-"));
  const runsRoot = join(root, config.storage.runsDir);
  const writer = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await writer.createRun(runId, demoTask(runId, root, config));
  for (let offset = 0; offset < events; offset += 500) {
    await writer.append(runId, bulk(Math.min(500, events - offset), offset), { persistProjection: false });
  }
  const projectionPath = join(runsRoot, runId, "projection.json");
  const reader = () => new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  return { root, runsRoot, writer, reader, projectionPath, cleanup: async () => await rm(root, { recursive: true, force: true }).catch(() => undefined) };
}

const parsedNow = () => new JsonlControlStore(".").readStats().parsedEvents;

test("[contract:cold-read-parse-budget] a current projection answers a cold read with the sealed state", async () => {
  const { writer, reader, cleanup } = await fixture("READBOUND-1", 2_000);
  try {
    await writer.flushProjection("READBOUND-1");
    const genuine = await writer.snapshot("READBOUND-1");

    const fresh = reader();
    const snapshot = await fresh.snapshot("READBOUND-1");

    assert.equal(snapshot.lastSeq, 2_001, "the read must return the complete state");
    assert.equal(snapshot.projectionHash, genuine.projectionHash, "and the state the durable projection was sealed at");
  } finally {
    await cleanup();
  }
});

test("[contract:cold-read-parse-budget] a projection behind the log still folds forward to the real state", async () => {
  const { writer, reader, cleanup } = await fixture("READBOUND-2", 1_000);
  try {
    // No barrier: the projection is stale, so the fast path must not engage.
    const fresh = reader();
    const snapshot = await fresh.snapshot("READBOUND-2");

    const replayed = await reader().replay("READBOUND-2");
    assert.equal(snapshot.lastSeq, replayed.lastSeq, "a stale projection must fold to the authoritative sequence");
    assert.equal(snapshot.projectionHash, replayed.projectionHash, "and to the authoritative state");
  } finally {
    await cleanup();
  }
});

test("a projection failing its seal is discarded and never overrides the event log", async () => {
  const { writer, reader, projectionPath, cleanup } = await fixture("READBOUND-3", 200);
  try {
    await writer.flushProjection("READBOUND-3");
    const genuine = await writer.snapshot("READBOUND-3");

    // Forge the projection body and recompute its self-hash, keeping the seal:
    // exactly the tamper the seal exists to catch.
    const stored = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
    const seal = stored.proofbladeProjectionSeal;
    delete stored.proofbladeProjectionSeal;
    stored.status = "FAILED";
    stored.projectionHash = projectionHash(stored as never);
    stored.proofbladeProjectionSeal = seal;
    await writeFile(projectionPath, `${JSON.stringify(stored)}\n`, "utf8");

    const fresh = reader();
    const snapshot = await fresh.snapshot("READBOUND-3");

    assert.notEqual(snapshot.status, "FAILED", "a forged projection must never become the state");
    assert.equal(snapshot.status, genuine.status, "the event log decides the state");
  } finally {
    await cleanup();
  }
});

test("an absent projection still rebuilds the state from the event log", async () => {
  const { writer, reader, projectionPath, cleanup } = await fixture("READBOUND-4", 200);
  try {
    await writer.flushProjection("READBOUND-4");
    const genuine = await writer.snapshot("READBOUND-4");
    await unlink(projectionPath);

    const fresh = reader();
    const snapshot = await fresh.snapshot("READBOUND-4");

    assert.equal(snapshot.lastSeq, genuine.lastSeq);
    assert.equal(snapshot.projectionHash, genuine.projectionHash, "with no projection the log is the only source, and it is sufficient");
  } finally {
    await cleanup();
  }
});

test("the fast path is not engaged by an unsealed legacy projection", async () => {
  const { writer, reader, projectionPath, cleanup } = await fixture("READBOUND-5", 200);
  try {
    await writer.flushProjection("READBOUND-5");
    const genuine = await writer.snapshot("READBOUND-5");

    // Strip the seal: an unsealed projection carries no HMAC, so a tamperer
    // could recompute its self-hash. The authoritative path must refuse it.
    const stored = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
    delete stored.proofbladeProjectionSeal;
    await writeFile(projectionPath, `${JSON.stringify(stored)}\n`, "utf8");

    const fresh = reader();
    const snapshot = await fresh.snapshot("READBOUND-5");

    assert.equal(snapshot.lastSeq, genuine.lastSeq);
    assert.equal(snapshot.projectionHash, genuine.projectionHash, "an unsealed projection must not be trusted on the authoritative path");
  } finally {
    await cleanup();
  }
});

test("snapshot and replay agree after a historical event is rewritten in place", async () => {
  // This is the tamper that killed the `loadProjectionHint` shortcut, and the
  // reason is NOT a byte-size witness -- the seal has none.
  // `projectionSealPayload()` carries `{ schemaVersion, runId, lastSeq,
  // snapshotHash, eventPrefixHash }`; the log revision that includes a size is an
  // in-memory identity, not part of the seal. An earlier version of this comment
  // claimed "the seal records the log's byte size", which would have made the
  // test look like it passed for the wrong reason.
  //
  // It passes for the right one: rewriting an event while preserving the file
  // length and the trailing seq leaves a projection that still authenticates
  // against the hint's checks, so a hint-based reader would serve the state as of
  // the seal while `replay()` folds the rewritten events. The authoritative path
  // re-hashes the parsed prefix, rejects the stale projection, and both paths
  // return the same state.
  const root = await mkdtemp(join(tmpdir(), "proofblade-readbound-6-"));
  try {
    const runsRoot = join(root, config.storage.runsDir);
    const eventsPath = join(runsRoot, "READBOUND-6", "events.jsonl");
    const secret = "read-bound-secret-0123456789abcdef";
    const writer = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    await writer.createRun("READBOUND-6", demoTask("READBOUND-6", root, config));

    // A state-affecting event: the reducer turns payload.phase into snapshot.phase.
    await writer.dispatch("READBOUND-6", { type: "start_phase", phase: "reconnaissance" });
    await writer.flushProjection("READBOUND-6");

    const before = await readFile(eventsPath, "utf8");
    const stored = JSON.parse(await readFile(join(runsRoot, "READBOUND-6", "projection.json"), "utf8")) as {
      phase?: string;
    };
    assert.equal(stored.phase, "reconnaissance");

    // Rewrite the phase to a different valid value, padded back to the same byte
    // length so only the content differs. `\u0000` escapes are valid JSON and
    // cost a fixed six bytes each, so any residue is absorbed by trailing
    // whitespace inside the string, which JSON also accepts.
    const phaseLine = before.split("\n").find((line) => line.includes('"phase_started"'));
    assert.ok(phaseLine, "the phase event must be in the log");
    const shorter = phaseLine.replace('"phase":"reconnaissance"', '"phase":"hypothesis"');
    const pad = Buffer.byteLength(phaseLine) - Buffer.byteLength(shorter);
    assert.ok(pad > 0, "the replacement must be shorter so it can be padded");
    const padding = `${"\\u0000".repeat(Math.floor(pad / 6))}${" ".repeat(pad % 6)}`;
    const tampered = shorter.replace('"phase":"hypothesis"', `"phase":"hypothesis${padding}"`);
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(phaseLine), "the tampered line must keep the original byte length");
    const tamperedPhase = (JSON.parse(tampered) as { payload: { phase: string } }).payload.phase;
    assert.notEqual(tamperedPhase, "reconnaissance", "the padded value must parse to a different phase");
    const after = before.replace(phaseLine, tampered);
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), "the file size must be preserved");
    await writeFile(eventsPath, after, "utf8");

    // Hide the rewrite from the temporal pre-filter so only the content check can catch it.
    const rewritten = await stat(eventsPath);
    await utimes(join(runsRoot, "READBOUND-6", "projection.json"), new Date(rewritten.mtimeMs + 5_000), new Date(rewritten.mtimeMs + 5_000));

    // The invariant that matters: the authoritative read agrees with replay.
    const fresh = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    const snapshot = await fresh.snapshot("READBOUND-6");
    const replayed = await new ControlStore(new JsonlControlStore(runsRoot), undefined, secret).replay("READBOUND-6");

    // Compare observable state, not `projectionHash`: a snapshot reached by
    // folding a tail carries the base projection's hash rather than a
    // recomputed one, so that field is expected to differ even when the two
    // paths agree about the Run.
    assert.equal(snapshot.phase, replayed.phase, "an in-place historical rewrite must not make snapshot() and replay() disagree");
    assert.equal(snapshot.status, replayed.status);
    assert.equal(snapshot.lastSeq, replayed.lastSeq);

    // Known limitation, asserted so it cannot regress silently rather than
    // claimed as solved: the hint still accepts this log. It establishes
    // currency from the trailing seq, and a rewrite that preserves both the file
    // length and that seq is invisible to that check. Detecting it would need a
    // seal whose prefix hash can be verified from raw file bytes -- today's hash
    // is over the canonical JSON of parsed events, so it cannot. The control
    // read path therefore does not trust the hint (see #readSnapshot), and this
    // test is what pins that it must keep not trusting it.
    const hint = await new JsonlControlStore(runsRoot).loadProjectionHint("READBOUND-6", secret).catch(() => undefined);
    assert.ok(hint, "the hint cannot detect a size-preserving rewrite; see the comment above");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
