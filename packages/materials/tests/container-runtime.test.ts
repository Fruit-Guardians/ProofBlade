import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveExecutionConfig, type ResolvedExecutionConfig } from "../src/config.js";
import { DockerContainerRuntime, type DockerCommandRunner, type DockerProcessResult } from "../src/container/docker.js";
import { parseCompetitionTargets } from "../src/competition/task.js";

test("competition target parser extracts URL and nc endpoints without leaking connection text into scope", () => {
  const targets = parseCompetitionTargets("nc 1.14.76.59 20996; web: http://example.test:8080/path");
  assert.deepEqual(targets, [
    { host: "example.test", port: 8080, protocol: "http" },
    { host: "1.14.76.59", port: 20996 },
  ]);
});

test("Docker runtime creates a target-only gateway namespace and destroys it idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-container-"));
  try {
    const calls: string[][] = [];
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        calls.push(args);
        if (args[0] === "run" && args.includes("-d")) return processResult(args[3]?.endsWith("-gateway") ? "gateway-id\n" : "solver-id\n");
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "exec") return processResult("");
        if (args[0] === "inspect") return processResult("true\n");
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = {
      ...resolveExecutionConfig({} as never),
      backend: "docker",
      pullPolicy: "never",
      networkPolicy: "target-only",
    };
    const runtime = new DockerContainerRuntime(config, runner);
    const ref = await runtime.create({ runId: "RUN/42", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, skillLibraryHostPath: root, targets: [{ host: "127.0.0.1", port: 31337 }], networkPolicy: "target-only" });
    assert.equal(ref.containerId, "solver-id");
    assert.ok(ref.gatewayContainerId);
    assert.ok(calls.some((args) => args.includes("--network") && args.includes("container:gateway-id")));
    assert.ok(calls.some((args) => args.some((arg) => arg.includes("destination=/opt/proofblade/skills,readonly"))));
    assert.ok(calls.some((args) => args[0] === "exec" && args.some((arg) => arg.includes("pb-egress-init"))));
    const command = await runtime.exec(ref, "python3 -c 'print(42)'", { cwd: root, timeoutMs: 2000 });
    assert.equal(command.exitCode, 0);
    const execCall = calls.find((args) => args[0] === "exec" && args.includes("python3 -c 'print(42)'"));
    assert.ok(execCall);
    assert.ok(execCall.includes("PYTHONUTF8=1"));
    assert.ok(execCall.includes("PYTHONIOENCODING=utf-8"));
    await runtime.destroy(ref);
    await runtime.destroy(ref);
    assert.ok(calls.filter((args) => args[0] === "rm").length >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function processResult(stdout: string, exitCode = 0): DockerProcessResult {
  return { stdout, stderr: "", exitCode, truncated: false, durationMs: 1 };
}
