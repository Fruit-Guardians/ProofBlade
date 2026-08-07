# Tool Contracts and Runtime

```json component-metadata
{
  "id": "materials-tools",
  "name": "Tool Contracts and Runtime",
  "version": "0.3.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T15:00:00+08:00"
}
```

## 职责

从单一规范路径生成 Tool 名称、描述、Schema、只读属性、超时、资源键、敏感度、执行模式和 replay policy，并统一结构化错误。

## 入口与边界

- `contracts.ts` 定义 Tool Contract。
- `runtime.ts` 执行 journaled Tool；`errors.ts` 归一化失败和签名。
- `output-rewrite.ts` 实现配置驱动的 builtin/RTK adapter、版本门槛、同 Shell 探测、RTK tee 读取和确定性回落。
- 具体 Solver/Coding 装配留在 Runtime，副作用持久化留在 Effects。
- Solver Runtime 将 target、Web 和允许的 MCP 调用结果统一转成 Observation/Evidence；其他能力结果只保留 Artifact 锚点。

## 开发规则与验证

Tool 名称、顺序、描述和 canonical Schema 属于 Provider 缓存及选工具行为契约。任何变化都要更新快照、契约文档和错误测试。

RTK 只改写 Coding `bash` 命令；成功改写接受 RTK `0/3` 退出协议，`1` 表示未命中，`2` 保持失败边界。Tool 返回前必须先保存 RTK tee 原文；上游未生成 tee 时保存 Pi 可见输出，并在 trace 中标记 `rawCapture=visible-output`。

```powershell
npm run test:materials
```
