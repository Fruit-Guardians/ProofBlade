# Effects and Artifact Store

```json component-metadata
{
  "id": "materials-effects",
  "name": "Effects and Artifact Store",
  "version": "0.2.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "33f00f9400191d1942e41c56212c5824e0165393673b66b8a7307843bacf0044",
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

`PROPOSED` 已落盘但外部执行尚未开始时，重复请求复用原 Effect 和原始参数，只补一次 `STARTED`，不会制造第二个 idempotency key；Verifier attestation 的输入先写入独立 verifier-owned recovery Artifact，恢复只按其稳定哈希读取，不把候选明文塞进 Effect 事件；`STARTED`、`UNKNOWN`、`RECONCILED` 或缺少结果 Artifact 的记录必须先走 reconcile，禁止调用方猜测性重跑。

调用方可以为 Effect 结果提供 Artifact sensitivity；生产路径使用 `result_candidate` 表示待验证的安全结果，`flag_candidate` 仅作为旧 Artifact 的读取兼容值。显式分类优先于内容形状启发式，未提供时仍按 `public` 保存；内容形状不会改变任务路由或验证结论。

```powershell
npm run test:materials
```
