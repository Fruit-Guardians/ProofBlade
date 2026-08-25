# Agent Orchestration

```json component-metadata
{
  "id": "materials-orchestration",
  "name": "Agent Orchestration",
  "version": "0.1.6",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-11T11:32:51.204Z",
  "qualityAudit": {
    "bugAuditCount": 6,
    "securityAuditCount": 6,
    "lastBugAuditAt": "2026-08-11T11:32:51.204Z",
    "lastSecurityAuditAt": "2026-08-11T11:32:51.204Z",
    "sourceHash": "34814af5ad77b8a60b176108d7e0a8d9267439b5b700874151f19b8b0d832a9d",
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

```powershell
npm run test:materials
npm run eval
```
