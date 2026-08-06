# Competition Platform Boundary

```json component-metadata
{
  "id": "materials-platform",
  "name": "Competition Platform Boundary",
  "version": "0.1.0",
  "createdAt": "2026-08-06T18:42:16+08:00",
  "updatedAt": "2026-08-06T18:42:16+08:00"
}
```

## 职责

定义无人值守比赛运行所需的平台边界：比赛快照、题目、附件、提交回执和提交恢复。平台凭据、认证 URL 与 Cookie 始终由 Host adapter 持有，不进入模型工具或题目工作区。

## 入口与边界

- `contracts.ts` 定义 `CompetitionPlatformPort` 和稳定的平台领域类型。
- `simulator.ts` 提供确定性的比赛平台模拟器，用于测试冷却、重复提交和提交后响应丢失。
- 平台提交是 Host 侧外部 Effect；Simulator 只是测试 adapter，不是生产平台客户端。
- 模型只能提出候选答案，不能直接调用 Platform Port。

## 开发规则与验证

真实平台 adapter 必须实现认证隔离、限流、服务端时间、附件哈希和提交 reconciliation。平台未提供幂等能力时，不得把本地 `attemptKey` 当作服务端恰好一次保证。

```powershell
npm run test:materials
```
