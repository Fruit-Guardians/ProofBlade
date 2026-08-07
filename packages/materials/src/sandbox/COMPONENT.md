# Fixture Sandbox

```json component-metadata
{
  "id": "materials-sandbox",
  "name": "Fixture Sandbox",
  "version": "0.1.1",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "8fbfea7aa8e4a39b673694b2dea72c38cd57b7d9a43ccae0550c44da77cda6f3",
    "result": "passed"
  }
}
```

## 职责

定义合成 Fixture 目录、构建/重置/健康检查和 generation 隔离，为 Effect 执行提供可复现目标环境。

## 入口与边界

- `fixture-catalog.ts` 描述可见 Fixture。
- `fixture.ts` 管理生命周期和目标执行。
- 模型看到的是不可信 Observation，不直接拥有 Sandbox 实例或控制状态。

## 开发规则与验证

Fixture 必须确定、离线可运行且可重置。重置提升 generation，旧 Effect/Evidence 不得被新一代任务采用。

```powershell
npm run eval
```
