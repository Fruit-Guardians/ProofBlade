# Fixture Sandbox

```json component-metadata
{
  "id": "materials-sandbox",
  "name": "Fixture Sandbox",
  "version": "0.1.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T20:10:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-07T20:10:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T20:10:00+08:00",
    "sourceHash": "115ef660ac0923ffbfe4046449d59bcc7f619494524c9e385027525c68c7573e",
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
- Sandbox 暴露幂等 `close()` 生命周期钩子；本地 Fixture 实现无进程资源时为空操作，HTTP-backed 实现必须在此释放服务。

## 开发规则与验证

Fixture 必须确定、离线可运行且可重置。重置提升 generation，旧 Effect/Evidence 不得被新一代任务采用。

```powershell
npm run eval
```
