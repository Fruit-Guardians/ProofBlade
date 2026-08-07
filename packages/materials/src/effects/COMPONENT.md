# Effects and Artifact Store

```json component-metadata
{
  "id": "materials-effects",
  "name": "Effects and Artifact Store",
  "version": "0.2.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "d39c55335693194162207c3f7d7c1d0c38e17de77aa71d69884bc43e207b3dbc",
    "result": "passed"
  }
}
```

## 职责

以 `PROPOSED → STARTED → FINISHED` 记录外部副作用，并把大输出保存为不可变 Artifact。恢复时依据 replay policy 重跑、收养或标记 UNKNOWN。

## 入口与边界

- `effect-journal.ts` 协调副作用生命周期和幂等键。
- `artifact-store.ts` 按哈希持久化与校验输出，并在注册时接受名称、摘要、标签、用途和关联 ID 的初始语义。
- Effect 状态属于 Control Store；目标执行由 Sandbox/Runtime 提供。

## 开发规则与验证

所有非纯操作必须声明 replay policy 和资源键。Artifact 先落盘再引用，敏感内容只进入 Artifact，不进入事件正文；后续命名或用途变化只更新 Control 语义投影，不改写内容哈希。

调用方可以为 Effect 结果提供 Artifact sensitivity；显式分类优先于内容形状启发式，未提供时继续检测 flag candidate 并默认使用 `public`。

```powershell
npm run test:materials
```
