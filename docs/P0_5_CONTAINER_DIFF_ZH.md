# P0.5 容器层改造 —— 具体 Diff 方案

> 前置阻塞项。目标：在补 Pwn/Web 持久会话之前，让容器层具备两件事——
> (A) 只读 rootfs 下 pwntools/gdb 有可写可执行的 HOME/scratch；
> (B) `ContainerRuntimePort` 提供**持久 exec 会话原语**（跨工具调用存活的 stdin/stdout 句柄）。
>
> 本文只覆盖容器层。会话领域建模（SessionRecord/事件/证据图）和模型可见工具（pwn_open/send/recv）属于 P1，见 `SESSION_INTERACTION_DESIGN_ZH.md`。

## 0. 已确认的现状（不要重复做）

读 `packages/materials/src/container/docker.ts` 后确认，以下**已经存在**，P0.5 不碰：

- `docker.ts:171`：pwn/pwn-kernel 已追加 `--cap-add SYS_PTRACE`。
- `docker.ts:175`：容器已用 `sleep infinity` 常驻。
- `containers/pwn/Dockerfile`：pwntools/pwncli/ropgadget/gdb/gdb-multiarch/libc6-dbg/one_gadget/qemu 齐全。
- `containers/base/Dockerfile:8`：用户 `ctf`（uid 1001），HOME=`/home/ctf`。

所以 P0.5 的净工作只有两块：**文件系统可写性（第 1 节）** 和 **持久会话原语（第 2-4 节）**。

---

## 1. Diff A：只读 rootfs 下的可写 HOME / scratch（低风险，先做）

### 1.1 问题

`docker.ts:170` 对所有 profile 用 `--read-only`，只挂了 `/tmp`（noexec）、`/run`、`/workspace`（bind）可写。但：

- pwntools 首次运行会写 `~/.cache/.pwntools-cache-*`、`~/.local/share`；
- `one_gadget` 缓存写 `~/.cache`；
- gdb 写 `~/.gdbinit` 历史、`~/.cache/gdb`；
- pwntools/gdb 生成的临时 gdbscript、`gdb.debug()` 的 exec 包装若落到 `/tmp` 会撞 `noexec`。

只读 rootfs + 只读 HOME 会让这些工具报错或静默退化，交互调试不稳定。

### 1.2 改法：给 pwn/pwn-kernel 挂 tmpfs HOME + exec scratch

在 `docker.ts` 的 `create()` 里，把 tmpfs/mount 参数从"写死一行"改为"按 profile 计算"。

**当前代码（docker.ts:169-175）：**

```ts
      const limits = request.limits;
      const args = ["run", "-d", "--name", name, ...labels, "--user", containerUser, "--workdir", "/workspace", "--mount", `type=bind,source=${request.workspaceHostPath},destination=/workspace`, ...(request.skillLibraryHostPath ? ["--mount", `type=bind,source=${request.skillLibraryHostPath},destination=/opt/proofblade/skills,readonly`] : []), "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g", "--tmpfs", "/run:rw,noexec,nosuid,size=64m", "--pids-limit", String(limits?.pids ?? 512), "--cpus", limits?.cpus ?? "2", "--memory", limits?.memory ?? "4g", "--shm-size", limits?.shmSize ?? "1g", "--ulimit", "nofile=4096:4096", "--ulimit", "fsize=1073741824:1073741824", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
      if (request.profile === "pwn" || request.profile === "pwn-kernel") args.push("--cap-add", "SYS_PTRACE");
```

**改为：**

```ts
      const limits = request.limits;
      const isPwn = request.profile === "pwn" || request.profile === "pwn-kernel";
      // Pwn tooling (pwntools cache, one_gadget cache, gdb history, gdb.debug()
      // exec wrappers) writes under HOME and needs an exec-capable scratch dir.
      // A read-only rootfs otherwise makes these tools fail or silently degrade,
      // which shows up as flaky interactive debugging. Give pwn a tmpfs HOME and
      // an exec scratch mount; keep /tmp noexec everywhere as the default.
      // NOTE: Docker forces `noexec` on --tmpfs unless `exec` is passed
      // explicitly (verified by smoke test). Pwn scratch must opt back in.
      const tmpfsArgs = isPwn
        ? [
            "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",         // pwn: allow exec in /tmp
            "--tmpfs", "/home/ctf:rw,exec,nosuid,uid=1001,gid=1001,mode=0770,size=512m",
            "--tmpfs", "/opt/pwn:rw,exec,nosuid,uid=1001,gid=1001,mode=0770,size=512m",
            "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
          ]
        : [
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
            "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
          ];
      const args = ["run", "-d", "--name", name, ...labels, "--user", containerUser, "--workdir", "/workspace", "--mount", `type=bind,source=${request.workspaceHostPath},destination=/workspace`, ...(request.skillLibraryHostPath ? ["--mount", `type=bind,source=${request.skillLibraryHostPath},destination=/opt/proofblade/skills,readonly`] : []), "--read-only", ...tmpfsArgs, "--pids-limit", String(limits?.pids ?? 512), "--cpus", limits?.cpus ?? "2", "--memory", limits?.memory ?? "4g", "--shm-size", limits?.shmSize ?? "1g", "--ulimit", "nofile=4096:4096", "--ulimit", "fsize=1073741824:1073741824", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
      if (isPwn) args.push("--cap-add", "SYS_PTRACE");
```

要点：
- **保留 rootfs `--read-only` 和 `no-new-privileges`**（安全基线不变），只放开 HOME/scratch/tmp 的写与执行。
- tmpfs 的 `uid=1001,gid=1001,mode=0770` 保证非 root 用户 `ctf` 可写，且非 world 可读（不泄漏题目 credential）。
- web profile 完全不变（保持 `/tmp` noexec）。

### 1.3 Dockerfile 侧：让 HOME 默认变量指向可写处（可选加固）

即便挂了 tmpfs HOME，某些工具用 `XDG_CACHE_HOME` 更稳。给 pwn 镜像加环境变量做双保险：

**`containers/pwn/Dockerfile`（在 ENV 段追加）：**

```dockerfile
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    HOME=/home/ctf \
    XDG_CACHE_HOME=/home/ctf/.cache \
    XDG_DATA_HOME=/home/ctf/.local/share \
    PWNLIB_NOTERM=1
```

`PWNLIB_NOTERM=1` 让 pwntools 在非 tty 环境下不启用 term 控制，交互输出更干净可解析（会话层解析 recv 时受益）。

### 1.4 验收（Diff A）

容器起来后，在容器内跑一次冒烟：

```bash
docker exec <cid> /bin/sh -lc 'cd /tmp && python3 -c "from pwn import *; print(asm(\"nop\"))" && echo OK-CACHE'
docker exec <cid> /bin/sh -lc 'gdb --batch -ex "python print(1)" && echo OK-GDB'
```

两条都应打印 OK-* 且无 "Read-only file system" / "Permission denied" 报错。

---

## 2. Diff B：ContainerRuntimePort 持久会话契约（核心）

`packages/materials/src/container/contracts.ts` 增加会话原语。这是把 dsh 四层架构接进 ProofBlade 的最底层接口。

### 2.1 在 contracts.ts 追加类型

```ts
export type SessionWaitReason = "prompt" | "idle" | "timeout" | "exit";

export interface ContainerSessionHandle {
  /** Registry-facing id, e.g. the docker exec instance id or an internal token. */
  readonly sessionId: string;
  readonly ref: ContainerRef;
}

export interface ContainerSessionOpenOptions {
  /** Command that becomes the long-lived process, e.g. ["/bin/bash","-i"]. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Absolute wall-clock ceiling for a single read/wait call. */
  waitTimeoutMs?: number;
  /** Silence window after which output is treated as idle. */
  idleSilenceMs?: number;
  signal?: AbortSignal;
}

export interface ContainerSessionWriteResult {
  /** Incremental UTF-8 output observed since the previous read, bounded. */
  delta: string;
  waitReason: SessionWaitReason;
  /** True when the underlying process has exited. */
  exited: boolean;
  exitCode?: number | null;
  truncated: boolean;
}

export interface ContainerSessionReadOptions {
  /** Do not send input; just drain available output. */
  waitTimeoutMs?: number;
  idleSilenceMs?: number;
  signal?: AbortSignal;
}
```

### 2.2 在 ContainerRuntimePort 接口追加方法

**当前（contracts.ts:79-88）末尾追加：**

```ts
export interface ContainerRuntimePort {
  doctor(profile?: ContainerRef["profile"]): Promise<ContainerDoctorReport>;
  prewarm(profiles: ContainerRef["profile"][]): Promise<void>;
  create(request: ContainerCreateRequest): Promise<ContainerRef>;
  executionEnv(ref: ContainerRef): ExecutionEnv;
  exec(ref: ContainerRef, command: string, options?: ContainerCommandOptions): Promise<ContainerCommandResult>;
  health(ref: ContainerRef): Promise<boolean>;
  destroy(ref: ContainerRef): Promise<void>;
  reapStale(options?: { olderThanMs?: number; runId?: string; protectedRunIds?: string[]; includeRunning?: boolean }): Promise<number>;

  // --- P0.5 persistent session primitives ---
  /** Start a long-lived process inside the container; the handle survives across tool calls. */
  openSession(ref: ContainerRef, options: ContainerSessionOpenOptions): Promise<ContainerSessionHandle>;
  /** Write bytes to the session stdin and wait until a readiness signal or timeout. */
  sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array, options?: ContainerSessionReadOptions): Promise<ContainerSessionWriteResult>;
  /** Drain output without sending input. */
  sessionRead(handle: ContainerSessionHandle, options?: ContainerSessionReadOptions): Promise<ContainerSessionWriteResult>;
  /** Send a signal to the session's foreground process group. */
  sessionSignal(handle: ContainerSessionHandle, signal: NodeJS.Signals): Promise<boolean>;
  /** Terminate the session process tree; idempotent. */
  closeSession(handle: ContainerSessionHandle): Promise<{ exitCode: number | null }>;
}
```

设计取舍：
- **只做"持久 exec 会话"这一层**，不在 contracts 里区分 local-pty / remote-tube。remote tube（pwntools `remote()`）是"在会话里跑一个 python 脚本"，属于 P1 在这个原语之上封装，不污染容器契约。
- `waitReason` 先做三档（prompt/idle/timeout/exit）。`prompt` 依赖注入 OSC 标记（见 4.2），首版可以先只实现 idle+timeout+exit，prompt 作为增强。诚实标注：idle/timeout **不证明前台命令已退出**。

---

## 3. Diff C：DockerContainerRuntime 实现持久会话

`packages/materials/src/container/docker.ts` 实现上面四个方法。核心是持有一个存活的 `docker exec -i` 子进程，而不是每次 spawn。

### 3.0 实现补充（落地后追加）

- 会话子进程 spawn 做成**可注入**（构造函数第三参 `sessionSpawner?: SessionProcessSpawner`，默认 `spawn(dockerCommand, args, {stdio:pipe})`）。单元测试注入一个跑本地 node 脚本的 spawner，无需真实 Docker 即可确定性验证 open/write/read/close/timeout/exit/truncated/destroy。真实 `docker exec -i` 路径另由冒烟脚本覆盖。
- `signalName` 把 `NodeJS.Signals` 映射为数字（`SIGINT→2` 等），`kill -N -1` 发给容器内前台组。
- 冒烟已验证真实 pwn 容器：环境变量、cwd 跨 write 保留，python 在会话内运行，close/destroy 无孤儿。

### 3.1 会话表 + 句柄

在 `DockerContainerRuntime` 类里加一个私有 Map 和一个内部 session 类。因为需要长期持有 `child_process`，不能复用 `SpawnDockerCommandRunner`（它 spawn 完就 resolve）。

```ts
interface LiveSession {
  sessionId: string;
  ref: ContainerRef;
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  buffer: string;          // bounded scrollback tail kept in memory
  dropped: boolean;
  exited: boolean;
  exitCode: number | null;
  idleSilenceMs: number;
  waitTimeoutMs: number;
}

const SESSION_BUFFER_MAX = 256 * 1024; // model only sees bounded viewport anyway
```

### 3.2 openSession

```ts
public async openSession(ref: ContainerRef, options: ContainerSessionOpenOptions): Promise<ContainerSessionHandle> {
  const cwd = containerCwd(ref.workspaceHostPath, options.cwd);
  const env = {
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
    ...options.env,
  };
  const args = ["exec", "-i", "--workdir", cwd];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push(ref.containerId, ...options.command);

  // Direct spawn: we must keep stdin open and read stdout incrementally, which
  // SpawnDockerCommandRunner intentionally does not do (it resolves on close).
  const child = spawn(this.config.dockerCommand ?? "docker", args, {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const sessionId = `dxs-${randomUUID()}`;
  const session: LiveSession = {
    sessionId, ref, child, buffer: "", dropped: false, exited: false, exitCode: null,
    idleSilenceMs: options.idleSilenceMs ?? 800,
    waitTimeoutMs: options.waitTimeoutMs ?? 30_000,
  };
  const append = (chunk: Buffer) => {
    session.buffer += chunk.toString("utf8");
    if (session.buffer.length > SESSION_BUFFER_MAX) {
      session.buffer = session.buffer.slice(-SESSION_BUFFER_MAX);
      session.dropped = true;
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append); // pwntools/gdb write progress to stderr; keep unified
  child.once("exit", (code) => { session.exited = true; session.exitCode = code; });
  this.sessions.set(sessionId, session);
  return { sessionId, ref };
}
```

### 3.3 sessionWrite / sessionRead（就绪判定）

```ts
public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array, options: ContainerSessionReadOptions = {}): Promise<ContainerSessionWriteResult> {
  const session = this.requireSession(handle);
  if (!session.exited) session.child.stdin.write(data);
  return await this.drain(session, options);
}

public async sessionRead(handle: ContainerSessionHandle, options: ContainerSessionReadOptions = {}): Promise<ContainerSessionWriteResult> {
  return await this.drain(this.requireSession(handle), options);
}

/** Wait for a readiness signal: idle silence, absolute timeout, or process exit. */
private async drain(session: LiveSession, options: ContainerSessionReadOptions): Promise<ContainerSessionWriteResult> {
  const start = Date.now();
  const idleMs = options.idleSilenceMs ?? session.idleSilenceMs;
  const hardMs = options.waitTimeoutMs ?? session.waitTimeoutMs;
  const before = session.buffer.length;
  let lastLen = before;
  let lastChange = Date.now();
  let waitReason: SessionWaitReason = "idle";

  for (;;) {
    if (options.signal?.aborted) { waitReason = "timeout"; break; }
    if (session.exited) { waitReason = "exit"; break; }
    if (Date.now() - start >= hardMs) { waitReason = "timeout"; break; }
    if (session.buffer.length !== lastLen) { lastLen = session.buffer.length; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= idleMs && session.buffer.length > before) { waitReason = "idle"; break; }
    await new Promise((r) => setTimeout(r, 40));
  }
  const delta = session.buffer.slice(before);
  return { delta, waitReason, exited: session.exited, exitCode: session.exitCode, truncated: session.dropped };
}
```

### 3.4 sessionSignal / closeSession

```ts
public async sessionSignal(handle: ContainerSessionHandle, signal: NodeJS.Signals): Promise<boolean> {
  const session = this.requireSession(handle);
  if (session.exited) return false;
  // The docker exec child is on the host; signal the in-container process group
  // via `docker exec kill` so SIGINT reaches the foreground pwn/gdb process.
  await this.runner.run(["exec", session.ref.containerId, "/bin/sh", "-lc", `kill -${signalNumber(signal)} -1 2>/dev/null || true`], { timeoutMs: configTimeout(this.config) });
  return true;
}

public async closeSession(handle: ContainerSessionHandle): Promise<{ exitCode: number | null }> {
  const session = this.sessions.get(handle.sessionId);
  if (!session) return { exitCode: null };
  try { session.child.stdin.end(); } catch { /* already closed */ }
  if (!session.exited) {
    if (process.platform === "win32" && session.child.pid) {
      spawn("taskkill", ["/pid", String(session.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      session.child.kill("SIGKILL");
    }
  }
  this.sessions.delete(handle.sessionId);
  return { exitCode: session.exitCode };
}

private requireSession(handle: ContainerSessionHandle): LiveSession {
  const session = this.sessions.get(handle.sessionId);
  if (!session) throw new Error(`Unknown container session: ${handle.sessionId}`);
  return session;
}
```

并在类顶部加字段：`private readonly sessions = new Map<string, LiveSession>();`

`destroy(ref)` 里应先关掉该 ref 的所有 session（避免孤儿 docker exec）：在 `destroy` 开头加一段遍历 `this.sessions`，对 `session.ref.containerId === ref.containerId` 的调用 `closeSession`。

### 3.5 关键实现说明

- **为什么不用 `docker exec -it`（分配 tty）**：node 侧 pipe stdio 更好解析，避免 tty 回显和控制字符污染。代价是拿不到真 pty 的前台组 `inputWaiting` 证据——**这就是首版 `waitReason` 先做 idle/timeout/exit、把 prompt 标记留作增强的原因**。若后续要 dsh 级的 `stdin_read` 精确判定，需在容器内跑一个真 pty broker（见第 4 节），那属于 P1 增强。
- **stderr 合并进 buffer**：pwntools/gdb 大量进度信息走 stderr，Pwn 交互必须看到；统一进 scrollback，模型看有界 viewport。
- **owner 隔离**：容器契约层不做 owner 校验，那属于 P1 的 SessionRegistry（对齐 dsh 的 owner-scoped registry）；容器层只提供裸原语。

---

## 4. 就绪判定的增强路径（P1，本文只标接口）

首版 idle/timeout 够跑通"send 一行 → 等静默 → 读 delta"的基本 tube。要达到 dsh 那种"程序是否卡在 read()"的精确判定，两条路（P1 做，不阻塞 P0.5）：

1. **OSC prompt 标记**：会话用 bash 时注入 `PROMPT_COMMAND='printf "\033]133;D;%s\007" "$?"'` + 固定 `PS1`，`drain` 里识别 `133;D;` 标记判 `prompt` 且带 exitCode。纯 tube（非 shell）不适用。
2. **容器内 pty broker**：容器内跑一个小进程用真 pty 起目标，暴露 unix socket，node 侧通过它拿前台组 `inputWaiting`。这是 dsh `LocalPtySession` 的等价物，成本高，仅在 idle 判定不够用时再做。

---

## 5. 会话作为长生命周期 Job（与现有 JobRecord 对齐）

P0.5 只交付容器原语；但要提前和 `JobRecord`（domain/types.ts:319）对齐，避免 P1 返工：

- `SessionRecord.externalId` 存 `ContainerSessionHandle.sessionId`；
- 会话的 open/close 各产生一个 Effect（走 EffectJournal），send/recv 的原始字节写 Artifact；
- Run 恢复时：`docker exec` 子进程是 host 进程，进程重启后必然失效 → 恢复流程把 `generation` 不匹配的 SessionRecord 标 `SUPERSEDED`，**不尝试复活**，由 Reproducer 用新连接重放（这与远程 socket 不可恢复的现实一致）。

---

## 6. 测试清单（P0.5 验收）

放在 `packages/materials/tests/`，用现有测试风格（node --test）。容器相关用可注入的 `DockerCommandRunner` fake，会话用真实 `spawn` 打一个本地 `/bin/sh` 或 `cat` 做确定性验证。

**Diff A（文件系统）——契约测试，校验生成的 `docker run` 参数：**
- pwn profile 的 args 含 `--tmpfs /home/ctf:...uid=1001...` 且 `/tmp` **不含** `noexec`；
- web profile 的 args 的 `/tmp` **仍含** `noexec`，且 **不含** `/home/ctf` tmpfs；
- 两者都仍含 `--read-only`、`no-new-privileges`、`--cap-drop ALL`；
- pwn 仍含 `--cap-add SYS_PTRACE`，web 不含。

**Diff B/C（持久会话）——用真实子进程：**
- openSession 起 `cat`，sessionWrite 写 "hello\n"，drain 在 idleSilence 内返回 delta 含 "hello"，waitReason=idle，exited=false；
- 写入后 closeSession，exitCode 返回，二次 closeSession 幂等不抛；
- openSession 起 `/bin/sh -lc 'echo done; exit 7'`，drain 观察到 exited=true 且 exitCode=7，waitReason=exit；
- 超短 waitTimeoutMs + 一个不产出的进程（`sleep 5`），drain 返回 waitReason=timeout 且 exited=false；
- buffer 超 SESSION_BUFFER_MAX 时 truncated=true；
- destroy(ref) 后该 ref 的 session 被清理（sessions.size 归零，无孤儿）。

**回归门禁：** 现有 `npm run build` + Materials 测试全绿；`docker.ts` 属高风险生命周期文件，按 `check:change-contracts` 规则需带故障路径测试（session 清理失败、进程提前退出）。

---

## 7. 落地顺序与风险

1. **先 Diff A**（纯参数分叉，风险最低，可独立合并并冒烟）。
2. **再 Diff B**（纯接口新增，不改现有行为）。
3. **最后 Diff C**（新增实现，不动 `exec`/`create` 主路径）。

风险点：
- Windows 主机上 `docker exec -i` 子进程的 kill 走 `taskkill /t /f`（已按现有 `SpawnDockerCommandRunner` 模式处理）。
- `--read-only` 放开 `/tmp` exec 后，pwn 容器的攻击面略增（可执行临时文件）；但 pwn 本就需要跑 exploit，且容器已 `no-new-privileges` + `cap-drop ALL` + target-only 网关，可接受。web 不放开，保持收紧。
- **冒烟实测坑（已修）**：Docker 的 `--tmpfs` **默认强制加 `noexec`**，即使挂载选项里没写。必须**显式传 `exec`** 才能在 tmpfs 里执行 patch 过的 binary / `gdb.debug()` exec 包装，否则 EACCES。这是只读代码发现不了、必须真实容器冒烟才能抓到的行为。
- 首版无真 pty，`waitReason` 精度有限；已在文档和返回值里诚实标注，P1 再增强。

---

## 8. 一页 diff 索引

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `packages/materials/src/container/docker.ts:169-171` | tmpfs/mount 按 profile 分叉（Diff A） | 改现有 |
| `containers/pwn/Dockerfile` | 追加 HOME/XDG/PWNLIB 环境变量（Diff A 加固） | 改现有 |
| `packages/materials/src/container/contracts.ts` | 新增会话类型 + Port 4 方法（Diff B） | 新增 |
| `packages/materials/src/container/docker.ts`（类内） | sessions Map + open/write/read/signal/close 实现（Diff C） | 新增 |
| `packages/materials/src/container/docker.ts`（destroy） | 关闭该 ref 的残留 session | 改现有 |
| `packages/materials/tests/*.test.ts` | Diff A 参数契约 + Diff B/C 会话行为 | 新增 |

> 完成 P0.5 后，P1 才在 `openSession/sessionWrite/...` 之上封装 `PwnLocalPtyBackend` / `PwnRemoteTubeBackend`、SessionRegistry（owner 隔离）和 pwn_open/send/recv 工具族。

---

## 9. 已落地进度（P0.5 + P1 基础层）

**P0.5（全部完成，含真实 Docker 冒烟）**
- Diff A：`docker.ts` 按 profile 分叉 tmpfs（pwn 得到 exec 的 `/tmp`、`/home/ctf`、`/opt/pwn`；web 保持 noexec）；`containers/pwn/Dockerfile` 加 HOME/XDG/PWNLIB 环境变量。
- Diff B/C：`contracts.ts` 会话契约 + `docker.ts` 持久 `docker exec -i` 会话实现（open/write/read/signal/close，可注入 `SessionProcessSpawner`）。

**P1 基础层（已完成，作为 pwn/web 工具与 Reproducer 的共同地基）**
- `domain/types.ts`：`SessionRecord` / `SessionKind` / `SessionStatus` / `SessionWaitReason`（单一真相）+ `RunSnapshot.sessions` + `session_*` 事件类型。
- `control/reducer.ts`：`session_opened/interacted/signaled/closed/superseded` 状态推进。
- `control/control-store.ts`：对应 5 个 DomainCommand。
- `container/session-registry.ts`：**owner-scoped `SessionRegistry`**——铸 id、每次交互落 Control 事件（可重放）、跨 lane 访问返回稳定错误码（`FOREIGN_SESSION`/`NO_SESSION`）、`supersedeStale` 在恢复时把旧代次会话标 SUPERSEDED（不复活死 socket）、`open` 失败回滚 runtime 子进程、`disposeAll` lane 关闭清理。

**P1 pwn 交互层（已完成）**
- `pwn/leak.ts`：`LeakRecord` + `parseLeakAddress`/`parseLeakHex`（le/be 32/64）+ `deriveBase`/`isPageAligned` 纯函数。PentAGI 完全没有的地址账本，让 ROP/FSOP 引用 base 公式而非硬编码绝对地址。
- `pwn/pwn-session.ts`：`PwnSession` 门面——在 `SessionRegistry` 上加 pwn 语义 `openLocal/openRemote/sendLine/send/recvUntil/shellProbe/readFlag`，自持累积 transcript 做 marker 匹配。`shellProbe` 发唯一 nonce 并要求 byte-exact 回显，EOF/exit 一律判失败。
- `verification/pwn-reproducer.ts`：`PwnReproducer` + `ExploitRecipe`。接受结构化 recipe（阶段 send/expect DAG），在新会话逐阶段执行，**shell_probe + flag_extract 双 barrier 同时成功才算复现**，flag 必须来自 live session（非脚本字面量）；成功落 `reproduction` 证据，失败落 `negative` 证据触发重规划。这是 PentAGI ReAct 循环缺的 CTF 版 Barrier Tool。

**P1 工具桥接层（已完成）**
- `pwn/pwn-tools.ts`：`PwnToolHandler`——模型可调用的桥接。按 durable session id 管理多个并存 `PwnSession`（模型可同时开 local binary + remote 连接），owner 固定为 lane 不取自模型；每次 send/recv 返回**有界 4KB viewport**（完整 transcript 留在 session/artifact 层），聊天型 tube 无法灌爆上下文；`reproduce` 是唯一能断言成功的路径（开新会话跑 PwnReproducer 双 barrier，local/remote 由 `target` 决定，对齐 local→remote 干净复现要求）。

**P1 待办（下一步，均需真实 lane/Docker 端到端验证）**：
- 把 `PwnToolHandler` 各方法适配成 `ProofBladeToolContract` schema（pwn_open/send/recv/signal/close/list/reproduce），接进 `PiCodingLane` 工具数组，并向 lane 注入 `SessionRegistry` + `ContainerRef`；
- `inspect_elf` / `gdb_batch` 等一次性能力（可走现有 `invoke_capability` 一次性模型，不必用会话）；
- 把 `LeakRecord` 接进证据图 reasoning 节点；
- `CompetitionOrchestrator` 用 Gate 串起 Handoff→Domain Solver→Reproducer→platform verdict（当前仍走 loop.ts 的 nudge）。
