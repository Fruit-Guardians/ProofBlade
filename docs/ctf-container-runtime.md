# CTF container runtime proposal

Status: implemented in the first runtime slice. The Docker adapter, host/tool
environment split, target-only gateway, Web/Pwn image definitions, and focused
tests are in the repository. Browser session capabilities and a full PTY API
remain follow-up work.

## Problem

Competition runs currently execute `bash` through Pi's host `NodeExecutionEnv`. On
Windows this means that a Web or Pwn worker does not have a stable Linux toolchain,
a persistent browser profile, GDB/pwndbg, a compatible libc collection, QEMU, or a
reliable interactive terminal. `CompetitionSandbox` manages platform attachments,
flag scoring, and target teardown, but it is not an operating-system isolation
boundary.

The missing layer is a per-run analysis environment between the coding lane and
the host. It must preserve the existing provider-visible `read`, `bash`, `edit`,
`write`, `shell_background`, `shell_job`, and `submit_flag` contracts.

## Goals

- Give every Web and Pwn run a persistent Linux container with a category-specific
  toolchain.
- Keep one isolated workspace, process tree, browser profile, terminal state, and
  network policy per challenge run.
- Keep platform credentials, model credentials, Pi sessions, Control Store, and
  flag submission on the host.
- Route command output through the existing Artifact, telemetry, cancellation,
  output-capping, and evidence paths.
- Make cancellation and process restart converge: no stale browser, fuzzer, shell,
  or container may silently survive a finished run.
- Support Docker Desktop on Windows and Docker Engine on Linux with the same
  contract. WSL host execution is an explicit development fallback, not an
  automatic security fallback.

## Non-goals for the first version

- Running arbitrary challenge-supplied Docker Compose files.
- Giving the Agent the Docker socket or Docker CLI.
- Privileged containers, host networking, host PID namespace, or host filesystem
  mounts.
- Public C2/listener exposure or unrestricted Internet scanning.
- Rebuilding a patched browser engine. Firefox-Reverse-style engine tracing can be
  an optional later image/MCP, not a requirement for the first Web image.
- Loading kernel modules on the host. Kernel Pwn must run under nested QEMU.

## Reference projects: what to adopt

### Firefox-Reverse

Adopt the environment model, not the full Firefox fork:

- one run owns one browser profile, browser process, control endpoint, captures,
  traces, and logs;
- browser state never crosses challenge boundaries;
- page automation, request capture, script saving, cookies, screenshots, and
  JavaScript evaluation are structured operations;
- browser work continues independently of one model response and can be stopped by
  run teardown.

The first ProofBlade Web image uses Playwright Chromium. A Firefox-Reverse image
can be added later for JS/JSVMP/WASM-heavy challenges without changing the
container runtime contract.

### CyberStrikeAI

Adopt its execution-governance pattern:

- blocking work runs behind an execution id;
- the Agent waits for a bounded time, then polls or cancels;
- tool and per-container concurrency are bounded;
- large output is persisted once and only a bounded preview enters context;
- orphaned work has an explicit recovery state;
- tools have short discovery descriptions and detailed, on-demand schemas.

ProofBlade already has `JobRecord`, `shell_background`, `shell_job`, Artifact
storage, and output rewriting. The container runtime should extend these paths,
not create a second job database.

### pwncli

Install pwncli in the Pwn image and preserve its main workflow:

- one exploit script switches between local debug and remote attack;
- GDB breakpoints/scripts do not require editing the exploit on every attempt;
- libc/loader patching, gadget discovery, QEMU, and exploit templates are readily
  available;
- pwntools tube interaction remains the primary scripting interface.

Headless ProofBlade should prefer batch GDB and a structured PTY/tmux session over
opening graphical terminals.

## Architecture

```text
Competition API and model provider (host only)
                |
        CompetitionChallengeSolver
                |
       ContainerRuntimePort ------------- Control Store / telemetry
                |                                      |
       per-run Docker container ---- command output -> Artifact Store
                |
       /workspace (only mounted host path)
                |
      target host/port through per-run egress policy
```

`SandboxPort` keeps its current business meaning: acquire/reset/score/destroy the
competition target. A new `ContainerRuntimePort` owns the local analysis process
environment. Combining them would make platform lifecycle recovery and local
process recovery unnecessarily dependent on each other.

### Host and tool environments must be split

`PiCodingLane.create()` currently constructs one `NodeExecutionEnv` and uses it
both for `JsonlSessionRepo` and coding tools. Container support must split this:

1. `sessionEnv`: host-only `NodeExecutionEnv` for Pi JSONL and ProofBlade state.
2. `toolEnv`: a workspace-scoped execution environment whose file operations use
   the mounted host workspace and whose process operations execute inside the
   run container.

This prevents Pi sessions from being lost with the container and avoids mounting
the full run/control directory into an untrusted analysis environment.

Suggested contracts:

```ts
export interface ContainerRef {
  runId: string;
  generation: number;
  containerId: string;
  image: string;
  imageDigest: string;
  profile: "web" | "pwn" | "pwn-kernel";
  workspaceHostPath: string;
  workspaceContainerPath: "/workspace";
}

export interface ContainerRuntimePort {
  doctor(profile?: ContainerRef["profile"]): Promise<ContainerDoctorReport>;
  prewarm(profiles: ContainerRef["profile"][]): Promise<void>;
  create(input: ContainerCreateRequest): Promise<ContainerRef>;
  executionEnv(ref: ContainerRef): WorkspaceExecutionEnv;
  health(ref: ContainerRef): Promise<ContainerHealth>;
  reconcile(input: ContainerReconcileRequest): Promise<ContainerReconcileResult>;
  destroy(ref: ContainerRef, reason: string): Promise<void>;
  reapStale(): Promise<ContainerRef[]>;
}
```

The provider tool schemas remain unchanged. `bash`, `read`, `edit`, and `write`
receive `toolEnv` in their existing context. Container-specific higher-level
operations are discovered through the existing `capability` proxy.

## Workspace layout

```text
fixtures/runtime/<run-id>/
  input/                  # downloaded challenge files; mounted read-only
  work/                   # exploits, scripts, unpacked copies; mounted read-write
  output/                 # screenshots, HAR, cores, reports; mounted read-write
  .proofblade-runtime/    # host-owned metadata; not mounted
```

The container sees:

```text
/workspace/input   (read-only)
/workspace/work    (read-write)
/workspace/output  (read-write)
/tmp               (tmpfs)
```

Existing flat workspaces need a compatibility mode during migration, but new
competition runs should never modify the original attachment bytes.

## Container profiles

### Common base

Pinned Ubuntu/Debian base digest, `tini`, Bash, Python, Git, curl, jq, file,
binutils, archive tools, CA certificates, tmux, socat, and netcat. Run as an
unprivileged `ctf` user. The root filesystem is read-only; `/tmp`, `/run`, and the
workspace write directories are the only writable locations.

### Web image

Include:

- Playwright with Chromium and Firefox;
- Node.js and Python with requests/httpx;
- curl, HTTPie, ffuf, feroxbuster/gobuster, sqlmap, nuclei, nikto, wafw00f;
- mitmproxy and HAR/trace conversion helpers;
- common PHP, Node, and Python runtimes for small local reproductions.

One persistent browser daemon owns `/workspace/work/browser-profile`. Its control
socket is Unix-domain-only inside the container and is never published to the
host network.

Proposed `ctf.web` capability operations:

- `session_start`, `session_status`, `session_stop`;
- `navigate`, `elements`, `click`, `type`, `evaluate`, `screenshot`;
- `network_list`, `network_get`, `cookies`, `storage`, `save_scripts`;
- `request_replay` and `export_har`.

Responses must be bounded summaries with Artifact ids for full bodies, HAR files,
screenshots, and traces. Page content is untrusted observation data and cannot
change scope or tool policy.

### Pwn image

Include:

- pwntools and pwncli;
- GDB plus pwndbg or GEF, checksec, binutils, elfutils, patchelf;
- ropper, ROPgadget, one_gadget, seccomp-tools;
- gcc/clang, make, CMake, multilib, strace, ltrace;
- QEMU user emulation and QEMU system emulation;
- a version-pinned, read-only libc/loader catalog and libc identification helpers.

Proposed `ctf.pwn` capability operations:

- `inspect_elf`: file, architecture, interpreter, dependencies, checksec, symbols;
- `init_exploit`: create a template only if the target path does not exist;
- `identify_libc`, `patch_loader`, `find_gadgets`;
- `gdb_batch`: bounded commands, transcript stored as an Artifact;
- `pty_start`, `pty_send`, `pty_read`, `pty_stop` for interactive programs and
  post-exploitation shell confirmation;
- `qemu_run` and `qemu_debug` for non-native architectures.

The PTY abstraction is necessary. A successful `system("/bin/sh")` cannot be
inferred from a socket reset; the Agent needs a durable session id, marker command,
captured output, and explicit exit status.

`pwn-kernel` is a separate opt-in profile. It runs QEMU in software mode by
default and never receives `/dev/kvm`, host devices, or privileged mode.

## Isolation and credentials

Default container settings:

- no Docker socket, host home, ProofBlade install root, run store, or credential
  file mounts;
- an explicit clean environment; do not inherit the host process environment;
- no platform access key or model API key in the container;
- non-root user, `no-new-privileges`, dropped Linux capabilities;
- Web: default seccomp profile and no added capabilities;
- Pwn: only `SYS_PTRACE` plus a narrow custom seccomp profile for debugging;
- CPU, memory, PID, file-size, open-file, and wall-clock limits;
- `--read-only`, tmpfs for transient directories, and bounded shared memory for
  browsers;
- deterministic labels containing run id, generation, profile, and image digest.

Suggested defaults:

| Profile | CPU | Memory | PIDs | `/tmp` | Extra |
| --- | ---: | ---: | ---: | ---: | --- |
| Web | 2 | 4 GiB | 512 | 1 GiB | 1 GiB shared memory |
| Pwn | 2 | 4 GiB | 512 | 1 GiB | `SYS_PTRACE` |
| Pwn-kernel | 4 | 8 GiB | 1024 | 2 GiB | nested QEMU only |

## Network policy

`competitionTask()` must normalize `connectionInfo` into a host and port. It
currently stores the whole connection string in `allowed_hosts` and leaves
`allowed_ports` empty; that is not enforceable by a container runtime.

For each run:

1. Resolve and freeze the challenge host/port set at container creation.
2. Put the solver behind a per-run egress namespace/gateway.
3. Permit only DNS resolution and the normalized target IP/port set.
4. Log destination, port, byte counts, and decision without storing payloads.
5. Treat redirects or new hosts as a scope-change request.

On Docker Desktop, environment proxy variables alone are insufficient because a
tool can bypass them. Hardened mode should use a small egress-gateway sidecar with
the solver sharing its network namespace; the solver has no `NET_ADMIN`. The
gateway owns the allowlist and is destroyed with the run.

Image building and dependency installation happen before competition environments
are started. A run does not get general package-manager Internet access. Explicit
operator approval can open a time-bounded additional destination when a challenge
legitimately requires an external callback.

## Lifecycle and recovery

```text
Fleet start
  -> Docker doctor + prewarm selected profile images
Challenge selected
  -> fetch detail/attachments
  -> normalize target scope
  -> start competition environment
  -> materialize immutable input workspace
  -> create per-run container and egress gateway
  -> open Pi coding lane with host sessionEnv + container toolEnv
  -> solve / submit_flag on host
Finally
  -> stop PTY/browser/background jobs
  -> destroy analysis container and gateway
  -> release competition environment
```

Prewarming must occur before `startEnvironment()` so image pulls do not consume a
challenge's expiry window.

Container names and labels are deterministic. On process restart, reconciliation
may adopt a healthy container only when run id, generation, workspace, profile,
and image digest all match. A mismatched container is destroyed and recreated.
Unadoptable active exec calls become `UNKNOWN`; durable tmux/browser sessions can
be reconciled by their recorded session ids.

A startup reaper removes labelled containers whose run is terminal or whose TTL
has expired. Cleanup failure is recorded and retried; it is never silently treated
as success.

## Configuration

Proposed optional configuration:

```json
{
  "execution": {
    "backend": "docker",
    "requireFor": ["web", "pwn"],
    "dockerCommand": "docker",
    "networkPolicy": "target-only",
    "pullPolicy": "if-missing",
    "images": {
      "web": "proofblade/ctf-web@sha256:<digest>",
      "pwn": "proofblade/ctf-pwn@sha256:<digest>",
      "pwn-kernel": "proofblade/ctf-pwn-kernel@sha256:<digest>"
    },
    "commandWaitMs": 30000,
    "commandHardTimeoutMs": 600000,
    "outputPreviewBytes": 50000,
    "staleContainerTtlMs": 3600000
  }
}
```

If Docker is installed but the daemon is unavailable, `doctor` reports
`installed: true, daemon: false`. Auto Fleet must refuse to start Web/Pwn workers
with a clear action message. It must not silently fall back to host execution.

## Code integration map

1. `packages/materials/src/container/`
   - contracts, Docker CLI adapter, workspace execution environment, network
     gateway, doctor, lifecycle, and reconciliation.
2. `packages/materials/src/runtime/coding-lane.ts`
   - accept injected `sessionEnv` and `toolEnv`; stop constructing one shared
     `NodeExecutionEnv` for both concerns.
3. `packages/materials/src/competition/task.ts`
   - parse connection info into enforceable host/port scope.
4. `packages/materials/src/competition/solver.ts`
   - preflight/prewarm before target provisioning, then create/destroy the run
     container around the coding lane.
5. `packages/materials/src/runtime/coding-resources.ts`
   - keep built-in tool schemas stable; add discovered `ctf.web`, `ctf.pwn`, and
     PTY capabilities through the existing router.
6. `packages/materials/src/domain/types.ts`
   - persist container profile, id/digest, lifecycle, and cleanup outcome or add a
     dedicated container record/event family.
7. `apps/gui/`
   - add a runtime doctor panel, image readiness, container/resource status,
     browser/PTY sessions, and cleanup failures. The GUI invokes materials; it
     does not call Docker directly.
8. `containers/`
   - pinned base/Web/Pwn Dockerfiles, lock manifest, seccomp profiles, helper
     scripts, and image smoke tests.

## Implementation phases

### Phase 1: process environment MVP

- Docker doctor and pinned Web/Pwn images.
- Per-run long-lived container, restricted mounts, resource limits, and teardown.
- Split host session environment from container tool environment.
- Route existing `bash/read/edit/write/shell_*` without changing provider schemas.
- Record image digest and container lifecycle in run telemetry.

This phase alone fixes the absent Linux toolchain and stale host-workspace problem.

### Phase 2: interactive Pwn

- pwncli, libc catalog, batch GDB, QEMU helpers, and structured PTY sessions.
- Regression challenge that proves local debug, remote switch, shell marker, and
  flag capture without assuming a reset means success.

### Phase 3: browser Web

- persistent Playwright profile, structured page/network/cookie tools, screenshots,
  HAR artifacts, and browser cleanup.
- Regression challenge covering upload, XSS/bot-style payload validation, request
  capture, and same-origin response inspection.

### Phase 4: hardened egress and recovery

- per-run egress gateway, enforced target-only policy, scope-change approval;
- container adoption/reaping, orphaned job reconciliation, and cleanup retries;
- optional rootless engine support and signed/published images.

### Phase 5: optional advanced labs

- safe host-managed local target topology for source challenges;
- Firefox-Reverse MCP/image for JS/JSVMP/WASM-heavy Web challenges;
- Pwn-kernel QEMU templates and architecture-specific image layers.

## Acceptance criteria

- Web/Pwn Auto Fleet refuses to start when Docker daemon or required image is
  unavailable and never falls back to the Windows host.
- Two concurrent challenges cannot see each other's files, processes, browser
  profile, terminal sessions, or network traffic.
- A container cannot read host API keys, the host home directory, Pi sessions, or
  the Docker socket.
- The target allowlist blocks a second test host/port and records the denial.
- Cancelling a run stops blocking commands, background jobs, PTYs, browser
  processes, gateway, and container within a bounded interval.
- A daemon/process restart produces either a verified adoption or an explicit
  `UNKNOWN`/recreate outcome; it never duplicates unsafe work.
- A 200 KiB tool response is persisted once and only a bounded preview reaches
  the model and GUI.
- Pwn smoke test performs checksec, libc/loader switch, batch GDB, local exploit,
  remote exploit, and shell marker capture.
- Web smoke test preserves one run's cookies across turns, isolates them from a
  second run, records network requests, and exports screenshot/HAR Artifacts.
- `submit_flag` remains host-only and no platform credential appears in container
  inspect output, environment, filesystem, or artifacts.

## Recommended first delivery

Implement Phase 1 and the Pwn PTY slice first. The recent shopping run showed
that Linux tooling alone is insufficient when a post-exploitation shell cannot be
observed. Then add the persistent Web browser profile and request capture. Hardened
target-only egress should be completed before enabling unattended Auto Fleet for
arbitrary competition targets.
