# Materials CLI Adapter Boundary

```json component-metadata
{
  "id": "materials-cli",
  "name": "Materials CLI Adapter Boundary",
  "version": "0.1.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-05T22:49:12+08:00"
}
```

## 职责

这是 Materials 内预留的可复用 CLI 适配边界。当前命令解析仍位于 `apps/cli`；只有当多种命令入口需要共享同一展示无关适配逻辑时，才在此增加实现。

## 边界

- 可以依赖 Materials 领域服务。
- 不读取 `process.argv`，不决定终端颜色或输出布局。
- 不为尚未出现的复用需求提前增加抽象。

## 开发规则与验证

首次增加源码时应在 Materials 公共入口明确导出，并同时加入契约测试。

```powershell
npm run typecheck --workspace=@proofblade/materials
```
