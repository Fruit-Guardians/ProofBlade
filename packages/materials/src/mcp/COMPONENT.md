# MCP Registry

```json component-metadata
{
  "id": "materials-mcp",
  "name": "MCP Registry",
  "version": "0.2.7",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 5,
    "securityAuditCount": 5,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "4e35b90ddc8bfcae10f92ffa77fdb18e01c2dec0ba46d41a73955a72fbd99b40",
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

- `binaryReverse` 映射显式绑定逻辑逆向操作到 Server/outer Tool/参数，嵌套 dispatcher 必须与 `nestedToolPolicy` 完全匹配。
- Deep reverse MCP 映射只有在 Server 或内层 Tool 声明 `readOnly=true` 且 `replay=pure` 时才可用，配置哈希进入 Backend 版本。

### Schema cache

`describe()` 会把已验证的 MCP Tool schema 按当前 Server 配置哈希持久化到安装根目录的
`.proofblade/mcp-schema-cache.json`。后续运行可直接复用 schema 摘要而不启动 stdio Server；
配置哈希变化时缓存自动失效，真正执行 Tool 仍必须经过正常连接、策略和审计路径。缓存只保存
名称、描述、输入 schema 和只读/重放元数据，不保存凭据、题目数据或原始调用参数。

```powershell
npm run test:materials
```
