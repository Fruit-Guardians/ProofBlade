# Context and Compaction

```json component-metadata
{
  "id": "materials-context",
  "name": "Context and Compaction",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

把 Control Store、Knowledge、Artifacts 和 Pi Session 编译成有预算的六层上下文，并执行 Tool 配对修复、snip、prune、checkpoint 与两阶段 durable compaction。

## 入口与边界

- `compiler.ts` 产出 ContextManifest；`maintenance-coordinator.ts` 决定维护阶段。
- `agent-pruner.ts` 处理消息对；`checkpoint.ts` 与 `durable-compaction.ts` 保证压缩可恢复。
- 本组件编译状态，不成为 Fact 或历史的权威来源。

## 开发规则与验证

保持稳定前缀与动态尾部分离。裁剪不得破坏 Tool pair、事实 ID、Evidence/Artifact 引用或最近错误。阈值和摘要格式变化必须有确定性回归测试。

```powershell
npm run test:materials
node --import tsx --test packages/materials/tests/context*.test.ts
```
