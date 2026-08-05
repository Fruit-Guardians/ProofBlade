# Capability Catalog and Router

```json component-metadata
{
  "id": "materials-capabilities",
  "name": "Capability Catalog and Router",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

维护稳定能力目录，并把固定 `invoke_capability` 请求路由到经过校验和 Effect Journal 记录的具体操作。

## 入口与边界

- `catalog.ts` 生成规范化 manifest 与哈希。
- `router.ts` 校验 capability、operation、参数键和 replay policy。
- Provider 只看到固定代理 Schema；完整能力细节按需获取。

## 开发规则与验证

能力 ID、操作顺序和 canonical JSON 属于缓存及行为契约。新增操作要同步 Tool Contract、Effect 策略和快照测试。

```powershell
npm run test:materials
```
