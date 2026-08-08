# Context and Compaction

```json component-metadata
{
  "id": "materials-context",
  "name": "Context and Compaction",
  "version": "0.4.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-08T17:13:52.928Z",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-08T17:13:52.928Z",
    "lastSecurityAuditAt": "2026-08-08T17:13:52.928Z",
    "sourceHash": "0bc56467ff87116f9d37fe6d76a40b5c61919c5e21457d78b501ab426d1125b8",
    "result": "passed"
  }
}
```

## 职责

把 Control Store、Knowledge、Artifacts 和 Pi Session 编译成有预算的六层上下文，并执行 Tool 配对修复、snip、prune、checkpoint 与两阶段 durable compaction。

## 入口与边界

- `compiler.ts` 产出 ContextManifest；`maintenance-coordinator.ts` 决定维护阶段。
- `agent-pruner.ts` 处理消息对；`checkpoint.ts` 与 `durable-compaction.ts` 保证压缩可恢复。
- 本组件编译状态，不成为 Fact 或历史的权威来源。

## 开发规则与验证

保持稳定前缀与动态尾部分离。已组织知识只注入 Reasoning Forest 的树摘要，不展开完整图；尚未组织的近期 Evidence 仍保留短索引。裁剪不得破坏 Tool pair、事实 ID、Evidence/Artifact 引用、树根、共享节点或最近错误。阈值和摘要格式变化必须有确定性回归测试。

进入 snip 阶段后，非错误 Tool Result 从首次进入 Provider 视图起就使用固定 head/tail 表示，禁止因“最新结果变旧”而再次改写同一消息。75% 阶段把旧 Tool exchange 裁剪到约 50% 的恢复目标；80% 触发回合结束后的持久 Pi compaction。持久压缩必须再次约束 `retainedTail`，不能依赖 Pi 固定的 20K recent-tail 默认值。错误结果保持原始诊断文本，最新完整 Tool pair 和 Control Store 检查点必须保留。

```powershell
npm run test:materials
node --import tsx --test packages/materials/tests/context*.test.ts
```
