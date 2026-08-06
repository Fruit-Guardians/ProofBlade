import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ResolvedOutputRewriteConfig } from "../src/config.js";
import { loadConfig, resolveOutputRewriteConfig, type ProofBladeConfig } from "../src/config.js";
import { BuiltinOutputRewriteAdapter, RtkOutputRewriteAdapter, type RtkProcessRunner } from "../src/tools/output-rewrite.js";

const baseConfig: ResolvedOutputRewriteConfig = {
  provider: "rtk",
  rtkCommand: "rtk",
  fallback: "builtin",
  rewriteTimeoutMs: 5_000,
  maxRawBytes: 16_000,
};

test("output rewrite configuration defaults to the builtin adapter", () => {
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: {} },
  } as unknown as ProofBladeConfig;
  assert.deepEqual(resolveOutputRewriteConfig(config), {
    provider: "builtin",
    rtkCommand: "rtk",
    fallback: "builtin",
    rewriteTimeoutMs: 5_000,
    maxRawBytes: 1_048_576,
  });
});

test("output rewrite configuration rejects invalid byte budgets", async () => {
  const dir = await projectTemp("rtk-config-");
  const path = join(dir, "proofblade.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    tools: { outputRewrite: { provider: "rtk", maxRawBytes: 12 } },
    modelProfiles: {
      executor: {
        provider: "test",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test",
        modelDiscoveryPath: "/models",
        apiKeyEnv: "TEST_KEY",
        contextWindow: 4_096,
        maxTokens: 512,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  }), "utf8");
  try {
    await assert.rejects(() => loadConfig(dir, path), /maxRawBytes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider retry settings accept a bounded Retry-After budget", async () => {
  const dir = await projectTemp("provider-retry-config-");
  const path = join(dir, "proofblade.json");
  await writeFile(path, JSON.stringify({
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
        apiKeyEnv: "TEST_KEY",
        contextWindow: 4_096,
        maxTokens: 512,
        requestTimeoutMs: 1_000,
        maxRetries: 4,
        maxRetryDelayMs: 15_000,
        input: ["text"],
      },
    },
  }), "utf8");
  try {
    const loaded = await loadConfig(dir, path);
    assert.equal(loaded.modelProfiles.executor.maxRetries, 4);
    assert.equal(loaded.modelProfiles.executor.maxRetryDelayMs, 15_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider retry settings reject an unbounded retry budget", async () => {
  const dir = await projectTemp("provider-retry-invalid-");
  const path = join(dir, "proofblade.json");
  await writeFile(path, JSON.stringify({
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
        apiKeyEnv: "TEST_KEY",
        contextWindow: 4_096,
        maxTokens: 512,
        requestTimeoutMs: 1_000,
        maxRetries: 9,
        input: ["text"],
      },
    },
  }), "utf8");
  try {
    await assert.rejects(() => loadConfig(dir, path), /maxRetries/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RTK prepares a rewritten command and returns its tee capture for artifact storage", async () => {
  const dir = await projectTemp("rtk-rewrite-");
  const calls: string[][] = [];
  const executable = join(dir, "rtk.exe");
  const runner: RtkProcessRunner = async ({ args }) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "rtk 0.42.4\n", stderr: "", exitCode: 0 };
    return { stdout: "rtk git status\n", stderr: "", exitCode: 3 };
  };
  try {
    const adapter = new RtkOutputRewriteAdapter({ ...baseConfig, rtkCommand: executable }, dir, runner);
    const ticket = await adapter.prepare({ toolCallId: "call/1", command: "git status", cwd: dir });
    assert.equal(ticket.applied, true);
    assert.equal(ticket.provider, "rtk");
    assert.equal(ticket.providerVersion, "0.42.4");
    assert.match(ticket.command, /rtk\.exe.*git status/);
    assert.notEqual(ticket.originalCommandHash, ticket.rewrittenCommandHash);
    assert.match(ticket.executionEnv.WSLENV!, /RTK_TEE_DIR\/p/);
    assert.deepEqual(calls, [["--version"], ["rewrite", "git status"]]);

    const configText = await readFile(join(ticket.executionEnv.APPDATA!, "rtk", "config.toml"), "utf8");
    assert.match(configText, /mode = "always"/);
    assert.match(configText, /enabled = false/);
    const raw = `${Array.from({ length: 159 }, (_value, index) => `PASS suite-${index} repeated diagnostic`).join("\n")}\nFAIL critical-case: expected 4, received 5`;
    await writeFile(join(ticket.executionEnv.RTK_TEE_DIR!, "raw.log"), raw, "utf8");
    const visible = "FAIL critical-case: expected 4, received 5\n159 tests passed";
    const finalized = await adapter.finalize(ticket, visible);
    assert.equal(finalized.rawCapture, "rtk-tee");
    assert.equal(finalized.rawOutput, raw);
    assert.match(finalized.rawOutput, /FAIL critical-case/);
    assert.match(visible, /FAIL critical-case/);
    assert.equal(finalized.rawBytes, Buffer.byteLength(raw));
    assert.ok(finalized.rawBytes > finalized.visibleBytes * 50);
    await assert.rejects(() => access(ticket.executionEnv.RTK_TEE_DIR!));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RTK no-match and process failure retain deterministic builtin behavior", async () => {
  const dir = await projectTemp("rtk-fallback-");
  let probeCalls = 0;
  const noMatch: RtkProcessRunner = async ({ args }) => {
    if (args[0] === "--version") {
      probeCalls += 1;
      return { stdout: "rtk 0.42.4", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  try {
    const adapter = new RtkOutputRewriteAdapter(baseConfig, dir, noMatch);
    const first = await adapter.prepare({ toolCallId: "one", command: "custom --verbose", cwd: dir });
    const second = await adapter.prepare({ toolCallId: "two", command: "custom --quiet", cwd: dir });
    assert.equal(first.provider, "rtk");
    assert.equal(first.applied, false);
    assert.equal(first.fallbackReason, "no-match");
    assert.equal(second.applied, false);
    assert.equal(probeCalls, 1);
    const finalized = await adapter.finalize(first, "original output");
    assert.equal(finalized.rawCapture, "visible-output");

    const missing = new RtkOutputRewriteAdapter(baseConfig, dir, async () => ({ stdout: "", stderr: "", exitCode: null, errorCode: "ENOENT" }));
    const fallback = await missing.prepare({ toolCallId: "missing", command: "git status", cwd: dir });
    assert.equal(fallback.provider, "builtin");
    assert.equal(fallback.fallbackReason, "probe-ENOENT");

    const strict = new RtkOutputRewriteAdapter({ ...baseConfig, fallback: "fail" }, dir, async () => ({ stdout: "", stderr: "", exitCode: null, errorCode: "ENOENT" }));
    await assert.rejects(() => strict.prepare({ toolCallId: "strict", command: "git status", cwd: dir }), /RTK output rewrite failed/);

    const denied = new RtkOutputRewriteAdapter(baseConfig, dir, async ({ args }) => args[0] === "--version"
      ? { stdout: "rtk 0.44.2", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 2 });
    await assert.rejects(() => denied.prepare({ toolCallId: "denied", command: "COMMAND", cwd: dir }), /RTK denied/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("builtin rewrite adapter preserves command and visible output", async () => {
  const adapter = new BuiltinOutputRewriteAdapter();
  const ticket = await adapter.prepare({ toolCallId: "call", command: "echo hello", cwd: "." });
  const result = await adapter.finalize(ticket, "hello");
  assert.equal(ticket.command, "echo hello");
  assert.equal(ticket.applied, false);
  assert.equal(result.rawOutput, "hello");
  assert.equal(result.rawCapture, "visible-output");
});

async function projectTemp(prefix: string): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(join(root, prefix));
}
