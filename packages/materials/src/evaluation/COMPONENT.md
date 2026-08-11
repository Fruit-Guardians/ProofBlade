# Fixture Evaluation

```json component-metadata
{
  "id": "materials-evaluation",
  "name": "Fixture Evaluation",
  "version": "0.2.5",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-11T11:32:51.204Z",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-11T11:32:51.204Z",
    "lastSecurityAuditAt": "2026-08-11T11:32:51.204Z",
    "sourceHash": "2ae85be62e0bae3520c5c269fef045dcafb069e825f52e0504f6506e9a9d9838",
    "result": "passed"
  }
}
```

## 职责

通过生产单 Agent 循环执行六个确定性 Fixture，并执行缓存、上下文、收敛、证据和持久化运行时场景，统计成功、证据绑定、重放一致性、候选泄漏、场景分类、遥测聚合和稳定报告哈希。

## 入口与边界

- `fixture-evaluator.ts` 是评测运行器。
- `runtime-scenario-evaluator.ts` 是运行时场景目录与隔离执行器；单场景失败必须形成机器可读结果，不能阻止其余场景执行。
- 评测不使用另一套求解逻辑；Provider-free deterministic lane 只替代模型输出。
- `baseline-v3` 的最小基线是 30 项：六题各三次形成 18 个生产循环，另有 12 个运行时场景；全部成功、全部证据绑定、全部重放一致、全部事实证据覆盖且无候选泄漏。
- 12 个运行时场景固定覆盖缓存用量与前缀漂移、上下文单调性与用户任务锚点、三种 Tool 收敛断路器、Evidence 整理背压与并发去重、暂停重放、Verifier 权限和 Lease 所有权隔离。
- 评测报告是发布门槛，不是 Control Store 的业务权威；Fixture 集合先规范排序，目标类型、描述、expected 和输入文件形成不含明文答案的 Catalog 哈希，Catalog 和执行预算进入稳定哈希，运行 ID、墙钟耗时和原始错误不进入稳定哈希。
- 运行时场景的 ID、分类和说明形成独立 Catalog 哈希；稳定报告哈希包含场景结果但排除墙钟耗时和原始错误。
- 未被 Control/Telemetry 识别的异常记录为 `unclassified`，不得推断成权限或环境错误。

## 开发规则与验证

新增能力必须先判断信息位置：题目求解能力增加 Fixture；跨题的缓存、上下文、调度、证据、恢复或权限不变量增加 Runtime Scenario。保持结果机器可读、顺序稳定并记录 attempt/runId。开发时允许子集报告，合并前必须执行完整 30 项门禁。

```powershell
npm run eval
npm run eval -- --enforce-gate
```
