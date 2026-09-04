# Runtime Observability

```json component-metadata
{
  "id": "materials-observability",
  "name": "Runtime Observability",
  "version": "0.1.6",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-29T10:18:09.178Z",
  "qualityAudit": {
    "bugAuditCount": 6,
    "securityAuditCount": 6,
    "lastBugAuditAt": "2026-08-29T10:18:09.178Z",
    "lastSecurityAuditAt": "2026-08-29T10:18:09.178Z",
    "sourceHash": "dc99000e770dcd8d69c9ddc900f61f818973adb4463f50314c2ffae37339d3ab",
    "result": "passed"
  }
}
```

## 职责

订阅 Pi 生命周期，把 Provider、Tool、Effect、成本、Token、缓存、延迟和失败分类投影为低敏感 durable telemetry。

## 入口与边界

- `pi-events.ts` 捕获生命周期事件、Provider 调度排队/取槽/取消并追加 Control events。
- `model_context_frame_recorded` 在 `before_provider_payload` 后记录最终 adapter payload 的 metadata-only frame，并将 ID/hash 写入 `request_epoch_context`。
- `run-telemetry.ts` 聚合只读报告，包括 Provider cacheRead 与缓存前缀稳定性。
- 不持久化 Provider payload、提示正文、原始 Tool 参数或 Key。

## 开发规则与验证

每个指标必须说明数据来源，Provider 实报与本地估算不得混用。Provider 报表的 `scheduling` 显示排队请求、取消、最大队列深度和等待时长。流式响应的普通 event gap 不逐条落盘；每个请求只在 `model_usage` 保存最大 idle 及其 attempt/event type，报表仍兼容旧 Run 的 `provider_request_inter_event_idle` 并按 request 取最大值。新增字段要保持旧事件可读，并补充聚合和脱敏测试。

Frame 事件只保存 role/source/content hash/visible length/estimated tokens 和 Artifact/Evidence 引用；禁止将 Provider payload、候选文本、凭据或完整工具正文写入 ControlStore。

```powershell
node --import tsx --test packages/materials/tests/observability.test.ts
```
