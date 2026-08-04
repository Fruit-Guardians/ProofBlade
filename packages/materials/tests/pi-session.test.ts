import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

test("Pi JSONL session reopens with the same branch entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pi-"));
  try {
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "SESSION-001", cwd: root, metadata: { runId: "RUN-001", lane: "executor" } });
    await session.appendCustomEntry("proofblade_anchor", { runId: "RUN-001", knowledgeVersion: 1 });
    const metadata = await session.getMetadata();
    const before = await session.getBranch();
    const reopened = await repo.open(metadata);
    const after = await reopened.getBranch();
    assert.deepEqual(after, before);
    assert.equal(after[0]?.type, "custom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
