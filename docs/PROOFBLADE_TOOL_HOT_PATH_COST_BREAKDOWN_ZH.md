# 工具热路径成本分解与 T1 write-behind 队列设计（PLAN-240 表项 T1）

> 文档版本：1.2.0
> 编写日期：2026-09-19（2026-09-21 复核修订：§2.2 的 12ms 改为推导值标注、§2.5/§2.6 重开 T2、§2.6 的「只有延后可行」撤销；2026-09-22 数字口径入口更正为三个）
> 文档性质：**成本分解实测 + 设计提案，部分已实施**（§2.5 的 T2 复核已由 `packages/materials/tests/dispatch-transaction-batch.test.ts` 实证）
> 父文档：`docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.6.3、表项 T1
> ProofBlade 基线：`156ec17`
>
> **修订说明（v1.2.0，2026-09-22）：§6.6 记录的「读取路径降为 O(增量)」已撤回。**
> 1. **§6.6 标题与正文改写为"实现过 → 测到 150 倍 → 撤回"的历史**，不再是"已实施"；那张 12.5 ms 的表保留，但明确标注为**已撤回形态**、不是当前行为。今天读取路径是 O(历史)，这是有意的。
> 2. **撤回理由**：封印的 `eventPrefixHash` 是 `sha256(canonicalJson(prefix))`，对**解析后的事件**求哈希，`projectionSealPayload()` 也没有任何字节长度字段；因此封印无法见证历史前缀的**原始字节**。把一条历史事件原地改写并保持文件长度与末尾 `seq`，快路径的每一项检查都通过，于是 `snapshot()` 返回封印时的状态而 `replay()` 折算出改写后的状态——同一个 Run 两个答案。杀死它的回归测试是 `projection-read-bound.test.ts` 的「snapshot and replay agree after a historical event is rewritten in place」。
> 3. **§6.5 里「这同时消掉了 §6.3/§6.4 那条优化的最后一个顾虑」已就地改写**：那条推理（"读取路径上没有前缀重校验，所以省掉它不损失什么"）被它自己的论据证伪——`loadProjection()` 正是用已解析事件流重算前缀哈希的，只是**必须在解析之后**才能算。
> 4. **§6.3 与 §6.6 的"残余 O(历史)"结论随之更正**：要把读取降到 O(增量)，需要一条能对**磁盘原始字节**验证的封印（链式哈希是一条路），属事件/投影协议的破坏性变更，不在任何 PR 里。
> 5. **全文 `file.ts:<行号>` 引用改为函数/用例名**：行号在本轮评审中已三次失效（`control-store.ts:736/743/744/765`、`jsonl-store.ts:456/597-602`、`pi-events.ts:524`、`coding-lane.ts:879`、`artifact-store.ts:31`、`observer.ts:78`、`control-store.test.ts:113`），逐条已核对到当前代码。
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
CTRL.dispatch            ArtifactStore.putTextWithContent   (artifact-store.ts)
CTRL.dispatchTransaction DeterministicObserver.observe      (observer.ts)
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
| `createProviderSchedulingTelemetry` 挂载的 Pi 事件回调（`observability/pi-events.ts` 的 `turn_end` / `agent_end` 分支） | 回合结束 | 每回合一次 |
| `PiCodingLane.create()` 传给 `PiCodingLane` 的 close 回调（`runtime/coding-lane.ts`，先 `stopAllShellJobs` 再 `flushProjection`） | 通道收尾 | 每次 Run 结束一次 |

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

   `flushProjection` 恒为 `replay()` 的 1/5–1/9，**热调用（投影已最新）为 0.0 ms**——它没有做全量重放。但它仍然随历史线性增长，原因在 `#readSnapshot` 无条件执行的 `eventStore.events(runId)`：这条路径**总是先取回并解析整条事件流**，然后才用投影 + `applyTail` 增量折叠。`projection.json` 在 20,200 事件下仍是 4.5 KB，说明**投影是 O(状态) 的，而读取路径不是**。

**因此真正剩余的条目是"读取路径的 O(历史) 输入"，不是"屏障频率"。** 具体地：投影带 `lastSeq`，若读取时只需解析事件流中 `(投影 lastSeq, 流末]` 这一段，冷读与屏障都可降为 O(增量)。**这一条后来被实现过，又被撤回**（撤回理由见 §6.6）：封印的 `eventPrefixHash` 是**解析后事件**的 canonical JSON 哈希，所以「验签」与「解析」是同一件事，无法只做前者；要让读取只解析增量，需要一条能对**磁盘原始字节**验证的封印（链式哈希是一条路），那是事件/投影协议的破坏性变更，不在任何 PR 里。因此它今天是一条**未立项的独立条目**——方向仍然成立，但前置条件从"改读取路径"变成了"改协议"。

**证据边界**：上两张表都是本机实测。「`eventStore.events()` 先解析整条流」是经代码核实的事实（`#readSnapshot` 里那次无条件 `events(runId)` 调用），而"因此成本随历史线性"是对上表第三点斜率的解释；若要把它变成门禁，需按 §7.2.2 补一个**计数**指标——例如读取路径解析的事件条数——而不是耗时阈值。

### 6.4 端到端核对：秒级的真正来源是「先解析整条流」，**不是**重放回退

父计划 §11 的完成定义里有一条中心判据：**几毫秒的普通工具不再被 ProofBlade 附加链路放大到秒级**，而 §7.2.1 把机制定位在重放回退（`#readSnapshot` 里 `loadProjection()` 失败后那次 `eventStore.replay()`）。本轮端到端补测**推翻了这个归因**，并把机制改指到 §6.3 那条结论上。

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
2. **真正的成本是"先取回并解析整条事件流"。** `snapshot()` 投影陈旧 **1877 ms** 而 `loadProjection()` 只要 **49 ms**，差额全部来自 `#readSnapshot` 里那次无条件的 `eventStore.events(runId)`：它解析整条 5.4 MB 流，然后才用投影 + `applyTail` 增量折叠。**这与 §6.3 第三条是同一个结论**，只是端到端把它放大到了秒级。注意这条结论在 §6.6 撤回后依然是现状：权威读取路径今天仍然无条件解析整条流。
3. **屏障的收益也是这一条。** 投影当前时冷读 247.6 ms，是因为 GUI 详情走 `loadProjectionHint()` 短路（0.4 ms）而不再解析事件流；`loadProjection()` 本身在 10,001 条前缀下仍要 228.1 ms——**O(历史) 的全前缀重哈希仍在**。所以屏障的价值是"让读取走 hint 短路"，而不是"避免重放"。（这一条描述的是 GUI **显示**路径，今天依然成立：hint 仍在被 GUI 用来加速显示，只是不再被权威读取路径采用——见 §6.6。）
4. ~~**推论：修读取路径的 O(历史) 输入，会同时解决 §6.3、本节第 2 条和残余窗口**……所以这是本计划真正的剩余性能项，且没有安全代价。~~ **这条推论错了，已划掉。** 它建立在「§6.5 的实测表明读取路径上并不存在前缀重校验」之上，而那个前提不成立：`loadProjection()` 正是用**已解析事件流**重算 `hashEventPrefix()` 的，"没有这项校验"实际是"这项校验无法在不解析的前提下完成"。据此实施的读取路径 O(增量) 快路径后来被撤回——它会对同一个 Run 给出两个答案，详见 §6.6。**剩余性能项的定性没有变（读取路径的 O(历史) 输入），但代价变了**：要降下来必须先有一条能对磁盘原始字节验证的封印，属协议变更。

**证据边界**：三张表都是本机实测（探针运行后已删除）。它证明的是**机制与量级**，不是"已达标"——§7.2.3 的目标段仍需按 §7.2.1 的基线评审，且本机数值不可直接当作阈值。

### 6.5 封印的保证边界：它防的是「伪造投影」，不是「篡改事件」

第 4 条那条优化本来受一个安全顾虑约束——"读取路径付 O(历史) 是为了重校验被篡改的事件前缀"。我当时的结论是**这个顾虑不成立**，据此实施了 O(增量) 快路径；**这个结论后来被证伪，快路径已撤回**（§6.6）。这一节保留篡改实验的实测数据，因为数据本身没错、而且正是它推翻了自己的结论：同一份日志，`loadProjection()` **rejected**、`loadProjectionHint()` **accepted**。当时把它读成"读取路径没有这项校验"，正确的读法是"读取路径**有**这项校验，但它必须在解析之后才能做"。

**复现步骤**（每一步都已实测）：

1. 建一个 Run，追加 201 条事件，加一条 `turn_started` 生命周期事件，调用 `flushProjection()` 让投影封印在当前 `lastSeq`；
2. 就地把中间某条事件的 `payload` 改掉（文件长度与末尾 `seq` 都不变），再把 `projection.json` 的 mtime 设为**晚于** `events.jsonl`，以排除 `loadProjectionHint()` 里的 mtime 预筛；
3. 分别用全新 `ControlStore` 读取。

**实测结果**（两类事件都试过：遥测类 `tool_result_recorded`、状态类 `turn_started`）：

| 读取方式 | 篡改后 |
|---|---|
| 重算前缀哈希 vs seal 里的 `eventPrefixHash` | **CHANGED**（封印确实覆盖 payload） |
| `loadProjection()` | **rejected** |
| `loadProjectionHint()`（mtime 已置新） | accepted |
| `snapshot()` | **accepted**，`lastSeq` 与 `replay()` 一致 |

**代码路径**：`#readSnapshot` 里的 `if (!durableStateChanged && snapshot === undefined)` 让 `loadProjection()` **只在本进程没有该 Run 快照缓存时**才被调用；revision 一变即跳过它、走 `eventStore.replay()`，而 `replayWithTask()`（`jsonl-store.ts`）只把磁盘事件折叠一遍、**不做任何校验**。

**这是设计边界，不是缺陷。** 仓库既有的 `control-store.test.ts`（用例「ControlStore rejects a self-hashed projection that is not sealed to the event prefix」）已经把封印的保证测清楚了：伪造一个 `status: "FAILED"` 且自哈希正确的投影后，`snapshot()` 仍然返回 **`READY`**（来自事件），并断言 `replayCount === 1`。也就是说：

- **封印要防的是「用伪造投影覆盖真实事件」**。这条不变量成立：投影是派生物，校验失败时被丢弃，事件才是权威。
- **封印不承诺「事件内容本身未被改动」**。事件是信任根；能写 `events.jsonl` 就等于能改状态，这一点在没有逐事件签名之前无法改变。
- ~~因此权威读取路径**不需要**为防篡改去重算前缀哈希——`snapshot()` 走 `replay()` 并不会让攻击者多得到什么，因为他本来就能写事件。~~ **这一条不成立，已划掉。** 前两条是关于"事件能否被改"的，这一条却推出"读取路径不必重算前缀哈希"——而重算前缀哈希防的不是"改事件"，是"**读了改过的事件却仍按未改的投影作答**"。跳过整条流的解析就同时跳过了这次重算，后果见下一段与 §6.6：`snapshot()` 与 `replay()` 会对同一个 Run 给出两个答案。

**上面这条推理后来被证伪了，而且证伪的正是它自己的论据。** 本节写的时候据此得出：读取路径不必重算前缀哈希，因为「读取路径上原本就没有这项能力」。但 `loadProjection()` 的实现说明相反——它接收**整条已解析事件流**，在判定期限内重算 `hashEventPrefix(events, runId, snapshot.lastSeq)` 并与封印里的 `eventPrefixHash` 比对（见 `jsonl-store.ts` 的 `loadProjection`）。也就是说：

- 权威读取路径**确实**在做这项校验，它只是**要求把事件解析出来才能做**。所以「读取路径上没有这项能力」不成立；成立的只是「这项能力无法在**不解析**的前提下使用」。
- 于是 §6.3/§6.4 那条优化（读取只解析 `(投影 lastSeq, 流末]`）**不是"白拿"**：跳过整条流的解析，等于同时跳过了这次前缀重校验。撤回实测（§6.6）给出了后果——把一条历史事件原地改写、保持文件长度与末尾 `seq`，`loadProjectionHint()` 全部检查通过并返回封印时的状态，而 `replay()` 折算出改写后的状态。同一个 Run，两条路径给出两个答案。
- **被放弃的信号因此不是"顺带的"**：`loadProjectionHint()` 认不出这类改写，而 `loadProjection()` 认得出；两者的差集正好是"投影与日志不一致"这一类。§6.5 表格里 `loadProjection()` 一行是 **rejected**、`loadProjectionHint()` 一行是 **accepted**，同一份日志——本节的表格当时就把这个差集摆在那里，只是结论写反了方向。

**仍然成立的部分**：封印要防的确实是「用伪造投影覆盖真实事件」，这条不变量没有变，§6.5 表格前三行的实测也没有变。变的是由它推出的**下一步**——由「读取路径没有这项能力」推出「可以省掉 O(历史)」是不成立的推论。

**注释仍然是失准的**：读取路径上原先有一条注释写「replay the full stream so modified prefixes and task-contract tampering are revalidated」。`replay()` 里没有任何 "revalidate" 步骤——它只是把磁盘上的事件折叠一遍；做前缀重校验的是 `loadProjection()`，不是 `replay()`。**该注释已删除**，替换为 `#readSnapshot` 里那段说明"为什么权威路径不走 `loadProjectionHint()` 捷径"的注释。

**证据边界**：以上为可复现实测，探针已删除、未入库。写入召回后我**补了一条测试**（当时认为既有 `control-store.test.ts` 已覆盖封印的真实保证，这一点判断错了）：`projection-read-bound.test.ts` 的「snapshot and replay agree after a historical event is rewritten in place」用真实 dispatch → 原地改写（补齐同字节长度）→ 强制投影 mtime 更新 → 断言 `snapshot()` 与 `replay()` 的 `phase`/`status`/`lastSeq` 一致。它同时断言 `loadProjectionHint()` **仍然接受**那条被改写的日志，把"hint 认不出这类改写"这个已知限制钉住，而不是声称它已解决。

### 6.6 读取路径的 O(增量) 快路径：**实现过、测出 150 倍、然后撤回**

**先读结论：今天读取路径是 O(历史)，这是有意的。** 本节记录的是一次**已撤回**的改动。撤回后的现状是：`#readSnapshot` 每次都无条件执行 `eventStore.events(runId)`，把整条事件流解析出来，再用投影 + `applyTail` 增量折叠。曾经达到的 12.5 ms 冷读**不再是当前行为**，下面的表与数字只能作为"这条机制当时确实生效过"的历史证据读，不能当作今天的性能。

**历史：做了什么、测到什么。** §6.3–§6.4 定位到「读取路径无条件解析整条事件流」是秒级的真正来源。改动分两处，因为根因有两个——第一次只修投影那一处，实测只从 1877 ms 降到 1845 ms，逐段计时才找到第二处：

| 阶段 | 修改前 | 修改后（当时） |
|---|---:|---:|
| `migrateLegacyRun()`（每次冷读都先跑） | **13.4 ms，解析 +2001** | **3.7 ms，解析 +0** |
| `loadProjectionHint()` | 6.8 ms，解析 +0 | 3.2 ms，解析 +0 |
| `snapshot()` 主体 | 6.2 ms，解析 +0 | 5.4 ms，解析 +0 |

第二处的修法**保留了下来**，因为它是安全的：`#readSnapshot` 每次缓存未命中都会先调 `#migrateLegacyRunBestEffort`，而 `migrateLegacyRun()` 原本**无条件 `events()` 解析整条流**，只为判断 Run 是否已锚定。现在改为两次有界读：`firstEvent()`（文件头 64 KiB）确认首个 `run_started` 带合法 `authorityHash`，加 `lastEventSeq()` + `lastEvent()`（文件尾 64 KiB）确认末尾不是 `run_authority_migrated`（后者本身也是锚，必须走完整路径）。判断不了就退回完整解析，因此**只多花时间、不会给错答案**。§7 里"读取路径改为请求 eager 投影"那条变异针对的不是它。

**当时撤回前的实测**（10,001 事件，生产形态：读写双方都用默认解析出的同一 authority）——**已失效，仅作历史**：

| 场景 | 修改前 | 快路径生效时（**已撤回**） |
|---|---:|---:|
| 冷读，投影当前 | **1876 ms**（解析 +10001） | **12.5 ms**（解析 **+0**） |
| 冷读，投影之后又有新增事件 | 1722 ms | 仍走完整路径（预期如此） |

即当时测到 **150 倍**，且快路径**一个事件都不反序列化**。规模曲线（每次都是全新 reader，缓存为空）当时也一致：投影当前时冷读恒定 11–12 ms，不随历史增长；投影落后时按 O(历史) 增长。**这些数字现在都不复现**，因为那条路径已经不在了。

**为什么撤回：快路径与 `replay()` 会对同一个 Run 给出不同答案。** 根因在封印的**构造**，不在实现：

- `projectionSealPayload()` 承载的是 `{ schemaVersion, runId, lastSeq, snapshotHash, eventPrefixHash }`，**没有任何字节长度字段**。`JsonlRunRevision` 里的 `size` 是内存态身份，不是封印的一部分。
- `eventPrefixHash` 是 `sha256(canonicalJson(prefix))`，**对解析后的事件**求哈希，不是对磁盘字节。
- 因此封印无法见证"历史前缀的字节就是当初那一段"。把一条历史事件**原地改写**、保持文件长度与末尾 `seq` 不变，`loadProjectionHint()` 的每一项检查（mtime 预筛、投影自哈希、task 契约守卫、`lastSeq` 比对、HMAC 验签）全部通过，它返回**封印时的状态**；而 `replay()` 折算出**改写后的状态**。同一个 Run，两条路径两个答案。
- 想让快路径安全，就得让封印能**从磁盘字节**验证前缀（链式哈希是一条路：新前缀哈希基于「上一前缀哈希 ‖ 新增事件字节」）。这是**事件/投影协议的破坏性变更**，不在任何 PR 里，需要单独决策与迁移方案。在那之前，权威读取路径保持 O(历史)。

**杀死它的回归测试**：`packages/materials/tests/projection-read-bound.test.ts` 的「snapshot and replay agree after a historical event is rewritten in place」。构造方式与 §6.5 的篡改实验同源——真实 dispatch 出一条状态事件、`flushProjection()`、把 `"phase":"reconnaissance"` 原地改成 `"phase":"hypothesis"` 并用 `\u0000` 转义补齐到**同字节长度**、把投影 mtime 置新以排除时间预筛——然后断言 `snapshot()` 与 `replay()` 的 `phase`/`status`/`lastSeq` 一致。同一个用例还断言 `loadProjectionHint()` **仍然接受**这条被改写的日志，把"hint 认不出这类改写"钉成已知限制，而不是声称已解决。撤回后权威路径不再信任 hint，所以两条断言同时成立：hint 接受它，而读取路径不采用它。

**还剩什么、以及为什么剩下它**：投影落后时读取仍要解析整条流（本文实测该形态是 §6.4 表里 10,001 事件 / 投影陈旧 = 1647.9 ms；本节旧表同一形态记的是 10,000 事件 1634.8 ms，两处同量级。撤回后没有任何改动碰过这条路径，所以那就是今天的数字）。这不是遗漏：`loadProjection()` 的前缀重校验要求**完整前缀**（`hashEventPrefix` 在 `prefix.length !== lastSeq` 时直接抛错），而按上面那条，验签与解析是同一件事。因此"只解析 `(投影 lastSeq, 流末]`"不仅要改读取路径，还要先有能验证**原始字节**的封印。

**覆盖面与其失效条件（快路径存在时的性质，留作历史）**：快路径要求 `loadProjectionHint()` 能用**同一 authority** 验签；读取方注入不同 secret 时验签失败，退回完整解析（当时实测 2064 ms）。这一类**是** fail-safe——配置不一致只损失性能，不会返回错状态。但它 fail-safe 的只是这一类；**原地改写**这一类它认不出来（长度与末尾 `seq` 都没变，没有 secret 可判），而那正是撤回原因。旧文写「这是 fail-safe」并就此收尾，把后者当成了前者。

**撤回后 `loadProjectionHint()` 并没有消失，它现在只服务于显示路径。** 调用点只有三处（`git grep -n loadProjectionHint -- packages apps`；去掉运行时形状清单、注释与测试后的调用点）：`ControlStore.loadProjectionHint()`（公共入口）、`#projectionAlreadyCurrent`（屏障的廉价检查，它只在能通过时决定**少写一次投影**，不决定读者看到什么），以及 GUI 的 `DebugDataService`（`runListSnapshot()` 的 `allowUnsealedHint` 分支、以及详情路径的 `hinted ?? await snapshot()`）。**每一处都是"显示"而不是"权威"**：GUI 先接受 hint，权威路径仍然独立判定。这是有意的分工——§6.5 那条"已知限制"（hint 认不出保持长度的原地改写）因此只影响显示层，不影响 Run 的状态判定。

**守恒测试**：`packages/materials/tests/projection-read-bound.test.ts` 6 条，锁住的是**代价换来的那些保证**，而不是计时。下面逐条给出它今天钉的是什么，以及本节原列表里哪几条描述的是**已不存在的**行为：

| # | 用例 | 今天钉住的 | 与本节旧列表的关系 |
|---:|---|---|---|
| 1 | `[contract:cold-read-parse-budget] a current projection answers a cold read with the sealed state` | 投影当前时冷读返回**完整的、与封印一致的**状态（`lastSeq`、`projectionHash`） | 对应旧列表第 1 条的**结论**，但**不再**断言"解析 0 个事件"——权威路径必然解析整条流，那条计数断言随快路径一起撤回 |
| 2 | `[contract:cold-read-parse-budget] a projection behind the log still folds forward to the real state` | 投影落后时折叠到与 `replay()` 一致的 `lastSeq` 与 `projectionHash`（**解析条数被记录为观测，不再是门禁**） | 对应旧列表第 2 条，仍然成立 |
| 3 | `a projection failing its seal is discarded and never overrides the event log` | 伪造投影正文 + 重算自哈希 + 保留封印 → 状态仍由事件决定 | 对应旧列表第 3 条，仍然成立 |
| 4 | `an absent projection still rebuilds the state from the event log` | 投影缺失 → 从事件日志重建，结果与合法投影一致 | 对应旧列表第 4 条，仍然成立 |
| 5 | `the fast path is not engaged by an unsealed legacy projection` | 去掉封印的旧投影不被权威路径信任 | 对应旧列表第 5 条；**"快路径不得被未认证投影触发"这个说法已无对象**（快路径不存在），它现在是"权威路径拒绝未密封投影" |
| 6 | `snapshot and replay agree after a historical event is rewritten in place` | 上述原地改写后 `snapshot()` 与 `replay()` 给出同一个 Run；并断言 hint 仍会接受它 | **新增，旧列表没有**。就是这一条杀死了快路径 |

第 3、5 条仍然是"封印的保证"（§6.5）的回归防线：**"伪造投影不能覆盖真实事件"这条不变量成立**。撤回改变的不是这条不变量，而是由它推出"可以省掉前缀重校验"的那个推论——那个推论错了。

**这一节现在大半是历史。** 如果只想回答"今天的读取路径是不是 O(增量)"：**不是**；它是 O(历史)，且这是撤回后的有意选择。


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
