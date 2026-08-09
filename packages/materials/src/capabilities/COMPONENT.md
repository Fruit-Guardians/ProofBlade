# Capability Catalog and Router

```json component-metadata
{
  "id": "materials-capabilities",
  "name": "Capability Catalog and Router",
  "version": "0.2.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T15:32:20.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-09T15:32:20.000Z",
    "lastSecurityAuditAt": "2026-08-09T15:32:20.000Z",
    "sourceHash": "f0d2fcbb2519c9ed26a689de4aa5aa6c253d36fbbea3bd631e1d5e1233dbe51f",
    "result": "passed"
  }
}
```

## 职责

维护稳定的逻辑能力目录，并把固定 `invoke_capability` 请求解析到可替换 Backend，再通过 Effect Journal 执行和留痕。

## 入口与边界

- `catalog.ts` 生成规范化 manifest 与哈希。
- `backend.ts` 定义 Backend/Resolver 契约，按优先级和稳定 ID 选择当前可用实现。
- `router.ts` 校验 capability、operation、参数键和 replay policy，并记录完整 Backend 来源。
- Provider 只看到逻辑 capability，不直接看到 bundled、MCP、本地进程或 provider-native 的重复语义工具。
- 未显式绑定时只允许在执行前跳过不可用 Backend；一旦选定并开始执行，失败不得静默切换实现。
- MCP 分发器调用按内层 Tool 动态解析策略，前台 Effect 与后台 Job 使用同一结果。
- Router 为后台 Job 生成统一的安全持久化参数计划，原始调用参数不进入 Control Store。
- 内层敏感级别为 `secret` 时，Router 必须把分类传给 Effect Journal，确保结果 Artifact 不会降级为 `public`。
- Provider 只看到固定代理 Schema；完整能力细节按需获取。

## 开发规则与验证

能力 ID、操作顺序和 canonical JSON 属于缓存及行为契约。Backend ID、优先级和版本也属于恢复契约；新增操作要同步 Tool Contract、Effect 策略和快照测试。

```powershell
npm run test:materials
```
