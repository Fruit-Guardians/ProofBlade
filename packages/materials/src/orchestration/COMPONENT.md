# Agent Orchestration

```json component-metadata
{
  "id": "materials-orchestration",
  "name": "Agent Orchestration",
  "version": "0.1.7",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 7,
    "securityAuditCount": 7,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "0e0220e2371dc39e6952ef01de1c7682f0328f8dc99f36866374fc711ef9d3d8",
    "result": "passed"
  }
}
```

## 职责

协调单 Agent Drive Loop、Auto/Assist 边界、阶段推进和 Planner-to-Executor 结构化交接。活动控制留在 Harness，不由自由文本决定。

## 入口与边界

- `single-agent-loop.ts` 是生产执行循环。
- `planner.ts` 根据任务元数据和知识版本产生确定性 HandoffRecord。
- Planner 与 Executor 使用独立职责；Verifier 决定完成，不由 Orchestrator 直接确认。

## 开发规则与验证

plan-only、等待确认和验证边界 fail-closed。引入新模型角色前先证明成功率、成本和延迟收益，并保持交接契约可测试。

- `SingleAgentCtfLoop` 在 lane 建成后通过 `onLaneReady` 暴露运行控制句柄；每轮模型调用前后都必须检查 durable `PAUSED` 状态。
- CTF loop 的 `onEvent` 会沿着统一 lane factory 传递到 Pi Harness，使 GUI 续解与首轮一样能实时显示 tool start/end、Provider 文本和上下文事件；事件展示不改变 Control Store 真相。
- 验证 Effect、Verifier 返回、report、finish 和最终 exhaust 边界都必须 fail-closed；ControlStore 原子拒绝后的 Loop 必须重新读取状态并保留 `PAUSED`。
- 暂停不是终态或预算耗尽；Auto 模式不得把暂停中的运行改写成 `EXHAUSTED`。
- Provider 的 `length` stop reason 与显式 maximum-context 错误进入同一单次恢复状态机：先持久化检查点并压缩，再继续下一 Executor turn；重复溢出必须明确失败。
- Task-owned reproduction 已由 Loop 统一收口：`CodingClaimVerifier` 已接受的 Completion 直接经过 `REPORT → SUBMIT`，不再错误地重复走 hidden scorer；崩溃恢复不得从 `SUBMIT` 回退到 `REPORT`。
- `RunWorkScheduler.blockAndQueue` 将失败 WorkItem、下一项 READY WorkItem 和 `replan_requested` 放进同一 ControlStore 事务；`phaseBudget` 从 durable Experiment/Effect/Replan 投影推导阶段、工具、提交和恢复余量，重启后不依赖进程内计数。
- `observation-queue.ts` 将事件 ingress 和派生的 Job/Provider/Verifier/Maintenance terminal 事件投影为模型可见的有界队列；队列不单独持久化，`observation_consumed` 是唯一确认标记，重启通过 ControlStore 事件流重建。单 Agent 在 Provider terminal、Tool end、Job safe point 或 idle 边界消费，未来多 Agent 只预留同一接口，不启用并行策略。

```powershell
npm run test:materials
npm run eval
```
