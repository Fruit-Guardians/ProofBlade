# Materials JSONL Storage

```json component-metadata
{
  "id": "materials-storage",
  "name": "Materials JSONL Storage",
  "version": "0.1.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "d165dcf4f510ac4f1bf8f3a1ee8e8138e98b292646dd23975db7304215876ab1",
    "result": "passed"
  }
}
```

## 职责

提供 Materials 使用的 JSONL append/read 机械适配，把 Atoms 的文件原语连接到 Control Store 的持久需求。

## 入口与边界

- `jsonl-store.ts` 负责逐行序列化、追加和读取。
- 不解释 Event 业务、不计算 RunSnapshot、不执行迁移策略。
- 写入顺序和并发所有权由上层 Control Store 保证。

## 开发规则与验证

保持追加格式可流式读取，明确处理空行、截断行和序列化错误。业务兼容逻辑进入 Control/Domain。

```powershell
npm run test:materials
```
