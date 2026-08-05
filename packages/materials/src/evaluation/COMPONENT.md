# Fixture Evaluation

```json component-metadata
{
  "id": "materials-evaluation",
  "name": "Fixture Evaluation",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

通过生产单 Agent 循环执行六个确定性 Fixture，统计成功、证据绑定、重放一致性、候选泄漏和报告哈希。

## 入口与边界

- `fixture-evaluator.ts` 是评测运行器。
- 评测不使用另一套求解逻辑；Provider-free deterministic lane 只替代模型输出。
- 评测报告是发布门槛，不是 Control Store 的业务权威。

## 开发规则与验证

新增能力必须优先增加能失败的 Fixture 或断言。保持结果机器可读、顺序稳定并记录 attempt/runId。

```powershell
npm run eval
```
