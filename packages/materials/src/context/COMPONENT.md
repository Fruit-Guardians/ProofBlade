# Context and Compaction

```json component-metadata
{
  "id": "materials-context",
  "name": "Context and Compaction",
  "version": "0.4.5",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "e3f04e7afe3a580387bedaa9db84043a047a237eed15e70215e6e56ce490f66d",
    "result": "passed"
  }
}
```

## 职责

把 Control Store、Knowledge、Artifacts 和 Pi Session 编译成有预算的六层上下文，并执行 Tool 配对修复、snip、prune、checkpoint 与两阶段 durable compaction。

## 入口与边界

- `compiler.ts` 产出 ContextManifest；`maintenance-coordinator.ts` 决定维护阶段。
- `model-receipt.ts` 产出模型可见的 complete/bounded/receipt 展示，明确 Artifact URI、内容哈希、省略数量和精确 Recall 下一步。
- `agent-pruner.ts` 处理消息对；`checkpoint.ts` 与 `durable-compaction.ts` 保证压缩可恢复。
- 本组件编译状态，不成为 Fact 或历史的权威来源。
- `<phase>` 中的 `control_view` 是有界只读摘要：Gate、ActionBundle、预算、失败分类、active WorkItem、Verifier 恢复请求和禁止重复 key 均来自当前 generation 的 Projection；它不包含原始日志，也不能写回 Control Store。

## 开发规则与验证

保持稳定前缀与动态尾部分离。已组织知识只注入 Reasoning Forest 的树摘要，不展开完整图；尚未组织的近期 Evidence 仍保留短索引。裁剪不得破坏 Tool pair、事实 ID、Evidence/Artifact 引用、树根、共享节点或最近错误。阈值和摘要格式变化必须有确定性回归测试。

工具结果即使已写入 Artifact，也必须在需要时把有界 Receipt 放入模型可见 `content`，不能只把引用放在 `details`。Receipt 不替代原始 L2；它提供状态、哈希、Artifact URI 和 `evidence.read`/Recall 入口。

进入 snip 阶段后，非错误 Tool Result 从首次进入 Provider 视图起就使用固定 head/tail 表示，禁止因“最新结果变旧”而再次改写同一消息。75% 阶段把旧 Tool exchange 裁剪到约 50% 的恢复目标；80% 触发回合结束后的持久 Pi compaction。持久压缩必须再次约束 `retainedTail`，不能依赖 Pi 固定的 20K recent-tail 默认值。错误结果保持原始诊断文本，最新完整 Tool pair 和 Control Store 检查点必须保留。

```powershell
npm run test:materials
node --import tsx --test packages/materials/tests/context*.test.ts
```
