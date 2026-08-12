# Runtime Observability

```json component-metadata
{
  "id": "materials-observability",
  "name": "Runtime Observability",
  "version": "0.1.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-12T02:57:23.000Z",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-12T02:57:23.000Z",
    "lastSecurityAuditAt": "2026-08-12T02:57:23.000Z",
    "sourceHash": "d0f4567230e9084ecd195fdeb41a47daada196b8321072f5e390c7ca449baa0a",
    "result": "passed"
  }
}
```

## 职责

订阅 Pi 生命周期，把 Provider、Tool、Effect、成本、Token、缓存、延迟和失败分类投影为低敏感 durable telemetry。

## 入口与边界

- `pi-events.ts` 捕获生命周期事件、Provider 调度排队/取槽/取消并追加 Control events。
- `run-telemetry.ts` 聚合只读报告，包括 Provider cacheRead 与缓存前缀稳定性。
- 不持久化 Provider payload、提示正文、原始 Tool 参数或 Key。

## 开发规则与验证

每个指标必须说明数据来源，Provider 实报与本地估算不得混用。Provider 报表的 `scheduling` 显示排队请求、取消、最大队列深度和等待时长。新增字段要保持旧事件可读，并补充聚合和脱敏测试。

```powershell
node --import tsx --test packages/materials/tests/observability.test.ts
```
