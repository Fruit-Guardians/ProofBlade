# 组件开发索引

ProofBlade 使用 `COMPONENT.md` 记录组件级开发契约。组件归属由仓库根目录的 `component-docs.json` 决定；路径重叠时，最长路径前缀优先。

## 更新纪律

修改组件源码、测试、包配置或构建配置时，必须同时更新对应文档的 `version`、`updatedAt` 和 `qualityAudit`。`createdAt` 保持首次编写时间不变。版本遵循 SemVer：破坏契约升主版本，兼容新增升次版本，修复、重构和文档校准升修订号。

`qualityAudit` 分别记录 BUG 与安全审计的次数、最近时间、结果和审计覆盖的源码 SHA-256。检查器会根据组件归属计算指纹；指纹未变化时可以跳过重复检查，源码变化后必须增加两项计数并更新审计时间。`result: "findings"` 表示仍有未解决问题，会阻止验证通过。

```powershell
npm run check:components
npm run verify
```

审计通过后使用 `npm run record:component-audit -- --components <id,...|all> --result passed` 写入记录。`--at` 可以省略，记录器依次采用显式 `--at`、`COMPONENT_AUDIT_AT`、GitHub PR 的 `updated_at`、最近提交时间或当前 UTC 时间。记录器默认跳过指纹未变化的组件；只有周期性复审相同源码时才传入 `--force`。

第一条命令在本地比较 `HEAD` 与工作区；CI 会比较 PR 基线与当前提交。新增组件时，需要同时创建 `COMPONENT.md` 并登记到 `component-docs.json`。

## 组件列表

| 层级 | 组件 | 文档 |
| --- | --- | --- |
| 原子 | Atoms | [`packages/atoms/COMPONENT.md`](../packages/atoms/COMPONENT.md) |
| 分子 | Molecules | [`packages/molecules/COMPONENT.md`](../packages/molecules/COMPONENT.md) |
| 物资 | Materials 核心 | [`packages/materials/COMPONENT.md`](../packages/materials/COMPONENT.md) |
| 物资 | App composition | [`packages/materials/src/app/COMPONENT.md`](../packages/materials/src/app/COMPONENT.md) |
| 物资 | Capabilities | [`packages/materials/src/capabilities/COMPONENT.md`](../packages/materials/src/capabilities/COMPONENT.md) |
| 物资 | CLI adapter boundary | [`packages/materials/src/cli/COMPONENT.md`](../packages/materials/src/cli/COMPONENT.md) |
| 物资 | Context | [`packages/materials/src/context/COMPONENT.md`](../packages/materials/src/context/COMPONENT.md) |
| 物资 | Control | [`packages/materials/src/control/COMPONENT.md`](../packages/materials/src/control/COMPONENT.md) |
| 物资 | Domain | [`packages/materials/src/domain/COMPONENT.md`](../packages/materials/src/domain/COMPONENT.md) |
| 物资 | Effects | [`packages/materials/src/effects/COMPONENT.md`](../packages/materials/src/effects/COMPONENT.md) |
| 物资 | Evaluation | [`packages/materials/src/evaluation/COMPONENT.md`](../packages/materials/src/evaluation/COMPONENT.md) |
| 物资 | Jobs | [`packages/materials/src/jobs/COMPONENT.md`](../packages/materials/src/jobs/COMPONENT.md) |
| 物资 | Knowledge | [`packages/materials/src/knowledge/COMPONENT.md`](../packages/materials/src/knowledge/COMPONENT.md) |
| 物资 | MCP | [`packages/materials/src/mcp/COMPONENT.md`](../packages/materials/src/mcp/COMPONENT.md) |
| 物资 | Observability | [`packages/materials/src/observability/COMPONENT.md`](../packages/materials/src/observability/COMPONENT.md) |
| 物资 | Orchestration | [`packages/materials/src/orchestration/COMPONENT.md`](../packages/materials/src/orchestration/COMPONENT.md) |
| 物资 | Recovery | [`packages/materials/src/recovery/COMPONENT.md`](../packages/materials/src/recovery/COMPONENT.md) |
| 物资 | Runtime | [`packages/materials/src/runtime/COMPONENT.md`](../packages/materials/src/runtime/COMPONENT.md) |
| 物资 | Sandbox | [`packages/materials/src/sandbox/COMPONENT.md`](../packages/materials/src/sandbox/COMPONENT.md) |
| 物资 | Skills | [`packages/materials/src/skills/COMPONENT.md`](../packages/materials/src/skills/COMPONENT.md) |
| 物资 | Storage | [`packages/materials/src/storage/COMPONENT.md`](../packages/materials/src/storage/COMPONENT.md) |
| 物资 | Tools | [`packages/materials/src/tools/COMPONENT.md`](../packages/materials/src/tools/COMPONENT.md) |
| 物资 | Verification | [`packages/materials/src/verification/COMPONENT.md`](../packages/materials/src/verification/COMPONENT.md) |
| 交付 | CLI | [`apps/cli/COMPONENT.md`](../apps/cli/COMPONENT.md) |
| 交付 | GUI | [`apps/gui/COMPONENT.md`](../apps/gui/COMPONENT.md) |
