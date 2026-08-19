import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveExecutionConfig, type ResolvedExecutionConfig } from "../src/config.js";
import { DockerContainerRuntime, SpawnDockerCommandRunner, type DockerCommandRunner, type DockerProcessResult } from "../src/container/docker.js";
import { parseCompetitionTargets } from "../src/competition/task.js";

test("competition target parser extracts URL and nc endpoints without leaking connection text into scope", () => {
  const targets = parseCompetitionTargets("nc 1.14.76.59 20996; nc -v -u 1.14.76.60 5353; nc -w 3 -u 1.14.76.61 5354; web: http://example.test:8080/path");
  assert.deepEqual(targets, [
    { host: "example.test", port: 8080, protocol: "tcp" },
    { host: "1.14.76.59", port: 20996, protocol: "tcp" },
    { host: "1.14.76.60", port: 5353, protocol: "udp" },
    { host: "1.14.76.61", port: 5354, protocol: "udp" },
  ]);
  assert.deepEqual(parseCompetitionTargets("udp://127.0.0.1:9000"), [
    { host: "127.0.0.1", port: 9000, protocol: "udp" },
  ]);
  assert.deepEqual(parseCompetitionTargets("socat - UDP:127.0.0.1:5353"), [
    { host: "127.0.0.1", port: 5353, protocol: "udp" },
  ]);
  assert.deepEqual(parseCompetitionTargets("udp://127.0.0.1:53 tcp://127.0.0.1:53"), [
    { host: "127.0.0.1", port: 53, protocol: "udp" },
    { host: "127.0.0.1", port: 53, protocol: "tcp" },
  ]);
  assert.deepEqual(parseCompetitionTargets("tcp://127.0.0.1:53 udp://127.0.0.1:53"), [
    { host: "127.0.0.1", port: 53, protocol: "tcp" },
    { host: "127.0.0.1", port: 53, protocol: "udp" },
  ]);
  assert.deepEqual(parseCompetitionTargets("udp 1.14.76.59:20996 (proxy of :20996)"), [
    { host: "1.14.76.59", port: 20996, protocol: "udp" },
  ]);
  assert.throws(() => parseCompetitionTargets("udp://[2001:db8::1]:53"), /IPv6 competition targets are not supported/);
});

test("Docker runtime creates a target-only gateway namespace and destroys it idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-container-"));
  try {
    const calls: string[][] = [];
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        calls.push(args);
        if (args[0] === "run" && args.includes("-d")) {
          const name = args[args.indexOf("--name") + 1];
          return processResult(name?.endsWith("-gateway") ? "gateway-id\n" : "solver-id\n");
        }
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
    const ref = await runtime.create({ runId: "RUN/42", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, skillLibraryHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" }], networkPolicy: "target-only" });
    assert.equal(ref.containerId, "solver-id");
    assert.ok(ref.gatewayContainerId);
    assert.ok(calls.some((args) => args.includes("--network") && args.includes("container:gateway-id")));
    assert.ok(calls.some((args) => args.some((arg) => arg.includes("destination=/opt/proofblade/skills,readonly"))));
    assert.ok(calls.some((args) => args[0] === "exec" && args.some((arg) => arg.includes("pb-egress-init"))));
    const gatewayInit = calls.find((args) => args[0] === "exec" && args.some((arg) => arg.includes("pb-egress-init")));
    assert.ok(gatewayInit?.includes("tcp:127.0.0.1:31337"));
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

test("Docker create removes a gateway by deterministic name when docker run fails after creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-partial-create-"));
  try {
    const cleanupCalls: string[][] = [];
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "run") return processResult("created-but-timeout", 1);
        if (args[0] === "inspect" && args.includes("--format")) return processResult(JSON.stringify({ "proofblade.managed": "true", "proofblade.run_id": "PARTIAL/1", "proofblade.generation": "1", "proofblade.profile": "pwn", "proofblade.owner_pid": String(process.pid), "proofblade.owner_started_at": "1" }));
        if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) { cleanupCalls.push(args); return processResult(""); }
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never", networkPolicy: "target-only" };
    const runtime = new DockerContainerRuntime(config, runner);
    await assert.rejects(runtime.create({ runId: "PARTIAL/1", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" }], networkPolicy: "target-only" }));
    assert.ok(cleanupCalls.some((args) => args[0] === "rm" && args[2] === "proofblade-partial-1-g1-pwn-gateway"));
    assert.ok(cleanupCalls.some((args) => args[0] === "network" && args[1] === "rm" && args[2] === "proofblade-partial-1-g1-net"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker create does not remove a pre-existing same-name gateway on conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-name-conflict-"));
  try {
    const cleanupCalls: string[][] = [];
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "run") return processResult("name conflict", 1);
        if (args[0] === "inspect" && args.includes("--format")) return processResult(JSON.stringify({ "proofblade.managed": "true", "proofblade.run_id": "another-run", "proofblade.generation": "1", "proofblade.profile": "pwn" }));
        if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) { cleanupCalls.push(args); return processResult(""); }
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never", networkPolicy: "target-only" };
    const runtime = new DockerContainerRuntime(config, runner);
    await assert.rejects(runtime.create({ runId: "CONFLICT/1", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" }], networkPolicy: "target-only" }));
    assert.equal(cleanupCalls.some((args) => args[0] === "rm" && args[2] === "proofblade-conflict-1-g1-pwn-gateway"), false);
    assert.ok(cleanupCalls.some((args) => args[0] === "network" && args[1] === "rm" && args[2] === "proofblade-conflict-1-g1-net"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker runtime reaps only stale stopped resources and their empty gateway networks", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const recent = new Date(Date.now() - 1).toISOString();
  const removed: string[] = [];
  const runner: DockerCommandRunner = {
    async run(args): Promise<DockerProcessResult> {
      if (args[0] === "ps") return processResult("old-container\nrecent-container\nrunning-container\n");
      if (args[0] === "inspect" && args[args.length - 1] === "old-container") return processResult(JSON.stringify({ Created: old, State: { Running: false }, Config: { Labels: { "proofblade.run_id": "old-run" } } }));
      if (args[0] === "inspect" && args[args.length - 1] === "recent-container") return processResult(JSON.stringify({ Created: recent, State: { Running: false }, Config: { Labels: { "proofblade.run_id": "recent-run" } } }));
      if (args[0] === "inspect" && args[args.length - 1] === "running-container") return processResult(JSON.stringify({ Created: old, State: { Running: true }, Config: { Labels: { "proofblade.run_id": "old-run", "proofblade.owner_pid": String(process.pid), "proofblade.owner_started_at": String(Date.now() - Math.floor(process.uptime() * 1_000)) } } }));
      if (args[0] === "network" && args[1] === "ls") return processResult("old-network\nrecent-network\norphan-network\n");
      if (args[0] === "network" && args[1] === "inspect" && args[args.length - 1] === "old-network") return processResult(JSON.stringify({ Created: old, Labels: { "proofblade.run_id": "old-run" }, Containers: {} }));
      if (args[0] === "network" && args[1] === "inspect" && args[args.length - 1] === "recent-network") return processResult(JSON.stringify({ Created: recent, Labels: { "proofblade.run_id": "recent-run" }, Containers: {} }));
      if (args[0] === "network" && args[1] === "inspect" && args[args.length - 1] === "orphan-network") return processResult(JSON.stringify({ Created: old, Labels: { "proofblade.run_id": "orphan-run" }, Containers: {} }));
      if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) { removed.push(args.at(-1)!); return processResult(""); }
      return processResult("");
    },
  };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner);
  assert.equal(await runtime.reapStale({ olderThanMs: 100, includeRunning: true }), 1);
  assert.deepEqual(removed, ["old-container", "old-network", "orphan-network"]);
});

test("Docker stale reaper does not trust a reused PID with a mismatched start time", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const removed: string[] = [];
  const runner: DockerCommandRunner = {
    async run(args): Promise<DockerProcessResult> {
      if (args[0] === "ps") return processResult("pid-reused-container\n");
      if (args[0] === "inspect") return processResult(JSON.stringify({ Created: old, State: { Running: true }, Config: { Labels: { "proofblade.run_id": "old-run", "proofblade.owner_pid": String(process.pid), "proofblade.owner_started_at": "1" } } }));
      if (args[0] === "network" && args[1] === "ls") return processResult("");
      if (args[0] === "rm") { removed.push(args.at(-1)!); return processResult(""); }
      return processResult("");
    },
  };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner);
  assert.equal(await runtime.reapStale({ olderThanMs: 100, includeRunning: true }), 1);
  assert.deepEqual(removed, ["pid-reused-container"]);
});

test("Docker command runner removes abort listeners after a normal close", async () => {
  let adds = 0;
  let removes = 0;
  const signal = {
    aborted: false,
    addEventListener: () => { adds += 1; },
    removeEventListener: () => { removes += 1; },
  } as unknown as AbortSignal;
  const runner = new SpawnDockerCommandRunner(process.execPath);
  const result = await runner.run(["-e", "process.stdout.write('ok')"], { signal });
  assert.equal(result.exitCode, 0);
  assert.equal(adds, 1);
  assert.equal(removes, 1);
});

test("Docker destroy reports cleanup failures after attempting every resource", async () => {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args): Promise<DockerProcessResult> {
      calls.push(args);
      if (args[0] === "rm") return processResult("daemon denied", 1);
      if (args[0] === "network" && args[1] === "rm") return processResult("daemon denied", 1);
      return processResult("");
    },
  };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner);
  await assert.rejects(
    runtime.destroy({ runId: "cleanup-failure", generation: 1, containerId: "solver", gatewayContainerId: "gateway", networkName: "network", name: "solver", profile: "pwn", image: config.images.pwn, imageDigest: "sha256:test", workspaceHostPath: "C:\\tmp", workspaceContainerPath: "/workspace", networkPolicy: "target-only" }),
    AggregateError,
  );
  assert.deepEqual(calls.filter((args) => args[0] === "rm" || args[0] === "network"), [
    ["rm", "-f", "solver"],
    ["rm", "-f", "gateway"],
    ["network", "rm", "network"],
  ]);
});

test("Docker stale reaper does not count a resource when rm is rejected", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const runner: DockerCommandRunner = {
    async run(args): Promise<DockerProcessResult> {
      if (args[0] === "ps") return processResult("stale-container\n");
      if (args[0] === "inspect") return processResult(JSON.stringify({ Created: old, State: { Running: false }, Config: { Labels: { "proofblade.run_id": "stale-run" } } }));
      if (args[0] === "rm") return processResult("permission denied", 1);
      if (args[0] === "network" && args[1] === "ls") return processResult("");
      return processResult("");
    },
  };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner);
  await assert.rejects(runtime.reapStale({ olderThanMs: 100 }), AggregateError);
});

function processResult(stdout: string, exitCode = 0): DockerProcessResult {
  return { stdout, stderr: "", exitCode, truncated: false, durationMs: 1 };
}
