# Agent Orchestration

```json component-metadata
{
  "id": "materials-orchestration",
  "name": "Agent Orchestration",
  "version": "0.1.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T20:17:19.5056968+08:00",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-07T20:17:19.5056968+08:00",
    "lastSecurityAuditAt": "2026-08-07T20:17:19.5056968+08:00",
    "sourceHash": "5ac13592eb2865a7dbe44af1193eb2e40dc6c7ce21e4a137260c7e88f72c342b",
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
- `SingleAgentRunOptions.signal` 在 Planner 返回、模型返回和验证入口 fail-closed，并通过同一个 Controller 将 Abort 传递给当前 Solver Lane。
- 暂停不是终态或预算耗尽；Auto 模式不得把暂停中的运行改写成 `EXHAUSTED`。

```powershell
npm run test:materials
npm run eval
```
