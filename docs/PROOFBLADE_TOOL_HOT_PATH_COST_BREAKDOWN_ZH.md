# 工具热路径成本分解与 T1 write-behind 队列设计（PLAN-240 表项 T1）

> 文档版本：1.0.0
> 编写日期：2026-09-19
> 文档性质：**成本分解实测 + 设计提案，尚未实施**
> 父文档：`docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.6.3、表项 T1
> ProofBlade 基线：`156ec17`

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

单次 `read`：4 条事件 / 2 个提交 / 约 25ms p50（PR #230 实测）。即**每个提交约 12ms**，其内容为：run 锁获取 → 事件追加 + `fsync` → 快照折叠。

### 2.3 T3 到底省了多少

用真实 ControlStore 对同一进程连续 5 次 `ExperimentGate.record()` 对比：

| 模式 | 5 次耗时 | 每次 |
|---|---:|---:|
| 延后投影（T3 之后的现状） | 46.8ms | 9.4ms |
| 强制投影（T3 之前的行为） | 68.1ms | 13.6ms |

**结论：投影重写每次约 4.3ms，约占单次提交成本的三分之一。**这是对 PR #228 独立、可复现的收益量化——不再是「改了代码」，而是「省了 4.3ms/次」。

### 2.4 因此剩余成本的结构

| 组成 | 每次 | 可否移除 |
|---|---:|---|
| run 锁 + event append + `fsync`（提交 1：artifact） | 约 12ms | 否——artifact 是 Evidence 提升的引用对象 |
| run 锁 + event append + `fsync`（提交 2：observation） | 约 12ms | **否——见 §2.5** |
| 投影重写 | 0（已由 T3 移除） | 已解决 |
| Artifact 回读 | 0（已由 PR #229 移除） | 已解决 |

**「零同步提交」在当前架构下不可达**：只要结果需要被后续 Evidence 引用，artifact 注册就必须在模型继续之前 durable。父计划 §5.6.3 的措辞应据此修正为「**普通结果最多一次同步提交**」。

### 2.5 表项 T2 不可行（经代码核实）

父计划表项 T2 要求「将 Artifact、annotation、Observation、Evidence、Experiment 合并为单次 ToolResultCommit」。**核实结论：在当前事务模型下不可行**，理由不是成本而是顺序：

```text
ControlStore.dispatchTransaction(runId, prepare, options)
  -> const transaction = prepare(before);          // before = 批次之前的快照
  -> #commitCommands(runId, before, transaction.commands, ...)
```

`prepare` 拿到的是**批次之前**的快照，整批命令都对它校验。因此同一批次内：

- 对「本批次刚注册的 artifact」发 `artifact_annotation` 会被校验拒绝；
- 引用「本批次刚创建的 observation」的 `evidence` 会被 `validateEvidence` 拒绝——它对 artifact 用的是 `snapshot.artifacts[artifactId]`（第 1573 行）而非同批次引用表，而 `artifact_annotation` / `supports` 走的是允许同批次的 `references`。

即 **artifact 注册必须先于派生观察提交**，这是被强制的不变量，不是实现疏漏。要突破它需要改事务模型（例如让校验按批内顺序增量应用），那属于语义变更，不是性能优化。

**实测复核**：一次 `read` 的公共写入口调用数为 3，但其中 `dispatch` 会内部委托 `dispatchBatch`，因此**逻辑提交为 2**（artifact 注册、派生观察各一）。这与 §2.1 的 4 条事件吻合：`observer.observe` 已把 annotation、observation、evidence 放在同一批次里。

**因此 T1/T2 的合并空间已被穷尽**：不能在 2 个提交以下完成一次「归档 + 派生观察」。剩余的 25ms 中约 24ms 是两次提交各自的固有成本，只能靠减少提交**次数以外的**手段解决（例如降低 `fsync` 频率——父计划 §5.6.6 已明确反对直接删除屏障）。

### 2.6 「合并」与「延后」是两条不同的路，只有后者可行

§2.5 否掉的是**合并**（把两个提交压成一个，两者仍都在工具返回前）。§3 提议的是**延后**（把派生观察移到回合边界，工具返回前只剩一个提交）。两者不可混淆：

| 方案 | 机制 | 工具返回前的提交数 | 可行性 |
|---|---|---:|---|
| 合并（表项 T2） | 一个批次里同时注册 artifact 并派生观察 | 1 | **不可行**，被 §2.5 的批前校验强制阻断 |
| 延后（§3，表项 T1） | artifact 同步提交；派生观察排队到回合边界 | 1 | 可行，但需处理 §3.3 的三处语义变化 |

两者最终都能把工具返回前压到 **1 个提交**，但路径不同：合并要求改事务模型（语义变更），延后只需引入队列与屏障（既有模式，`ControlEventBatcher` 已是同构先例）。**因此应走延后，并据此把表项 T2 关闭或改述**。

## 3. 设计提案：延后派生观察

### 3.1 目标

把提交 1 保留，把提交 2（annotation + observation + evidence）推迟到回合边界，使普通 `read`/`glob`/`grep`/短 `bash` 从 2 次同步提交降到 1 次，理论收益约 12ms/次（25ms → 约 13ms）。

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

**唯一仍然失准的是注释**：`control-store.ts:739-741` 写「replay the full stream so modified prefixes and task-contract tampering are revalidated」。`replay()` 里没有任何"revalidate"步骤——它只是把磁盘上的事件折叠一遍。这句话会让人（包括我）误以为读取路径在校验事件完整性，进而得出"不能省掉 O(历史)"的错误结论。**建议改注释**，但这属于源码语义说明的改动，我没有自行提交。

**证据边界**：以上为可复现实测，探针已删除、未入库。我**没有**添加测试：既有 `control-store.test.ts:113` 已经覆盖封印的真实保证，再加一个只会重复它。

## 7. 参考

- `docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.4.3、§5.6.3、§5.6.6、§5.7.1、§5.7.2、§6、表项 G/H/T1
- `scripts/tool-hot-path-real-run-baseline.ts`：§2 全部数据的产生脚本
- `packages/materials/src/effects/artifact-store.ts`、`packages/materials/src/knowledge/observer.ts`：§2.1 的两个提交点
- `packages/materials/src/observability/pi-events.ts`：§3.2 引用其 "Control-plane commands never use this class" 边界
- `apps/gui/src/App.tsx`、`apps/gui/src/shared.ts`：§6.2 的载荷构成与客户端消费点
