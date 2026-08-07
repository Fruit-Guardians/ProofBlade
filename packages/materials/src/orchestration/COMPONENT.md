# Agent Orchestration

```json component-metadata
{
  "id": "materials-orchestration",
  "name": "Agent Orchestration",
  "version": "0.2.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T15:00:00+08:00"
}
```

## 职责

协调单 Agent Drive Loop、Auto/Assist 边界、阶段推进和 Planner-to-Executor 结构化交接。活动控制留在 Harness，不由自由文本决定。

## 入口与边界

- `single-agent-loop.ts` 是生产执行循环。
- `planner.ts` 根据任务元数据和知识版本产生确定性 HandoffRecord。
- Planner 与 Executor 使用独立职责；Verifier 决定完成，不由 Orchestrator 直接确认。
- Executor 提示要求先检查目标材料，再按需发现目标专用 Capability；不把所有题型固定为静态文件读取流程。

## 开发规则与验证

plan-only、等待确认和验证边界 fail-closed。引入新模型角色前先证明成功率、成本和延迟收益，并保持交接契约可测试。

```powershell
npm run test:materials
npm run eval
```
