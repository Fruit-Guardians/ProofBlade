import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AblationService } from "../src/ablation-service.js";

const config = {
  schemaVersion: 1 as const,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test", api: "openai-completions" as const, baseUrl: "https://example.test/v1", model: "model",
      modelDiscoveryPath: "/models", apiKeyEnv: "TEST_KEY", contextWindow: 4096, maxTokens: 256,
      requestTimeoutMs: 1000, maxRetries: 0, input: ["text"] as Array<"text">,
    },
  },
};

test("ablation GUI start lock is exclusive and stale running status becomes paused", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ablation-"));
  try {
    const service = new AblationService(root, config, {} as never) as unknown as {
      withStartLock: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
      readStatus: (id: string) => Promise<{ status: string; startedAt?: string; error?: string }>;
    };
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const first = service.withStartLock("AB-GUI", async () => await new Promise<void>((resolve) => { release = resolve; entered(); }));
    await enteredLock;
    await assert.rejects(() => service.withStartLock("AB-GUI", async () => undefined), /正在启动/);
    release();
    await first;
    const statusDir = join(root, ".proofblade", "ablation");
    await writeFile(join(statusDir, "AB-STALE.status.json"), JSON.stringify({ status: "running", startedAt: "2026-08-31T00:00:00.000Z" }));
    const stale = await service.readStatus("AB-STALE");
    assert.equal(stale.status, "paused");
    assert.match(stale.error ?? "", /服务重启/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
