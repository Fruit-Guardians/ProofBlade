# 中断恢复协议

ProofBlade 将恢复看作 Orchestrator 的确定性工作，而不是让模型猜测上一次执行到了哪里。`RunRecoveryService` 按固定顺序执行：回收过期 lease、检查 Fixture 生命周期、在必要时递增 generation、终结旧代次 job、最后协调未完成 Effect。`proofblade reconcile RUN_ID` 使用同一个入口。

## 六个故障注入点

| # | 中断窗口 | 持久事实 | 恢复动作 | 强制不变量 |
| --- | --- | --- | --- | --- |
| 1 | `effect_started` 后、真实执行前 | Effect 为 `STARTED`，没有结果制品 | `pure`/`idempotent` Effect 使用原 effect id 执行；其他策略按契约协调 | Effect 记录只有一份，第二次恢复为空操作 |
| 2 | 工具完成且 artifact 注册后、`effect_finished` 前 | artifact 带 `sourceEffectId` | 采用已存在的 artifact 并补记 `effect_finished` | 不再次执行，不产生第二个结果制品 |
| 3 | assistant 工具调用落入 Pi Session 后、preflight 前 | assistant 消息存在，Tool 结果缺失 | Provider 上下文构建时补入 `isError: true` 的中断占位结果 | 每个调用恰有一个紧邻结果 |
| 4 | 并行 Tool 批次只完成一部分 | 部分真实结果存在 | 保留真实结果，为缺失调用补错误结果，并按 assistant 原调用顺序重建 | 无孤立、重复、错位或缺失结果 |
| 5 | 机械摘要和 checkpoint 已写、Pi Session append 前 | checkpoint、摘要 artifact 和 Fact 已在 Control Store | 重试复用最后一个同原因 checkpoint，再向 Pi append 一次 compaction | 不重复摘要，不丢 Fact，Pi 分支只有一条 compaction |
| 6 | lease 心跳停止或 Fixture 意外消失 | lease、Fixture generation、活动 Effect/job 可重放 | 回收过期 lease；重建 Fixture 并递增 generation；旧代次 Effect/job 进入 `UNKNOWN` | 没有活动 lease/job，旧代次动作不在新 Fixture 上执行 |

对应的可执行回归位于 `packages/materials/tests/interruption-recovery.test.ts`。每个用例还检查恢复后的稳定性：再次恢复不追加事件，Control Store replay 与持久 projection 保持同一哈希。

## Effect 与代次

`EffectJournal.reconcile()` 先比较 Effect 参数中的 `generation` 与当前 Run generation。两者不同时，即使重放策略是 `pure`，也会把结果标记为 `UNKNOWN`。这防止旧环境中的读取或实验在新环境中被误当成同一动作。

结果 artifact 是 `effect_finished` 之前的提交屏障。恢复时若找到相同 `sourceEffectId` 的 artifact，就从不可变制品读取结果并补齐 Effect，而不是再次启动进程。

## Lease 与 Fixture

lease 释放携带 `ownerLane` 和 `generation`。回收前再次读取当前 lease，避免旧 Worker 删除后来获得的新一代 lease；已经过期的 lease 也不能通过迟到 heartbeat 续期。

Fixture 健康状态分为 `healthy`、`missing`、`unhealthy` 和 `generation-drift`。缺目录、缺可见目标、缺 scorer、缺 generation marker 或 Control Store 代次不一致都会触发重建。重建后的 generation 严格大于已记录代次，从而使旧证据和旧 Effect 可被识别。

## Pi compaction 两阶段提交

`DurableCompactionCoordinator` 在 Pi `session_before_compact` hook 中运行：

1. `CheckpointService` 写入固定格式摘要 artifact。
2. Control Store 注册 checkpoint，Fact、否决假设、Effect、lease 和下一动作已可恢复。
3. hook 把同一摘要作为机械 compaction 返回给 Pi。
4. Pi 向 JSONL Session 追加 compaction entry。
5. `session_compact` 观测事件记录完成情况。

步骤 2 和 4 之间中断时，checkpoint 自身是最后一个领域事件。再次创建相同原因的 checkpoint 会复用它，因此不需要额外 Provider 摘要调用。

## Tool 消息不变量

`repairAgentMessages()` 在每次 Pi Provider 上下文构建时运行，不依赖上下文是否达到 snip/prune 阈值。`toolPairViolations()` 可独立检查以下错误：

- assistant Tool 调用缺少结果；
- Tool 结果没有所属 assistant 批次；
- 同一 Tool 调用出现多个结果；
- 结果顺序与 assistant 原调用顺序不同。

修复只改变本次 Provider 视图。完整 Pi Session、Effect、制品和 Control Store 事件仍保留，供审计与后续检索。
