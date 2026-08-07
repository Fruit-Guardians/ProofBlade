# Durable Background Jobs

```json component-metadata
{
  "id": "materials-jobs",
  "name": "Durable Background Jobs",
  "version": "0.2.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "6da281daa494e4333e03fdd3427909d30c88aca56c48e27a84163814bccd6582",
    "result": "passed"
  }
}
```

## 职责

在执行工作前创建 durable JobRecord，管理排队、启动、完成、取消、超时和进程边界后的恢复。

## 入口与边界

- `background-runner.ts` 管理 AbortController 与 Effect Journal 关联。
- Job 生命周期通过 Control Store 事件投影；执行结果通过 Artifact 引用。
- Run teardown 必须停止仍在进程内活动的任务。

## 开发规则与验证

恢复行为必须服从 replay policy；取消与超时不能绕过 Effect 终态记录。增加并发时保留稳定资源键。

分发型 MCP Job 在排队前解析内层 Tool，并持久化内层 replay policy；禁止自动重放的浏览器或进程动作不得继承外层分发器默认值。

Job 事件只持久化 Provider 提供的安全参数副本。原始参数只用于当前进程内执行；参数经过脱敏的 Job 必须标记 `argsRedacted`，进程重启后转为 `UNKNOWN`，不得使用脱敏占位符重放。

```powershell
npm run test:materials
```
