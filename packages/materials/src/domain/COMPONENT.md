# Domain Contracts

```json component-metadata
{
  "id": "materials-domain",
  "name": "Domain Contracts",
  "version": "0.3.5",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T16:31:33.000Z",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-09T16:31:33.000Z",
    "lastSecurityAuditAt": "2026-08-09T16:31:33.000Z",
    "sourceHash": "47cb22386ff00dc37963155517392889f0304503ad5341ecc767af5a021ea410",
    "result": "passed"
  }
}
```

## 职责

定义 ProofBlade 的 Task、Run、Event、Fact、Evidence、Reasoning Node/Edge/Tree/Forest、带语义元数据的 Artifact、Effect、Job、Checkpoint、Telemetry 和 Planner handoff 等业务类型及规范化辅助函数。

## 入口与边界

- `types.ts` 是领域类型源；`handoff.ts` 处理结构化计划交接；`utils.ts` 提供领域级 ID/哈希封装。
- 可以扩展 Atoms/Molecules 类型，不反向修改底层来容纳业务字段。

## 开发规则与验证

新增字段先判断所属 durable domain。事件和持久结构变化要同步 Reducer、版本快照、GUI 投影、文档与兼容测试。

`JobRecord.argsRedacted` 表示持久化参数不是可执行原文。恢复流程不得把这类参数交给 Provider 重放。`JobRecord.backendId` 与 `backendVersion` 是新 Job 的必填执行绑定；旧事件通过显式 `job_queued_legacy` 兼容读取，不能让普通新命令缺少绑定。

Reasoning Tree 是共享 DAG 的可读投影，不是独立复制的数据结构。引用已有领域实体的节点复用其稳定 ID；只有中间推理节点使用独立 ID。

Reasoning Forest 的 orphan 投影必须同时保留总数和有界的近期语义摘要，避免把无界 ID 列表注入模型上下文。

```powershell
npm run typecheck --workspace=@proofblade/materials
npm run test:materials
```
