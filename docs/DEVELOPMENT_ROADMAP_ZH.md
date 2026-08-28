# ProofBlade 开发计划交接文档

> 面向接手后续开发的人。目标：看完就知道**现在在哪、已经做了什么、接下来按什么顺序做、每步的接入点和验收标准**。
> 最后更新：2026-08-27。配套阅读：`docs/HANDOFF.md`（项目总览与踩坑）、`docs/CTF_AGENT_ARCHITECTURE_PLAN_ZH.md`（Web/Pwn 架构方向）、`docs/SESSION_INTERACTION_DESIGN_ZH.md`（持久会话设计）、`docs/P0_5_CONTAINER_DIFF_ZH.md`（容器+会话落地记录）。

> **当前工作树审计覆盖（2026-08-27）**：统一 coding lane、RunCoordinator/verifier-first 终态、Browser 可选 Playwright smoke、Pwn 四类阶段契约矩阵、DASCTF 只读 `npm run platform:selfcheck`、verifier recovery 和外部资源 registry 第一阶段已落地。新增 Pwn/HTTP Durable Session Runtime Service 后，定向 session wire/service、typecheck/build、API index、组件/变更契约和 CI gates 均通过；本轮修复 Windows 同路径并发原子替换的 `EPERM` 时序 flake，并补充 64 路原子写回归；`atomicWriteFile` 现对短暂 `EPERM/EBUSY/EACCES` 做有界退避；随后 staged 三阶段分别执行全绿（fast 700/700、slow 22/22、integration 86/86，共 808/808）；本轮新增 `EXTERNAL_CONFIRMED` 协调器状态并通过受影响恢复回归，同时落地加密、可重启接管的参考 `DurableHttpSessionRuntimeHost`、Pwn supervisor、detached-worker 重启接管、Docker fault matrix、Browser smoke 可归档报告以及 CI staged 日志归档 contract；Session Runtime/Browser Runtime 服务新增 `--require-ready` 启动闸门，非稳定 Host 不会绑定服务端口，Browser wire 还新增 owner commit 后幂等持久化 `bindingTxnId` 的 `/v1/browser/bind`，CLI/GUI/Competition 现在会把配置 Broker 的 Browser 缺失情况作为 required 传入唯一 Coding Lane；新增 Browser Runtime service 启动/鉴权/required-readiness 契约回归 6/6，并将平台环境幂等 key 固定为 `ownerId + challengeId`、同一 Run/challenge 的重复 reservation fail-closed。当前 CI gates 36/36、offline eval 30/30；`npm run test:platform-fault-matrix` 已纳入 verify；本轮修正 local holdout 两个本地 variant 的身份建模与 Windows 慢 worker 截止后，本轮 canonical `npm run verify` 已全链路通过（component/change-contract、API index、CI gates 36/36、platform fault 6/6、staged 808/808、offline eval 30/30、`npm audit --omit=dev` 0 vulnerabilities）。真实 Provider 评测、远程 tube 和 Docker Pwn/Browser smoke 仍按本文边界作为显式外部动作，不作为常规 CI 前置。

---

## 0. 一句话现状

统一部署预检新增 4 条脚本契约后，CI gates 当前为 40/40；此前段落中的 36/36 保留为上一阶段历史基线。

本轮 Competition runtime preflight 改动后的最新分层回归为 fast 700/700、slow 22/22、integration 86/86（808/808）；此前 Browser handoff 阶段的 698/698、22/22、86/86（806/806）为上一阶段基线，697/697、22/22、86/86（805/805）、696/696、22/22、86/86（804/804）和 695/695、22/22、86/86（803/803）是更早基线。统一部署预检契约加入后，当前 CI gates 为 40/40；本轮 canonical `npm run verify` 已全链路通过（staged 808/808、offline eval 30/30、`npm audit --omit=dev` 0 vulnerabilities）；审计段落中的 30/30 和 80/80（794/794）是更早的历史基线。

本轮部署一致性补齐：Browser Runtime 服务与 Session Runtime 使用相同的
`--require-ready`/环境变量启动门禁；诊断模式输出真实 `ready|degraded`，发布模式在
监听端口前拒绝非 `READY` 或 `stableAcrossRestart=false` 的 Host。这样 Browser、HTTP session、Pwn session 的外部能力
不会因为服务进程成功启动而被误报为可恢复。

比赛是 **DASCTF（gcsis.dasctf.com）** competition 模式：连 API 取题 → 起 Docker 容器 → 自动解 → 提交 flag。**不是** GUI 人工对话（那只是调试入口）。DASCTF 的 pwn 靶机是**裸 TCP `nc host port`**（实测：`REMOTE:nc 1.14.76.59:23984`），不是 WebSocket。

持久 pwn tube（P0.5+P1）已建好并接进 competition 的 coding lane；平台链接 API、P0 收敛和 Fleet → Run Actor → Observer → Verifier 离线组合回放也已接入。Web 探索现在有 lane-owned 的 `web_session_open/request/close`，验证器使用独立 clean session，并在 lane 关闭或 generation 变化时失效旧会话。当前下一阶段不是增加第二条解题 lane，而是完成真实 backend reconcile、孤儿会话回收、统一 verifier outcome 和故障注入发布门禁；P3 Planner/Refiner 仍须等真实 Provider 评测有稳定收益后再考虑。本项目不把真实 DASCTF、远程 tube 或 pwn E2E 作为自动验收前提。

---

## 1. 已完成（PR #67，分支 `feat/pwn-web-persistent-sessions`）

> ⚠️ **PR 当前状态 CONFLICTING**：需要 rebase 到最新 main 才能合并。合并前先 `git rebase origin/main`，重点看 `control-store.ts`/`reducer.ts`/`domain/types.ts` 三个文件（本分支和 main 都动过），冲突解决后重跑 `npm run verify`。

| 层 | 内容 | 关键文件 |
|---|---|---|
| **P0.5 容器** | per-profile tmpfs（pwn 得可写可执行 HOME/scratch）；持久 `docker exec -i` 会话原语（open/write/read/signal/close）；signal 精确到 setsid 进程组 | `container/docker.ts`、`container/contracts.ts`、`containers/pwn/Dockerfile` |
| **P1 会话地基** | `SessionRecord` 领域类型 + `session_*` 事件 + reducer；owner-scoped `SessionRegistry`（可重放、supersede-on-recovery、rollback、disposeAll） | `domain/types.ts`、`control/reducer.ts`、`control/control-store.ts`、`container/session-registry.ts` |
| **P1 pwn 逻辑层** | `LeakRecord` + 地址解析；`PwnSession`（recvUntil/shellProbe/readFlag）；`PwnReproducer`（shell-probe+flag 双 barrier）；共享 `pwn/bytes.ts`、`pwn/pattern.ts`（ReDoS 防护） | `pwn/*.ts`、`verification/pwn-reproducer.ts` |
| **P1 工具接线** | `PwnToolHandler` + 7 个模型可见工具（pwn_open/send/recv/signal/close/list/reproduce）；接进 `PiCodingLane`（仅 pwn 容器激活）；base64 二进制 payload；endpoint scope 校验；lane 关闭 disposeAll | `pwn/pwn-tools.ts`、`runtime/pwn-coding-tools.ts`、`runtime/coding-lane.ts` |
| **CH-10662 超时治理** | pwn prompt 不再诱导"同步塞前台 bash"；按 tube 可用性分支引导；交互 bash 超时给针对性提示（用 tube/shell_background） | `runtime/coding-lane.ts`、`runtime/coding-resources.ts` |

测试：`npm run verify` 409 测试全绿、0 漏洞。

**验证边界**：本项目不执行真实 DASCTF 登录、远程 tube 或 pwn 端到端；competition 路径的 pwn_* 覆盖使用可注入 fake。平台接入本身由 API contract tests 验证，真实连通性只能作为用户明确授权后的独立运维动作。

---

## 2. 诊断得到的核心教训（务必先读，避免重走弯路）

1. **CH-10662 反复 14 次 0 解出的根因**：模型把完整交互式 exploit 当**一条前台 bash** 跑，`recvuntil/interactive` 阻塞 → 撞满 180s → 断路器 → 重写整个脚本 → 再超时。~45min/run 全耗在超时等待，从没产出可提交 candidate。**这正是持久 tube 要解决的问题。**
2. **GUI 普通对话 ≠ 比赛路径**：GUI「新对话」走 host `NodeExecutionEnv`，不起容器，pwn_* 不激活——这是**设计如此**，不是 bug。比赛只走 competition。
3. **DASCTF pwn = 裸 TCP nc**：不用做 WebSocket tube。（那些 `wss://ctf.xidian.edu.cn` 是另一场 moectf 的 GUI 测试，与 DASCTF 无关。）
4. **审核三轮共 15 个问题**：kill -1 误伤、256KiB 增量读死、flagPath 注入、过期 work item 饿死、同 generation 孤儿、二进制 payload、endpoint 越界、ReDoS、lane 清理……说明**会话/进程/正则/边界这类"外部不可信输入 + 长生命周期"的地方最容易出坑**，新代码在这些点要格外小心。
5. **trust but verify**：有一次我以为改了 #2/#4 其实没落地，靠 `grep -c` 才发现。**推进前先核实文件真实状态。**

---

## 3. 后续开发计划（按建议优先级）

> 优先级理由：P1 收尾和 P0 直接决定"比赛时 pwn 题能不能真解出来"，比 P3（用评测证明策略层是否值得增加模型调用）更紧迫。P3 是"锦上添花且需评测背书"，放在收敛闭环跑通之后。

### P1 收尾（最高优先，收敛能力闭环）

**P1.1 — 平台链接 API 契约与配置装配（不做真实 E2E）**
- 目标：保持 `CompetitionApi` 五个操作稳定，DASCTF 适配器覆盖 `/slab-match/api/v1/agent` 的 envelope、`X-Agent-AccessKey`、附件、环境轮询、错旗 allowlist、限流/重试；GUI 从 `competition.json`/环境变量正确选择适配器。
- 验收：fake `fetch` 契约测试覆盖成功、鉴权/业务错误、附件大小与 URL、环境 build/poll/recover、错误 flag、429/503；配置缺失时 fail-closed，不把演示成功当真实得分。
- 接入点：`packages/materials/src/competition/api.ts`、`dasctf-api.ts`、`apps/gui/src/competition-settings.ts` 及对应 tests。禁止把真实凭据或远程 tube 放进 CI。

**P1.2 — inspect_elf / gdb_batch 一次性能力**
- 走现有 `invoke_capability` 一次性模型即可（不必用会话）。inspect_elf = file/arch/checksec/symbols 结构化输出；gdb_batch = 无交互断点 + 寄存器/内存断言。
- 接入点：`capabilities/catalog.ts`（加 manifest）、`capabilities/backend.ts`（加 backend，注入 ContainerRuntimePort 执行）。
- 验收：模型能一次调用拿到结构化 checksec/符号，而不是 hand-parse bash 输出。

**P1.3 — LeakRecord 接进证据图**
- 现在 `pwn/leak.ts` 的 `LeakRecord` 是纯数据结构，没进 reasoning 图。把泄漏地址/gadget/偏移作为 reasoning 节点，让重规划能引用"已确认的 base 公式"。
- 接入点：`knowledge/evidence-graph.ts`、`domain/types.ts` 的 ReasoningNode。
- 验收：一次 leak 后，证据图里有对应节点，后续 handoff/replan 能引用它。

### P0（可观测→可收敛，治本次 run 暴露的系统性问题）

**P0.1 — 比赛 Run 持久化 domainPhase**
- 现状：competition run 全停在 `intake`（CH-10662 实证：622 事件 phase 从没推进）。架构规划第二节要求快照存 `domainPhase`（INTAKE→RECON→TARGET_MODEL→HYPOTHESIS→EXPERIMENT→REPRODUCE→REPORT→SUBMIT）。
- 接入点：`domain/types.ts`（加 domainPhase）、`competition/loop.ts`、reducer。
- 验收：live run 的阶段在事件与 projection 一致，不再全是 intake。

**P0.2 — 每 turn 先查 Gate 再给动作 + ExperimentRecord**
- 把每次 bash/capability 绑定到 hypothesis + repeatKey（`sha256(domain+generation+action+canonical(input))`）；同一失败动作第三次机械拒绝。重复检测要**剔除给 UI 看的解说字段**再比对（借鉴 pentagi `clearCallArguments`）。
- 接入点：`competition/loop.ts`（turn 循环）、`domain/types.ts`（ExperimentRecord）。
- 验收：同一失败动作第三次出现被拒；重启后能恢复当前阶段和下一动作。

**P0.3 — 长计算/交互引导走后台（补 CH-10662 治理的运行时侧）**
- prompt 治理已做（不诱导前台 bash），但可再加运行时护栏：检测到模型仍把长交互塞前台 bash 时，更强地 nudge 到 tube/shell_background。
- 接入点：`runtime/coding-resources.ts`（已有 `interactiveTimeoutHint`，可扩展到"启动即检测"而非"超时后才提示"）。

### P2（Web，复用 P1 抽象）

- ✅ `HttpSessionBackend`（cookie jar + CSRF 复用 + host/port scope + 脱敏 exchange Artifact/自动 Observation）；coding lane 通过 `web_session_open/request/close` 提供受 scope 约束的探索会话，并在 lane shutdown 时回收。`BrowserContextBackend`（Playwright-compatible persistent context/storageState + scope + response/state Artifact）；`WebReproducer`（干净 session 重放 ExploitChain，flag 必来自本轮响应且不能是请求字面量）。
- DASCTF web 靶机形式：`REMOTE:http 1.14.76.59:port (proxy of :80)`（实测），HTTP 代理，不是裸 TCP。
- 复用 P1 的 `SessionRegistry`/`SessionRecord`/`session_*` 事件/Reproducer 抽象，只换底层 backend 为 HTTP/Playwright；跨进程 Browser 通过版本化 lifecycle/action wire，禁止把 Playwright 对象或 storage 值当作恢复句柄。
- 接入点：`container/`（新 backend）、`domain/types.ts`（SessionKind 已含 "http"/"browser"）、新 `web/` 目录。
- 验收（离线已通过）：Cookie/CSRF 同 Run 内可复用、跨 Run 不可见；每条链有结构化 exchange/HAR-like Artifact 与 Observation；复用旧 session、跨 generation、越界 host/port 和反射 flag 都会被拒绝；干净重放产出 candidate/evidence。真实 DASCTF/Web 连接不属于自动验收范围。

### P3（单 coding lane 上的 Planner/Refiner 策略层，以评测为准）

- Planner 只输出结构化 Handoff（不直接操作目标）；唯一的 coding lane/executor 只接受当前 knowledgeVersion 的 Handoff；失败由 Refiner 生成替代假设 + 禁止重复列表。
- **强烈建议移植 pentagi 的 delta-patch 重规划**（add/remove/modify/reorder by id + afterId，见 `backend/pkg/tools/args.go:65-91`），而不是全量重写——天然是事件，对证据图友好。
- **门槛**：用 20+ 道 Web/Pwn holdout 对比当前单 coding lane，只有成功率/成本/p95 至少一项**稳定改善**才允许启用可选的 Planner 模型；没有评测背书不增加模型调用。
- 接入点：`orchestration/planner.ts`、`orchestration/refiner.ts`、`domain/handoff.ts`；不新增第二条解题 lane。
- 现状：PLAN-210 在 project-status.json 里是 `blocked`，依赖 P0/P1/P2 完成。

### P4（无人值守 Fleet / 高级题型）

- ✅ `CompetitionEnvironmentJanitor` 已接入 live GUI backend：启动前容量 reservation、`instanceId`/`expiresAt` 持久账本、重启后的过期 sweep、失败清理保留与重试。
- 容器/PTY 恢复 + stale reaper；更严格 egress scope-change 审批；pwn-kernel 独立 QEMU profile；Web3/JSVMP 等作为后续，不阻塞基础 Web/Pwn。

---

运行时补充：新增只读 `runtime:selfcheck`，在启动前统一检查 Browser、HTTP-session、Pwn-session broker 的 health、能力和 `stableAcrossRestart`；配置不完整时以退出码 2 fail-closed，不创建外部资源。Competition solver 在平台环境返回后、创建 Coding lane 前按题目 `target_kind` 做方向性 preflight，并把同一结果传入 lane；动态 flag 快速路径不触碰 session runtime，普通运行预检失败会先释放已申请 reservation；显式注入的测试 Browser factory 仍保留。对于同一 session broker 同时承载两类会话，可使用 `scripts/session-runtime-combined-host.ts`，按不可变 `request.kind` 分派；任一底层 host 不稳定时共享端点整体保持非 READY。部署级证据可通过 `npm run deployment:preflight` 一次汇总 runtime、Browser smoke、Pwn Docker smoke 和 Pwn fault matrix；普通模式对缺少外部依赖明确报告 `SKIPPED`，`deployment:preflight:required` 才将其变为发布阻断。

## 4. 评测指标（P0 起就该记，别只看"是否提交正确 flag"）

`solve_rate`（平台接受率）、`verified_rate`（独立复现成功率）、`first_evidence_ms`/`first_primitive_ms`/`first_candidate_ms`、`tool_calls`/`experiment_count`/`repeat_block_count`、`wrong_submission_count`/`duplicate_submission_count`；pwn 另记：协议同步失败率、Leak 解析成功率、Shell Marker 成功率、local→remote 漂移率、**前台 bash 超时次数**（直接反映 CH-10662 类问题是否复发）。

---

## 5. 工作流约定（沿用本轮）

- 分支：`feat/*`；推自己的 fork（`weixiao33661/ProofBlade`）；从 fork 开 PR 到 `Fruit-Guardians/ProofBlade:main`（无组织写权限）。
- 每次改动后 `npm run build` → 相关测试 → 合并前 `npm run verify`（含 change-contracts 门禁；`docker.ts`/`coding-lane.ts` 等是高风险文件，改动需带故障路径测试）。
- **审核修复推同一 PR 分支**（不新开 PR），并在 PR 上逐条回应 + 指向 commit。
- `docker.ts`/`session-registry.ts`/`pwn/*` 这类"长生命周期 + 外部不可信输入"的地方，任何新增都要问：越界？超时？注入？孤儿？（三轮审核的 15 个问题全集中在这里。）
- 参考实现：`D:\project\deepseekharness\deepseek-harness`（持久 PTY 会话四层架构）、`D:\project\ai\pentagi`（容器生命周期、护栏、delta-patch 重规划）。
- `npm test` 在 Windows 并行下偶发 EBUSY/时序 flake（background-jobs / reasoning-forest），隔离重跑即通过，不是回归。

---

## 6. 最小上手路径

```
1. git rebase origin/main   # 解决 PR #67 的 CONFLICTING（control-store/reducer/domain 三处）
2. npm run verify           # 409 绿才算基线正常
3. 读 CTF_AGENT_ARCHITECTURE_PLAN_ZH.md + SESSION_INTERACTION_DESIGN_ZH.md
4. 做 P1.1（API contract/config wiring，离线完成）
5. 按 P1 收尾 → P0 → P2 → P3 顺序推进；真实平台连通性不作为自动验收前提
```

## 7. P0/P1/P2 执行结果（2026-08-22）

本轮按“每个改动必须有测试、类型检查和构建”的约束完成了 P0、P1、P2：

- **P0 工程化恢复**：`check:changed-tests` 根据 `.github/test-matrix.json` 自动把源码变更映射到测试；`CompetitionEnvironmentJanitor` 升级为 schema v2，支持跨进程锁、启动前 reservation、原子账本写入、schema v1 迁移、过期 reservation sweep 和重启恢复。
- **P1 运行边界**：新增持久化 `ApprovalPolicy`（submit/start/network/session 默认 fail-closed），Solver 的动态 flag 和正常提交路径在未批准时只产生 pending approval；新增 `ProofBladeAppServer`，提供 `run/read`、事件分页/订阅、审批查询和批准接口，不暴露 ControlStore 写原语；GUI 增加 `/api/v2` 只读/审批边界。
- **P2 本地评测**：新增 hash-bound `fixtures/holdout/`（Web 12 + Pwn 12，并加入 Reverse/Crypto/Forensics 冒烟题）和 `LocalHoldoutEvaluationRunner`。确定性 lane 复用生产 evaluator 的证据、重放、成本和对照协议，27 case/2 variant 成功率为 1，Provider 请求数为 0；不连接真实 DASCTF、远程 tube 或 pwn E2E。

本轮验证命令：

```powershell
npm run check:changed-tests
npm run build --workspace=@proofblade/materials
npm run typecheck --workspace=@proofblade/gui
npm run build --workspace=@proofblade/gui
node --test scripts/tests/ci-gates.test.mjs
```

P3 Planner/Refiner 仍需等待更大规模 holdout 数据，不在本轮提前引入。

## 8. 当前未完善项的解决设计（2026-08-26）

本阶段不再增加第二条解题 lane，也不把 Planner/Refiner 提前塞进主循环。所有缺口按同一条 `ControlStore → Effect Journal → Artifact → Evidence → Verifier` 证据链补齐：Pwn/HTTP 的远程 session 接缝已由版本化 `session-runtime-wire`（lifecycle + action）、有界脱敏和 broker runtime proxy 固化；真实可持久化 broker 仍是发布环境责任。

1. **P1b-3 统一结果索引（已完成第一垂直切片）**：Pwn/Web/Browser replay 与 Claim final attestation 都使用有界 `VerifierOutcomeEnvelope`；replay 信封禁止 candidate、accepted、terminal 和 Evidence ID，Claim 只有在受信 Evidence/Completion 已准备好后才写 terminal envelope。投影按 request key、policy/recipe hash、generation、candidate、attempt、transcript 和 Evidence 全量校验，旧信封或缺引用直接 `unverified`。
2. **P1b-3 外部资源账本（已完成第一垂直切片）**：`ExternalResourceRegistry` 以独立 `.proofblade/external-resources.json` 保存 `PROPOSED → STARTED → CONFIRMED/UNKNOWN → RELEASED`，跨进程锁保护；Session/Web/Browser/Competition janitor 已可写入，恢复只在 backend `inspect` 给出精确 `MATCH` 时 `adopt`，旧 generation 只在确认归属后释放。
3. **P1b-4 真实 backend 接入（进行中）**：Docker 已提供 label + run/generation hash 精确匹配 adapter，并在 Docker runtime 创建/销毁时写入 registry；Browser 已提供 `BrowserRuntimeBroker`、opaque handle、稳定 verification key、幂等 `/v1/browser/create` create/open wire、`HttpBrowserVerifierFactory`、可调用 context handoff、顺序多-attempt replay 的原 session/Effect 续跑、RPC timeout、版本化 lifecycle/action/health/heartbeat/bind HTTP wire、服务端 dispatcher、`DurableBrowserRuntimeService`、`BrowserRuntimeContextActionService`、CLI/GUI recovery composition 以及真实 Playwright host 注入入口。host 在 Chromium 支持 `launchPersistentContext` 时已实现受控 profile + 脱敏 host ledger 的 restart-stable `inspect/adopt/resolve`，不支持时仍动态声明 `stableAcrossRestart=false`；Browser session 在 Control Store 事件前用 `registerStarted()` 单锁登记，owner commit 后再以同一 `bindingTxnId` 调用幂等 `bind`，recovery 对无对应 session 的句柄只做精确 release；Pwn/HTTP 已提供 `SessionRuntimeBroker`、opaque externalId、broker runtime binding、`SessionRegistry/HttpSessionBackend.adopt` 和唯一 lane handoff，以及版本化 `session-runtime-wire` 的 create/open、health、lifecycle/action、远程 HTTP fetch/Pwn runtime proxy 和请求/响应边界测试；新增 `DurableSessionRuntimeService` 与 `scripts/session-runtime-service.ts`，由独立账本、STARTING 对账和注入式 `SessionRuntimeHost` 承担跨进程恢复，Coding lane 现在还会在首个 Provider 回合前做并发 health/capability preflight，并由 Competition solver 按 `target_kind` 只校验当前方向需要的 Pwn/HTTP kind；Browser transport 尚未纳入平台题目合同，不能因存在 Browser broker 配置就猜测启用。配置 broker 失败时禁止静默退回 Docker/进程内 HTTP。平台通用接缝已支持 `Idempotency-Key`、STARTING reservation、query-by-idempotency（含 `{idempotencyKey}` 路径占位符）和 `CompetitionEnvironmentIdentityCapabilities`，DASCTF 明确声明 `challenge-only + stableAcrossRestart=false`，ACTIVE/ABSENT/UNKNOWN 观察和通用 remote-query fault matrix 已接入。本轮已补上 Control Store `FINALIZING → BOUND` fence 和 Browser service ledger marker，避免 close 与 external marker 竞态误报绑定；剩余是让 CLI/GUI 默认注入真实 host、逐平台实现稳定实例句柄，并完成部署级 fault proof。所有 adapter 只允许精确 binding 的 `inspect → adopt → release`；查询失败或身份不完整保持 `UNKNOWN + RECOVERY_REQUIRED`。
4. **P2 故障注入与发布门禁（本轮闭环）**：固定覆盖 batch、Effect 四生命周期点、Verifier Evidence/Completion、进程重启；要求 replay projection hash 不漂移、Artifact/Evidence 不悬空、恢复重复为 no-op、未知外部结果不能升级 accepted。`run-tests-with-watchdog.mjs` 已加入全量测试，超时会输出阶段和最近输出摘要；`run-test-stage.mjs` 现将测试拆为可单独重试的 `test:fast`、`test:slow`、`test:integration`，每阶段输出 JSON 起止事件并保留 `.proofblade/test-logs/<stage>.log`；CI 默认并发 2，并在成功/失败后上传这些日志；`test:platform-fault-matrix` 已纳入发布链。本轮将 `atomicWriteFile` 按目标路径串行化、增加短暂 rename 错误的有界退避并补 64 路并发回归，最新分阶段回归为 fast 700/700、slow 22/22、integration 86/86（808/808），新增 Browser Runtime service 启动/鉴权/required-readiness 回归后 CI gates 36/36；Docker fault matrix 与 Browser smoke 均支持部署证据报告。发布顺序固定为 `build → changed-tests → api:index:test → api:index:check → component/contract/CI gates → platform-fault-matrix → test:staged → offline eval → npm audit`。
5. **P3 真实能力评测（最后）**：准备至少 20 个不泄漏答案的 Web/Pwn case、两个有明确 token pricing 的 Provider variant；仅在显式 `--allow-live --enforce-gate` 下运行。Provider telemetry 为 0 的 holdout 只验证管线，不代表模型解题率，也不触发 Planner/Refiner 引入。

每一步都必须先有 schema/状态不变量，再有失败、重启、越权和幂等测试；真实 DASCTF、远程 tube、Docker Pwn 和真实 Provider 不作为常规 CI 的隐式依赖。
