# 工具热路径成本分解与 T1 write-behind 队列设计（PLAN-240 表项 T1）

> 文档版本：1.1.1
> 编写日期：2026-09-19（2026-09-21 复核修订：§2.2 的 12ms 改为推导值标注、§2.5/§2.6 重开 T2、§2.6 的「只有延后可行」撤销；2026-09-22 数字口径入口更正为三个）
> 文档性质：**成本分解实测 + 设计提案，部分已实施**（§2.5 的 T2 复核已由 `packages/materials/tests/dispatch-transaction-batch.test.ts` 实证）
> 父文档：`docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.6.3、表项 T1
> ProofBlade 基线：`156ec17`
>
> **数字口径**：本文所有毫秒值来自**单机**测量（Windows / i9-14900HX / Node 22），除明确标注「n≥20」者外，`p95` 在 n=8 时**就是最大值**（nearest-rank）。凡未经入库 harness 产生的数字都标了来源。可复现入口是**三个**（`package.json` 的 `baseline:tools` / `baseline:tools:real` / `baseline:tools:longrun`，分别对应 `scripts/tool-hot-path-baseline.ts`、`scripts/tool-hot-path-real-run-baseline.ts`、`scripts/tool-hot-path-long-run-baseline.ts`）。本文早期版本写「仅有的两个」，漏了 provider-free 的那个。

## 1. 为什么要单独成文

父计划的表项 T1 写的是「普通工具结果启用零同步控制写快速路径」。在实施前我做了两件事，结果表明这个目标需要先改设计再动代码：

1. 用真实 Run 基线（PR #230）测出**每次调用的固定链路成本约 25ms**；
2. 把这 25ms 落到**具体的提交与事件**上，发现它不是一个可单点删除的开销，而是两个提交各自的固有成本。

如果直接按「零同步提交」实施，会得到一个无法通过测试的目标，或者一个把 durable 语义改坏的实现。因此本文先固定事实，再给设计。

## 2. 实测事实

### 2.1 一次 `read` 到底写了什么

在真实 ControlStore 上追踪单次 `read`（1 字节文件），`events.jsonl` 新增 4 条：

| seq | 事件 | lane | 来源 |
|---|---|---|---|
| 2 | `artifact_registered` | executor | `ArtifactStore.putText` → `ControlStore.dispatch` |
| 3 | `artifact_annotated` | main | `DeterministicObserver.observe` |
| 4 | `observation_added` | executor | 同上 |
| 5 | `evidence_added` | executor | 同上 |

调用栈确认只有**两个逻辑提交**：

```text
CTRL.dispatch            ArtifactStore.putText            (artifact-store.ts:31)
CTRL.dispatchTransaction DeterministicObserver.observe    (observer.ts:78)
```

`observer.observe` **已经**把 annotation、observation、evidence 合并进一个事务（其源码注释即说明此举是为「halve snapshot/replay work on every read/bash result」）。因此按「合并派生写入」的思路优化这一条已经没有剩余空间。

### 2.2 25ms 花在哪

单次 `read`：4 条事件 / 2 个提交 / 约 25ms p50（PR #230 实测，n=8）。

**「每个提交约 12ms」是 25 ÷ 2 的推导值，不是测量值。**本节的插桩识别的是提交**点**（哪几个位置各提交一次），没有任何一处测量了单次提交的耗时。把它写成「实测事实」是错的，写成「由此推出的量级」才对，置信度也随之降低：它假设两次提交成本相同，而第一次（artifact 注册）与第二次（派生观察）折叠的快照大小并不必然一样。要得到真实数字需要分别给两个 dispatch 点插桩计时，那还没有做。

单个提交的内容是：run 锁获取 → 事件追加 + `fsync` → 快照折叠。

另需注意「25ms」这一列的口径：它是 PR #230 脚本里 `command` 列的值，即**工具体本身**的耗时，其中包含它触发的 durable 提交；`framework − command` 只有 1.4–4ms。因此 25ms 不是「附加在命令之外的链路开销」，而是「命令内部含它自己的提交」。§7.2 的收益数字据此重新推导。

### 2.3 T3 到底省了多少

用真实 ControlStore 对同一进程连续 5 次 `ExperimentGate.record()` 对比：

| 模式 | 5 次耗时 | 每次 |
|---|---:|---:|
| 延后投影（T3 之后的现状） | 46.8ms | 9.4ms |
| 强制投影（T3 之前的行为） | 68.1ms | 13.6ms |

**结论：投影重写每次约 4.3ms（68.1 − 46.8 = 21.3ms ÷ 5），约占单次提交成本的三分之一。**这是对 PR #228 的收益量化——但口径必须说清：单进程、5 次、无重复、无 warm-up 的 A/B，且它是拿 `ExperimentGate` 的数字去比一个**推导出来**的读取路径数字（§2.2 的 12ms）。它是「省了 4.3ms/次」的证据，不是「投影重写占提交成本三分之一」这一普遍结论的证据。

### 2.4 因此剩余成本的结构

| 组成 | 每次 | 可否移除 |
|---|---:|---|
| run 锁 + event append + `fsync`（提交 1：artifact） | 约 12ms（**推导值，25÷2**） | 否——artifact 是 Evidence 提升的引用对象 |
| run 锁 + event append + `fsync`（提交 2：observation） | 约 12ms（**推导值，25÷2**） | 否，但可并入提交 1——见 §2.5 复核 |
| 投影重写 | 0（已由 T3 移除） | 已解决 |
| Artifact 回读 | 0（已由 PR #229 移除） | 已解决 |

上表两行的 12ms 都是**同一个推导值**，不是两次独立测量：它的作用是给出量级，不是给出精度。真实数字需要分别插桩两个 dispatch 点。

**「零同步提交」在当前架构下不可达**：只要结果需要被后续 Evidence 引用，artifact 注册就必须在模型继续之前 durable。父计划 §5.6.3 的措辞应据此修正为「**普通结果最多一次同步提交**」。

### 2.5 表项 T2 复核：**原「不可行」判定不成立，T2 已重开**

父计划表项 T2 要求「将 Artifact、annotation、Observation、Evidence、Experiment 合并为单次 ToolResultCommit」。本节曾判定**不可行**，理由是「`prepare(before)` 用批次前快照校验整批，故不能在同一批次内注解或引用本批次刚注册的 artifact」。**该理由与代码不符**，已被 `packages/materials/tests/dispatch-transaction-batch.test.ts` 实测推翻：

```text
ControlStore.dispatchTransaction(runId, prepare, options)
  -> const transaction = prepare(before);          // before 只用于生成命令与 project
  -> #commitCommands(runId, before, transaction.commands, ...)
       let after = before;
       for (const command of commands) {
         validateCommand(after, command, references, authority);   // ← 校验的是批内折叠后的 after
         after = reduce(after, event);
       }
```

批内引用表 `buildBatchReferences(before, commands)` 还会把**本批次将要创建的 id** 预先并入 `references`（artifact / evidence / completion / domain record）。于是：

| 批内命令 | 前向引用（先引用、后创建） | 依据 |
|---|---|---|
| `artifact_annotation` | **可**（同批 `artifact` 在前即可） | `validateCommand` 查 `after.artifacts`，`after` 已折叠 |
| `observation` | **可**（顺序无关） | 只查 `references`，其中已有同批 artifact id |
| `evidence`（无 effect） | **可**（顺序无关） | `validateEvidence` 在 `!effect` 时提前返回，不解析 artifact |
| `domain_record` | **可** | `assertKnownReferences` 查 `references` |

实测结论（`dispatch-transaction-batch.test.ts`，3 条用例）：

1. 一个事务里 `artifact` + `artifact_annotation` + `observation` + `evidence` 四条命令全部落盘，`evidence.provenance.artifactIds` 正确解析到同批 artifact；
2. 引用可以出现在创建**之前**，同样成立（顺序无关）；
3. 批内谁都没创建的 id，只有 `artifact_annotation` 会拒绝（`Unknown artifact`），且整批原子回滚。

**因此 §2.6 的「合并 vs 延后」结论需要改写**：合并**不需要**改事务模型，是现有事务模型的既有能力；原判断把它当成了语义变更。

**一处应当补的缺口**（本复核顺带记录，不是 T2 的阻碍）：`observation.source.artifactId` 目前**完全不校验**——既不查 `snapshot.artifacts` 也不查 `references`，因此可以写入指向不存在 artifact 的 observation。`evidence` 在无 `effectId` 时同样在解析 artifact 之前返回。这是既有行为，与本表项的可行性无关。

**仍成立的部分**：一次 `read` 的公共写入口调用数为 3，其中 `dispatch` 内部委托 `dispatchBatch`，因此**逻辑提交为 2**（artifact 注册、派生观察各一），与 §2.1 的 4 条事件吻合。原 §2.5 关于「artifact 注册必须先于派生观察提交」的结论**是错的**——两者本就可以在同一个提交里。

### 2.6 「合并」与「延后」是两条不同的路，后者**不是唯一**可行的

§2.5 曾否掉**合并**（把两个提交压成一个，两者仍都在工具返回前），并由此论证只能走**延后**。既然合并可行，两条路都成立，取舍改为工程权衡：

| 方案 | 机制 | 工具返回前的提交数 | 可行性 |
|---|---|---:|---|
| 合并（表项 T2） | 一个批次里同时注册 artifact 并派生观察 | 1 | **可行**，事务模型无需改动（§2.5 复核） |
| 延后（§3，表项 T1） | artifact 同步提交；派生观察排队到回合边界 | 1 | 可行，但需处理 §3.3 的三处语义变化 |

两者最终都能把工具返回前压到 **1 个提交**。合并的代价是**语义面更窄**：它只减少同一工具调用内部的提交次数，不改变观察发生在工具返回前这一事实；延后则会把观察推迟到回合边界，需额外处理崩溃窗口与投影滞后（§3.3）。**取舍交由实施者按风险选择，但不能再以「合并不可行」为前提。**

## 3. 设计提案：延后派生观察

### 3.1 目标

把提交 1 保留，把提交 2（annotation + observation + evidence）推迟到回合边界，使普通 `read`/`glob`/`grep`/短 `bash` 从 2 次同步提交降到 1 次。**收益的量化口径**：少一次提交，按 §2.2 的**推导值**约 12ms/次——该数字是 25÷2 推出来的，不是两次独立测量，所以这里只应读作量级（25ms → 十几毫秒），不是精确到毫秒的承诺。要把它变成实测数字，需要分别给两个 dispatch 点插桩计时。

### 3.2 为什么不能直接把这些事件丢进 `ControlEventBatcher`

`ControlEventBatcher`（`observability/pi-events.ts`）的类注释明确写着 **"Control-plane commands never use this class."** 它承载的是遥测事件，且是 fail-soft（失败就退回队列重试）。Observation 与 Evidence **不是遥测**：

- Evidence 是结论的正式支撑，丢失会让「结论有证据」变成假陈述；
- 因此新队列必须是 **fail-closed**：队列满时必须阻塞或降级为同步提交，不能静默丢弃。

**两者语义不同，不能复用同一个队列。**

### 3.3 需要解决的三处语义变化

| 变化 | 现状 | 延后后 | 处置 |
|---|---|---|---|
| 模型可见 notice 的 ID | `[ProofBlade observation O-… evidence EV-…]` 同步可得 | 回合末才有 ID | notice 只保留 `progressKey`；或改为 `[ProofBlade observation pending]` |
| `details.observationId/evidenceId` | 同步写入 | 回合末才有 | 同上；GUI 调试视图需容忍缺失 |
| 重复抑制 | 依据 `artifactOutputRefs` 内存表 | 不变 | 内存表本就在进程内，不受影响 |

**第一项是本项唯一的模型可见行为变更**，也是它必须独立评审、不能与 I/O 优化夹带的原因。

### 3.4 建议的落盘边界

与既有约定一致（父计划 §5.7.2）：

```text
enqueue（工具返回前，仅内存）
  -> turn end / agent end
  -> checkpoint
  -> lane close / pause
  -> verifier handoff
  -> 进程关闭
```

其中 **verifier handoff 与显式 `evidence_record` 必须仍是同步的**：凡结论要引用它，就必须在引用前完成 durability barrier（父计划 §5.7.1 已规定）。

### 3.5 建议的验收条件

- [ ] 普通成功 `read`/`glob`/`grep` 的同步 ControlStore 提交 ≤ 1；
- [ ] `details` 中 artifact 引用仍同步可得，模型仍能沿 artifact 读取内容；
- [ ] 回合结束时 observation 与 evidence 均已落盘，且**仅凭事件日志重放可见**；
- [ ] 队列满时**降级为同步提交**，不丢弃、不静默失败；
- [ ] 显式 `evidence_record`、verifier 输入、失败/超时结果**仍为同步提交**；
- [ ] 进程在回合中途被终止：artifact 仍在（提交 1 已 durable），observation 可按父计划 §5.7.2 的语义重新派生，不产生伪完成；
- [ ] 模型可见 notice 的新格式有对应快照测试。

## 4. 不推荐的做法

| 做法 | 为什么不 |
|---|---|
| 复用 `ControlEventBatcher` | 它是 fail-soft 的遥测队列，装载 Evidence 会让「证据已记录」变成可能为假的陈述 |
| 把 artifact 注册也延后 | artifact 是后续 Evidence/verifier 的引用对象，延后会让引用悬空 |
| 为「零同步提交」删掉 observation/evidence | 这会削弱证据链，属于父计划 §6 明令不得破坏的安全与一致性机制 |
| 直接降低 `fsync` 频率 | 父计划 §5.6.6 已明确反对；正确做法是合并屏障，不是删除屏障 |

## 5. 与父计划的关系

本文不改变表项 T1 的**目标方向**，只修正它的**措辞与验收条件**：

- 原文「普通工具结果启用零同步控制写快速路径」→ 建议改为「普通结果最多一次同步提交，派生记录在回合边界批量落盘」；
- 新增 §3.5 的验收条件，替换原「同步 ControlStore commit 为 0」这一不可达条目；
- 表项 T1 的实施顺序建议排到 **D1（Session live buffer）之后**：D1 已经要建立「有界缓冲 + 明确 flush 屏障」的机制，T1 的队列应复用同一套屏障定义，而不是先造一个再改。

## 6. 相邻表项的核实结果

### 6.1 表项 G（Context 热路径去重）：已无剩余空间

父计划 §5.4.3 假设「queue items 会先 canonicalize 再 hash，随后 ContextCompiler 又会把相同数据纳入 manifest hash」。**实测不支持这个假设**：

| 环节 | 实测 | 说明 |
|---|---|---|
| 空 Run 的 observation queue | **0 项** | `projectObservationQueue` 在无事件时不产出条目 |
| lane 的 `sha256(canonicalJson(items))` | **0.0016 ms** | 0 项时；64 项约 0.40ms，256 项约 1.61ms，1024 项约 6.70ms（合成压测） |
| 500 次请求的重投影次数 | **1** | `ObservationQueueCache` 已按 `lastSeq/generation/projectionHash` 命中 |
| 缓存命中的 `snapshot()` | **0.06 ms** | 快照本身也已缓存 |

结论：**该路径已经被既有缓存覆盖**，剩余可省的是每请求一次亚毫秒级哈希。父计划 §5.4.3 提出的 revision 化（用 `lastSeq/generation` 取代内容哈希）方向正确，但收益量级为**亚毫秒**，不值得单独立项。**表项 G 建议关闭。**

### 6.2 表项 H（GUI 详情按视图拆分）：假设成立，且可量化

`RunDetail` 每次轮询都会完整构建并下发。实测（一个 121 事件的 Run）：

| 载荷部分 | 字节 | 占比 |
|---|---:|---:|
| `events` | **100,160** | **69%** |
| `snapshot` | 41,525 | 29% |
| `telemetry` | 2,591 | 2% |
| `controlView` / `observationQueue` / `sessions` | 各 <400 | <1% |
| 合计 | 144,901 | 100% |

即**每次轮询都在传 100KB 的完整事件流**，而 `Overview` 只用 `detail.events.slice(-10)`。父计划 §2.5 的判断因此得到确认。

**但实施需要客户端协同**，不能只改服务端：`App.tsx` 的事件时间线与调试器**确实**要过滤完整事件数组（`detail.events.filter(...)`、`for (const event of detail.events)`），因此拆分为 `summary` + 增量 `events?afterSeq=` 时，时间线与调试器必须改为按需拉取。这是 GUI 行为变更，**无法仅凭单元测试证明 UI 仍然正确**，需要真机/浏览器验证。

**建议**：H 作为独立条目推进，并在 PR 中明确标注"服务端载荷已验证、UI 行为需浏览器验证"，不要把两者混为一次"已验证"的改动。

### 6.3 屏障补齐投影：屏障自身是 O(历史)，且它并不消除这笔成本

§2.5 与父计划 §7.2.1 把「长 Run 重放回退」定为实测事实，并建议**在明确屏障处补齐投影**而不是削弱回放校验。经本轮实测，该建议**方向成立但收益被高估**：屏障确实把开销前移出了读取路径，但它**没有消除**这笔 O(历史) 成本，只是把它从"读的时候付"改成"回合边界付"。

**屏障在真实编码通道中的触发点**（经代码核实，不是推断）：

| 位置 | 触发条件 | 频率 |
|---|---|---|
| `observability/pi-events.ts:524` | `turn_end` / `agent_end` | 每回合一次 |
| `runtime/coding-lane.ts:879` | `stopAllShellJobs`（通道收尾） | 每次 Run 结束一次 |

两者都调用 `controlStore.flushProjection(runId)`，因此**屏障频率天然等于回合边界**。

**屏障频率实测**（10,000 事件全部 `persistProjection: false` 写入，随后冷缓存 `DebugDataService.getRun` 读一次）：

| 屏障间隔 | 屏障次数 | 单次屏障 | 屏障累计 | 冷 `getRun` |
|---|---:|---:|---:|---:|
| 不加屏障 | 0 | — | 0 ms | **1524 ms** |
| 每 5,000 事件 | 1 | 164.7 ms | 164.7 ms | **1168 ms** |
| 每 2,000 事件 | 4 | 112.6 ms | 450.6 ms | **780 ms** |
| 每 1,000 事件 | 9 | 143.1 ms | 1287.8 ms | **599 ms** |
| 每 500 事件 | 9 | 126.6 ms | 1139.6 ms | **569 ms** |

三条结论：

1. **单次屏障约 113–165 ms，与间隔无关；冷读在最后一档仍要 569 ms。** 也就是说屏障并**没有**给出"读一次总是很快"的保证——它只是让"新鲜度"在回合边界上被补到最新，而真正付掉这笔 O(历史) 成本的是**屏障本身**。加密屏障并不能把冷读压到常数。
2. **收益的绝大部分由第一次屏障拿到**（1524 → 1168 ms），此后每加一档只再降 200 ms 左右，而屏障累计开销线性上涨。**屏障次数应当尽量少，取"回合边界"这一天然最粗粒度即可**——这正是现有实现的做法。
3. **`flushProjection` 不是全量重放，但仍随历史线性增长。** 同机对照（纯 `control.replay()` vs 冷 `flushProjection`）：

   | 事件数 | `replay()` | 冷 `flushProjection` | `projection.json` |
   |---:|---:|---:|---:|
   | 1,200 | 119.4 ms | 23.5 ms | 4.5 KB |
   | 5,200 | 1056.1 ms | 139.6 ms | 4.5 KB |
   | 10,200 | 1737.8 ms | 226.7 ms | 4.5 KB |
   | 20,200 | 2729.8 ms | 310.4 ms | 4.5 KB |

   `flushProjection` 恒为 `replay()` 的 1/5–1/9，**热调用（投影已最新）为 0.0 ms**——它没有做全量重放。但它仍然随历史线性增长，原因在 `control-store.ts:736` 的 `eventStore.events(runId)`：这条路径**总是先取回并解析整条事件流**，然后才用投影 + `applyTail` 增量折叠。`projection.json` 在 20,200 事件下仍是 4.5 KB，说明**投影是 O(状态) 的，而读取路径不是**。

**因此真正剩余的条目是"读取路径的 O(历史) 输入"，不是"屏障频率"。** 具体地：投影带 `lastSeq`，若读取时只需解析事件流中 `(投影 lastSeq, 流末]` 这一段，冷读与屏障都可降为 O(增量)。**起初以为这要拿"前缀防篡改校验"去换，但 §6.5 的实测表明读取路径上并不存在这项校验**——封印的保证是"伪造投影无法覆盖真实事件"，与读取解析多少事件无关。这是一条**新的、可独立立项的条目**，属于投影/事件存储子系统的重构，不在 PLAN-240 现有条目内。

**证据边界**：上两张表都是本机实测。「`eventStore.events()` 先解析整条流」是经代码核实的事实（`control-store.ts:736`），而"因此成本随历史线性"是对上表第三点斜率的解释；若要把它变成门禁，需按 §7.2.2 补一个**计数**指标——例如读取路径解析的事件条数——而不是耗时阈值。

### 6.4 端到端核对：秒级的真正来源是「先解析整条流」，**不是**重放回退

父计划 §11 的完成定义里有一条中心判据：**几毫秒的普通工具不再被 ProofBlade 附加链路放大到秒级**，而 §7.2.1 把机制定位在重放回退（`control-store.ts:743`）。本轮端到端补测**推翻了这个归因**，并把机制改指到 §6.3 那条结论上。

**端到端三点**（10,001 事件，全部 `persistProjection: false` 写入；每点都是全新 `DebugDataService` 冷缓存，走真实 GUI 读取路径）：

| 时序 | `projection.json` | 冷 `getRun` |
|---|---:|---:|
| 快速路径刚写完（投影陈旧） | 4,506 B（陈旧） | **1647.9 ms** |
| 回合边界屏障之后 | 4,510 B（当前） | **223.3 ms** |
| 投影被删除（纯回退） | absent | **1846.0 ms** |

**分解实验**（同一写入形态，10,001 事件，5,385,107 字节流，投影陈旧停在 `lastSeq=1`）：

| 操作 | 耗时 |
|---|---:|
| `loadProjectionHint()` | **0.4 ms** |
| `loadProjection()`（含全前缀重哈希，但只解析到 `lastSeq=1`） | **49.1 ms** |
| `snapshot()`（投影陈旧） | **1877.3 ms** |
| `snapshot()`（投影当前） | **247.6 ms** |
| `replay()`（`forceReplay`） | **2216.6 ms** |
| `loadProjection()`（投影当前，前缀 10,001 条） | **228.1 ms** |

四条结论：

1. **秒级不是回退造成的。** 投影陈旧时 `snapshot()` 走的是**投影 + `applyTail`** 路径，**不是** `eventStore.replay()`。§7.2.1 原先的"重放回退"归因是**推断，不是实测**，此处更正。（这一条最初是用一个临时计数器验证的，该计数器已因设计缺陷移除——见 §6.5；结论本身由下面的分解数据独立支持：`loadProjection()` 只要 49 ms，若走的是 `replay()` 则不可能低于它。）
2. **真正的成本是"先取回并解析整条事件流"。** `snapshot()` 投影陈旧 **1877 ms** 而 `loadProjection()` 只要 **49 ms**，差额全部来自 `control-store.ts:736` 的 `eventStore.events(runId)`：它无条件解析整条 5.4 MB 流，然后才用投影 + `applyTail` 增量折叠。**这与 §6.3 第三条是同一个结论**，只是端到端把它放大到了秒级。
3. **屏障的收益也是这一条。** 投影当前时冷读 247.6 ms，是因为 GUI 详情走 `loadProjectionHint()` 短路（0.4 ms）而不再解析事件流；`loadProjection()` 本身在 10,001 条前缀下仍要 228.1 ms——**O(历史) 的全前缀重哈希仍在**。所以屏障的价值是"让读取走 hint 短路"，而不是"避免重放"。
4. **推论：修读取路径的 O(历史) 输入，会同时解决 §6.3、本节第 2 条和残余窗口。** 让读取只解析 `(投影 lastSeq, 流末]` 这一段，`snapshot()` 走投影路径就从 1877 ms 降到与新增事件数成正比。**这项优化原本被认为要拿"事件前缀防篡改校验"去换，但 §6.5 的实测表明读取路径上并不存在这项校验**——封印防的是伪造投影覆盖真实事件，而那条不变量在优化后依然成立。所以这是本计划真正的剩余性能项，且没有安全代价。

**证据边界**：三张表都是本机实测（探针运行后已删除）。它证明的是**机制与量级**，不是"已达标"——§7.2.3 的目标段仍需按 §7.2.1 的基线评审，且本机数值不可直接当作阈值。

### 6.5 封印的保证边界：它防的是「伪造投影」，不是「篡改事件」

第 4 条那条优化本来受一个安全顾虑约束——"读取路径付 O(历史) 是为了重校验被篡改的事件前缀"。为确认这个顾虑是否成立，我做了篡改实验。结论是**这个顾虑不成立**，而且过程中查清了封印实际提供的保证是什么。

**复现步骤**（每一步都已实测）：

1. 建一个 Run，追加 201 条事件，加一条 `turn_started` 生命周期事件，调用 `flushProjection()` 让投影封印在当前 `lastSeq`；
2. 就地把中间某条事件的 `payload` 改掉（文件长度与末尾 `seq` 都不变），再把 `projection.json` 的 mtime 设为**晚于** `events.jsonl`，以排除 `jsonl-store.ts:456` 的时间预筛；
3. 分别用全新 `ControlStore` 读取。

**实测结果**（两类事件都试过：遥测类 `tool_result_recorded`、状态类 `turn_started`）：

| 读取方式 | 篡改后 |
|---|---|
| 重算前缀哈希 vs seal 里的 `eventPrefixHash` | **CHANGED**（封印确实覆盖 payload） |
| `loadProjection()` | **rejected** |
| `loadProjectionHint()`（mtime 已置新） | accepted |
| `snapshot()` | **accepted**，`lastSeq` 与 `replay()` 一致 |

**代码路径**：`control-store.ts:744` 的 `if (!durableStateChanged && snapshot === undefined)` 让 `loadProjection()` **只在本进程没有该 Run 快照缓存时**才被调用；revision 一变即跳到 `:765` 的 `replay()`，而 `replayWithTask`（`jsonl-store.ts:597-602`）只把磁盘事件折叠一遍、**不做任何校验**。

**这是设计边界，不是缺陷。** 仓库既有的 `control-store.test.ts:113` 已经把封印的保证测清楚了：伪造一个 `status: "FAILED"` 且自哈希正确的投影后，`snapshot()` 仍然返回 **`READY`**（来自事件），并断言 `replayCount === 1`。也就是说：

- **封印要防的是「用伪造投影覆盖真实事件」**。这条不变量成立：投影是派生物，校验失败时被丢弃，事件才是权威。
- **封印不承诺「事件内容本身未被改动」**。事件是信任根；能写 `events.jsonl` 就等于能改状态，这一点在没有逐事件签名之前无法改变。
- 因此权威读取路径**不需要**为防篡改去重算前缀哈希——`snapshot()` 走 `replay()` 并不会让攻击者多得到什么，因为他本来就能写事件。

**这同时消掉了 §6.3/§6.4 那条优化的最后一个顾虑**：把读取路径降到 O(增量) 不会削弱防篡改能力，因为**读取路径上原本就没有这项能力**。真正被放弃的只是 `loadProjectionHint()` 顺带提供的"投影与事件不一致"信号，而那个信号由 `loadProjection()`（屏障、`#projectionAlreadyCurrent` 调用）继续提供。

**唯一仍然失准的是注释**：读取路径上原先有一条注释写「replay the full stream so modified prefixes and task-contract tampering are revalidated」。`replay()` 里没有任何"revalidate"步骤——它只是把磁盘上的事件折叠一遍。这句话会让人（包括我）误以为读取路径在校验事件完整性，进而得出"不能省掉 O(历史)"的错误结论。**该注释已在 §6.6 的改动中一并删除并改写。**

**证据边界**：以上为可复现实测，探针已删除、未入库。我**没有**添加测试：既有 `control-store.test.ts:113` 已经覆盖封印的真实保证，再加一个只会重复它。

### 6.6 已实施：读取路径降为 O(增量)

§6.3–§6.5 得出的结论——真正剩余的是「读取路径无条件解析整条事件流」，且该优化**不牺牲任何防篡改能力**——已落地实施。

**根因是两处，不是一个。** 第一次改动只修了投影那一处，实测只从 1877 ms 降到 1845 ms。逐段计时才定位到第二处：

| 阶段 | 修改前 | 修改后 |
|---|---:|---:|
| `migrateLegacyRun()`（每次冷读都先跑） | **13.4 ms，解析 +2001** | **3.7 ms，解析 +0** |
| `loadProjectionHint()` | 6.8 ms，解析 +0 | 3.2 ms，解析 +0 |
| `snapshot()` 主体 | 6.2 ms，解析 +0 | 5.4 ms，解析 +0 |

`#readSnapshot` 每次缓存未命中都会先调 `#migrateLegacyRunBestEffort`，而 `migrateLegacyRun()` **无条件 `events()` 解析整条流**——它只需要判断 Run 是否已锚定。现在改为两次有界读：`firstEvent()`（文件头 64 KiB）确认首个 `run_started` 带 `authorityHash`，加 `lastEvent()`（文件尾 64 KiB）确认末尾不是 `run_authority_migrated`（后者本身也是锚，必须走完整路径）。判断不了就退回完整解析，因此**只多花时间、不会给错答案**。

**实测（10,001 事件，生产形态：读写双方都用默认解析出的同一 authority）**：

| 场景 | 修改前 | 修改后 |
|---|---:|---:|
| 冷读，投影当前 | **1876 ms**（解析 +10001） | **12.5 ms**（解析 **+0**） |
| 冷读，投影之后又有新增事件 | 1722 ms | 仍走完整路径（预期如此） |

即 **150 倍**，且快路径**一个事件都不反序列化**。

**规模曲线（每次都是全新 reader，缓存为空；`persistProjection: false` 让投影停在 `lastSeq=1`）**：

| 事件数 | 投影状态 | 冷读 | 解析事件数 |
|---:|---|---:|---:|
| 0 | 当前 | 11.0 ms | **0** |
| 1,000 | 陈旧 | 182.8 ms | 1,000 |
| 5,000 | 陈旧 | 811.9 ms | 5,000 |
| 10,000 | 陈旧 | 1634.8 ms | 10,000 |
| 10,001 | **当前** | **11.5 ms** | **0** |

**这张表就是目标达成的证据**：投影当前的读取**恒定在 11–12 ms，不随历史增长**（0 事件与 10,001 事件同价）；而投影落后于日志时仍按 O(历史) 增长。

**残余的 O(历史) 窗口，以及为什么它需要另一条改动**：投影落后时读取仍要解析整条流（10,000 事件 1635 ms）。原因不是遗漏——`loadProjection()` 的封印校验要求**完整前缀**才能重算 `eventPrefixHash`（`prefix.length !== lastSeq` 直接抛错），而要把这段也降到 O(增量)，得把封印改成**链式哈希**（新前缀哈希基于「上一前缀哈希 ‖ 新增事件」），那是**事件/投影协议的破坏性变更**，需要单独决策与迁移方案。本条目只解决「投影当前」这一档，也就是使用者实际遇到的那一档（回合边界屏障之后 GUI 的读取）。

**覆盖面与其失效条件**（必须一起读）：快路径要求 `loadProjectionHint()` 能用**同一 authority** 验签。若读取方注入了与投影封印时不同的 secret，验签失败，则**回退到完整解析**（实测仍是 2064 ms）。这是 fail-safe：配置不一致时只损失性能，不会返回错状态。生产形态下 CLI 写入方与 GUI 读取方都走 `resolveControlAuthority()`，因此命中快路径。

**守恒测试**：`packages/materials/tests/projection-read-bound.test.ts` 5 条，锁住的是**代价换来的那些保证**，而不是计时：

1. 投影当前 → 冷读解析 **0** 个事件（计数断言，非耗时）；
2. 投影落后 → 仍折叠到与 `replay()` 完全一致的 `lastSeq` 与 `projectionHash`；
3. **伪造投影（自哈希正确、保留 seal）仍不能覆盖事件日志**——状态由事件决定；
4. 投影缺失 → 从事件日志重建，结果与合法投影一致；
5. **无 seal 的旧投影不被信任**（快路径不得被未认证投影触发）。

第 3、5 条正是"封印的保证"（§6.5）的回归防线：优化放弃的是"用解析出的事件重算前缀哈希"，而这条从未决定读者看到哪个状态；**"伪造投影不能覆盖真实事件"这条不变量仍然成立**。


## 7. 交付测试的变异验证

「有测试」和「测试能失败」是两件事。为了不在评审时把前者当后者，我对本计划交付的改动逐个做了**变异测试**：故意改坏源码，看对应测试是否会红。方法本身不需要新工具，只需「改坏 → 跑测试 → 还原」。

**结果：16 个变异里 15 个被抓住。**

| # | 变异（把正确行为改坏） | 对应测试 | 结果 |
|---|---|---|---|
| M1 | 版本快照缓存永不复用已构建结果 | `version-cache.test.ts` | ✅ 抓住 |
| M2 | 被拒绝的构建也缓存下来 | `version-cache.test.ts` | ✅ 抓住 |
| M3 | 不再把已持有的归档文本传给 observer（回读磁盘） | `artifact-readback.test.ts` | ✅ 抓住 |
| M4 | 先取错误消息再计数（复现原 bug） | `observer-diagnostics.test.ts` | ✅ 抓住 |
| M5 | 反转「日志 vs 投影」时效判定 | `projection-hint-currency.test.ts` | ✅ 抓住 |
| M8 | 文档隐藏时仍允许轮询 | `polling.test.ts` | ✅ 抓住 |
| M9 | 不再检测缺失的运行时成员 | `runtime-shape.test.ts` | ✅ 抓住 |
| M10 | 无 defaults 时也冻结能力清单 | `workspace-settings.test.ts` | ✅ 抓住 |
| M11 | revision 变化后仍复用 RunDetail 缓存 | `debug-data.test.ts` | ✅ 抓住 |
| M12 | 遥测 payload 在 append 时立刻解析（回到关键路径） | `telemetry-lazy-payload.test.ts` | ✅ 抓住 |
| M13 | 每次 experiment 记录都持久化投影 | `experiment-gate-projection.test.ts` | ✅ 抓住 |
| M14 | 永不复用 skill registry 记忆化结果 | `skill-registry-cache.test.ts` | ✅ 抓住 |
| M15 | 让归档失败逃逸出读取（成功的读被推翻） | `archival-failure-semantics.test.ts` | ✅ 抓住 |
| M16 | artifact dispatch 不再遵守 `persistProjection` | `hot-path-budget.test.ts` | ✅ 抓住 |
| M17 | 读取路径改为请求 eager 投影 | `hot-path-budget.test.ts` | ✅ 抓住 |
| M6 | `#projectionAlreadyCurrent` 恒返回「不当前」 | — | ❌ **未抓住** |

即 §7.2.2 那张不变量表上的计数门禁（事件预算、投影预算、回读预算、skill catalog 解析预算、归档失败语义、observer 诊断）**都经过变异验证确实能红**，不是"跑绿了所以有效"。

### 唯一未抓住的一项：不是断言弱，是路径不可达

为抓 M6 试了**三种**可观测手段，**三种全部通过**：

1. `projection.json` 的 mtime —— 正确与错误路径**都会写**；
2. 计数 `events()` —— **量错了成本**：这里 `events()` 命中解析缓存，真正昂贵的是 `hashEventPrefix()`，它不解析任何事件，因此计数器根本不动；
3. 强制走「已是最新」的提前返回 —— **根本到不了**。

第 3 点揭示了实质：**deferred append 会把流推进到投影之后**，所以在 deferred 模式下屏障求值该谓词时，答案恒为「不当前」。可达性未建立，**该检查可能实际是死代码**；若如此，§6.3 那次屏障成本修复的收益来自「在 hint 缺失/陈旧路径上避开 `loadProjection()`」，而不是来自这个谓词。

我**没有**为它写一条不可能失败的断言。三种失效手段已记入 `packages/materials/tests/barrier-projection.test.ts` 的注释，测试文件里没有任何测试假装覆盖它。

### 顺带修掉一个真实缺陷

同一轮里发现 `barrier-projection.test.ts` 那条「第二次屏障对已是最新的投影是 no-op」断言写的是 `settled.mtimeMs >= first.mtimeMs`——**文件被重写时同样通过**，正好与测试名声称的相反；而且它的前置步骤（re-defer 后再 flush）**本来就该发生一次写入**，注释描述的时序并未建立。现已改为先 flush 掉那次写入、再断言后续屏障不改变 mtime。

### 仍未变异验证的部分

`read-path-parse-budget.test.ts` 与 `projection-hint-currency.test.ts` 的部分用例、以及 `debug-data.test.ts` 里与本计划无关的历史用例未逐一做变异。上表覆盖的是本计划**声明为门禁**的那些断言；其余属于既有测试面。

## 8. 参考

- `docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.4.3、§5.6.3、§5.6.6、§5.7.1、§5.7.2、§6、表项 G/H/T1
- `scripts/tool-hot-path-real-run-baseline.ts`：§2 全部数据的产生脚本
- `packages/materials/src/effects/artifact-store.ts`、`packages/materials/src/knowledge/observer.ts`：§2.1 的两个提交点
- `packages/materials/src/observability/pi-events.ts`：§3.2 引用其 "Control-plane commands never use this class" 边界
- `apps/gui/src/App.tsx`、`apps/gui/src/shared.ts`：§6.2 的载荷构成与客户端消费点
