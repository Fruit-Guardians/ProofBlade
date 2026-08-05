# 组件开发索引

ProofBlade 使用 `COMPONENT.md` 记录组件级开发契约。组件归属由仓库根目录的 `component-docs.json` 决定；路径重叠时，最长路径前缀优先。

## 更新纪律

修改组件源码、测试、包配置或构建配置时，必须同时更新对应文档的 `version` 和 `updatedAt`。`createdAt` 保持首次编写时间不变。版本遵循 SemVer：破坏契约升主版本，兼容新增升次版本，修复、重构和文档校准升修订号。

```powershell
npm run check:components
npm run verify
```

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
