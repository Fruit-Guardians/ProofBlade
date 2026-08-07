# Capability Catalog and Router

```json component-metadata
{
  "id": "materials-capabilities",
  "name": "Capability Catalog and Router",
  "version": "0.2.5",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T20:10:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-07T20:10:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T20:10:00+08:00",
    "sourceHash": "c5d1190a68f38a4ef85102b8a823e6fe976cb0ab74f168d97ec1b86fd9682ce0",
    "result": "passed"
  }
}
```

## 职责

维护稳定能力目录，并把固定 `invoke_capability` 请求路由到经过校验和 Effect Journal 记录的具体操作。

## 入口与边界

- `catalog.ts` 生成规范化 manifest 与哈希。
- `router.ts` 校验 capability、operation、参数键和 replay policy。
- MCP 分发器调用按内层 Tool 动态解析策略，前台 Effect 与后台 Job 使用同一结果。
- Router 为后台 Job 生成统一的安全持久化参数计划，原始调用参数不进入 Control Store。
- 内层敏感级别为 `secret` 时，Router 必须把分类传给 Effect Journal，确保结果 Artifact 不会降级为 `public`。
- Provider 只看到固定代理 Schema；完整能力细节按需获取。

## 开发规则与验证

能力 ID、操作顺序和 canonical JSON 属于缓存及行为契约。新增操作要同步 Tool Contract、Effect 策略和快照测试。

```powershell
npm run test:materials
```
