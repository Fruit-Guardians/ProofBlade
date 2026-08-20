# ProofBlade 持久化交互能力设计（Pwn Tube / Web Session）

> 本文基于 ProofBlade 当前源码、deepseek-harness（dsh）与 PentAGI 两个参考项目的机制分析整理。
> 目标：为 Pwn/Web 补齐"持久化交互会话"这一核心缺口，并给出对 `docs/CTF_AGENT_ARCHITECTURE_PLAN_ZH.md` 现有规划的合理性评估。
> 结论先行放在第六节；若只想看"规划是否合理"，可直接跳到第六、七节。

## 零、一句话结论

- **Pwn 的持久 tube 会话应该照搬 dsh 的四层 PTY 架构**（原语 → 单会话状态机 → owner-scoped registry → sessionId 工具族），不要照搬 PentAGI（它是一次性 `docker exec`，交互能力反而是反面教材）。
- **Web 的持久 session 两个参考项目都没有可移植的成品**（PentAGI 是无状态 GET scraper，dsh 无 Web 栈），需要自研，但可以完全复用 Pwn 落地的 `Session / Artifact / Reproducer / Candidate` 抽象。
- 现有 `CTF_AGENT_ARCHITECTURE_PLAN_ZH.md` 的**方向正确、优先级合理**（Pwn 先行），但它**低估了一个前置阻塞项**：当前容器运行时是**一次性 exec**（`docker exec` 每命令独立，命令间不共享进程状态），且 `--read-only` 让 pwntools/gdb 的 HOME 缓存无处可写。会话层依赖容器层先补上"持久 exec 原语 + 可写 HOME/scratch"。这一项必须提到 P1 之前，记为 P0.5。
- **更正（相对本文早期草稿）**：容器层**已经**为 pwn/pwn-kernel 加了 `--cap-add SYS_PTRACE`（`docker.ts:171`），也**已经**用 `sleep infinity` 常驻（`docker.ts:175`），pwn 镜像的 pwntools/gdb/gdb-multiarch/one_gadget/qemu 也齐全。所以 P0.5 的真实缺口不是"cap 和保活"，而是"持久 exec 原语 + 只读 rootfs 下的可写缓存目录"。详见 `docs/P0_5_CONTAINER_DIFF_ZH.md`。

---

## 一、当前状态的精确诊断（带代码位置）

### 1.1 比赛执行路径：一次性 nudge，无领域闭环

`packages/materials/src/competition/loop.ts` 的 `runCompetitionLoop`：每个 provider turn 就是给 `PiCodingLane` 发一句 `turnPrompt`（turn 1 是题面，之后是 "Continue from where you left off"）。源码注释（loop.ts:60-62）明确写着比赛路径 **"Dropped: phase/planner choreography and verifier orchestration"**。

结果就是架构规划里描述的现象：控制平面记录了大量 Artifact，却没有把过程约束成"目标模型 → 假设 → 实验 → 复现 → 提交"的闭环。已有的护栏只有：
- `REPLAN_NUDGE_AFTER_TURNS = 12`（loop.ts:352）：12 turn 没提交就插一句硬重规划提示；
- `MAX_GUARD_REPLANS = 2`（loop.ts:353）+ `isRecoverableTurnGuard`（loop.ts:406）：experiment_budget / no_progress / repeated_tool_failure / tool_failure_storm 时阻塞旧 WorkItem 并新建重规划项。

这些都是"文本层 nudge"，不是"结构化 Gate"。

### 1.2 容器运行时：一次性 exec + 只读 rootfs 的缓存问题（**前置阻塞**）

`packages/materials/src/container/docker.ts`：

- `exec(ref, command, options)`（docker.ts:207）每次都是 `docker exec -i --workdir <cwd> ... <command>`，**命令之间不共享进程状态**。`ContainerCommandOptions.stdin` 只是"one-shot stdin for exploit scripts"（contracts.ts:55），不是持久 tube。**这是会话层的核心缺口。**
- 容器创建参数（docker.ts:170-171）：`--read-only`、`--tmpfs /tmp:...,noexec`、`--pids-limit`、`--security-opt no-new-privileges`、`--cap-drop ALL`，且**已经**对 pwn/pwn-kernel 追加 `--cap-add SYS_PTRACE`。容器用 `sleep infinity` 常驻（docker.ts:175）。

**已经具备的（相对早期草稿更正）**：SYS_PTRACE 有了（gdb/strace/ptrace 附加可用）、容器常驻有了、镜像工具链齐全。

**真实缺口**：
1. **持久 exec 原语缺失** —— tube 交互需要一个跨多次工具调用存活、可持续写 stdin / 读 stdout 的进程；当前 `exec` 一次性返回。
2. **`--read-only` 下 HOME 无处可写** —— pwntools/one_gadget/gdb 会往 `~/.cache`、`~/.local`、`~/.gdbinit` 写缓存/历史；rootfs 只读且未给 `/home/ctf` 挂可写卷，部分工具会报错或退化。
3. **`/tmp` 是 `noexec`** —— 若 exploit 需要在 scratch 目录里跑 patch 过的 binary 或临时编译产物会被拒；`/workspace` 可写可执行，但工具默认可能落到 `/tmp`。

`no-new-privileges` 对纯 remote pwn 可保留；仅当题目涉及本地 SUID 提权（boot2root 类，CTF pwn 少见）才需按 profile 去掉，列为后续可选项，不阻塞主线。

### 1.3 能力后端：无状态一次性执行，未注入容器

`packages/materials/src/capabilities/backend.ts`：

- 所有 backend 的 `prepareExecution(...)` 返回 `{ execute?: (signal) => Promise<RawEffectResult> }`（backend.ts:54），**一次性 async，返回即结束**，没有会话句柄。
- `CapabilityBackendContext`（backend.ts:41）只有 `runId / fixture / runsRoot / artifacts`，**没有 `ContainerRuntimePort` / `JobRunner`**。架构规划第五节第 2 点正确指出了这一点。

### 1.4 已有的可复用基础（好消息）

- **`BackgroundJobRunner` + `JobRecord`**（jobs/background-runner.ts、domain/types.ts:319）：已有 `QUEUED/RUNNING/SUCCEEDED/...` 状态、`externalId`、`generation`、可取消可恢复。**持久会话本质上就是一种"长生命周期 Job"，可以在此之上建模，而不是另起炉灶。**
- **`WorkItem` 状态机 + Lease**（domain/types.ts:241，PLAN-220 刚落地）：已有 claim / block / lease 过期回收，可直接承载 tube 会话的所有权与恢复。
- **`EffectJournal / ArtifactStore / EvidenceGraph / Generation-Lease / RunRecoveryService`**：事件溯源 + 恢复语义已完备，是两个参考项目都不具备的优势（PentAGI 是进程内 worker map + DB 只恢复不选主）。

---

## 二、两个参考项目给我们的净结论

| 维度 | PentAGI | deepseek-harness | ProofBlade 取舍 |
| --- | --- | --- | --- |
| 持久终端交互 | ❌ 一次性 `docker exec`，detach 丢句柄 | ✅ 四层 PTY，就绪判定成熟 | **抄 dsh** |
| 会话所有权/清理 | 容器级持久，无会话对象 | ✅ owner-scoped registry + effect 自动清理 | **抄 dsh** |
| 就绪判定（程序是否在等输入） | ❌ 无 | ✅ OSC prompt 标记 + 前台组 inputWaiting + 静默超时三级证据 | **抄 dsh**（Pwn 刚需） |
| 容器生命周期/能力集 | ✅ `tail -f /dev/null` 保活 + cap 白名单(含 SYS_PTRACE) + PidsLimit | 无容器（本机 PTY） | **抄 PentAGI 的 cap 取舍** |
| 工具护栏（迭代上限/重复检测/收尾窗口/fixer） | ✅ 成熟全家桶 | ⚠️ 结构性护栏，无重复检测硬上限 | **抄 PentAGI** |
| 动态重规划 | ✅ Refiner delta-patch（add/remove/modify/reorder by id） | 子 agent handoff | **抄 PentAGI 的 delta-patch** |
| Web 持久 session/浏览器 | ❌ 无状态 GET scraper | ❌ 无 Web 栈 | **自研，复用 Pwn 抽象** |

关键洞察：**"持久化交互"这件事，dsh 已经做到了生产级，PentAGI 没做到。** 所以 Pwn tube 的技术风险其实不高——有一份可逐行参考的实现。真正需要自研的是 Web 浏览器/HTTP session，以及把这套东西接进 ProofBlade 的事件溯源 + 证据图。

---

## 三、核心抽象：持久交互会话（Session）

把 Pwn tube 和 Web session 统一成一个领域一等实体，落在 Control Store 事件流里。这是整个设计的地基。

### 3.1 分层（对齐 dsh 四层）

```
InteractionTool（模型可见）     pwn_open/send/recv/... , http_session_open/request/...
        ↓  返回 sessionId，后续调用带 sessionId
SessionRegistry（owner-scoped） 铸 id、授权校验、生命周期、effect 自动清理
        ↓  SessionBackend（可插拔 type）
  ┌─────────────┬──────────────┬────────────────┐
LocalPty      RemoteTube      HttpSession       BrowserContext
(容器内 pty)  (pwntools tube) (cookie jar)      (Playwright persistent ctx)
        ↓
每次 send/recv/request 作为 Effect + Artifact + Evidence 落库
```

### 3.2 领域类型（建议加到 `packages/materials/src/domain/types.ts`）

```ts
export type SessionKind = "pwn-local" | "pwn-remote" | "http" | "browser";
export type SessionStatus = "OPEN" | "CLOSED" | "EXITED" | "ERROR";

export interface SessionRecord {
  id: string;                 // registry 铸造，如 "SES-..."
  runId: string;
  kind: SessionKind;
  ownerLane: Lane;
  generation: number;         // 与 Generation/Lease 对齐，旧代次会话不可复用
  status: SessionStatus;
  endpoint?: string;          // remote: host:port; http: baseUrl; browser: 起始 URL
  externalId?: string;        // 复用 JobRecord.externalId：容器内 broker 的 pid/句柄 id
  scrollbackArtifactId?: string; // 完整 transcript 落 Artifact，模型只看有界摘要
  stateHash?: string;         // cookie/storage/session 状态哈希，用于复现比对
  lastWaitReason?: "stdin_read" | "inferred_idle" | "timeout" | "session_exit";
  createdSeq: number;
  updatedSeq: number;
}
```

配套事件（进 reducer，与现有 work_item_* 同构）：
`session_opened / session_sent / session_received / session_signaled / session_closed / session_exited / session_superseded`。

### 3.3 关键设计决策

1. **会话 = 长生命周期 Job。** 复用 `JobRecord.externalId` 存"容器内 broker 进程标识"，复用 `BackgroundJobRunner` 的取消/恢复。不引入第二套生命周期真相。
2. **owner 身份不靠模型传。** 照抄 dsh：从 `exec.agent` / 当前 Lane 取 owner，模型只传 `sessionId` 字符串。跨 owner 访问返回稳定错误码 `FOREIGN_SESSION`。
3. **原始 I/O 只进 Artifact，模型只看有界摘要。** 每次 send/recv 的完整字节写 Artifact（`scrollbackArtifactId` 追加），模型上下文只放 viewport（最近 N 行）+ Artifact id + `waitReason`。这既是 ProofBlade 既有原则，也天然形成"协议 transcript 账本"。
4. **就绪判定诚实标注证据强度。** 照抄 dsh 的四种 `waitReason`，并在返回里明确 `inferred_idle/timeout` **不证明命令已退出**——这对 Pwn 判"程序是否卡在 read()"至关重要。
5. **恢复即代次隔离。** Run 恢复时，`generation` 不匹配的会话直接标 `SUPERSEDED`，不尝试复活裸 socket（远程连接无法可靠恢复），而是让 Reproducer 用新连接重放。

---

## 四、Pwn Solver 落地（P1，建议第一个纵向切片）

### 4.1 前置：容器层改造（P0.5，必须先做，见 1.2）

具体 diff 见独立文档 `docs/P0_5_CONTAINER_DIFF_ZH.md`。要点：
- 保留已有的 `--cap-add SYS_PTRACE` 和 `sleep infinity`；
- 按 profile 给 pwn/pwn-kernel 挂**可写可执行的 HOME 与 scratch**（tmpfs `/home/ctf` + `/opt/pwn`），解决只读 rootfs 下 pwntools/gdb 缓存无处写；
- 在 `ContainerRuntimePort` 上新增**持久会话原语**（openSession/write/read/signal/close），`DockerContainerRuntime` 用一个存活的 `docker exec -i` 子进程实现，句柄跨工具调用保留。

> 这一步是整份规划里**被现有文档低估的前置阻塞**。不先做，后面 pwn_send/recv / gdb 交互全部无法持久。

### 4.2 会话 backend

- `PwnLocalPtyBackend`：在容器内 `docker exec -it` 起 pty（node 侧用 `docker exec` + stdin/stdout pipe，或容器内跑一个小 broker 暴露 unix socket）。就绪判定照抄 dsh `session.ts` 的 `pollReadiness`：OSC `133;D` prompt 标记 + 前台组 `inputWaiting` + 静默超时。
- `PwnRemoteTubeBackend`：容器内用 pwntools `remote()` 建 tube，broker 把 `send/recv/recvuntil/recvline` 暴露成结构化命令。**同一 Exploit Recipe 通过切换 backend type 实现 local→remote**（架构规划 4.2 第 6 点的核心诉求，dsh 的可插拔 backend 天然支持）。

### 4.3 模型可见工具（范式 A：显式 sessionId）

| 工具 | 作用 | 返回 |
| --- | --- | --- |
| `pwn_open` | 按 type(local/remote) + target 建会话 | `{sessionId, kind, pid?, endpoint?, motd}` |
| `pwn_send` | 写字节/行，等就绪 | `{viewport, waitReason, status, artifactId}` |
| `pwn_recv` | 按 until/size/timeout 读 | `{bytes 摘要, matched, artifactId}` |
| `pwn_signal` | 给前台组发信号（SIGINT 等） | `{delivered}` |
| `pwn_close` | 关会话并等进程树消失 | `{outcome}` |
| `pwn_list` | 列当前 Lane 拥有的会话 | `snapshot[]` |
| `gdb_batch` | 无交互断点 + 寄存器/内存断言 | `{transcript artifactId, assertions[]}` |
| `inspect_elf` | file/arch/checksec/symbols | `{BinaryProfile, artifactId}` |

`recv` 出来的泄漏字节，由模型或规则解析成 `LeakRecord`（来源字节范围、地址类型、基址公式、置信度）写进证据图——这是 PentAGI 完全没有、必须自研的部分。

### 4.4 PwnReproducer（独立验证器，Barrier）

接受结构化 Exploit Recipe（阶段 DAG：sync→setup→trigger→leak→derive→overwrite→control→shell_probe→read_flag），**不接受自然语言"应该成功"**：新建连接 → 逐阶段校验 Marker/Leak/地址公式 → 发唯一 `PB_READY_<nonce>` 并读精确回显 → 读 flag。**只有 shell_marker + flag_extraction 同时成功才产出 Candidate。** EOF/RST/SIGSEGV/进程退出只能作为失败 Evidence。

这正是 PentAGI ReAct 循环最缺的"Barrier Tool"：模型能提 Recipe，不能自称拿到 shell。

---

## 五、Web Solver 落地（P2，复用 Pwn 抽象）

Web 两个参考项目都没成品，但落完 Pwn 后，`Session / Artifact / Reproducer / Candidate` 已经抽象好，Web 只是换底层 backend：

- `HttpSessionBackend`：持久 cookie jar + CSRF token 复用 + 连接复用。`http_session_open → sessionId`，`http_request(sessionId, ...)` 每次落标准化请求/响应 Artifact。
- `BrowserContextBackend`：Playwright persistent context（`storageState`），处理 JS/admin-bot/DOM/上传；`browser_navigate/click/type/evaluate` + `network_list/get`（HAR）。`browser_evaluate` 默认禁跨域网络/FS/Node API，需回连显式申请 scope change。
- `WebReproducer`：接受结构化 `ExploitChain`（步骤/请求模板/变量来源/断言/flag 提取表达式），在干净 Session/Profile 重放，flag 必须来自本轮响应而非脚本字面量。平台拒绝 → `platform_rejection` Evidence → 自动回 hypothesis，不让模型盲改 flag。

Cookie/CSRF 在同一 Run 内可复用、跨 Run 不可见——靠 `SessionRecord.generation` + owner 隔离天然实现。

---

## 六、对现有 `CTF_AGENT_ARCHITECTURE_PLAN_ZH.md` 的合理性评估

### 6.1 判断正确、应保留的部分

1. **"不要照搬 PentAGI 多 Agent"** — 完全正确。研究证实 PentAGI 的 13 角色是同进程递归逻辑角色，且它的交互层反而更弱。
2. **"Pwn 先行"的优先级** — 正确。Pwn 的 tube 是所有会话抽象的最小闭环，Web 可复用。且 dsh 有现成蓝本，风险最低。
3. **"submit 走 candidate → independent verifier → platform"** — 正确，且当前 `accepted()`（loop.ts:334）已经要求 `fixture_score` effect，方向一致。
4. **"领域无关 ExperimentRecord + repeatKey"** — 正确，且应吸收 PentAGI 的重复检测细节：**比较前先剔除给 UI 看的解说字段**（PentAGI `clearCallArguments`），只按归一化领域参数算 repeatKey，否则会误判。
5. **"保留 Control Store / Effect / Evidence / Recovery / Docker / CompetitionApi"** — 正确，这些正是相对两个参考项目的核心优势。

### 6.2 需要修正或补强的部分

| 现有规划 | 问题 | 建议修正 |
| --- | --- | --- |
| P1 直接做 `ctf.pwn` 的 process/gdb 能力 | **漏了容器层前置阻塞**：当前 `--read-only` + 无 `SYS_PTRACE`，gdb/tube 起不来 | 新增 **P0.5 容器改造**：按 profile 加 `SYS_PTRACE`、放开可写目录、常驻 broker 入口 |
| 能力仍走 `execute: (signal)=>Promise` 一次性模型 | 持久会话无法用一次性 execute 表达 | 明确会话 = 长生命周期 Job，复用 `BackgroundJobRunner`/`JobRecord.externalId`，`CapabilityBackendContext` 注入 `ContainerRuntimePort` + `JobRunner` |
| 会话就绪判定未展开 | "程序是否在等输入"是 Pwn 交互的核心难点，规划没提 | 明确照抄 dsh `pollReadiness`：OSC 标记 + 前台组 inputWaiting + 静默超时，四种 waitReason 并诚实标注强度 |
| Refiner 重规划只说"生成替代假设+禁止列表" | 没定义数据结构，容易做成全量重写 | 照抄 PentAGI **delta-patch**（add/remove/modify/reorder by id + afterId），天然是事件，对证据图友好 |
| 护栏只说"重复由领域归一化决定" | 缺"接近迭代上限强制收尾""state 类错误不进 fixer 重试" | 补 PentAGI 的收尾窗口（倒数 N 轮注入收尾指令）+ 双阈值软/硬中止 |
| Gate 用现有 Phase 兼容 | 现有比赛 Run 全停在 `intake`（规划自己也观察到） | 快照必须持久化 `domainPhase`，且 Gate 是**确定性检查持久事实**，不是模型文本声称 |

### 6.3 规划里"暂缓/降级"的判断

- **P3 Planner/Executor 双模型**：规划说"以评测为准"——正确，应保持 `blocked`，别在会话闭环跑通前投入。
- **P4 无人值守 Fleet / kernel / Web3**：正确地放在最后。
- **浏览器逆向/JSVMP 等**：正确地不阻塞基础 Web/Pwn。

---

## 七、修正后的交付顺序

```
P0（观测→收敛，规划已有，保留）
  持久化 domainPhase；ExperimentRecord + repeatKey；每 turn 先查 Gate；
  submit 统一走 candidate→verifier→platform；记录收敛指标。

P0.5（新增，前置阻塞，必须先做）★
  容器按 profile 改造：SYS_PTRACE、可写目录、常驻 broker 入口；
  ContainerRuntimePort 注入能力后端；会话 = 长生命周期 Job 的建模。

P1（Pwn 纵向切片，照抄 dsh 四层 + PentAGI cap 取舍）
  SessionRegistry + PwnLocalPty/RemoteTube backend + pollReadiness 就绪判定；
  pwn_open/send/recv/signal/close/list + gdb_batch + inspect_elf；
  LeakRecord 证据图；PwnReproducer（shell_probe + flag_extract 双 barrier）；
  回归题：ret2win / format string leak / ret2libc-PIE / menu heap-UAF，各 ×3。

P2（Web，复用 P1 抽象，自研 backend）
  HttpSessionBackend + BrowserContextBackend(Playwright storageState)；
  http_session_* / browser_* / network(HAR)；WebReproducer + 干净复现；
  回归题：SQLi / SSRF / upload-穿越 / XSS-adminbot。

P3（评测门槛后才做）Planner/Refiner delta-patch 双 Lane。
P4  Fleet 恢复 / kernel QEMU / 高级题型。
```

**最小可跑通切片**（与规划一致，仅前置容器改造）：
```
[P0.5 容器 SYS_PTRACE + 可写 + broker]
  → inspect_elf → pwn_open(remote) → pwn_send/recv(协议 transcript)
  → exploit_recipe → gdb_batch(local 验证) → shell_probe → flag_extract
  → PwnReproducer(新连接复现) → submit_flag
```

---

## 八、给"另一个 agent"的具体接入点清单

按依赖顺序，每项都指向确定的文件：

1. `packages/materials/src/container/docker.ts:170` — 按 profile 分叉 cap/只读/保活参数（P0.5）。
2. `packages/materials/src/container/contracts.ts` — `ContainerRuntimePort` 增加持久会话方法（openSession/write/read/signal/closeSession），或新增 `SessionRuntimePort`。
3. `packages/materials/src/domain/types.ts` — 增 `SessionRecord`、`SessionKind/Status`、`LeakRecord`、`CandidateRecipe` 及 `session_*` 事件类型。
4. `packages/materials/src/control/reducer.ts` — `session_*` 事件的状态推进（对齐现有 `work_item_*` 写法）。
5. `packages/materials/src/capabilities/backend.ts:41` — `CapabilityBackendContext` 注入 `ContainerRuntimePort` + `JobRunner`；新增 `ctf.pwn` backend。
6. `packages/materials/src/jobs/background-runner.ts` — 会话作为长生命周期 Job 的取消/恢复复用点。
7. `packages/materials/src/verification/` — 新增 `PwnReproducer`、`WebReproducer`、统一 `CandidateVerifier`。
8. `packages/materials/src/competition/loop.ts:64` — 从"每 turn nudge"升级为读 Gate → Handoff → Domain Solver → Reproducer → verdict 的 Orchestrator；通用 Coding Lane 降为 fallback。

参考实现（逐行可抄）：
- 就绪状态机：`D:\project\deepseekharness\deepseek-harness\packages\terminal\terminal-bash\src\session.ts`（`pollReadiness`）
- owner-scoped registry：`...\packages\terminal\terminal\src\index.ts`
- sessionId 工具族：`...\packages\terminal\tool-terminal\src\index.ts`
- 容器 cap 取舍：`D:\project\ai\pentagi\backend\pkg\tools\tools.go:509-537`
- 护栏全家桶：`D:\project\ai\pentagi\backend\pkg\providers\performer.go` + `helpers.go`
- delta-patch 重规划：`D:\project\ai\pentagi\backend\pkg\tools\args.go:65-91` + `subtask_patch.go`
```
