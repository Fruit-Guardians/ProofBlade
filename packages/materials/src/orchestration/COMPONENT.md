# Agent Orchestration

```json component-metadata
{
  "id": "materials-orchestration",
  "name": "Agent Orchestration",
  "version": "0.1.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T22:17:05.6261580+08:00",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-07T22:17:05.6261580+08:00",
    "lastSecurityAuditAt": "2026-08-07T22:17:05.6261580+08:00",
    "sourceHash": "0c0a5725ce75314d200eff120827dab57ae04ebdf87347b3e886b298981e21eb",
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
- 验证 Effect、Verifier 返回、进入 report 和 finish 前都必须检查 AbortSignal；暂停状态只能由显式 `resume` 恢复，不能被普通阶段转换覆盖。
- 暂停不是终态或预算耗尽；Auto 模式不得把暂停中的运行改写成 `EXHAUSTED`。

```powershell
npm run test:materials
npm run eval
```
