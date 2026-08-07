# Fixture Evaluation

```json component-metadata
{
  "id": "materials-evaluation",
  "name": "Fixture Evaluation",
  "version": "0.2.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T19:40:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-07T19:40:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T19:40:00+08:00",
    "sourceHash": "99cb7490811b6bc52f884ce37f14e611ce292306e886852b962026b3fa2b9656",
    "result": "passed"
  }
}
```

## 职责

通过生产单 Agent 循环执行六个确定性 Fixture，默认每题重复三次，统计成功、证据绑定、重放一致性、候选泄漏、遥测聚合和稳定报告哈希。

## 入口与边界

- `fixture-evaluator.ts` 是评测运行器。
- 评测不使用另一套求解逻辑；Provider-free deterministic lane 只替代模型输出。
- `baseline-v2` 要求六题完整覆盖、至少三次尝试、全成功、全证据绑定、全重放一致、全事实证据覆盖且无候选泄漏。
- 评测报告是发布门槛，不是 Control Store 的业务权威；Fixture 集合先规范排序，目标类型、描述、expected 和输入文件形成不含明文答案的 Catalog 哈希，Catalog 和执行预算进入稳定哈希，运行 ID、墙钟耗时和原始错误不进入稳定哈希。
- 未被 Control/Telemetry 识别的异常记录为 `unclassified`，不得推断成权限或环境错误。

## 开发规则与验证

新增能力必须优先增加能失败的 Fixture 或断言。保持结果机器可读、顺序稳定并记录 attempt/runId。开发时允许子集报告，合并前必须执行完整门禁。

```powershell
npm run eval
npm run eval -- --enforce-gate
```
