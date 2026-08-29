# Application Composition

```json component-metadata
{
  "id": "materials-app",
  "name": "Application Composition",
  "version": "0.1.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "138527d86237259495c6151e32ad116969a17e6851f095e23f8cac3edfe8a8ff",
    "result": "passed"
  }
}
```

## 职责

创建可供 CLI、GUI 和测试复用的服务集合、示例任务与 Fixture 任务契约，是应用入口与领域服务之间的组装点。

## 入口与边界

- `demo.ts` 创建 repositories/services 和演示任务。
- `fixture-task.ts` 把 Fixture 元数据转换为 Run Task。
- 可以认识完整 Materials；不处理终端参数或浏览器状态。

## 开发规则与验证

新增服务应先在所属领域组件实现，再在此装配。测试夹具必须使用生产服务路径，避免平行实现。

```powershell
npm run test:materials
```
