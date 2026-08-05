# Durable Background Jobs

```json component-metadata
{
  "id": "materials-jobs",
  "name": "Durable Background Jobs",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
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

```powershell
npm run test:materials
```
