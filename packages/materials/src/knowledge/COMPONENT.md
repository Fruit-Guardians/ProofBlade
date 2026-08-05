# Knowledge Observer

```json component-metadata
{
  "id": "materials-knowledge",
  "name": "Knowledge Observer",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

把不可信目标输出转换为有来源的 Observation/Evidence，并为 Fact、Hypothesis 与 completion grounding 提供确定性依据。

## 入口与边界

- `observer.ts` 负责观察归一化与证据锚定。
- 模型只能提出知识命令；Reducer 决定知识状态。
- 原始大输出留在 Artifact，Knowledge 只保存可检索索引与引用。

## 开发规则与验证

所有目标内容保持不可信标签和来源。Fact 确认、假设拒绝和完成候选必须绑定当前 Fixture generation 的成功 Evidence。

```powershell
npm run test:materials
```
