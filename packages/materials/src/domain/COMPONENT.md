# Domain Contracts

```json component-metadata
{
  "id": "materials-domain",
  "name": "Domain Contracts",
  "version": "0.2.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T02:31:17+08:00"
}
```

## 职责

定义 ProofBlade 的 Task、Run、Event、Fact、Evidence、带语义元数据的 Artifact、Effect、Job、Checkpoint、Telemetry 和 Planner handoff 等业务类型及规范化辅助函数。

## 入口与边界

- `types.ts` 是领域类型源；`handoff.ts` 处理结构化计划交接；`utils.ts` 提供领域级 ID/哈希封装。
- 可以扩展 Atoms/Molecules 类型，不反向修改底层来容纳业务字段。

## 开发规则与验证

新增字段先判断所属 durable domain。事件和持久结构变化要同步 Reducer、版本快照、GUI 投影、文档与兼容测试。

```powershell
npm run typecheck --workspace=@proofblade/materials
npm run test:materials
```
