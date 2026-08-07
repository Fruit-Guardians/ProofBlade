# Run Recovery

```json component-metadata
{
  "id": "materials-recovery",
  "name": "Run Recovery",
  "version": "0.1.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T19:40:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-07T19:40:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T19:40:00+08:00",
    "sourceHash": "64f14564a818ed0891da384ec054ec54172512974bf80f74a021fe64fcb88231",
    "result": "passed"
  }
}
```

## 职责

在进程重启或中断后协调租约回收、Fixture generation 核对、Job reconciliation、Effect 恢复和上下文溢出收敛。

## 入口与边界

- `run-recovery.ts` 按环境、控制状态、Job、Effect 的固定顺序恢复。
- 恢复只解释 durable facts，不依赖内存中的旧对象。
- UNKNOWN 是禁止重放 Effect 的显式终态，不用猜测成功。

## 开发规则与验证

新增中断点必须证明重复执行收敛、旧 generation 隔离且投影哈希一致。恢复顺序变化需要同步恢复文档。

```powershell
node --import tsx --test packages/materials/tests/*recovery*.test.ts
```
