# MCP Registry

```json component-metadata
{
  "id": "materials-mcp",
  "name": "MCP Registry",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
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

```powershell
npm run test:materials
```
