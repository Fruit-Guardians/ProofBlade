# Materials JSONL Storage

```json component-metadata
{
  "id": "materials-storage",
  "name": "Materials JSONL Storage",
  "version": "0.1.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T20:10:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-07T20:10:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T20:10:00+08:00",
    "sourceHash": "71901f72eb873188a6b32bf4387a326ffe8d1d28760cdf3a5fa5370ff2c2efe5",
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
