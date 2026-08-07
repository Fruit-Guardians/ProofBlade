# MCP Registry

```json component-metadata
{
  "id": "materials-mcp",
  "name": "MCP Registry",
  "version": "0.2.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "28be58fd098bbe94adde5ee04d318759b48d81b3889dc2fad2ee5458ab4c3a36",
    "result": "passed"
  }
}
```

## 职责

加载项目级 `.mcp.json`，延迟启动 stdio Server，发现 Tool 并映射为按需 Capability，同时管理脱敏、进程回收和会话级启用集合。

## 入口与边界

- `registry.ts` 是 MCP 配置、发现、调用和关闭入口。
- 主 Provider 上下文只保留稳定代理和服务摘要，完整 Schema 按需进入调用上下文。
- MCP 结果沿 Capability Router、Effect Journal 和 Artifact/Evidence 路径记录。

## 开发规则与验证

默认延迟连接；环境变量和凭据不得进入事件、版本快照或 GUI 响应。Server/Tool 顺序与配置哈希必须确定。

分发型 MCP Tool 必须用 `nestedToolPolicy` 对内层工具执行默认拒绝校验。Effect 创建前解析内层身份并采用它的 replay/sideEffect/sensitivity/resourceKeys；显式配置的脱敏字段不受启发式最短长度限制。Solver 与 Coding MCP 代理共用 `describeServer()` 返回允许的内层工具与策略；`describe` 固定使用 `manual` 重放策略。

前台 Effect 与后台 Job 必须复用同一套 MCP 参数脱敏逻辑。后台 Job 的原始参数只能保留在当前进程内，不能进入事件日志或运行投影。

```powershell
npm run test:materials
```
