# Runtime Observability

```json component-metadata
{
  "id": "materials-observability",
  "name": "Runtime Observability",
  "version": "0.1.8",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-19T09:20:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 8,
    "securityAuditCount": 8,
    "lastBugAuditAt": "2026-09-19T09:20:00.000Z",
    "lastSecurityAuditAt": "2026-09-19T09:20:00.000Z",
    "sourceHash": "a23a4c18f453b228ec859145c1753c2d7b501173e374c10ad89a169c59d51af4",
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

`tool-timing.ts` 是工具热路径的进程内分段计时器，与上面的 durable telemetry 明确分离：它只写入有界内存环形缓冲，不触碰 ControlStore、事件日志或文件系统。理由是测量工具延迟本身不得成为一次 durable 写——否则记录器会引入它正要消除的同步屏障，并改变被测对象。`percentile` 使用 nearest-rank，保证报告的每个数值都是实际观测到的时长；只报告两端都已埋点的阶段，`finish()` 合成的 `subscribersEnd` 不产生阶段，避免把未埋点跨度凭空计时。`withToolTiming` 在未提供 recorder 时返回原对象本身，保证未开启计时的 lane 与出厂行为逐字节一致，工具契约哈希不受影响。

`ControlEventBatcher` 承载 Pi hook 遥测，且**必须被 lane 实际装配**：`attachPiObservability()` 在 `telemetry` 与 `scheduling.batcher` 都不存在时会退回直接 `controlStore.append()`，即每次 hook 同步落盘。`PiCodingLane.create` 必须创建 batcher 并同时传入 `attachPiObservability`，否则 `tool_execution_end` 会在工具结果路径上等待一次锁与 `fsync`。

需要 snapshot 等昂贵计算才能补齐的遥测字段，一律通过 `append(..., resolve)` **延迟到 drain 时计算**：遥测是 fail-soft 旁路，其富化不得落在工具结果路径上——模型不该为装饰一个它从不读取的可观测载荷而等待一次 snapshot 读取。resolver 抛错时只丢弃富化字段并保留事件；无 batcher 的回退路径会在写入前就地解析，保证两种路径记录的事件形状一致。`resolve` 本身绝不进入事件日志。

```powershell
node --import tsx --test packages/materials/tests/observability.test.ts packages/materials/tests/tool-timing.test.ts packages/materials/tests/telemetry-lazy-payload.test.ts
npm run baseline:tools
```
