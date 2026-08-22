# Runtime Approval Security

```json component-metadata
{
  "id": "materials-security",
  "name": "Runtime Approval Security",
  "version": "0.1.0",
  "createdAt": "2026-08-22T00:00:00+08:00",
  "updatedAt": "2026-08-22T00:00:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-22T00:00:00+08:00",
    "lastSecurityAuditAt": "2026-08-22T00:00:00+08:00",
    "sourceHash": "0000000000000000000000000000000000000000000000000000000000000000",
    "result": "passed"
  }
}
```

## 职责

为平台提交、环境启动、网络请求和 session 打开等外部副作用提供持久化、可审计、默认 fail-closed 的人工审批策略。

## 入口与边界

- `approval-policy.ts` 只保存资源摘要哈希，不把 flag、token 或 URL 明文写入审批账本。
- 审批状态通过 `PENDING → GRANTED/DENIED → CONSUMED` 单向推进；过期或未知记录必须拒绝。
- App Server 负责暴露审批读取/批准接口，业务执行器仍需在副作用前调用 `check`。

## 开发规则与验证

任何新增受保护副作用都必须增加策略测试，验证未批准时不触发外部调用、重启后状态可恢复、重复 grant/consume 幂等且敏感资源不出现在磁盘内容或错误消息中。

```powershell
node --import tsx --test packages/materials/tests/approval-policy.test.ts packages/materials/tests/app-server.test.ts
```
