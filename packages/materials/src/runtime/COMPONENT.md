# Pi and Provider Runtime

```json component-metadata
{
  "id": "materials-runtime",
  "name": "Pi and Provider Runtime",
  "version": "0.2.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T23:18:36+08:00"
}
```

## 职责

适配 Pi AgentHarness、Provider Profile、OpenAI-compatible 传输、Coding/Solver lane、系统提示和实际 Tool 装配。

## 入口与边界

- `coding-lane.ts` 驱动普通对话；`solver-lane.ts` 驱动证据型任务。
- `pi-adapter.ts` 管理 Session；`lmstudio-provider.ts` 解析配置模型；`provider-transport.ts` 处理代理传输。
- `solver-tools.ts` 与 `coding-resources.ts` 装配最小 Tool/Skill/MCP 面。
- Coding Provider 始终看到固定 `load_skill` 和 `mcp_call`；启用的 Skill/MCP 只改变运行时允许集合与短摘要，不展开动态 Tool Schema。

## 开发规则与验证

模型、URL、思考等级和缓存策略只能来自配置。保持 System/Tool 前缀稳定，Provider 切换不进入底层组件。Pi 升级必须更新锁定快照与适配测试。

`load_skill` 和 `mcp_call` 每次执行都要校验当前对话的 enabled set。MCP `list` 不连接 Server，`describe` 才允许懒连接，`call` 必须使用 describe 后可见的 allowlist Tool。

```powershell
npm run test:materials
```
