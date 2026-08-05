# Knowledge Observer

```json component-metadata
{
  "id": "materials-knowledge",
  "name": "Knowledge Observer",
  "version": "0.3.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T02:47:13+08:00"
}
```

## 职责

把不可信目标输出转换为有来源的 Observation/Evidence，并为 Fact、Hypothesis 与 completion grounding 提供确定性依据。

## 入口与边界

- `observer.ts` 负责观察归一化与证据锚定。
- `evidence-graph.ts` 为 Coding lane 提供 Artifact 标注、多关键词证据检索/读取、Evidence 记录和 Proposed Fact 关联。
- 模型只能提出知识命令；Reducer 决定知识状态。
- 原始大输出留在 Artifact，Knowledge 只保存可检索索引与引用。

## 开发规则与验证

所有目标内容保持不可信标签和来源。Routine Tool 输出默认只是 intermediate/debug Artifact；只有具备名称、摘要、标签和来源引用的发现才提升为 Evidence。Evidence 之间通过 `dependsOn`，Evidence 与 Artifact/Fact 通过稳定 ID 形成可重放证据链。

```powershell
npm run test:materials
```
