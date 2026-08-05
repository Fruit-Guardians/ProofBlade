# Independent Verifier

```json component-metadata
{
  "id": "materials-verification",
  "name": "Independent Verifier",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

独立复现候选结果，通过隐藏 scorer 和当前 generation Evidence 决定 completion 是否接受。只有 Verifier 可以提交 `SUCCEEDED`。

## 入口与边界

- `verifier.ts` 执行配置次数的复现并产出报告。
- Solver/Planner 只能提出 candidate，不能确认成功。
- 候选明文放在敏感 Artifact，事件只保留哈希和引用。

## 开发规则与验证

验证失败保持显式、可重放且不泄漏 scorer 细节。修改接受条件时同步 Task Contract、评测协议和 Auto/Assist 测试。

```powershell
npm run eval
```
