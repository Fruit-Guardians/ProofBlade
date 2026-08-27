import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveExecutionConfig, type ResolvedExecutionConfig } from "../src/config.js";
import { spawn } from "node:child_process";
import { DockerContainerRuntime, SpawnDockerCommandRunner, type DockerCommandRunner, type DockerProcessResult, type SessionProcessSpawner } from "../src/container/docker.js";
import type { ContainerRef } from "../src/container/contracts.js";
import { parseCompetitionTargets } from "../src/competition/task.js";
import { ExternalResourceRegistry } from "../src/recovery/external-resource-registry.js";

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
    const externalResources = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const runtime = new DockerContainerRuntime(config, runner, undefined, externalResources);
    const ref = await runtime.create({ runId: "RUN/42", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, skillLibraryHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" }], networkPolicy: "target-only" });
    assert.equal(ref.containerId, "solver-id");
    assert.ok(ref.gatewayContainerId);
    assert.ok(calls.some((args) => args.includes("--network") && args.includes("container:gateway-id")));
    assert.ok(calls.some((args) => args.some((arg) => arg.includes("destination=/opt/proofblade/skills,readonly"))));
    assert.ok(calls.some((args) => args[0] === "exec" && args.some((arg) => arg.includes("pb-egress-init"))));
    const gatewayInit = calls.find((args) => args[0] === "exec" && args.some((arg) => arg.includes("pb-egress-init")));
    assert.ok(gatewayInit?.includes("tcp:127.0.0.1:31337"));
    const resourceId = "container:RUN/42:1:pwn";
    assert.equal((await externalResources.get(resourceId))?.state, "CONFIRMED");
    assert.equal((await externalResources.get(resourceId))?.externalId, "solver-id");
    const command = await runtime.exec(ref, "python3 -c 'print(42)'", { cwd: root, timeoutMs: 2000 });
    assert.equal(command.exitCode, 0);
    const execCall = calls.find((args) => args[0] === "exec" && args.includes("python3 -c 'print(42)'"));
    assert.ok(execCall);
    assert.ok(execCall.includes("PYTHONUTF8=1"));
    assert.ok(execCall.includes("PYTHONIOENCODING=utf-8"));
    await runtime.destroy(ref);
    await runtime.destroy(ref);
    assert.equal((await externalResources.get(resourceId))?.state, "RELEASED");
    assert.ok(calls.filter((args) => args[0] === "rm").length >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker create gives pwn a writable exec home and scratch while web stays noexec", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-fs-profile-"));
  try {
    const runArgsByProfile = new Map<string, string[]>();
    let currentProfile: "web" | "pwn" | "pwn-kernel" = "pwn";
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "run" && args.includes("-d")) {
          const name = args[args.indexOf("--name") + 1] ?? "";
          if (!name.endsWith("-gateway")) runArgsByProfile.set(currentProfile, args);
          return processResult(name.endsWith("-gateway") ? "gateway-id\n" : "solver-id\n");
        }
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "exec") return processResult("");
        if (args[0] === "inspect") return processResult("true\n");
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never", networkPolicy: "none" };
    const runtime = new DockerContainerRuntime(config, runner);

    currentProfile = "pwn";
    await runtime.create({ runId: "FS/PWN", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, targets: [], networkPolicy: "none" });
    currentProfile = "web";
    await runtime.create({ runId: "FS/WEB", generation: 1, profile: "web", image: config.images.web, workspaceHostPath: root, targets: [], networkPolicy: "none" });

    const pwn = runArgsByProfile.get("pwn");
    const web = runArgsByProfile.get("web");
    assert.ok(pwn && web);

    const tmpfsValues = (args: string[]): string[] => args.filter((_, index) => args[index - 1] === "--tmpfs");
    const pwnTmpfs = tmpfsValues(pwn);
    const webTmpfs = tmpfsValues(web);

    // Pwn: /tmp, HOME and scratch must opt back into exec (Docker forces noexec
    // on --tmpfs by default) with a writable non-root uid/gid.
    assert.ok(pwnTmpfs.some((value) => value.startsWith("/tmp:") && value.includes("exec") && !value.includes("noexec")));
    assert.ok(pwnTmpfs.some((value) => value.startsWith("/home/ctf:") && value.includes("exec") && !value.includes("noexec") && value.includes("uid=1001") && value.includes("gid=1001")));
    assert.ok(pwnTmpfs.some((value) => value.startsWith("/opt/pwn:") && value.includes("exec") && !value.includes("noexec") && value.includes("uid=1001")));

    // Web: keeps the tighter noexec /tmp and gets no HOME/scratch tmpfs.
    assert.ok(webTmpfs.some((value) => value.startsWith("/tmp:") && value.includes("noexec")));
    assert.equal(webTmpfs.some((value) => value.startsWith("/home/ctf:")), false);
    assert.equal(webTmpfs.some((value) => value.startsWith("/opt/pwn:")), false);

    // Security baseline is unchanged for both, and only pwn adds SYS_PTRACE.
    for (const args of [pwn, web]) {
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
      const noNewPrivIndex = args.indexOf("no-new-privileges");
      assert.ok(noNewPrivIndex > 0 && args[noNewPrivIndex - 1] === "--security-opt");
    }
    assert.ok(pwn.includes("--cap-add") && pwn.includes("SYS_PTRACE"));
    assert.equal(web.some((value, index) => value === "SYS_PTRACE" && web[index - 1] === "--cap-add"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker create removes a gateway by deterministic name when docker run fails after creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-partial-create-"));
  try {
    const cleanupCalls: string[][] = [];
    let gatewayLabels: Record<string, string> = {};
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "run") {
          gatewayLabels = {};
          for (let index = 0; index < args.length; index += 1) {
            const label = args[index] === "--label" ? args[index + 1] : undefined;
            if (!label?.startsWith("proofblade.")) continue;
            const separator = label.indexOf("=");
            if (separator > 0) gatewayLabels[label.slice(0, separator)] = label.slice(separator + 1);
          }
          return processResult("created-but-timeout", 1);
        }
        if (args[0] === "inspect" && args.includes("--format")) return processResult(JSON.stringify(gatewayLabels));
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
        if (args[0] === "inspect" && args.includes("--format")) return processResult(JSON.stringify({ "proofblade.managed": "true", "proofblade.run_id": "CONFLICT/1", "proofblade.generation": "1", "proofblade.profile": "pwn", "proofblade.owner_pid": String(process.pid), "proofblade.owner_started_at": "1", "proofblade.owner_token": "different-create-attempt" }));
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

test("Docker create does not remove a pre-existing same-name network on conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-network-conflict-"));
  try {
    const cleanupCalls: string[][] = [];
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "network" && args[1] === "create") return processResult("network name already exists", 1);
        if (args[0] === "network" && args[1] === "inspect" && args.includes("--format")) {
          return processResult(JSON.stringify({ "proofblade.managed": "true", "proofblade.run_id": "another-run", "proofblade.generation": "1", "proofblade.owner_pid": "999", "proofblade.owner_started_at": "1" }));
        }
        if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) { cleanupCalls.push(args); return processResult(""); }
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never", networkPolicy: "target-only" };
    const runtime = new DockerContainerRuntime(config, runner);
    await assert.rejects(runtime.create({ runId: "NETWORK/CONFLICT", generation: 1, profile: "pwn", image: config.images.pwn, workspaceHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" }], networkPolicy: "target-only" }));
    assert.equal(cleanupCalls.some((args) => args[0] === "network" && args[1] === "rm"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker create does not remove a concurrently-created same-name network", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-network-race-"));
  try {
    let createCalls = 0;
    let networkInspectCalls = 0;
    let winningNetworkLabels: Record<string, string> | undefined;
    let secondCreateEntered!: () => void;
    const secondCreate = new Promise<void>((resolve) => { secondCreateEntered = resolve; });
    let networkRemovals = 0;
    const runner: DockerCommandRunner = {
      async run(args): Promise<DockerProcessResult> {
        if (args[0] === "image" && args[1] === "inspect") return processResult("sha256:image\n");
        if (args[0] === "network" && args[1] === "inspect") {
          // Before either create wins, the deterministic name is absent. Once
          // the first create has won, expose that invocation's full label set.
          networkInspectCalls += 1;
          return processResult(networkInspectCalls <= 2 || !winningNetworkLabels ? "{}" : JSON.stringify(winningNetworkLabels));
        }
        if (args[0] === "network" && args[1] === "create") {
          createCalls += 1;
          if (createCalls === 1) {
            winningNetworkLabels = {};
            for (let index = 0; index < args.length; index += 1) {
              const label = args[index] === "--label" ? args[index + 1] : undefined;
              if (!label?.startsWith("proofblade.")) continue;
              const separator = label.indexOf("=");
              if (separator > 0) winningNetworkLabels[label.slice(0, separator)] = label.slice(separator + 1);
            }
            await secondCreate;
            return processResult("network-id\n");
          }
          secondCreateEntered();
          return processResult("network name already exists", 1);
        }
        if (args[0] === "network" && args[1] === "rm") { networkRemovals += 1; return processResult(""); }
        if (args[0] === "run" && args.includes("-d")) {
          const name = args[args.indexOf("--name") + 1];
          return processResult(name?.endsWith("-gateway") ? "gateway-id\n" : "solver-id\n");
        }
        if (args[0] === "exec") return processResult("");
        return processResult("");
      },
    };
    const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never", networkPolicy: "target-only" };
    const runtime = new DockerContainerRuntime(config, runner);
    const request = { runId: "SAME/RUN", generation: 1, profile: "pwn" as const, image: config.images.pwn, workspaceHostPath: root, targets: [{ host: "127.0.0.1", port: 31337, protocol: "tcp" as const }], networkPolicy: "target-only" as const };
    const first = runtime.create(request);
    const second = runtime.create(request);
    const outcomes = Promise.allSettled([first, second]);
    await new Promise<void>((resolve) => {
      const poll = (): void => createCalls >= 2 ? resolve() : setTimeout(poll, 0);
      poll();
    });
    const results = await outcomes;
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(networkRemovals, 0);
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

const SESSION_REF: ContainerRef = {
  runId: "SESSION/1", generation: 1, containerId: "session-container", name: "session-container",
  profile: "pwn", image: "proofblade/ctf-pwn:latest", imageDigest: "sha256:test",
  workspaceHostPath: process.cwd(), workspaceContainerPath: "/workspace", networkPolicy: "none",
};

/** A spawner that ignores the docker args and runs a controlled local node script. */
function localNodeSpawner(script: string, scriptArgs: string[] = []): SessionProcessSpawner {
  return () => spawn(process.execPath, ["-e", script, "--", ...scriptArgs], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function sessionRuntime(spawner: SessionProcessSpawner): DockerContainerRuntime {
  const runner: DockerCommandRunner = { async run(): Promise<DockerProcessResult> { return processResult(""); } };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  return new DockerContainerRuntime(config, runner, spawner);
}

test("session echoes stdin back as bounded incremental output and reports idle", async () => {
  // A cat-like echo loop: every stdin line is written straight back to stdout.
  const runtime = sessionRuntime(localNodeSpawner("process.stdin.on('data',d=>process.stdout.write(d));"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/cat"], idleSilenceMs: 120, waitTimeoutMs: 4000 });
  try {
    const first = await runtime.sessionWrite(handle, "hello\n");
    assert.match(first.delta, /hello/);
    assert.equal(first.waitReason, "idle");
    assert.equal(first.exited, false);
    // A read without input returns no new bytes and still resolves via timeout.
    const idle = await runtime.sessionRead(handle, { idleSilenceMs: 60, waitTimeoutMs: 300 });
    assert.equal(idle.delta, "");
    assert.equal(idle.waitReason, "timeout");
  } finally {
    await runtime.closeSession(handle);
  }
});

test("session close is idempotent and returns the exit code", async () => {
  const runtime = sessionRuntime(localNodeSpawner("process.stdin.resume();"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/cat"] });
  const first = await runtime.closeSession(handle);
  const second = await runtime.closeSession(handle);
  assert.doesNotThrow(() => second);
  assert.equal(second.exitCode, null);
  void first;
});

test("session reports exit with the process exit code", async () => {
  const runtime = sessionRuntime(localNodeSpawner("process.stdout.write('done\\n');process.exit(7);"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/sh"], idleSilenceMs: 5000, waitTimeoutMs: 4000 });
  try {
    const result = await runtime.sessionRead(handle, { waitTimeoutMs: 4000 });
    assert.equal(result.exited, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.waitReason, "exit");
    assert.match(result.delta, /done/);
    await runtime.closeSession(handle);
    await assert.rejects(runtime.sessionRead(handle), /Unknown container session/);
  } finally {
    await runtime.closeSession(handle);
  }
});

test("session read hits the absolute timeout on a silent long-running process", async () => {
  const runtime = sessionRuntime(localNodeSpawner("process.stdin.resume();setTimeout(()=>{},60000);"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/sleep", "60"] });
  try {
    const result = await runtime.sessionRead(handle, { idleSilenceMs: 5000, waitTimeoutMs: 200 });
    assert.equal(result.waitReason, "timeout");
    assert.equal(result.exited, false);
    assert.equal(result.delta, "");
  } finally {
    await runtime.closeSession(handle);
  }
});

test("session marks output truncated once the unread accumulator exceeds its ceiling", async () => {
  // Emit ~1.3 MiB in one burst, above the 1 MiB unread ceiling, then idle.
  const runtime = sessionRuntime(localNodeSpawner("process.stdout.write('A'.repeat(1300*1024));process.stdin.resume();"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/sh"], idleSilenceMs: 150, waitTimeoutMs: 4000 });
  try {
    const result = await runtime.sessionRead(handle, { idleSilenceMs: 150, waitTimeoutMs: 4000 });
    assert.equal(result.truncated, true);
    assert.ok(result.delta.length <= 1024 * 1024);
  } finally {
    await runtime.closeSession(handle);
  }
});

test("session keeps delivering new output after it has already produced a lot (no dead cursor)", async () => {
  // Regression for the bug where, once buffer.length hit the ceiling, every
  // later read returned "" because the delta was a slice at buffer.length.
  // Emit a chunk, read it, emit MORE on a later stdin line, read again.
  const script = "process.stdin.on('data',(d)=>{const n=parseInt(String(d),10)||1;process.stdout.write('B'.repeat(n)+'\\n');});";
  const runtime = sessionRuntime(localNodeSpawner(script));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/sh"], idleSilenceMs: 120, waitTimeoutMs: 4000 });
  try {
    const first = await runtime.sessionWrite(handle, "500000\n", { idleSilenceMs: 200, waitTimeoutMs: 4000 });
    assert.ok(first.delta.length >= 500000, `first delta ${first.delta.length}`);
    // A second, small burst must come back in full — not swallowed as "".
    const second = await runtime.sessionWrite(handle, "7\n", { idleSilenceMs: 200, waitTimeoutMs: 4000 });
    assert.match(second.delta, /BBBBBBB/);
    assert.ok(second.delta.length >= 7 && second.delta.length < 1000, `second delta ${second.delta.length}`);
  } finally {
    await runtime.closeSession(handle);
  }
});

test("sessionSignal targets the session's own pid, not kill -1, and reports the real result", async () => {
  const calls: string[][] = [];
  let killExit = 0;
  const runner: DockerCommandRunner = {
    async run(args): Promise<DockerProcessResult> {
      calls.push(args);
      // The signal path runs `sh -c <script> pb-signal <pidfile> <signum>`.
      if (args[0] === "exec" && args.includes("pb-signal")) return processResult("", killExit);
      return processResult("");
    },
  };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner, localNodeSpawner("process.stdin.resume();"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/cat"] });
  try {
    const ok = await runtime.sessionSignal(handle, "SIGINT");
    assert.equal(ok, true);
    const signalCall = calls.find((args) => args.includes("pb-signal"));
    assert.ok(signalCall, "expected a pb-signal exec");
    // Must reference this session's pidfile and must NOT broadcast with kill -1.
    assert.ok(signalCall!.some((arg) => arg.includes(".pb-session-") && arg.endsWith(".pid")));
    // The signal number and pid are passed positionally to the script; the args
    // must never contain a literal broadcast target like "-1".
    assert.equal(signalCall!.includes("-1"), false);
    assert.equal(signalCall!.some((arg) => /(^|\s)-1(\s|$)/.test(arg)), false);
    // The kill script must target the process GROUP (kill ... -- -"$p") so a
    // forked child of the target receives the signal too, not just the leader.
    assert.ok(signalCall!.some((arg) => arg.includes('-- -"$p"')), "must signal the process group");
    // A non-zero kill (e.g. empty pidfile) must surface as false, not fake true.
    killExit = 3;
    assert.equal(await runtime.sessionSignal(handle, "SIGINT"), false);
    // An unknown signal name must throw, not silently downgrade to SIGTERM.
    await assert.rejects(runtime.sessionSignal(handle, "SIGIN" as NodeJS.Signals), /Unsupported signal/);
  } finally {
    await runtime.closeSession(handle);
  }
});

test("openSession wraps the target in setsid so it leads its own process group", async () => {
  const spawnedArgs: string[][] = [];
  const spawner: SessionProcessSpawner = (command, args) => {
    spawnedArgs.push([command, ...args]);
    return spawn(process.execPath, ["-e", "process.stdin.resume();"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  };
  const runner: DockerCommandRunner = { async run(): Promise<DockerProcessResult> { return processResult(""); } };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner, spawner);
  const handle = await runtime.openSession(SESSION_REF, { command: ["./chall"] });
  try {
    const args = spawnedArgs[0]!;
    // setsid -w makes the target a new session/group leader (pid==pgid) and waits.
    assert.ok(args.includes("setsid"));
    assert.ok(args.includes("-w"));
    // The real target command is still exec'd at the tail.
    assert.ok(args.includes("./chall"));
  } finally {
    await runtime.closeSession(handle);
  }
});

test("destroy closes live sessions for the container without orphaning children", async () => {
  const runner: DockerCommandRunner = { async run(): Promise<DockerProcessResult> { return processResult(""); } };
  const config: ResolvedExecutionConfig = { ...resolveExecutionConfig({} as never), backend: "docker", pullPolicy: "never" };
  const runtime = new DockerContainerRuntime(config, runner, localNodeSpawner("process.stdin.resume();"));
  const handle = await runtime.openSession(SESSION_REF, { command: ["/bin/cat"] });
  await runtime.destroy(SESSION_REF);
  // The session is gone: a subsequent read must reject as unknown.
  await assert.rejects(runtime.sessionRead(handle), /Unknown container session/);
});

function processResult(stdout: string, exitCode = 0): DockerProcessResult {
  return { stdout, stderr: "", exitCode, truncated: false, durationMs: 1 };
}
