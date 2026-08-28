# ProofBlade 未完善点改造设计

本文冻结 ProofBlade 下一阶段的设计边界。目标不是继续堆叠 Agent 角色，而是把已经存在的阶段机、ActionBundle、Effect Journal、Evidence 和 Verifier 组合成一条可恢复、可解释、可限额的解题路径。

## 1. 现状与问题边界

本轮 Competition runtime preflight 改动后的最新分层回归为 fast 700/700、slow 22/22、integration 86/86，合计 808/808；此前 Browser Runtime handoff 阶段的 698/698、22/22、86/86（806/806）保留为上一阶段基线，697/697、22/22、86/86（805/805）、696/696、22/22、86/86（804/804）和 695/695、22/22、86/86（803/803）是更早基线。新增 Browser Runtime service 启动/鉴权/required-readiness 契约后，CI gates 为 36/36；统一部署预检新增 4 条脚本契约后，当前 CI gates 为 40/40；更早的 30/30、80/80（794/794）仍只作为历史基线。本轮 canonical `npm run verify` 已全链路通过（platform fault 6/6、staged 808/808、offline eval 30/30、`npm audit --omit=dev` 0 vulnerabilities）；下面的逐阶段结果和该发布链共同构成当前证据。

当前已经具备的基础：

- `RunCoordinator` 是 Competition、GUI、Fixture/Evaluation 共享的唯一运行编排入口；
- Control Store 以 JSONL 事件为事实来源，Projection 可以重放；
- 工具调用有 Effect/Artifact/Evidence 账本，成功终态由 verifier 绑定；
- `INTAKE → RECON → TARGET_MODEL → HYPOTHESIS → EXPERIMENT → REPRODUCE → REPORT/SUBMIT` 已经是持久化领域阶段；
- Web/Pwn 的工具预检、ActionBundle、会话和重复实验限制已经存在；
- 失败分类已经集中到 `domain/failure-policy.ts`。

当前基础控制面已经具备持久化预算、阶段门、恢复视图和统一领域账本；剩余问题集中在“复现覆盖”和“发布证明”两条边界：

1. Web/Pwn 的基础 clean session/process verifier 已接入，但 Web exploit-chain 的可信升级和 Browser-required 链路仍需扩大覆盖；
2. 跨重启、跨 generation、越权拒绝和旧 Run 降级需要继续进入固定 CI 场景，而不是只靠人工检查；
3. 离线评测需要覆盖领域记录质量、重复实验率、复现率和错误提交，而不只是“最终是否拿到 flag”。

本轮 P0 已进一步收敛：多命令 `dispatchBatch` 通过同步临时文件 + 原子替换写入 JSONL，`ControlStore.reconcileProjection()` 在恢复入口以事件流重建并幂等修复过期/损坏 Projection；事件已落盘但 Projection 尚未写入的崩溃边界已有回归测试。控制面新增 Run 目录级跨进程文件锁，完整读-校验-事件-Projection 事务在锁内重新读取事件流，两个独立 Node 进程并发写入已有序号/重放回归。Effect 落盘、Verifier Evidence 写入和更广泛的故障注入仍按后续发布门禁继续补齐。

### 2026-08-27：Pwn/HTTP broker 接线与跨账本 marker 收敛

本轮按“先契约、再绑定、最后默认装配”的顺序推进了一条可验收垂直切片：

- `SessionRuntimeCreateRequest` 现在对 Pwn/HTTP 创建输入做版本化、严格白名单和相反类型拒绝；`HttpSessionRuntimeBroker` 支持幂等 create、opaque handle、bounded action 和流式响应上限。配置了 `runtime.sessionBroker` 但缺少 token 时，CLI/GUI/Competition/唯一 Coding lane 统一 fail-closed；未配置 broker 时保留显式的本地 Docker/HTTP 路径。
- broker 返回的 Pwn/HTTP handle 通过 `SessionRegistry.openExternal()` / `HttpSessionBackend.open()` 写入 `ExternalResourceRegistry`，恢复时先 `inspect → adopt`，再把 broker-owned runtime/fetch 交给同一个 Coding lane；adopt 会幂等补回丢失的 resource projection，不创建新的 `session_opened` 或替代 session。
- `SessionRecord` 与 external-resource ledger 共享 `bindingTxnId` 以及 request/policy/recipe/scope hash。新记录两边都有 marker 时必须精确相等；旧 Control Store 记录没有 marker 时仍可依据不可变身份字段恢复，避免升级后把历史 Run 全部误判为人工恢复。CLI、GUI 和 Competition 现在把“已配置 Browser broker 但 factory/凭据缺失”作为 required 条件传入唯一 Coding Lane，Browser transport 题目直接 fail-closed，不静默回退进程内 Playwright。
- Coding lane 现在在首个 Provider 回合前执行 broker health/capability preflight。只有 `READY`、覆盖对应 session kind 且声明 `stableAcrossRestart=true` 的 broker 才进入活动组合；`DurableSessionRuntimeService` 还会强制要求 host 提供 `inspectByIdempotency()`，否则把该声明降级为 `DEGRADED/stableAcrossRestart=false`，避免无法对账 STARTING 崩溃的 host 进入生产组合。配置了 broker 但 token 缺失、health 失败、能力不匹配或服务降级时，Pwn/HTTP 按 kind fail-closed，不能静默退回 Docker 或进程内 HTTP。Competition solver 在平台环境返回后、创建 Coding lane 前执行同一份只读 preflight；动态 flag 快速路径不触碰 session runtime，普通运行若预检失败会先精确释放已申请环境；显式注入的测试 Browser factory 仍是受控替身，不被远程健康探针覆盖。为保持测试注入能力，没有 health 方法的显式 fake/dev broker 仍可使用，但生产 HTTP broker 必须提供 health。
- Competition preflight 现在按题目的不可变 `target_kind` 只阻断必需 runtime：Pwn 只要求 `pwn-session`，Web 默认 HTTP 只要求 `http-session`，其他方向不因无关 session kind 不可用而失败；动态 flag 仍完全跳过 runtime。这样保持“配置的 broker 对对应方向权威”与“无关 backend 不扩大故障域”两个边界。
- Pwn 的 `reproduce` 在 Broker 模式下也通过同一个 durable broker 创建全新的 clean session，不再误走仅用于本地 Docker 的 session opener；它仍只产生观察性 replay 结果，只有具备独立 trusted verifier 的 Docker 路径才能提升为可信 Evidence。

验证结果：本轮分阶段回归为 fast 700/700、slow 22/22、integration 86/86，统一部署预检契约加入后 CI gates 40/40（此前 Browser Runtime 阶段的 36/36 保留为历史基线）；Competition solver 定向回归 31/31；Browser/Binding/Web 定向回归 59/59，required Browser runtime fail-closed 回归 1/1，Competition Browser handoff 回归 1/1，Browser Runtime service 启动契约回归 6/6，平台身份稳定 key/重复 reservation 回归 1/1；公开 API 重新生成与 `api:index:check`、`npm run build`、`npm run typecheck`、`check:components`、`check:change-contracts`、`check:changed-tests` 也均通过。一次误用 workspace glob 的全量 Node test 命令暴露了既有 Windows/Pwn worker 环境依赖失败，不能当作本轮代码回归通过；正确的分阶段 runner 已通过并保留日志。Docker fault matrix 仍需发布环境的 Docker daemon/固定镜像，Browser smoke 仍需 Playwright 浏览器。共享 Session Runtime 可由 `scripts/session-runtime-combined-host.ts` 按不可变 `request.kind` 路由 HTTP/Pwn；只有两个底层 Host 都 `READY + stableAcrossRestart` 时才报告整体 READY。

这条切片仍不等于全部真实能力已完成：参考 `DurableHttpSessionRuntimeHost` 已提供可部署的 HTTP 持久 Host（Cookie/CSRF 加密账本、精确 scope、流式响应上限和重启接管），但 Pwn tube 仍需部署独立 supervisor；跨 ledger 最终原子提升、逐平台稳定远端实例句柄，以及至少 20 个匿名 Web/Pwn case 的带价格 Provider 评测仍是后续发布门槛。health/capability preflight 已落地，但它只能阻止错误降级，不能替代真实 host 的跨重启证明。没有这些证据时，系统只能报告 `UNKNOWN/SKIPPED`，不能把 fake broker、provider-free holdout 或协议测试计入真实解题率。

## 2. 设计不变量

### 2026-08-27：Browser Runtime 发布门禁补齐

Browser Runtime 服务现与 Session Runtime 对称支持 `--require-ready`（或
`PROOFBLADE_BROWSER_RUNTIME_REQUIRE_READY=1`）。默认诊断启动会准确输出
`ready|degraded`，其中只有 `READY + stableAcrossRestart=true` 才是 `ready`；发布模式
在绑定端口前拒绝 `DEGRADED/UNAVAILABLE` 或非重启稳定 Host，避免 Playwright 驱动不可用
时仍对外宣称服务已就绪。

### 2.1 单一事实来源

所有会影响控制流的值必须来自 Run 事件或由事件重放得到：当前阶段、预算使用量、重规划记录、门禁结果、Verifier verdict 和终态都不能只存在于进程内变量。

### 2.2 原子性

一次“失败 → 当前 WorkItem 阻塞 → 记录重规划 → 创建下一项 WorkItem”必须是同一个 `dispatchBatch`。任何中间状态都不允许被恢复逻辑解释为成功。

### 2.3 模型不可越权

模型只能提出事实、假设、实验和候选 Completion；不能直接写入 `SUCCEEDED`、Verifier Evidence、平台 verdict、预算增加或阶段门通过。

### 2.4 有界上下文

上下文只注入结构化摘要、ID 和 bounded viewport。原始 HTTP、PTY、GDB、响应 body 和截图继续保存在 Artifact 中；目标输出永远是不可信数据，不能改变范围、权限、预算或终态。

### 2.5 旧 Run 可重放

新增字段必须有旧事件流的默认值；新增事件只增不改历史。旧 Run 可以显示 `LEGACY-UNTRUSTED` 并只读重放，不能因为新门禁不存在而伪造通过。

## 3. 状态模型：阶段预算、重规划与门禁

### 3.1 可回放预算视图

不直接维护一组容易漂移的“已用计数”，而是用持久化对象推导预算视图：

```text
RunSnapshot
  task.constraints.max_tool_calls / max_submissions / deadline_ms
  experiments[...].domainPhase
  effects[...]
  replanRecords[...]
  phaseGates[...]
  toolPreparation.actionBundles[...].maxCalls
```

新增纯函数 `phaseBudget(snapshot)`，返回：

- 当前 domain phase 的 ActionBundle、上限、已记录 Experiment 数和剩余动作数；
- Run 级 effect/tool-call 使用量和剩余量；
- submission 使用量和剩余量；
- `replansUsed / replanLimit / replansRemaining`；
- `deadlineRemainingMs`、`exhausted` 以及触发原因。

第一版的阶段动作预算以 `ExperimentRecord` 为计量单位，避免给所有 Effect 事件重新补 phase 字段；Run 级工具预算仍由 Effect Journal 的持久化 Effect 数量计量。后续若需要更细粒度，再给 Effect 增加可选 `domainPhase`，不改变现有事件含义。

### 3.2 重规划事件

新增 `replan_requested` 事件和对应命令，至少包含：`id`、失败分类、来源阶段、原因摘要、被阻塞 WorkItem、创建的下一项 WorkItem、禁止重复的 repeat key，以及当前 generation。`RunSnapshot` 保留 `replanCount` 和有界的 `replanRecords` 投影。

`replanCount` 只在真实创建下一项 WorkItem 时增加；普通一次重试、Provider 内部退避、Verifier 查询不增加。重规划上限由确定性策略给出：优先使用任务约束中的可选 `max_replans`，旧任务缺省按 target kind 使用安全默认值（Web/Pwn 先为 2，其他方向为 1）。达到上限后，下一次 `replan_requested` 被 Control Store 拒绝并转入 `EXHAUSTED` 或 `NEED_HUMAN`，不能由模型继续开新会话绕过。

### 3.3 阶段验证门

新增纯函数 `evaluatePhaseGate(snapshot, phase)`，只读取 durable state，返回：

```text
{ phase, status: pass | blocked | stale,
  required: [...], satisfied: [...], missing: [...], evidenceIds: [...] }
```

第一版门禁：

| 阶段 | 必须满足 |
| --- | --- |
| `INTAKE` | 题目类型、输入哈希、目标范围和工具预检存在 |
| `RECON` | 至少一个基线 Observation/Transcript，且存在可操作目标模型 |
| `TARGET_MODEL` | 非空 Hypothesis、支持 Evidence、至少一个有前置条件的 ActionBundle |
| `HYPOTHESIS` | 当前假设未被拒绝，且下一动作不是重复实验 |
| `EXPERIMENT` | 本阶段有 Effect/Artifact/Experiment 结果，结果已分类 |
| `REPRODUCE` | 新 generation/session 的 verifier-owned reproduction Evidence |
| `SUBMIT` | 当前 Completion、候选哈希、提交次数和平台 verdict 一致 |

`set_domain_phase` 在前向转换时检查上一阶段门；允许回退的路径仍由现有 phase machine 控制。门禁结果可按需追加 `phase_gate_evaluated` 事件用于审计，但“是否通过”必须始终能从快照重新计算，事件不能成为第二套事实来源。

## 4. 失败与重规划流程

统一流程如下：

```text
tool/provider/verifier outcome
        ↓
PrimaryFailureCategory
        ↓
failure-policy: retry | replan | stop | escalate
        ↓
原子写入 evidence/experiment + replan_requested（如需要）
        ↓
下一回合读取 phaseBudget + phaseGate + ActionBundle
```

`retry` 只允许在当前实验和当前会话内有限重试；`replan` 必须产生新的 WorkItem 和禁止重复项；`stop` 直接耗尽当前 Run 预算；`escalate` 进入 `NEED_HUMAN` 或可恢复暂停。Turn Guard 只是短生命周期的触发器，不能继续维护一套独立的重规划计数。

## 5. Verifier 与终态门

Verifier 保持独立权限边界，并把最终判定拆成三个门：

1. **候选来源门**：候选必须来自当前 generation 的 Artifact/Observation，不能来自 prompt、脚本字面量或模型消息；
2. **清洁复现门**：新 session/进程中完整链路成功，拥有结构化断言、transcript 和 result Artifact；
3. **平台提交门**：平台 API 调用由 Journal 的幂等键、提交预算和 cooldown 保护，接受 verdict 与 Completion 的 candidate hash 必须完全一致。

只有三门都通过，trusted verifier 才能提交 `completion_verified` 和 `run_finished(SUCCEEDED)`。拒绝形成 durable negative Evidence，并按失败策略回到 `EXPERIMENT`，禁止盲目改 flag 重试。

## 6. Web/Pwn 结构化能力补齐

ActionBundle 只负责“此阶段允许什么”，领域能力负责“产出什么”。统一要求每个 capability 返回 `effectId + artifactId + structured summary`，并可选生成 Evidence：

- Web：`BaselineRecord`、`EndpointRecord`、`RequestRecord`、`ExploitChain`、clean-session reproduction；
- Pwn：`BinaryProfile`、`ProtocolTranscript`、`PrimitiveHypothesis`、`LeakRecord`、`ExploitStage`、clean-process reproduction。

这些记录都进入现有 Evidence Graph，而不是另建一套数据库。`bash` 保留为受限 escape hatch：它可以产出 Artifact，但不能绕过结构化门直接声称目标模型、Leak、复现或提交成功。

当前已落地的最小垂直切片是：HTTP session 自动写入 `web_baseline`、稳定的 `web_endpoint`、逐次 `web_request` 和有界的 `web_exploit_chain=observed`；Pwn tube 自动写入有界 `pwn_protocol_transcript`，Leak 解析会写入可重放的 `pwn_leak`，`proofblade.binary` 的 `identify/inspect_elf` 会从真实 Effect Artifact 写入 `pwn_binary_profile`，`pwn_record_primitive` 写入带 Artifact/Evidence 前置条件的非可信假设，`pwn_reproduce` 现在会在配置了 immutable Pwn policy 的容器运行中使用 verifier-owned clean process，生成受信 Effect、transcript Artifact、reproduction/negative Evidence 和 Completion verdict；没有该配置时仍保持 fail-closed。Web clean replay 也会由 verifier capability 写入逐步 `web_request` 记录，只有成功复现的链才升级为 `web_exploit_chain=reproduced`，失败链保持 `observed` 并保留 negative Evidence。所有记录通过 Control Store 原子提交，并校验当前 generation、目标类型以及 Artifact/Evidence/记录引用。`web_exploit_chain=reproduced` 和 Pwn Completion accepted 仍只允许 trusted verifier；模型生成的 Pwn stage 不能升级为验证成功。`bash` 仅增加常见控制账本写入的静态拦截，不能替代 Control Store 的权限校验。

仍未完成的部分有明确边界：Browser 已有 verifier-owned runtime factory 边界、目标 scope/policy hash 绑定、步骤/时限/响应上限和 navigation/click/fill/submit/wait action 协议；`evaluate` 默认不开放。当前已补上无硬依赖的 Playwright adapter，并由 CLI/GUI 在运行时发现到可用 Playwright/浏览器二进制后注入；缺失时不注册 Browser `web_reproduce`，继续 fail-closed。发布前 Browser smoke 入口为 `npm run browser:smoke:required`，可通过 `PROOFBLADE_PLAYWRIGHT_MODULE` 指向外置 Playwright 安装；CI 可使用无依赖的默认 `npm run browser:smoke`，缺运行时只报告 skip。Pwn 的离线四类阶段契约矩阵已经补齐，仍需在有固定镜像的发布环境按需执行容器 smoke，并补齐跨重启、越权拒绝、恢复和私有 corpus 的固定发布门禁。后续不允许通过“先写一条看起来像成功的记录”填补这些空白，所有可信结论必须沿着 Effect → Artifact → Evidence → verifier verdict 链路产生。

## 7. Context 与 GUI 可观测性

### Context

在现有 L0-L5 之后追加一个有界 `<control-view>`：当前阶段、门禁缺口、ActionBundle、阶段预算、Run 预算、重规划剩余次数、失败分类和下一项 WorkItem。该片段必须稳定排序、限制长度并计入 context manifest/hash，不把动态原始日志塞进 system prefix。

### GUI

GUI 只读取 Projection/Replay，增加四个只读卡片：

- `Phase / Gate`：当前阶段、通过项、缺口和允许的下一阶段；
- `Budget`：工具、阶段动作、提交、时间剩余；
- `Recovery`：失败分类、策略、已用/剩余重规划次数、禁止重复项；
- `Next action`：当前 ActionBundle、WorkItem、所需工具和成功判据。

暂停、恢复、人工批准仍通过 Control capability 写入，不允许 GUI 直接改 Projection。断线重连后从事件流重建同样视图。

## 8. 未完善项的解决设计

### 8.1 Web/Pwn 统一复现协议

复现器只接收三类输入：当前 generation 的候选 Artifact、任务启动时冻结的 verifier policy、以及由领域记录引用的最小步骤图。模型不能传入 flag 正则、目标地址、shell marker、命令或 stage 内容来改变 policy。复现器每次都创建新 session/process，并把完整 transcript、断言结果和退出状态写入 verifier-owned Artifact；Effect 的 args 必须绑定 `runId/taskHash/generation/candidateHash/policyHash`。

Web HTTP 复现按 `baseline → request steps → response predicate` 执行，Browser 复现按 `fresh storage → navigation steps → response predicate` 执行；Cookie/CSRF/浏览器 storage 只存在于复现器创建的 clean profile。Pwn 复现按 `binary/protocol → primitive → exploit stages → shell marker → flag read` 执行，二进制 payload 以 base64 保留原始字节。只有 verifier Effect + verifier Artifact + accepted verdict 三者齐全时，才允许写入 `web_exploit_chain=reproduced`、reproduction Evidence 和 `completion_verified`。

### 8.2 代际与恢复闭环

所有领域记录和 Evidence 必须带 generation；reset/restart 后旧记录只用于审计，不能满足当前 gate。当前已验证“事件批次落盘后、Projection 写入前退出”的恢复：新进程从事件流重放并修复 Projection，重复修复不会产生新事件。后续故障注入继续覆盖 Effect 落盘、Verifier Evidence 写入和更接近真实进程终止的边界，验证不会出现半个 chain、半个 stage 或悬空引用。对 legacy Run 采用 fail-closed：可以显示和重放，但不能升级为可信成功。

当前已先落地稳定验证请求锚点：Web/Browser/Pwn/Claim 在创建 clean session、进程或平台命令前，先由 `runId + generation + verifier kind + policyHash + recipeHash + sourceIds` 派生并持久化 `VerificationRequest`。Web/Browser/Pwn 现在还会在外部动作前持久化不携带候选的 `verification_replay` Effect 和 immutable recipe Artifact，session/process 绑定到该 Effect 后才开始复现；Claim 的最终受信命令也会把 terminal `VerifierOutcomeEnvelope` 与 Completion/Evidence 绑定。同一请求重试不再以随机 session 或 Completion ID 作为身份；已绑定终态只读取 durable candidate/Evidence，仍为 PENDING 或 PROPOSED 时直接 fail-closed，不再次制造外部实验。验证结果输入现在先以 verifier-owned recovery Artifact 持久化并只在 Effect args 中保存其 hash，因此 `PROPOSED` attestation 可以在不触碰外部资源的情况下复用原输入恢复。随后已接入 `VerificationRecoveryService.inspect()`：RunRecovery 会跳过 verifier-owned Effect 的通用 Sandbox 重放，输出 terminal/pending/proposed/in-flight/ambiguous/stale/invalid 诊断；如果 verifier 结果 Artifact 已经落盘，恢复服务会在不触碰外部资源的情况下复用原 Artifact 完成原 Effect。Pwn 终态重放也会从受信结果 Artifact 恢复 stage summary 和 shell barrier，而不是返回空的 `stages`。剩余工作是为各类 backend 注入真实 reconcile/resume adapter，在不新建 session 的情况下继续同一个 replay Effect、回收 orphan session、从 replay Artifact/Evidence 重建完整结构化结果，并在无法确定外部结果时明确进入人工恢复，而不是猜测成功。

### 8.3 越权与重复实验闭环

将以下操作固定为拒绝场景：模型伪造 verifier lane、直接写 `reproduced`、引用旧 generation Artifact、把 bash 输出当成 primitive/leak、跨任务 session 复用、同一失败 payload 通过新 session 绕过 repeat key。每个拒绝都必须在 reducer/control-store 层发生，并且不产生 projection 变化；工具层只提供友好错误，不承担最终权限判断。

### 8.4 发布门禁与评测

CI 固定执行 `build → targeted changed-tests → api:index:test → api:index:check → component/contract checks → platform-fault-matrix → test:fast → test:slow → test:integration → offline eval gate`。离线题目按 Web/Pwn/其他方向分层，除 solve/verified rate 外记录首个 Evidence、首个 Primitive、重复阻断、复现耗时、错误提交和上下文恢复次数。真实平台 API 只在显式 `--allow-live` 下运行，凭据来自环境变量或未跟踪本地配置，永不进入 Artifact、报告和 generated API 索引。

### 8.5 Pwn 覆盖的分层落地

Pwn 不把“能启动 Docker”误当成“能解题”，也不把一次远程成功当成可回归证据。覆盖拆成三层：

1. **阶段契约矩阵（CI 必跑）**：为 ret2libc、format-string、heap/UAF、stack-pivot 各准备一个独立 Run，使用可注入 tube 只替换底层 I/O，不替换 `PwnReproducer`、Control Store 或 verifier。每个场景都必须经过 `stage → shell marker → flag read`，并检查 `pwn_exploit_stage=passed`、verifier-owned Effect/Artifact/Evidence 和 `Completion=ACCEPTED`；模型提供的 stage 不能直接升级为成功。
2. **容器运行 smoke（发布环境可选）**：在具备 Docker daemon 和固定本地靶场镜像的环境，复用同一矩阵执行一次真实进程；镜像 digest、命令、端口和 flag policy 全部冻结，结果只上传脱敏指标。Docker 不可用时 CI 不伪造通过，而是明确标记 skip；`--required` 才将其变成发布失败。
3. **平台/远程验证（显式运维动作）**：DASCTF 登录、远程 tube 和提交不进入常规 CI，也不把真实题目答案写入仓库。它们只验证平台 API contract、scope/cooldown/idempotency 和人工授权后的连通性。

平台连通性使用只读入口 `npm run platform:selfcheck`。它只调用题目列表和（若有题目）一道题目的详情/附件接口，不创建环境、不恢复环境、不提交 flag；缺少 `PROOFBLADE_COMPETITION_ACCESS_KEY` 时以非零状态 fail-closed。`PROOFBLADE_COMPETITION_SERVER_HOST` 可选，默认使用 DASCTF 官方 host；AccessKey 只从环境变量读取并且只报告长度，不进入输出。

当前已完成第一层的四类阶段契约矩阵；第二层受本机 Docker daemon/镜像可用性约束，第三层按项目范围保持显式触发。这样既能持续证明 Pwn 控制面没有回归，也不会把 fake tube 测试包装成真实 exploit 成功率。

### 8.6 真实 Provider 评测的安全闭环

真实模型质量不靠单元测试猜测，按以下顺序运行：

1. `eval-real --preflight` 只读取私有 corpus、模型配置和环境变量存在性，不创建 Run、不发请求；必须至少两个 Variant、20 个以上不泄漏答案的私有 case，并同时包含 Web/Pwn。
2. 每个 Variant 明确 provider/model/API、价格、最大 turns、deadline 和 Run 级成本上限；请求前预留预算，超限不发请求，Provider 重试关闭。
3. `--allow-live --enforce-gate` 才允许真实请求。报告只保留 provider telemetry、category metrics、稳定 hash 和脱敏错误；API key 只能来自环境变量或 ignored 本地目录，绝不写入事件、Artifact、报告、generated API 或聊天记录。
4. 发布决策至少同时看 verified/solve rate、成本、p95、首个 Evidence、重复阻断和 deadline-before-completion；Provider 请求数为 0 的 deterministic holdout 只能证明管道，不得宣称模型能力。

现有实现已经具备 preflight、答案字面量泄漏检查、Provider traffic 门禁、价格/成本校验和 anonymized report。剩余工作是由使用者准备私有 corpus、核对当前价格并在显式授权后运行；不把真实 key 或真实远程结果纳入代码提交。

### 8.7 Recovery 与越权发布证明

剩余的可靠性缺口用故障注入测试收敛，而不是靠人工观察：批次提交、Effect 的四个生命周期边界（`after_proposed`、`after_started`、`after_execute`、`after_artifact`）、Verifier Evidence 写入和进程重启分别中断，重启后比较 replay projection hash，要求“不多一条、不少一条、不出现悬空引用”。当前还已覆盖 `PROPOSED` 重试复用原 Effect、`STARTED` 重试必须先 reconcile、`evidence + completion_verified` 已提交后重试只重放 durable terminal outcome，以及 Verifier 结果端口对完全相同 Evidence/Completion 重试做严格 no-op、对同 ID 不一致内容拒绝的策略。Control Store 的跨进程锁已覆盖活跃 owner 不抢占、stale owner 回收、并发序号连续和 Projection 不被旧快照覆盖。同时固定拒绝伪造 `reproduced`、旧 generation、跨 Run session、bash 伪 primitive 和第三次失败实验；拒绝必须发生在 reducer/control-store，并验证 projection 不变。全部通过后才把 `api:index:check`、changed-tests、组件/契约检查、全量测试和 offline eval 作为发布门禁。

### 8.8 统一外部恢复服务的实现边界

`VerificationRecoveryService.reconcileRun(runId)` 必须在 Run 锁内重新 replay，然后按以下优先级处理：

1. 已有 `ACCEPTED/REJECTED` Completion：校验 candidate Artifact、verifier Evidence、Effect verdict 和 request key，只返回 durable 结果，不触碰 Web/Browser/Pwn/平台外部资源；
2. `PROPOSED` Completion 或 `PROPOSED` Effect：复用原 ID、原 args 和原幂等键，补齐缺失的 Artifact/Evidence/terminal event，禁止生成新的 Completion；
3. `STARTED/UNKNOWN` Effect：先调用对应 backend 的 reconcile/inspect（容器、session registry、平台查询），只能确认结果后写 `effect_reconciled`；无法确认就保持未知并进入 `NEED_HUMAN`/恢复队列，不能重新执行非幂等外部动作；
4. PENDING 且没有 Effect：标记为 `RECOVERY_REQUIRED`，等待受控恢复命令；不能自动再次打开 clean session/process；
5. 所有补写都使用一个 verifier batch，并在 batch 内校验 generation、request key、candidate hash 和 Artifact 引用。

绑定事务恢复顺序补充（2026-08-27）：`RunRecoveryService` 先处理无 Control Store owner 的精确 release，再执行外部资源 inspect/adopt，最后才允许 `BindingTransactionCoordinator` 补写缺失的 Control Store 绑定。`STARTED/UNKNOWN` 即使与 OPEN owner 的 immutable identity 相符，也不会仅凭 metadata marker 提升为 `BOUND`；只有 backend 已确认资源，或已经存在精确 control-session marker，才允许事务完成。这样把“账本关系存在”和“外部句柄仍可接管”明确分开，避免恢复过程把失联 Host 误报为可用 session。

每个复现器的返回值改为读取统一的 `VerifierOutcomeEnvelope`（包含 primary response/artifact、attempts、stage summary、accepted、evidenceIds），避免当前“重启后把 candidate Artifact 误当作主响应 Artifact”或 Pwn `stages: []` 这类语义降级。

### 8.9 Browser 与平台 backend 的具体解决设计

这两个 backend 不能按 Docker 的方式直接“猜一个可用句柄”。它们的发布边界分别冻结如下：

#### Browser：broker 才能跨进程接管

Playwright 的 `BrowserContext`、`Page` 和本地浏览器进程只存在于创建它们的 Node 进程内，不能把 `sessionId` 当成可恢复句柄。因此 Browser 恢复分两种模式：

1. **可接管模式**：由应用注入一个独立的 `BrowserRuntimeBroker`。材料层已经提供 `BrowserVerifierFactory.runtimeBroker`、opaque `BrowserVerifierContextHandle` 和 `BrowserContextResourceAdapter`：broker 在持久化前返回不含 cookie/token 的 `externalId`，并实现 `inspect(record)`、`adopt(record)`、`release(record)`。它必须在服务端验证 run/generation/policyHash，返回精确 `MATCH` 后才允许恢复原 context；恢复只复用原 replay Effect，不创建第二个 context。
2. **进程内模式**：当前 Playwright adapter 继续创建 verifier-owned、空 storage、headless 的 clean context，但不宣称跨进程可恢复。进程崩溃或没有 broker 时，registry 记录转为 `UNKNOWN`，Run 进入 `RECOVERY_REQUIRED/NEED_HUMAN`；只允许人工确认或显式 release，禁止用新 context 冒充 adopt。

Browser adapter 的 fake-broker 测试已经覆盖 opaque handle、run/generation/policy 绑定、无 broker 的 `UNKNOWN`、同一 handle adopt 不创建第二个 context、释放幂等，以及恢复后复用原 replay Effect/session id、按 durable interaction count 从中断 step 继续且不创建第二个 context；adapter 现在对 inspect/adopt/release 统一施加有界 RPC timeout，超时保持 `UNKNOWN` 并可重试。BrowserReproducer 现在还能读取已完成 attempt 的 verifier replay Artifact，并在保持顺序的前提下恢复唯一的后续 STARTED attempt；恢复入口还会回收“结果已完成但 session.close 尚未落盘”的 broker context，并把 release 结果同步到 external-resource projection；已补充“同一请求两个同时 in-flight 必须拒绝”和“释放失败保留 handoff、下一轮成功重试”的回归。多个同时 in-flight 或结果不明确仍进入 `RECOVERY_REQUIRED`，因为不能猜测前序尝试是否完成。`npm run browser:smoke:required` 只验证新建 clean context，不把它当作跨进程恢复证明。

#### Platform：查询优先，账本只能证明“我曾经拥有”

`CompetitionApi` 增加可选的 `inspectEnvironment(challengeId, instanceId)` 能力，不改变没有该能力的现有平台适配器；同时通过 `CompetitionEnvironmentIdentityCapabilities` 声明平台真正能证明的稳定身份（`idempotency-key`、`instance-id`、`challenge-only` 或 `none`）。`CompetitionEnvironmentResourceAdapter` 的决策顺序固定为：

```text
本地 janitor 记录不存在/STOPPED       → ABSENT
存在可用 inspectEnvironment            → 校验 ACTIVE + challenge + instance 精确匹配
inspect 返回不匹配/超时/未知            → UNKNOWN（不 stop）
平台不支持 inspect                    → UNKNOWN；仅显式 allowLedgerOnlyRecovery 才兼容本地账本
```

只有声明为跨重启稳定且精确匹配才允许 `adopt` 或 `release`；缺字段是 `UNKNOWN`，不匹配是 `MISMATCH`；无能力声明或无远程查询也保持 `UNKNOWN`，不再把本地账本当作远端存活证明；`stopEnvironment` 失败保持 ACTIVE/UNKNOWN 并可重试。通用 `CompetitionApi`/HTTP 接缝已经支持 `Idempotency-Key`、STARTING reservation 和 query-by-idempotency；DASCTF 适配器明确声明 `challenge-only + stableAcrossRestart=false`，仍可以通过题目 detail 提供 ACTIVE/ABSENT/UNKNOWN 观察，但不能把题目级 detail 当作租约所有权。后续逐个平台提供真实 query-by-idempotency/实例查询时，必须先补充 wire contract、脱敏回放 fixture、重复 stop 和实例复用测试，再打开自动 orphan release。

#### 故障注入与发布闸门

每个 adapter 和每个 verifier replay Effect 都统一注入四个中断点：`after_proposed`、`after_started`、`after_external`、`after_terminal_artifact`。重启后要求：

- `PROPOSED` 只复用原 Effect/recipe，不接触外部 backend；
- `STARTED` 先 inspect，不能确认就保持 `UNKNOWN`；
- terminal artifact 已存在时只重放统一 outcome envelope；
- release 失败不删除账本记录，下一次 reconcile 必须可重试；
- replay projection、Evidence 引用和 external-resource ledger 均无重复、无悬空记录。

落地顺序固定为：Browser broker 接口、fake broker 测试、CLI/GUI recovery composition、in-flight Browser replay handoff、可配置 broker RPC timeout、顺序多 attempt 恢复、并发 in-flight/release-failure 故障回归、`CompetitionApi.inspectEnvironment` seam、DASCTF detail wire fixture、稳定身份能力声明和通用 remote-query 故障矩阵已完成；本轮又落地 `HttpBrowserRuntimeBroker` 的版本化 HTTP wire、本地脱敏/超时/超大响应/retry fixture、可复用的服务端 lifecycle/action/health/heartbeat/bind dispatcher、Node HTTP handler/context proxy、持久 Browser Runtime Service 和真实 Playwright host 注入入口（动作结果有界、state hash 传递、storageState 脱敏、动作回显绑定校验、能力探针和精确租约续期）。`scripts/browser-runtime-playwright-host.ts` 现在在真实 Chromium 提供 `launchPersistentContext` 时使用受控 profile root + 脱敏 host ledger，并有新进程重启接管回归测试；旧 driver 自动降级并继续声明 `stableAcrossRestart=false`。Browser service 现在默认加载该受控 Playwright Host，仍由独立进程/部署编排负责生命周期；`npm run test:platform-fault-matrix` 已纳入 `verify`。下一步是让 CLI/GUI 在生产配置中只接受该持久 broker、逐平台评估稳定实例句柄，并为其补脱敏 wire fixture 和 RPC 故障测试。没有真实 backend 能力的环境继续显式显示 `UNKNOWN`，而不是把“恢复成功”写成模型可见的成功事实。

## 9. 测试与发布门槛

每个改动必须至少有：

1. Reducer replay parity：事件流重放与 Projection 相等；
2. 原子性测试：失败、重规划和 WorkItem 队列不能出现半提交；
3. 越权测试：模型/GUI 不能伪造 gate、verifier 或预算；
4. 预算边界测试：重复实验、跨 generation、超限和重启恢复；
5. 目标类型集成测试：Web/Pwn 各至少一条成功、一条拒绝、一条恢复路径；
6. 生成稳定性和跨工作区路径测试；
7. `npm test`、`npm run build`、`npm run api:index:test`、`npm run api:index:check`、changed-tests、component/contracts/CI gates 全部通过。

真实模型评测只作为发布前的能力指标，不作为单元测试前置条件。Provider/API key 必须来自运行环境或本地未跟踪配置，仓库和报告中不出现真实密钥。

## 10. 实施顺序

1. **P0：状态账本（已完成）** — `replan_requested`、可回放 `phaseBudget`、重规划原子提交、跨进程 Run 锁和 Projection 修复；
2. **P1a：阶段门与单 lane（已完成）** — `evaluatePhaseGate`、ActionBundle、失败分类、重复实验阻断，以及所有入口统一到 coding lane；
3. **P1b-1：恢复状态机（当前已完成第一垂直切片）** — 稳定 `VerificationRequest`、verifier-owned recovery Artifact、`RECOVERY_REQUIRED`/`RECOVERED` durable marker、终态只读接管和 Pwn stage replay；
4. **P1b-2：真实 backend reconcile（已完成最小垂直切片）** — `VerificationRecoveryAdapterRegistry` 已按 verifier kind 唯一注册，并在 fixture/generation 确认后构造适配器；Claim 的纯本地命令与 `fixture_score` 可以在 `PROPOSED` 下复用原 Effect，平台和已启动 Pwn 保持 fail-closed/UNKNOWN；Pwn 的 `PROPOSED verification_replay` 已接入真实复现适配器；
5. **P1b-3：统一结果信封与孤儿回收（第一垂直切片已完成）** — `VerifierOutcomeEnvelope` 已接入 Pwn/Web/Browser replay 和 Claim final attestation，并由 Effect Journal/Claim 投影校验绑定；`ExternalResourceRegistry` 已提供有界跨进程账本和 `inspect/adopt/release` 状态机，Pwn/Web/Browser session 与 Competition platform environment 可选接入，旧 generation 只在精确归属确认后释放；Docker 容器已接入 label 精确匹配的 `inspect/adopt/release` adapter，并在 runtime 创建/销毁时写入 registry；Browser broker 接口、opaque handle、adapter 及 CLI/GUI 组合已完成，Pwn/HTTP 已提供 broker adapter、opaque externalId 和真正的 runtime handoff：恢复先 inspect/adopt，再把可调用 binding 传入唯一 `PiCodingLane`，没有 binding 仍为 `UNKNOWN`；Pwn/HTTP session runtime 现在还有和 Browser 一致的可续期 lease heartbeat，远程动作在心跳和精确绑定未确认前不会下发，过期句柄仍只允许精确 release；平台通用幂等启动/查询契约已完成，逐个平台的稳定远端实例句柄和 remote-query fault matrix 仍待补齐，无法确认时继续进入人工恢复；
6. **P1c：预检与可观测性** — 每个 Run/generation 只做一次工具/MCP/browser 预检，生成 ActionBundle；Context `<control-view>` 与 GUI 读取同一 Projection；
7. **P2：发布证明与能力评测** — fault injection、跨路径 API 生成检查、Web/Pwn 目标类型集成、Docker/Browser required smoke，以及显式授权的真实 Provider eval。

每一阶段都先落最小 schema 和测试，再接入主循环；不在一个 PR 中同时修改状态模型、GUI 和全部 Web/Pwn 工具。

## 11. 下一阶段的具体设计与验收

### 11.1 P1b-2：把“恢复请求”变成可执行的 replay Effect

当前 `VerificationRequest` 能安全阻止重复实验，但它本身没有描述“外部动作已经走到哪一步”。Web/Browser/Pwn 的第一步已经在创建 clean session/process **之前**写入不携带候选的 replay Effect 和 immutable recipe Artifact：

```text
VerificationRequest(READY)
  + recovery-input Artifact(verifier-owned, immutable)
  + Effect(PROPOSED, replayPolicy=verifier, requestKey/policyHash/recipeHash)
```

外部动作开始前只把 Effect 推进到 `STARTED`；动作完成后再以一个 verifier batch 写入 result Artifact、`Effect(FINISHED)`、Evidence 和 Completion。这样四个崩溃点都能被恢复服务区分：

- `PROPOSED`：只可复用原输入、原 Effect ID，不能新建 session；
- `STARTED/UNKNOWN`：必须调用 backend `reconcileStarted`，只能确认结果，不能盲重放；
- `FINISHED` 缺 Evidence：只补齐缺失的 verifier batch；
- PENDING 且没有 Effect：写 `RECOVERY_REQUIRED`，等待受控命令或人工处理。

当前已实现 `resumeProposed`/`reconcileStarted` 的最小 adapter registry、Pwn/Claim 适配器和 Docker label 精确匹配 adapter；外部资源侧也已实现持久化 `ExternalResourceRegistry` 与平台 janitor adapter。Browser runtime handle/adopt、平台 inspect seam，以及 Pwn/HTTP 的 `SessionRuntimeBroker` 与 `SessionResourceAdapter` 已接入材料层。Pwn handoff 必须同时提供理解 opaque handle 的 session runtime，HTTP handoff 必须提供 broker-owned `fetchImpl`，Browser handoff 必须提供 broker-owned context；`RunRecoveryService` 在 `supersedeOrphans` 前提取 handoff，`SessionRegistry`/`HttpSessionBackend`/`BrowserContextBackend`/`PiCodingLane` 复用原 session id，不写新的 `session_opened`。Browser replay 对每个 attempt 使用稳定 attempt id；恢复时可以从已完成 replay Artifact 重建前序 attempt，再从唯一 STARTED attempt 的 SessionRecord interaction count 继续执行；多个 STARTED、缺失前序 attempt 或没有当前进程 binding 时继续 `RECOVERY_REQUIRED/UNKNOWN`，不能把 process-local id 当成可恢复句柄。adapter 不得创建随机 session，也不得改变候选、policy、scope 或 generation。

### 11.2 P1b-3：统一 verifier outcome 与外部资源回收

四类 verifier 都产出同一份有界 `VerifierOutcomeEnvelope`：

```text
requestKey, runId, generation, candidateHash, policyHash
attempts[], primaryArtifactId, transcriptArtifactId
stageSummary, accepted, evidenceIds, externalId, terminal
```

Web/Browser 的 `attempts` 是 request/navigation/assertion；Pwn 是 protocol/primitive/stage/shell/flag；Claim 是 verifier command attempts。原始 body、截图、tube transcript 仍只在 Artifact，信封只存索引和摘要。当前 replay 信封还明确禁止 candidate、accepted、terminal verdict 和 Evidence ID，避免“观察到复现”越权成为可信结论；Claim 只有在受信 Evidence/Completion 已经提交后才允许 terminal envelope。`externalId` 由 SessionRegistry、容器运行时或平台 submission id 提供；重启后先 inspect/adopt，无法确认则保留 `UNKNOWN + RECOVERY_REQUIRED`，不猜测成功。剩余垂直切片是接入真实 backend inspect/adopt 和故障注入发布门禁。

### 11.3 P1c：预检缓存而不是逐次补工具

Run `READY` 时按 `targetKind + runtimeKey + generation` 计算 preparation cache key，一次完成：二进制工具、调试器、容器 runtime、Playwright、MCP server 的存在性、版本和可执行路径检查。结果写入 `RunToolPreparation`，并由 ActionBundle 声明每个阶段的 `toolNames/capabilityIds/maxCalls`。之后工具调用只校验缓存健康与 scope；只有 runtimeKey、generation 或工具 hash 变化时才重新预检。缺失必需工具在进入模型回合前直接转为 `permission_or_environment`，不让模型在回合中反复请求“安装/查找/补一个工具”。

Context 和 GUI 只读同一份 bounded view：当前 Gate、ActionBundle、预算、失败分类、最多 8 个 active WorkItem、最多 8 个恢复请求和最多 16 个禁止重复 key。原始日志不进入 control-view，也不改变 stable prefix。

### 11.4 P2：故障注入与发布门禁

为 Control batch、Effect `PROPOSED/STARTED/after_execute/after_artifact`、Verifier Evidence、进程重启分别提供注入点。每个场景要求：重启后 `replay(snapshot)` 与预期 hash 一致、无悬空 Artifact/Evidence/Completion、重复恢复为 no-op、未知外部结果不会升级为 accepted。发布命令固定为 `build → changed-tests → api:index:test → api:index:check → component/contract/CI gates → platform-fault-matrix → npm test → offline eval`；Docker、Browser、真实平台和 Provider 只在显式 required/allow-live 下运行。

### 11.5 P2：CI 长测试稳定性与可诊断性

发布门禁不能允许测试 worker 无限等待。当前 `npm test` 已能独立完成全量测试，但一次完整 `npm run verify` 曾出现单个 Node test worker 长时间无 CPU/网络活动且没有终态输出；这被视为 CI 稳定性缺口，而不是通过。已落地 `run-tests-with-watchdog.mjs`（默认 12 分钟、超时返回 124）和 `run-test-stage.mjs`：`npm run test:staged` 构建一次后按 fast/slow/integration 三阶段执行，每阶段输出 JSON 起止事件并保留独立日志；CI 默认并发固定为 2，需要本地并行实验时才使用 `npm run test:parallel`（并发 4）。`atomicWriteFile` 现在对 Windows 短暂 `EPERM/EBUSY/EACCES` 做有限指数退避，耗尽预算仍原样失败。剩余解决顺序固定为：

1. 已完成有界 watchdog、分阶段执行与独立日志；新增原子替换退避后，仍需在 CI 上收集不同 Windows runner 的锁争用统计，确认不会掩盖持续性权限错误。
2. 对并发写入、跨进程锁、外部资源 broker 和平台 fixture 增加重复运行/随机顺序测试；当前 fake broker 已证明“超时会失败、双 in-flight fail-closed、释放失败可重试且不误关会话、重试不产生新 Effect”。
3. 把同一契约接到真实 broker wire/fault fixture，并确保日志足够定位后再扩大外部发布门禁。

CI workflow 现在在验证成功或失败后归档 `.proofblade/test-logs/*.log`，保留 14 天；这只增强 watchdog/runner 差异的诊断能力，不把 Docker、真实平台或 Provider 凭据引入默认 CI。

该门禁只解决可观测性和确定性，不放宽任何 fail-closed 规则；测试超时、外部查询 UNKNOWN 或缺少真实 backend 都不能被包装成成功。

### 11.6 P1b-4：真实 backend 的接入顺序与启用条件

本轮新增的 crash-boundary 保护已覆盖 Browser、Pwn/HTTP session 与 Docker container：在 opaque/container handle 已知后以 `registerStarted()` 单锁登记；稳定 `bindingTxnId` 贯穿 STARTED→Control-bound，恢复按纯判定器区分 `ADOPT/RECONCILE/RELEASE/MANUAL`；恢复若发现没有对应 Control Store session，只能精确 release，释放失败保留 `UNKNOWN` 供下一轮重试，禁止 adopt 到新 lane。

下一步不是把 fake broker 换成“看起来像真实”的实现，而是按以下顺序交付一个可审计的 backend。当前已完成 create/open wire、HTTP route、client factory、持久化 service ledger、health/heartbeat/bind wire、`registerStarted()` 单锁登记和“无 Control Store session 不 adopt、只精确 release”的恢复边界；跨 ledger 的最终提升已有 `FINALIZING` fence 与幂等 marker，后续仍需把真实服务端 host、物理多文件事务和部署级故障证明补齐：

1. **Browser 创建握手**：已落地版本化、严格校验的 `/v1/browser/create` wire、可选 HTTP route、`HttpBrowserVerifierFactory` 和 `/v1/browser/bind`；它绑定 target、run/generation/policy/recipe/scope 和 verification key，要求 64 位幂等键，并把服务端 session/external id、初始 URL、state hash 转成 action/release context port。`BrowserContextBackend.open()` 现在在写 Control Store session 事件前以单次 registry mutation 记录 STARTED，owner commit 后再持久化同一 `bindingTxnId`；恢复时若找不到对应 session，只释放精确句柄而不接管。剩余工作是让真实服务以同一 request key 持久保存映射，并把这条 marker 与部署级的物理事务/故障证明接起来。
2. **Browser broker 服务进程**：已落地 `DurableBrowserRuntimeService` 的持久 ledger、原子 STARTING reservation、跨进程 create 竞态防重、精确 binding、lease/heartbeat、health/capability probe、resolver-owned action service，以及 `scripts/browser-runtime-playwright-host.ts` 的真实 Playwright host 注入入口；服务端通过注入的 host 维护 `externalId → BrowserContext` 私有映射。真实 Chromium host 在支持 `launchPersistentContext` 时还维护受控 profile root 和脱敏 host ledger，新进程可按 exact handle `inspect/adopt/resolve`，并在释放时只删除自身 profile；不支持该能力的 driver 仍明确声明 `stableAcrossRestart=false`，不得伪装成持久 daemon。现在额外提供版本化 `bind` wire：Control Store owner commit 后以同一 `bindingTxnId` 写入 broker ledger，重复 bind 是 no-op，action/heartbeat 对带 marker 的资源拒绝未绑定记录；`inspect/adopt/release/bind/action/heartbeat` 必须继续复用同一份 resource binding 校验（run、generation、effect/request、policy/recipe/scope hash）。action 只允许 `navigate/click/fill/submit/wait`，返回 bounded content、current URL、state hash；cookie、storage、截图、Page/Context 对象和任意 `evaluate` 永不出 wire。服务重启后若无持久外部映射返回 `UNKNOWN/ABSENT`，不得升级为 `MATCH`。

本地启动方式：先安装/提供 Playwright，再设置 `PROOFBLADE_BROWSER_RUNTIME_TOKEN`，运行 `npm run browser:service -- --host-module scripts/browser-runtime-playwright-host.ts`；客户端配置 `runtime.browserBroker.baseUrl` 与同名 token 环境变量。未配置 token、host 模块或真实 driver 时，CLI/GUI 不注册 Browser replay 能力并保持 fail-closed。Session Runtime 服务默认可在 `DEGRADED` 状态启动用于诊断，但发布命令应附加 `--require-ready`（或设置 `PROOFBLADE_SESSION_RUNTIME_REQUIRE_READY=1`），在绑定端口前拒绝不具备稳定恢复能力的 Host。
3. **应用接线**：CLI/GUI 启动时先做 broker health/capability probe，再注入 `HttpBrowserRuntimeBroker`、`BrowserRuntimeContextActionService` 和 resolver；远程 broker 只有同时报告 `READY` 与 `stableAcrossRestart=true` 才注册可恢复 Browser replay，缺服务、版本不匹配、鉴权失败或 resolver 无法确认时不注册。release 由 registry/janitor 重试，不能由客户端创建替代 context。
4. **平台身份**：每个平台适配器先声明 `stableAcrossRestart` 和可证明字段，再实现 query-by-idempotency/instance detail 的脱敏 wire fixture；只有 `ACTIVE + challenge + instance + owner` 精确匹配才允许 adopt/release。环境 reservation 的远端幂等 key 现在只由不可变 `ownerId + challengeId` 派生，不再混入随机 `leaseId`；同一 Run/challenge 的并发 reservation 直接拒绝，避免两个调用共享一个远端环境后互相释放。DASCTF 当前 `challenge-only + stableAcrossRestart=false`，保持人工恢复，不能把 challenge detail 当作实例租约。
5. **Pwn/HTTP/Docker**：Pwn/HTTP 已有版本化 `session-runtime-wire`（lifecycle + action）、远程 HTTP fetch/Pwn runtime proxy 和有界脱敏测试；Pwn clean reproduction 已复用同一 Broker 并确保每次分配新的 session。当前新增 `DurableHttpSessionRuntimeHost` 与 `scripts/session-runtime-http-host.ts` 作为参考生产 Host：它用状态密钥加密 Cookie/CSRF 私有账本，支持精确 scope、重启 `inspect/adopt`、bounded streaming 和幂等 release；没有状态密钥时 health 明确降级。Pwn 侧已冻结 `PwnSessionSupervisor`/`PwnSessionRuntimeHost` 适配器和 `scripts/session-runtime-pwn-host.ts` 加载入口，并落地 `DurablePwnSessionSupervisor` + `scripts/pwn-session-worker.mjs`：实际本地子进程、固定容器内 `docker exec`，或显式 allowlist 的远程 raw TCP socket和滚动 transcript 由 detached worker 持有，supervisor 只持久化 opaque handle、幂等请求和 worker 位置；worker RPC token 通过 0600 私有文件传递，不再出现在 worker 命令行，释放后清理；服务重启可对同一 externalId inspect/adopt，worker 消失则保持 UNKNOWN，不创建替代 tube。Docker 模式的 container ID 与 command allowlist 由部署配置提供，模型不能选择宿主容器；远程 endpoint 必须同时匹配部署配置的 host/port scope，远程请求里的 command 只作为 immutable hint，worker 不执行它。`npm run pwn:docker:smoke` 已提供固定镜像的可选发布验证，`pwn:docker:smoke:required` 才打开部署 gate；仍需在发布环境跑完整 Docker 故障矩阵，并继续覆盖双 in-flight、release 失败、旧 generation 越权和 transcript 断点恢复。

   **Pwn supervisor 的冻结契约（detached-worker 本地/远程 TCP/受控 Docker 参考实现已实现）**：

    - **职责边界**：supervisor 是独立进程或容器，唯一持有子进程/tube、PID/容器句柄和滚动 transcript；ProofBlade 的 `DurableSessionRuntimeService` 只持有 `idempotencyKey → sessionId/externalId/requestHash/state/lease` 元数据。不能把 Node `ChildProcess`、socket、PTY 或完整 transcript 写进 ProofBlade ledger，也不能由客户端重启时重新执行 `command` 作为替代恢复。远程 TCP 只能连接部署 allowlist 内的 endpoint，不能借此形成任意 SSRF。
   - **创建与身份**：`create(request, idempotencyKey)` 必须在 supervisor 账本中原子预约 `STARTING`，同一 key 和完整 immutable request 只能返回同一 `externalId`；`externalId` 由 supervisor 命名空间生成且跨进程稳定，不能使用 PID、临时端口或客户端随机 session id。`inspectByIdempotency` 返回 `PRESENT + 完整 created identity`、`ABSENT` 或 `UNKNOWN`，后两者都不能隐式创建第二个 tube。
   - **精确接管**：`inspect/adopt/release` 每次都校验 `runId、generation、ownerLane、mode、command/cwd、endpoint、requestKey、policyHash、scopeHash`；只有 `PRESENT + MATCH` 才允许 `adopt`，只有同一绑定才允许 `release`。旧 generation、endpoint 漂移、请求 hash 不一致或 supervisor 查询超时一律 `UNKNOWN/MANUAL`，不猜测、不误杀。
   - **动作与边界**：`pwn_write/read/signal/close` 通过现有 `session-runtime-wire` 暴露；写入/读取分块且有硬字节上限，`idle/timeout` 不等于 EOF，`signal` 只允许 supervisor 映射后的受控信号，`close` 与 lease release 都必须幂等。action 返回增量、`waitReason、exited、exitCode、truncated`，原始长 transcript 留在 supervisor/Artifact，不进入模型上下文。
   - **租约与恢复**：每次 action 前 heartbeat 精确刷新租约；supervisor 重启先按 idempotency 扫描 `STARTING`，只能提升明确找到的完整 identity，无法判断则保留 `UNKNOWN`。ProofBlade `RunRecovery` 顺序固定为“无 owner 精确 release → backend inspect/adopt → `EXTERNAL_CONFIRMED` → Control commit → marker/finalize → handoff”，任何一步失败都可重试且不会创建替代 tube。
    - **发布验收**：注入式 supervisor contract fixture、detached-worker process fixture 和本地 TCP fixture 已验证双 create、host 重启、双 in-flight、旧 generation、action 超限、scope 拒绝、远程 signal 语义、adopt/heartbeat/release 失败和重复恢复；remote TCP BindingTransaction fault matrix 已覆盖五个崩溃边界；`npm run pwn:docker:smoke[:required]` 提供固定镜像 happy path，`npm run pwn:docker:fault-matrix[:required]` 提供固定镜像跨账本故障 gate。真实 DASCTF tube 不是 CI 前置，但没有 worker 跨进程证据时，health 必须声明 `stableAcrossRestart=false`，Coding lane 按 Pwn kind fail-closed。
6. **发布闸门**：先跑本地 wire/fault/restart fixtures，再跑 `browser:smoke:required`、Docker Pwn required smoke 和平台 adapter targeted；这些部署证据也可由 `npm run deployment:preflight:required` 按固定顺序统一编排。最后在显式 `--allow-live --enforce-gate` 下跑私有 Web/Pwn corpus 与两个有价格的 Provider variant。任何一步缺少真实 identity、结果或成本数据，都只能报告 `UNKNOWN/SKIPPED`，不得提升为解题率或恢复成功。

启用条件固定为：协议版本兼容、认证与 scope 校验通过、稳定句柄能力声明为真、四类中断点和重复恢复为 no-op、Artifact/Evidence/Effect 引用完整，以及 required smoke 和私有评测均达到门槛。未满足条件时，生产配置继续使用当前 fail-closed 的本地 Playwright/HTTP/Pwn 路径。

### 11.7 下一阶段：跨 ledger handoff 的最终原子提升

远程 TCP 的真实 detached worker 已加入 Control Store commit 边界测试，并在重启后完成精确 inspect/adopt、恢复后继续读写和释放；`npm run pwn:docker:fault-matrix:required` 已提供同一套 Docker 部署级故障矩阵 gate，部署环境仍需实际执行并保留镜像、daemon 与结果证据。

当前 `registerStarted() → session_opened → markControlBound()` 已经把崩溃窗口变成可判定的 `RELEASE/RECONCILE/MANUAL`，但两个账本仍不是同一物理事务。第一版 `BindingTransactionCoordinator` 已经落地并接入 Pwn/HTTP/Browser/Container session open：它把 PREPARE、EXTERNAL_CONFIRMED、CONTROL_COMMITTED、BOUND intent 写入独立 durable journal，Control Store 事件携带 `bindingTxnId + bindingIdentityHash`，恢复入口会先重放 coordinator，再交给 backend inspect/adopt。当前已用真实 detached Pwn worker 覆盖本地与 remote TCP 的 `after_control_commit → inspect/adopt → recover` 和完整 remote fault matrix；下一阶段继续补齐 Docker/remote host 的部署级多进程故障矩阵，不把协议扩散到所有 Effect：

本轮已补上最终提升前的 Control Store fence：coordinator 提交 owner 时写入 `bindingState=FINALIZING`，external marker 完成后必须在同一 Run 锁内追加受 binding authority 保护的 `session_binding_completed`，才允许 intent 进入 `BOUND`。如果 close 或进程退出发生在 marker 与 fence 之间，恢复会保留 `CONTROL_COMMITTED/FINALIZING` 并进入 release/manual 分支，绝不会把已关闭 owner 升级为 BOUND；没有该字段的旧 session 仍按兼容路径重放。对应的跨 ledger close race、伪造 binding event、恢复和重试回归已加入 binding transaction 测试。该 fence 仍不是物理多文件事务，部署级 Docker/remote fault proof 和真实 backend 身份能力仍是发布门槛。

本轮还保留了一个兼容旧记录的保守子路径：对没有 coordinator intent、但 immutable identity 完全匹配且 Control Store owner 仍为 OPEN 的资源，`RunRecoveryService` 执行 metadata-only marker repair，然后继续标准 `inspect → adopt`。该修复不联系外部 backend、不创建新 session；若 marker 写入遇到并发或不一致，仍回到 `UNKNOWN/MANUAL`。

1. **Prepare**：`BindingTransactionCoordinator.prepare()` 生成不含 opaque handle 的 `bindingTxnId`，在 External Resource ledger 写入 immutable `run/generation/kind/request/policy/recipe/scope` 和 `STARTED`；同一事务的 intent journal 记录 `resourceId + sessionId + bindingTxnId + identityHash`。
2. **External confirm**：backend 精确 `inspect → adopt` 成功后，协调器追加 `EXTERNAL_CONFIRMED`；仅有 `STARTED/UNKNOWN` 时不得进入该状态。
3. **Control commit**：`commitControl()` 让 Control Store 的 `session_opened` 携带同一 `bindingTxnId + bindingIdentityHash`；写入前后都校验 intent，重复调用读取已有 OPEN owner，不追加第二个 session。
4. **Finalize**：`finalize()` 把 intent 推进到 `CONTROL_COMMITTED`，再在 External Resource ledger 写 `controlSessionId`，最后推进 `BOUND`；任何一步崩溃都能从 intent 重试，重复 finalize 是 no-op。
5. **Recovery**：`recover()` 先读取 intent，再比较两账本和当前 generation：两边 exact match 且 intent 已提交才 `ADOPT`；Control 已提交但 marker 缺失则补 marker 后 `ADOPT`；只有 External `STARTED` 则交给 backend 精确 `RELEASE`；任何 hash、owner、generation 或 session 不一致都 `MANUAL/UNKNOWN`，绝不创建替代 session。
6. **故障矩阵**：固定注入 `after_external_started`、`after_intent`、`after_external_confirmed`、`after_control_commit`、`after_finalize`、重复恢复、双进程并发和 release 失败；验收条件是两账本最终一致、projection hash 不变、没有第二个 session、未知状态可重试且不误释放。当前已覆盖 coordinator happy path、Control commit 后恢复、重复恢复 no-op、同进程并发、独立 Node 进程并发 owner commit，以及真实 detached Pwn 本地/remote TCP 在 Control commit 边界后的 inspect/adopt/recover 和 remote fault matrix；真实 Docker 跨进程 fault fixture（含 release 失败）仍未完成。

实现边界：事务协调器只负责 handoff 元数据和恢复，不持有 socket、cookie、token、命令行或响应正文；真实 host 仍由 `SessionRuntimeHost`/Browser host 提供。这样可以在不破坏现有 `ControlStore` 事件语义的前提下，逐步把 Pwn/HTTP/Browser 的跨重启证明接到同一个提交协议。
