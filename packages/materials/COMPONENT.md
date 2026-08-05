# Materials 物资层核心

```json component-metadata
{
  "id": "materials",
  "name": "Materials 物资层核心",
  "version": "0.3.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T00:19:34+08:00"
}
```

## 职责

承载 ProofBlade 业务语义并组装领域组件。根级 `config.ts` 定义配置契约与加载规则，`index.ts` 是 CLI/GUI 可依赖的公开 API 面。

## 入口与依赖

- 公共入口：`src/index.ts`。
- 配置入口：`src/config.ts`。
- 向下依赖 Atoms、Molecules，以及固定版本的 Pi、MCP、TypeBox 和网络传输库。
- 应用层只能通过公开入口使用 Materials，避免深路径绑定内部实现。

## 开发规则

- 根目录只放跨领域装配和公共导出；具体行为进入最匹配的子组件。
- 新增导出时检查依赖漏斗，避免导出 GUI/CLI 类型。
- 配置字段必须有默认值、解析测试和密钥边界说明。
- Coding Agent 的 Skill/MCP 通过固定代理契约进入 Provider；会话启用集合必须在执行时再次校验。
- Tool 输出改写由 `tools.outputRewrite` 选择 `builtin | rtk`；RTK 命令、失败策略、超时和原始输出上限都来自配置。

## 验证

```powershell
npm run test:materials
```
