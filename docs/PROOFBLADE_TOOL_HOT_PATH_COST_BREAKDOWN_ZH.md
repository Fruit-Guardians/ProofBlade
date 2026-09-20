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

## 6. 参考

- `docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §5.6.3、§5.6.6、§5.7.1、§5.7.2、§6、表项 T1
- `scripts/tool-hot-path-real-run-baseline.ts`：§2 全部数据的产生脚本
- `packages/materials/src/effects/artifact-store.ts`、`packages/materials/src/knowledge/observer.ts`：§2.1 的两个提交点
- `packages/materials/src/observability/pi-events.ts`：§3.2 引用其 "Control-plane commands never use this class" 边界
