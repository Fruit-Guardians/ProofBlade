# Tool Contracts and Runtime

```json component-metadata
{
  "id": "materials-tools",
  "name": "Tool Contracts and Runtime",
  "version": "0.2.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-10T09:59:52.000Z",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-10T09:59:52.000Z",
    "lastSecurityAuditAt": "2026-08-10T09:59:52.000Z",
    "sourceHash": "8ff11c5b85262b60b4f167427660333201fa8f50f4258c1b88e879a5dfc15f40",
    "result": "passed"
  }
}
```

## 职责

从单一规范路径生成 Tool 名称、描述、Schema、只读属性、超时、资源键、敏感度、执行模式和 replay policy，并统一结构化错误。

## 入口与边界

- `contracts.ts` 定义 Tool Contract。
- `runtime.ts` 执行 journaled Tool；`errors.ts` 归一化失败和签名。
- Runtime 组装 bundled 与 MCP Backend，但对模型保持单一 `list_capabilities` / `invoke_capability` 代理面，并在状态、Effect、Artifact 与 Job 投影中保留实现来源。
- Runtime 同时装配可选本地 Rizin 与 MCP deep reverse Backend；模型不需要知道具体执行引擎。
- `output-rewrite.ts` 实现配置驱动的 builtin/RTK adapter、版本门槛、同 Shell 探测、RTK tee 读取和确定性回落。
- 具体 Solver/Coding 装配留在 Runtime，副作用持久化留在 Effects。

## 开发规则与验证

Tool 名称、顺序、描述和 canonical Schema 属于 Provider 缓存及选工具行为契约。任何变化都要更新快照、契约文档和错误测试。

RTK 只改写 Coding `bash` 命令；成功改写接受 RTK `0/3` 退出协议，`1` 表示未命中，`2` 保持失败边界。Tool 返回前必须先保存 RTK tee 原文；上游未生成 tee 时保存 Pi 可见输出，并在 trace 中标记 `rawCapture=visible-output`。

```powershell
npm run test:materials
```
