# Atoms 原子层

```json component-metadata
{
  "id": "atoms",
  "name": "Atoms 原子层",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

定义最小类型、确定性值操作、哈希、ID、原子文件替换和按键串行队列。该层只表示和持久化通用信息，不认识 Agent、CTF、Pi、Provider 或 UI。

## 入口与依赖

- 公共入口：`src/index.ts`。
- 核心文件：`contracts.ts`、`value.ts`、`storage/atomic.ts`、`storage/operation-queue.ts`。
- 运行时只使用 Node.js 标准库，不依赖其他 ProofBlade workspace。

## 开发规则

- 新类型必须保持业务无关；上层需求通过扩展类型处理。
- 值操作必须确定、可序列化，并有边界测试。
- 存储原语只保证机械一致性，不解释 Run 或业务状态。

## 验证

```powershell
npm run test:atoms
```
