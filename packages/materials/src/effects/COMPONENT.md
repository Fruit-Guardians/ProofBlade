# Effects and Artifact Store

```json component-metadata
{
  "id": "materials-effects",
  "name": "Effects and Artifact Store",
  "version": "0.3.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T15:00:00+08:00"
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

调用方可以为 Effect 结果提供 Artifact sensitivity。`secret` 始终优先；其他结果检测到候选时升级为 `flag_candidate`，否则保留显式 `target` 或默认 `public`。

```powershell
npm run test:materials
```
