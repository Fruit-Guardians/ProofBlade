# Tool Contracts and Runtime

```json component-metadata
{
  "id": "materials-tools",
  "name": "Tool Contracts and Runtime",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

从单一规范路径生成 Tool 名称、描述、Schema、只读属性、超时、资源键、敏感度、执行模式和 replay policy，并统一结构化错误。

## 入口与边界

- `contracts.ts` 定义 Tool Contract。
- `runtime.ts` 执行 journaled Tool；`errors.ts` 归一化失败和签名。
- 具体 Solver/Coding 装配留在 Runtime，副作用持久化留在 Effects。

## 开发规则与验证

Tool 名称、顺序、描述和 canonical Schema 属于 Provider 缓存及选工具行为契约。任何变化都要更新快照、契约文档和错误测试。

```powershell
npm run test:materials
```
