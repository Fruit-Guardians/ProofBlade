# 从第 6、9 章看 ProofBlade 的统一 Agent 开发建议

> 状态：开发建议
>
> 日期：2026-08-29
>
> 适用范围：ProofBlade 的普通 Chat、CTF Chat、Fixture、Competition、Coding Lane、上下文维护、工具调用、证据和长期运行。

## 1. 先给结论

这次阅读带来的最重要结论不是“把动态上下文重新排序”，而是要把 ProofBlade 从“模型回合 + 工具返回”的局部循环继续推进为一个**由统一事件驱动、在安全点恢复、由证据推动整理的长期运行系统**。

当前实现把变化的 ProofBlade 上下文追加到 transcript 后面，这个方向是对的。因为动态块已经位于完整消息历史之后，所以动态块在尾部内部的排列顺序不会把它们变成 Provider 可复用的前缀，也不会直接提高上游 KV Cache 命中率。排序仍有价值，但价值属于客户端和上下文投影层：

- 决定预算不足时优先保留什么；
- 决定哪一类内容先被 snip、prune 或转换成 placeholder；
- 决定本地投影和压缩时可以从哪一块开始增量重建；
- 让 ContextManifest、GUI 和 replay 能稳定比较“哪一块发生了变化”；
- 为未来的 checkpoint-prefix 模式提供确定性的块边界。

因此，不应把“稳定内容在动态尾部靠前”描述成当前 Provider KV Cache 优化。当前模式仍然是：

```text
System + fixed Tool Schema
  -> persisted transcript
  -> latest user/assistant/tool interaction
  -> ProofBlade dynamic suffix
```

第 6 章提供的是时间轴上的启发：外部事件、后台任务和用户消息不应依赖模型下一次主动轮询，长任务必须可监控、可打断、可恢复，动作之后必须重新观察环境。第 9 章提供的是长期演化启发：先评价再总结，在线执行只记录可追溯证据，整理和更新进入可验证、可回滚的离线或空闲闭环。

本提案建议保持一个统一系统：

```text
所有输入/输出/工具/作业/维护事件
              |
      一个 ControlStore 事件流
              |
      一个安全点事件循环
              |
      一个 Coding Lane / RunCoordinator
              |
  ContextCompiler + Evidence + Artifact + Verifier
```

内存队列、ContextManifest、ArtifactStore 和 GUI 都只能是现有事件流的投影、缓存或访问入口，不能成为第二份任务真相，也不能为普通 Chat、CTF 和 Fixture 建立不同的完成、证据或恢复系统。

## 2. 参考章节与链接说明

用户消息中的 Markdown 显示文字是 chapter9，但实际 href 指向 chapter6：

- 显示为 chapter9 的实际链接：[第 6 章：交互：观察与动作空间的扩展](https://bojieli.github.io/ai-agent-book/book/chapter6/)
- 同时核对的 chapter9：[第 9 章：Agent 的持续进化](https://bojieli.github.io/ai-agent-book/book/chapter9/)

两章都纳入本建议。第 6 章回答“Agent 如何持续接收世界变化并行动”，第 9 章回答“Agent 如何从运行经验中更新并保持长期质量”。

### 2.1 第 6 章的工程要点

第 6 章把回合制 Agent 的隐藏假设显式化：模型在生成期间，世界并不会静止。用户可能插话，后台命令可能产生新输出，外部 API 可能回调，页面和物理环境可能改变。因此需要以下能力：

1. **事件驱动而不是只有轮询**：用户消息、工具完成、外部回调、定时器和监控信号都进入事件流。
2. **安全点消费事件**：事件不应任意插入正在执行的 Tool pair 或半成品 Provider stream，而是在一次推理、一次工具返回或一次可控取消之后批量消费。
3. **按紧急度选择队列、取消或并行**：紧急事件可以请求取消当前可取消动作；普通事件排队；独立的轻量工作可以并行。
4. **长任务必须有监控入口**：不能让模型反复调用 read 来检查后台命令，也不能等进程完全结束才知道已经卡死。监控应由新增输出、关键词、退出、错误和心跳触发。
5. **动作之后重新观察**：一次点击、写入、执行或状态变更只代表期望动作，不代表目标状态已经成立。后续计划必须依据新观察修正。
6. **快慢分离**：低延迟层负责接收事件和给出状态，较慢的推理、规划、整理和验证在后台推进，但二者必须共享同一个持久状态和事件契约。

这些结论直接对应 ProofBlade 已经遇到的“指令卡住半天、强行停止、没有提示、证据没有节点”和“后台任务只能被动读取”的问题。

### 2.2 第 9 章的工程要点

第 9 章的核心不是让 Agent 每轮写一篇反思，而是建立一个可归因、可验证的持续演化闭环：

1. **保存经历不等于学习**：原始轨迹只能说明发生过什么；跨轨迹比较、归纳、验证后才形成可复用经验。
2. **评价先于总结**：先通过结果验证、过程验证和质量量表判断任务哪里成功、哪里失败，再让模型生成经验草案。
3. **选择正确的更新载体**：事实和行动经验适合知识；可清楚表达的策略适合 Prompt/Skill；硬约束和精确流程适合程序；高维能力才考虑参数更新。
4. **在线记录与离线整合分离**：在线路径不能因一次偶然成功、网络故障或提示注入立即修改正式能力。
5. **最小修改、独立验证、保留集回归**：更新是带来源的局部 diff，不是重写整个 Prompt；触发失败的边界集要改善，原本通过的保留集不能退化。
6. **保留负面结果和失败原因**：被拒绝的假设、失败实验、工具错误和停止原因不能被压缩成“无用历史”，否则系统会反复走同一条死路。
7. **区分更新能力和受益能力**：系统产生了正确 Skill，不代表后续 Agent 能检索、激活并遵守它。激活率和遵循率必须单独测量。
8. **持续整理需要过期、冲突和回滚机制**：经验库、Prompt 和 Skill 不能无限追加，必须保留版本、适用条件、最近验证时间和撤销路径。

## 3. ProofBlade 当前状态对照

以下判断以当前源码和已有文档为基线，不把本建议中的目标能力当作已经交付的实现。

| 领域 | 当前已有能力 | 仍需重点补齐 |
| --- | --- | --- |
| 权威状态 | ControlStore、Reducer、Effect Journal、RunSnapshot、Work Graph | 将新事件入口统一绑定到现有事件日志，不再由内存队列独立记账 |
| 上下文 | ContextCompiler 的 L0-L5、ContextManifest、动态尾部、压缩和 Tool pair 修复 | 块元数据、事件驱动的维护触发、用户可选择压缩目标、块级变化诊断 |
| Provider | 并发队列、idle watchdog、有限重试、重试退避、RequestEpoch、cacheRead/cacheWrite 观测 | 将排队、首 token、流间空闲、重试、卡住和恢复做成用户可见的状态事件 |
| Tool | 统一 Tool Contract、结构化错误、Effect/Artifact、后台 Job、取消接口 | `monitor_shell` 类增量监控、事件唤醒、幂等键、部分结果和 unknown 结果的统一恢复 |
| Evidence | Evidence Graph、Artifact 引用、Verifier、Evidence curation、失败/重复护栏 | 把整理作为低优先级可恢复维护，不让文书压力阻断探索；统一生成 L0/L1/L2 投影 |
| 恢复 | Lease、Job、Effect、Fixture、Pi compaction 和 replay 恢复 | “需要恢复”必须进入事件循环，不能以无提示强制终止作为默认出口 |
| GUI | SSE 流式状态、Tool 生命周期、Token/缓存和上下文显示、暂停/恢复 | 实时显示队列、卡住原因、下次自动动作、当前事件和预计维护点 |
| 评测 | provider-free 运行时场景、holdout、Replay Parity、成本和延迟指标 | 异步事件、监控、重试、压缩、无硬停、持续整理和更新受益能力的矩阵 |

### 3.1 上下文尾部的准确含义

`injectReasoningForestContext()` 在 `packages/materials/src/runtime/coding-lane.ts` 中把变化的 Forest 内容追加到现有消息数组末尾。其设计目标是保留 transcript 的前缀和 Tool pair 顺序，这个目标应继续保留。

`ContextCompiler` 在 `packages/materials/src/context/compiler.ts` 中把 L0-L5 编译成结构化消息。当前 L0/L1 可作为稳定指纹，L2-L5 仍属于动态任务内容。这里有三个容易混淆的层次：

```text
Context Layer:   L0-L5   一次请求包含哪些信息
Knowledge Level: K0-K2   某个知识对象加载到什么深度
Placement Band:  P0-P10  在动态投影中的排列和处理优先级
```

建议继续使用三套正交编号，不要把它们合并成一套“缓存层级”。

### 3.2 需要修正的缓存表述

当前追加式模式下，Provider 通常根据完整消息前缀匹配缓存。假设相邻请求如下：

```text
请求 A: system -> tools -> old transcript -> suffix A
请求 B: system -> tools -> new transcript -> suffix B
```

即使 suffix B 内部把 durable ledger 放在 artifact pointer 前面，A 和 B 的共同前缀通常也只到 `new transcript` 之前。动态块排序不会把 suffix A 中的某一段单独变成 Provider 的命中边界。

所以指标必须拆开：

- `stablePrefixHash`：客户端生成的稳定前缀形状，发现 System/Tool 是否漂移；
- `dynamicSuffixHash`：动态投影是否发生变化；
- `localProjectionReuse`：本地是否只重建了受影响的块；
- `cacheRead/cacheWrite`：Provider 实际报告的缓存 Token；
- `firstChangedMessage`：完整消息历史中最早变化的位置。

只有 Provider 的 `cacheRead` 才能证明上游发生了缓存复用。前缀稳定而 `cacheRead=0` 可能是中转站没有缓存，不能从上下文文本长度推断命中。

## 4. 统一系统目标架构

### 4.1 一个事件模型覆盖所有来源

建议在现有 domain event 和 ControlStore append/reduce 机制上增加统一的 `RunEventEnvelope` 概念。它是事件的通用外壳，不创建第二个日志：

```ts
interface RunEventEnvelope {
  id: string;
  runId: string;
  generation: number;
  source: "user" | "provider" | "tool" | "job" | "external" | "timer" | "maintenance" | "verifier";
  kind: string;
  priority: "urgent" | "normal" | "background";
  status: "queued" | "admitted" | "deferred" | "applied" | "coalesced" | "failed";
  sequence: number;
  correlationId: string;
  causationId?: string;
  coalescingKey?: string;
  deadlineAt?: string;
  replayPolicy: "pure" | "idempotent" | "unknown" | "never";
  payloadRef?: { artifactId?: string; eventType: string; hash: string };
  createdAt: string;
}
```

事件 payload 大于上下文预算时只保存 Artifact 引用和短摘要；完整输入仍在现有 ArtifactStore 或原始 session 中。事件 envelope 记录“要处理什么”和“如何恢复”，而不是复制一份新的事实库。

统一事件来源至少包括：

```text
user.message                 用户新消息
provider.queued/started/...  Provider 排队、开始、重试、完成、卡住
provider.progress            流式进度或首 token
tool.started/progress/end   Tool 生命周期
job.output/keyword/exit      后台作业监控结果
external.callback            外部回调或连接通道
timer.due                    一次性或周期性维护触发
maintenance.pressure        上下文、证据或 Artifact 压力
verifier.result              结果/过程/质量验证
```

### 4.2 一个事件循环，而不是多套 Agent

建议扩展现有 `RunCoordinator`、`SingleAgentLoop` 和 Coding Lane，而不是新增普通 Chat Agent、领域 Agent、后台 Curator Agent 三个执行系统。维护任务可以作为同一个 Run 的低优先级 WorkItem 和事件批次执行。

安全点事件循环的逻辑如下：

```text
append incoming event to ControlStore
  -> reducer materializes queue/status projection
  -> classify priority, generation, replay and coalescing key
  -> if current step is unsafe, defer without changing transcript
  -> at provider/tool/turn safe point, admit a bounded event batch
  -> apply user cancel, provider result, job progress or maintenance event
  -> rebuild ContextManifest and dynamic suffix
  -> continue, retry, compact, replan, wait or request user input
```

“队列”可以在内存中加速，但重启后必须由 ControlStore 事件重建。队列顺序、是否消费、是否合并和未完成状态都不能只存在于进程内。

### 4.3 可恢复状态与终态分离

目前的 `RunStatus` 有 `PAUSED`、`NEED_HUMAN`、`FAILED`、`EXHAUSTED` 等状态。建议明确以下语义：

| 情况 | 运行状态 | Agent 行为 |
| --- | --- | --- |
| 上下文接近预算 | `RUNNING` | 自动 snip、整理、压缩并继续 |
| Tool 超时但状态未知 | `RUNNING` 或 `PAUSED` | 记录 unknown，执行 reconcile，不重放未知副作用 |
| Provider 流暂时卡住 | `RUNNING` | 记录 stalled，重试或更换可用路径，持续给出状态 |
| 证据不足 | `RUNNING` | 降低结论可信度、提示下一步，不强制停机 |
| 重复失败或无进展 | `RUNNING` | 进入维护/重规划 WorkItem，禁止完全相同调用，继续探索 |
| 用户明确暂停 | `PAUSED` | 保留队列和快照，等待恢复事件 |
| 用户明确取消 | `CANCELLED` | 取消可取消动作并完成资源回收 |
| 外部不可恢复且需要决定 | `NEED_HUMAN` | 保留所有证据和恢复入口，进程与 GUI 不消失 |
| 已通过独立 verifier | `SUCCEEDED` | 形成完成记录，不再以模型文本覆盖结果 |

关键原则是：**recoverable pressure 不是 terminal stop**。上下文压力、一次 Tool 错误、Provider 暂时超时、Evidence 尚未整理和重复探索都不能直接把 Agent 强行停止。对于确实不能安全继续的外部动作，应把运行置于可恢复等待或人工介入状态，而不是让 UI 没有任何提示。

## 5. 上下文、压缩和 KV Cache 建议

### 5.1 保持追加式动态尾部

第一阶段不改变消息历史顺序：

```text
P0  System 和固定 Tool Schema
P1  Run-stable 配置
    persisted transcript，保持原始顺序
P2  immutable TaskContract
P3  K0 root/schema index
P4  L3A durable reasoning ledger
P5  当前 Run runtime state
P6  K0 volatile state + selected K1
P7  L3B active controls
P8  L5 Artifact pointers
P9  L4 recent Tool placeholders
P10 K2 原始内容，显式读取时临时出现
```

P2-P10 仍作为动态尾部整体追加。P4 在 P7 前面不是为了让 Provider 只缓存 P4，而是为了：

- 在预算不足时先保护长期推理和验证链；
- 让高频 Lease、Job heartbeat、短期状态先成为裁剪候选；
- 让压缩后再次生成的 suffix 有固定结构；
- 让本地 `firstChangedBlock` 诊断可解释。

L3 必须逻辑拆成 `L3A durable ledger` 和 `L3B active controls`。Lease heartbeat、Job progress、队列等待和临时维护提示不能污染 L3A，否则长期推理摘要会随每个后台事件重写。

### 5.2 块模型与确定性序列化

建议给 ContextCompiler 内部每一块增加统一元数据：

```ts
interface ContextBlock {
  id: string;
  band: "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";
  layer: "L0" | "L1" | "L2" | "L3A" | "L3B" | "L4" | "L5" | "K0" | "K1" | "K2";
  content: string;
  required: boolean;
  volatility: "immutable" | "run_stable" | "low" | "medium" | "high" | "very_high";
  sourceIds: string[];
  contentHash: string;
  estimatedTokens: number;
  compressible: boolean;
}
```

统一序列化规则：

```text
sort by band
  -> fixed block order
  -> stable sequence or canonical id
  -> serialize once
  -> calculate block hashes and first changed block
```

Evidence、Coding Lane、GUI 和 replay 不应分别拼接自己的顺序。它们可以请求同一 ContextCompiler 的不同视图，但不能生成第二套排序逻辑。

### 5.3 当前阶段不做 checkpoint-prefix 激进改造

如果将 TaskContract、K0 root 和 L3A 放到 transcript 前面，理论上可以让它们参与 Provider prefix reuse：

```text
System + tools
  -> TaskContract + K0 root + L3A checkpoint
  -> user message
  -> assistant/tool transcript
  -> active suffix
```

但 checkpoint 一旦更新，checkpoint 后的整段 transcript 都可能失去上游缓存复用。因此只能在以下边界更新：

- consolidate 完成；
- 一次持久 compaction 完成；
- 用户明确请求整理；
- generation reset；
- 大批量任务阶段切换。

不能因为每次 Evidence、Lease heartbeat 或 Tool Result 变化就更新 checkpoint。建议先实现块级测量和真实 `cacheRead` 对照，再决定是否增加这种模式；当前追加式尾部本身不需要为了缓存重新排列。

### 5.4 手动选择压缩点

用户需要看到并能控制“距离满上下文还有多少”，但界面不应暴露多套互相矛盾的阈值。建议建立一个统一 `ContextMaintenancePolicy`：

```ts
interface ContextMaintenancePolicy {
  targetRatio: number;
  hardRatio: number;
  autoConsolidate: boolean;
  keepRecentTurns: number;
  selectedCompressionTarget?: "tool-results" | "recent-transcript" | "ledger" | "all";
}
```

其余 notice、snip、prune、compact、force 的边界由这个策略和当前 ContextWindow 确定性推导。GUI 显示：

```text
used / available input tokens
remaining tokens
target compression point
hard boundary
next maintenance action
largest compressible band
last consolidation result
```

用户手动选择的是目标压缩点或目标范围，不是修改 ControlStore 的事实，也不跳过 Tool pair、Effect unknown、当前任务和验证链的硬保留规则。

### 5.5 三层知识与工具结果压缩

上下文整理可以同时是一次压缩，但必须把“压缩 Provider 视图”和“删除原始事实”彻底分离：

```text
L0 abstract:    一句话说明对象是什么、是否与当前任务相关
L1 overview:    当前结论、适用条件、反例、下一步和来源索引
L2 raw:         Artifact/Session 的完整原始内容，按需有界读取
```

推荐流程：

```text
Tool/Provider 原始结果
  -> ArtifactStore immutable raw
  -> 单次运行观察/失败分析
  -> evidence.consolidate 生成 L0/L1、links、next action
  -> 确认投影成功后，把旧 Tool Result 替换为 placeholder
  -> 需要时通过 read_artifact/search_history/load_skill 读取 L2
```

整理应由 Agent 调用已有统一 Tool/Capability 入口完成，而不是要求模型在每次工具调用后手工维护一份账本。维护调用应是低优先级、可中断、可重试和幂等的 WorkItem。

硬保留内容包括：TaskContract、当前用户任务、未完成 Tool pair、STARTED/UNKNOWN Effect、运行中 Job、当前候选验证链、唯一失败诊断、Artifact URI/hash/generation 和被拒假设索引。重复搜索结果、已进入 L3A 的旧原始输出和无关 Artifact 正文属于软保留。

## 6. 工具、Provider 和延迟可靠性

### 6.1 Tool 生命周期必须可观察

统一每一次 Tool/Capability/后台作业的生命周期：

```text
planned
  -> queued
  -> started
  -> progress* / monitor signal*
  -> succeeded
  -> failed | timeout | cancelled | unknown
  -> reconciled | superseded
```

每个阶段至少记录 `toolCallId/jobId`、Effect id、generation、backend/version、开始时间、结束时间、输出字节、Artifact hash、error code、retryable、replay policy 和 Evidence contribution。GUI 应能在 Tool 还未结束时显示当前节点和下一步，而不是只在最后收到一个结果。

### 6.2 增加 monitor_shell 语义，但复用后台 Job

现有 `run_background`、`read_job_output`、`stop_job` 已经提供了后台执行基础。建议增加的是统一监控操作或同一工具 contract 的 monitor operation，不是再建第二个 Job 系统：

```text
monitor_job(jobId, sinceCursor, triggers)
triggers = [new_output, keyword, exit, error, heartbeat]
```

要求：

- `sinceCursor` 是 Job 输出的单调游标，避免重复读取；
- 新输出按时间窗或字节上限合并，避免每一行唤醒 Provider；
- 关键词匹配返回行范围、Artifact id 和匹配 hash；
- 进程退出必须生成终态事件，即使没有 stdout；
- 卡死只产生 `job.stalled`，触发 reconcile 或重规划，不让整个 Run 消失；
- `stop_job` 是显式取消动作，必须记录是否真的停止，不能把请求发送成功当作进程已停止；
- 监控事件可以唤醒同一个 Coding Lane，不创建后台 Solver transcript。

### 6.3 工具失败的统一分类与自动修复

现有 `packages/materials/src/tools/errors.ts` 已有结构化错误分类。建议把错误分类直接接入事件循环的恢复矩阵：

| 错误 | 默认动作 | 是否可重试 |
| --- | --- | --- |
| `BAD_TOOL_ARGS` | 读取当前 schema，修正参数，禁止原样重发 | 只允许改参后重试 |
| `TOOL_NOT_FOUND` | 刷新 catalog/status，重新选择能力 | 目录变化后重试 |
| `TOOL_TIMEOUT` | 检查 Job/Effect 状态，缩小范围或转后台 | 仅 replay-safe |
| `TOOL_ABORTED` | 判断是谁取消、是否仍 active，进入恢复事件 | 按策略 |
| `PERMISSION_DENIED` | 检查 TaskContract scope，换到允许资源 | 不允许盲重试 |
| `TOOL_EXECUTION_FAILED` | 保存 error signature 和 Artifact，改变假设或 backend | 按 backend/replay policy |
| `EFFECT_OUTCOME_UNKNOWN` | reconcile 外部状态，禁止重复副作用 | 不直接重放 |

自动修复必须改变操作、参数、范围、Backend 或恢复阶段中的至少一项。相同 `operation + argsHash + errorSignature` 不能无限重试；达到重复上限时进入维护或重规划 WorkItem，仍保持 Run 活跃。

### 6.4 Provider 调度和“卡住”处理

现有 `provider-scheduler.ts` 已有 Provider 级并发槽、队列、idle watchdog、流级重试和指数退避。这些能力应继续保留，但要把“技术上的 attempt 终止”和“Agent Run 被强行终止”区分开：

- Provider attempt 可以因流空闲超时而结束，并在同一 stream boundary 重试；
- 重试不能泄漏半截流，不能让同一个 Agent turn 或 Tool 再执行一次；
- 队列等待、实际请求、首 token、最后 token、流间空闲、重试等待和总耗时分别记录；
- Retry-After、429、5xx、连接断开、无 terminal event 和本地 abort 不能合并为一个模糊错误；
- 超过重试上限时应生成 `provider.recovery_required`，由同一 Run 选择等待、切换已允许 Provider、降级输出或请求用户输入；不能只让 UI 静默结束；
- 需要继续长期运行时，Run 可以处于 `PAUSED`/`NEED_HUMAN` 等可恢复状态，进程资源得到回收，但事件和恢复入口保留。

推荐的延迟指标：

```text
queueWaitMs
providerConnectMs
timeToFirstEventMs
timeToFirstTokenMs
interEventIdleP50/P95/P99
providerTotalMs
retryCount / retryDelayMs
toolQueueWaitMs / toolExecutionMs
timeToFirstEvidenceMs
timeToRecoveryEventMs
```

“一直跑”不等于让一个失去响应的 HTTP stream 永远占住并发槽。正确目标是 Run 不丢失、状态不断流、可恢复动作自动执行、不可判断的外部状态进入 unknown/reconcile，而不是无限占用一个已经失去进展的请求。

## 7. 证据、上下文整理和持续演化

### 7.1 在线路径只做轻量记录

在线任务的每次工具调用只需要完成这些动作：

1. 保存原始输出到 Artifact；
2. 记录结构化 Tool/Effect/Job 结果；
3. 在确有新信号时生成简短 Observation 或 Evidence；
4. 关联已有 Hypothesis、Fact、Tree 和 WorkItem；
5. 判断是否需要自动维护提示，但不强制马上全文整理。

在线路径不应该在每个 `read`、`bash` 或 Provider token 后调用 LLM 做长篇总结。这样会把探索变成文书工作，也会反过来制造更多动态上下文。

### 7.2 空闲或无新思路时集中整理

满足以下任一条件时，创建同一个事件循环中的 `maintenance.consolidate` WorkItem：

- 动态 Tool 输出达到策略目标比例；
- 新增多个未整理 Artifact/Evidence；
- 相同 URI、命令、参数或错误反复出现；
- 现有 Evidence 没有被后续推理引用；
- 当前 Hypothesis 没有新支持或反驳；
- Agent 连续产生无 durable progress 的动作；
- 用户明确请求“整理上下文/证据”；
- Provider 或 Tool 空闲，且没有更高优先级事件。

整理 WorkItem 的输出必须同时包含：

```text
Knowledge result:
  L0/L1 summary, source ids, conflicts, hypothesis update, next action

Context result:
  replaceable message ids, placeholder text, retained refs,
  before/after tokens, compaction policy and projection hash
```

只有 Knowledge result 已经持久化并可重建时，才允许把 Provider 视图中的原始 Tool Result 替换为 placeholder。整理失败时保留原视图，不产生半成品状态。

### 7.3 证据要求采用软门控

证据系统要区分三件事：

- 探索观察：可以低成本写入，表示“看到了什么”；
- 结构化推理：需要来源和关系，表示“为什么支持或反驳”；
- 完成确认：必须满足统一 verifier 和任务契约，表示“是否真的完成”。

前两者不能被过度严格的文书门槛阻塞。没有足够证据时，系统应提供轻量提示、记录 `evidence_gap` 并继续允许新观察；当连续无新思路或接近压缩点时再集中整理。最后的 deterministic claim、Completion 和可信结果仍由统一 verifier 掌握。

普通 Chat、CTF、Fixture 和 Competition 共用这个门槛。差异只能来自 TaskContract 的 verification policy 和目标环境，不允许出现普通 Chat 一套 `verify_claim` 语义、CTF 另一套 Evidence/Completion 语义。

### 7.4 持续演化的更新载体

从轨迹得到稳定问题后，按以下顺序选择最小更新位置：

| 问题性质 | 首选载体 | 例子 |
| --- | --- | --- |
| 对当前任务有用的事实或行动经验 | K1/知识投影 | 某类 API 版本下的调用前检查 |
| 可清楚描述、作用域有限的行为规则 | Skill 或局部 Prompt | 缺少参数时先向用户询问 |
| 权限、预算、幂等、状态转换和硬门槛 | 程序/Harness | 禁止重复副作用、Tool pair repair |
| 语言风格、感知或隐式策略 | 模型评估/训练管线 | 只在有独立数据和回归集时考虑 |

更新对象必须是版本化的最小 diff，包含：触发问题、支持轨迹、反驳轨迹、适用条件、变更前后 hash、迁移集、保留集、安全集、评测结果、批准状态和 rollback pointer。系统不可让待更新 Agent 修改批准自身更新的 verifier、评测基线、审计日志或稳定版本备份。

### 7.5 两个独立指标：更新成功与使用成功

每个更新提案至少测量：

```text
proposalAcceptanceRate  提案在独立验证中有价值的比例
activationRate          后续任务正确加载知识/Skill/工具的比例
followingRate           加载后按规则执行的比例
triggered-set gain      触发失败集的改善
holdout regression      保留集是否退化
cost/latency delta      Token、Provider 和 Tool 成本变化
safety delta            越权、注入、虚假完成和重复副作用变化
```

一次成功的当前任务不能单独证明 Agent 已经学习。一次文档写入也不能证明后续 Agent 会找到、激活并遵循该文档。

## 8. 分阶段开发建议

### Phase 0：统一契约和观测基线

**目标**：先让所有状态变化可解释，不改变现有任务流程。

**建议改动**：

- 在 `packages/materials/src/domain` 增加统一事件 envelope 的类型和 canonical hash；
- 复用现有 ControlStore event schema、RequestEpoch、Effect、Job、Evidence 和 WorkItem；
- 为 Provider/Tool/Job/Compaction/Evidence 增加统一 `correlationId`、`causationId`、`generation` 和 `replayPolicy`；
- 在 GUI 和 `RunTelemetry` 中区分 queue wait、execution、recovery 和 maintenance latency；
- ContextManifest 增加 block hash、firstChangedBlock、dropped reason 和 compression target。

**验收**：任何一次 Provider、Tool、Job、Evidence 或维护动作都能从 GUI/CLI 追溯到同一 Run、同一 generation 和同一恢复入口；重放后 projection hash 稳定。

### Phase 1：安全点事件循环

**目标**：让外部输入和后台状态可以唤醒同一个 Coding Lane。

**建议改动**：

- 扩展现有 `RunCoordinator`/`SingleAgentLoop` 的输入入口，所有输入先 append event；
- 在 Provider 完成、Tool 返回、Job 进度和用户消息边界统一 drain 事件；
- 增加 urgent/normal/background 三种优先级和 generation fencing；
- 让可恢复压力进入 `maintenance` 或 `replan` WorkItem，不再调用终止型 guard；
- 明确用户 pause/cancel 与系统 recoverable retry 的不同终态。

**验收**：长 Provider 请求期间用户消息不会丢失；后台 Job 完成会自动进入下一安全点；上下文压力不会无提示结束 Run；第二次 recovery pass 是 no-op。

### Phase 2：后台作业监控和 Provider 状态流

**目标**：消除主动轮询和“卡住半天没有任何节点”。

**建议改动**：

- 在 `packages/materials/src/tools/runtime.ts` 的 Job 基础上增加 monitor cursor 和 trigger；
- 在 `solver-tools.ts` 暴露统一 monitor operation，继续通过同一 Effect/Artifact 链；
- 在 `provider-scheduler.ts` 和 `observability/pi-events.ts` 增加首事件、流间空闲、重试、recovery required 事件；
- UI 对 queued、started、progress、stalled、retrying、reconciliating、completed 状态提供持续投影；
- 进程和请求状态未知时只进入 reconcile，不自动重复有副作用的动作。

**验收**：模拟 Provider 中途停流、HTTP 200 后无终态、Tool 卡死、后台命令输出增长和进程退出；所有场景都有可见事件、最终状态和不重复重试结果。

### Phase 3：统一 Context Block 和可控压缩

**目标**：提高本地投影和压缩质量，同时保持当前 transcript/cache 语义。

**建议改动**：

- 重构 `ContextCompiler` 为统一 block builder + serializer；
- 把 L3 拆为 L3A durable ledger 和 L3B active controls；
- 将 Forest、K0、K1、Artifact pointer 和 Tool placeholder 放入同一 dynamic suffix 容器；
- 将 P9/P10 大输出优先转换成 Artifact pointer/L0/L1，而不是删除原始 Artifact；
- 增加 GUI 的单一 ContextMaintenancePolicy 和手动目标压缩点；
- 缓存报告同时显示 stable prefix、dynamic suffix、本地复用和 Provider 实测 cacheRead。

**验收**：动态 Evidence 增加不改变 P0/P1 hash；Lease heartbeat 不改变 L3A；压缩后 Tool pair 和当前用户任务完整；排序变化不会被报告为 Provider cache hit 增加。

### Phase 4：Evidence consolidate 与睡眠式整理

**目标**：在没有新思路时集中整理，不影响探索节奏。

**建议改动**：

- 将现有 curation/annotation 能力收敛到统一 `evidence.consolidate` 操作；
- 单次整理生成 L0/L1、Evidence links、冲突、负面结果、下一动作和上下文替换计划；
- 维护任务使用同一 Run 的 WorkItem、Effect、Artifact 和 ControlStore；
- 对整理结果做幂等检查、来源校验、generation 检查和 checkpoint；
- 失败时恢复原 Provider 视图，不能出现只写摘要但未写来源的半提交。

**验收**：三条重复 Tool 结果可压缩成一个带 Artifact refs 的 L1；同一整理请求重放不产生重复 Evidence；未验证观察不会升级为 confirmed Fact；原始结果仍可按 URI 读取。

### Phase 5：可验证的持续更新

**目标**：让系统能够从失败中提出局部修改，并证明后续受益。

**建议改动**：

- 增加 versioned update proposal 和最小 diff 结构；
- 自动生成触发失败集、保留集、迁移集和安全集的评测任务；
- 更新前后保存 Prompt/Skill/Tool/Runtime/Verifier 版本快照；
- 将提案验证、审批、发布和回滚接入同一 Work Graph；
- 独立记录 proposal acceptance、activation 和 following 三类指标；
- 把被拒假设、负面实验和退化案例放入长期索引。

**验收**：一个修复提案改善触发集且保留集不退化；发布失败可回滚到旧 hash；更新器不能修改 verifier 和基线；同一提案可重放，生成相同的评测摘要。

## 9. 文件级改动地图

| 文件/模块 | 建议 |
| --- | --- |
| `packages/materials/src/context/compiler.ts` | 引入 ContextBlock、L3A/L3B、P band、块 hash 和统一序列化；保留当前 L0/L1 stable-prefix 语义 |
| `packages/materials/src/runtime/coding-lane.ts` | 继续追加 dynamic suffix；将 Forest 注入接入统一投影，不插入旧 transcript 中间 |
| `packages/materials/src/context/maintenance-coordinator.ts` | 从“是否超预算”扩展到“哪个 band 需要何种维护”；返回 nextAction，不在 hook 内重入 Pi |
| `packages/materials/src/context/agent-pruner.ts` | 按 band、任务相关性、恢复重要性和是否已有摘要选择 snip/prune；保持 Tool pair 不变量 |
| `packages/materials/src/context/durable-compaction.ts` | 将 checkpoint、压缩、恢复和 L0/L1 投影绑定为幂等批次 |
| `packages/materials/src/tools/runtime.ts` | 增加 Job output cursor、监控触发和 stalled/reconcile 状态，继续复用现有 Job/Effect |
| `packages/materials/src/runtime/solver-tools.ts` | 增加统一 monitor/consolidate operation 的稳定代理契约，不能为 Chat/CTF 分叉 schema |
| `packages/materials/src/runtime/provider-scheduler.ts` | 保留 stream boundary retry；补齐 attempt、stall、backoff、recovery 事件和幂等关联 |
| `packages/materials/src/observability/pi-events.ts` | 记录 queue、first event/token、idle、retry、Tool/maintenance correlation 和 cache 诊断 |
| `packages/materials/src/runtime/coding-turn-projection.ts` | 把 advisory、recoverable、replan 和 terminal 投影区分，禁止普通维护提示伪装成终止 |
| `packages/materials/src/domain/types.ts` | 增加统一事件、维护策略、压缩结果、更新提案和恢复状态类型 |
| `apps/gui/src/server.ts` 与 GUI 状态投影 | 提供事件流、上下文预算、压缩点、队列、卡住原因和恢复动作 |
| `docs/architecture.md`、`docs/recovery.md`、`docs/gui.md` | 同步统一事件循环、缓存事实、手动压缩和长期整理契约 |
| `README.md`、API 索引、project reports | 每次公共类型/方法或治理文档变化后同步生成和检查 |

## 10. 测试和故障矩阵

### 10.1 事件与恢复

| 场景 | 必须验证 |
| --- | --- |
| 用户消息在 Provider 流中到达 | 事件持久化、在安全点消费、原流不产生重复 Tool |
| Job 在模型思考期间完成 | 自动生成 job completion 事件，下一轮可见，不依赖主动轮询 |
| urgent cancel 到达不可取消 Effect | 记录 cancel requested，等待 reconcile，不伪造 cancelled |
| generation reset 后旧事件到达 | 被拒绝或转历史，不能污染当前 Run |
| 进程崩溃后恢复 | 队列从 ControlStore 重建，已应用事件不重复应用 |
| 同一事件重复投递 | correlation/idempotency 防止重复 Evidence、Effect 和 Completion |

### 10.2 Provider 和 Tool

| 场景 | 必须验证 |
| --- | --- |
| 队列等待后取消 | 释放槽位，写 queue_cancelled，消费者收到 terminal event |
| HTTP 200 后中途错误 | 丢弃半截 attempt，stream boundary 重试，不重复 Agent turn |
| 无 terminal event | idle watchdog 产生 stalled/retry/recovery 事件，槽位最终释放 |
| Tool 输出巨大 | 原文 Artifact 不变，Provider 视图只保留 bounded result 和 refs |
| Tool timeout 状态未知 | 不盲重放 Effect，进入 reconcile |
| 相同错误连续出现 | 改变参数/范围/策略或进入 replan，不能无限原样重试 |
| monitor 关键词命中 | 增量 cursor 正确，重复读取不重复唤醒 |

### 10.3 上下文和缓存

| 场景 | 必须验证 |
| --- | --- |
| 仅 Evidence 增加 | P0/P1/stable prefix hash 不变，P4/P6 变化可解释 |
| 仅 Lease heartbeat 增加 | L3A content hash 不变，L3B 变化 |
| 压缩 P9/P10 | Tool pair、当前用户任务、Effect unknown、Artifact refs 保留 |
| 同一快照重复编译 | 消息顺序、块 hash、Manifest hash 完全一致 |
| 动态尾部内部换序 | 不报告 Provider cacheRead 增益，只报告本地投影差异 |
| Provider 返回 cacheRead | 与 stablePrefixHash、firstChangedMessage 一起展示，不从估算值推断 |
| 手动选择压缩目标 | 只改变维护策略，不改变 TaskContract、权限和 verifier 事实 |

### 10.4 Evidence 与持续演化

| 场景 | 必须验证 |
| --- | --- |
| 观察未达验证门槛 | 可作为 observation 保存，但不能变成 confirmed Completion |
| consolidate 中途失败 | 不替换原 Tool view，不产生半提交 Evidence |
| 负面实验被压缩 | 仍可检索并影响 rejected hypothesis/重复 breaker |
| 更新提案改善触发集但损害保留集 | 拒绝发布并保留报告 |
| Skill 已发布但未被加载 | proposal 可接受，activation/following 仍单独失败并进入下一轮修复 |
| 回滚后重放 | 恢复旧版本 hash、投影 hash 和行为结果 |

## 11. 不应做的事情

1. 不要为了“稳定内容靠前”把动态块插入旧 Tool Call/Tool Result 中间。
2. 不要把当前动态尾部内部排序宣传成 Provider KV Cache 命中优化。
3. 不要让普通 Chat 和 CTF Chat 使用两套 verifier、Evidence、Completion 或 recovery 逻辑。
4. 不要用第二个后台 Agent、第二个数据库或第二个知识真相解决整理问题。
5. 不要把每次工具调用后的长总结设为硬门槛。
6. 不要把一次 Provider attempt 的超时等同于整个 Run 被强行终止。
7. 不要把 `stop_job` 请求成功当作外部进程已停止。
8. 不要对 unknown Effect 直接重放可能产生副作用的动作。
9. 不要把 LLM 自己的反思、置信度或摘要直接当作验证证据。
10. 不要让更新器修改 verifier、测试基线、审计记录或回滚锚点。
11. 不要只用成功率判断持续演化；必须同时看证据、过程、成本、延迟、安全和保留集。
12. 不要把 GUI 的“看起来有进度”当作真实运行进度；每个节点都必须能回到事件、Effect、Job、Artifact 或 Evidence。

## 12. 最终建议的交付顺序

建议按下面顺序推进，而不是一次性改写上下文布局：

```text
1. 统一事件 envelope 和恢复状态投影
2. 把 Provider/Tool/Job 延迟和卡住状态变成可见事件
3. 在同一 Job 系统上增加 monitor cursor/trigger
4. 把 ContextCompiler 改成统一 ContextBlock serializer
5. 接入用户可控的单一压缩策略和 L0/L1/L2 投影
6. 将 Evidence consolidate 做成空闲/无进展时的幂等 WorkItem
7. 用 holdout、迁移、回归和 activation/following 指标验证更新
8. 只有真实 Provider cacheRead 证明有收益后，再评估 checkpoint-prefix 模式
```

最终状态应满足：Agent 可以长时间运行；遇到工具失败、Provider 卡住、上下文压力、证据缺口或重复探索时，系统会记录节点、自动修复、整理、重试、重规划或进入可恢复等待；它不会因为一次 recoverable 问题静默消失，也不会为了完成证据文书工作而阻塞正常探索。

这条路线同时保留当前 ProofBlade 最重要的约束：ControlStore 是唯一状态权威，ArtifactStore 保留原始事实，Evidence Graph 记录来源关系，Verifier 决定完成，ContextCompiler 负责有预算的投影，所有 Chat/CTF/Fixture/Competition 共享同一套执行、证据、压缩和恢复契约。
