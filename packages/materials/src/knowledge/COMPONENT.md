# Knowledge Observer

```json component-metadata
{
  "id": "materials-knowledge",
  "name": "Knowledge Observer",
  "version": "0.4.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T11:05:27+08:00"
}
```

## 职责

把不可信目标输出转换为有来源的 Observation/Evidence，并通过共享 DAG、推理树和森林索引为 Fact、Hypothesis 与 completion grounding 提供确定性依据。

## 入口与边界

- `observer.ts` 负责观察归一化与证据锚定。
- `evidence-graph.ts` 为 Coding lane 提供 Artifact 标注、Evidence 归纳、带类型边的共享 DAG、Reasoning Tree 整理、Forest 摘要和局部树检查。
- 模型只能提出知识命令；Reducer 决定知识状态。
- 原始大输出留在 Artifact，Knowledge 只保存可检索索引与引用。

## 开发规则与验证

所有目标内容保持不可信标签和来源。Routine Tool 输出默认只是 intermediate/debug Artifact；只有具备名称、摘要、标签和来源引用的发现才提升为 Evidence。Evidence Curator 通过固定代理命名、解释、连边和组织树；主 Agent 默认读取 Forest 摘要，需要溯源时才展开局部树。底层图允许节点被多树采用，GUI 的树形结构只是投影。

```powershell
npm run test:materials
```
