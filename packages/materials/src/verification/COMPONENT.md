# Independent Verifier

```json component-metadata
{
  "id": "materials-verification",
  "name": "Independent Verifier",
  "version": "0.4.1",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "892a95d3fe505879f3ec1c27157519a3842476516bf08e95310ed034e9c8342a",
    "result": "passed"
  }
}
```

## 职责

独立复现候选结果，通过隐藏 scorer 和当前 generation Evidence 决定 completion 是否接受。只有 Verifier 可以提交 `SUCCEEDED`。

## 入口与边界

- `verifier.ts` 执行配置次数的隐藏 scorer 复现并产出报告。
- `claim-verification.ts` 为普通 Coding 对话识别高风险确定性结论，并把成功命令复现记录成 Artifact、Evidence、Completion 与确认 Fact。
- Solver/Planner 只能提出 candidate，不能确认成功。
- 候选明文放在敏感 Artifact，事件只保留哈希和引用。

## 开发规则与验证

验证失败保持显式、可重放且不泄漏 scorer 细节。修改接受条件时同步 Task Contract、评测协议和 Auto/Assist 测试。

Coding 复现命令不得包含候选明文，命令输出必须包含与最终回答完全一致的候选；字符串扫描只能作为观察，不能单独形成 reproduction Evidence。`verify_claim` 必须校验传入的支撑 Evidence ID，并将其挂到 reproduction Evidence、确认 Fact 和结果 Artifact 上。

成功复现还必须生成以 accepted Completion 为根的结果树，并通过 `reproduces/supports/depends_on/derived_from` 边连接上游 Evidence 与复现 Artifact，供主 Agent 和 GUI 回溯完整依据。

```powershell
npm run eval
```
