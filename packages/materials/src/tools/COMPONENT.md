# Tool Contracts and Runtime

```json component-metadata
{
  "id": "materials-tools",
  "name": "Tool Contracts and Runtime",
  "version": "0.2.7",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-19T07:35:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 7,
    "securityAuditCount": 7,
    "lastBugAuditAt": "2026-09-19T07:35:00.000Z",
    "lastSecurityAuditAt": "2026-09-19T07:35:00.000Z",
    "sourceHash": "670c690381297256caa82c23b440f229711f3eaa2a1aac1d96c225aa38b766a8",
    "result": "passed"
  }
}
```

## 职责

从单一规范路径生成 Tool 名称、描述、Schema、只读属性、超时、资源键、敏感度、执行模式和 replay policy，并统一结构化错误。

## 入口与边界

- `contracts.ts` 定义 Tool Contract。
- `runtime.ts` 执行 journaled Tool；`errors.ts` 归一化失败和签名。
- `runtime.ts` 的 `observeArtifact()` 接受可选 `content`：调用方若仍持有刚归档的字节，观察器就不再回读 Artifact 文件。观察器只检查有界 stdout 中的候选值与失败签名，因此把同样的字符从磁盘读回来纯属热路径开销。省略 `content` 时仍回读，保持既有调用点行为不变。
- Runtime 组装 bundled 与 MCP Backend，但对模型保持稳定的 Discovery/Invoke 代理面；Discovery 只读取目录并按需返回 Schema，Invoke 在状态、Effect、Artifact 与 Job 投影中保留实现来源。
- Runtime 同时装配可选本地 Rizin 与 MCP deep reverse Backend；模型不需要知道具体执行引擎。
- `output-rewrite.ts` 实现配置驱动的 builtin/RTK adapter、版本门槛、同 Shell 探测、RTK tee 读取和确定性回落。
- 具体 Solver/Coding 装配留在 Runtime，副作用持久化留在 Effects。

## 开发规则与验证

Tool 名称、顺序、描述和 canonical Schema 属于 Provider 缓存及选工具行为契约。任何变化都要更新快照、契约文档和错误测试。

RTK 只改写 Coding `bash` 命令；成功改写接受 RTK `0/3` 退出协议，`1` 表示未命中，`2` 保持失败边界。Tool 返回前必须先保存 RTK tee 原文；上游未生成 tee 时保存 Pi 可见输出，并在 trace 中标记 `rawCapture=visible-output`。

```powershell
npm run test:materials
```
