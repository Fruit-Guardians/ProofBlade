# ProofBlade 协作开发规范

ProofBlade 是一个分层的 TypeScript monorepo。多人协作时，先保持依赖方向和 durable domain 契约稳定，再扩展具体功能。

## 开始开发

环境要求：Node.js `>=22.19.0`。

```powershell
git clone https://github.com/mansujiaosheng/ProofBlade.git
cd ProofBlade
npm ci
npm run verify
```

`npm ci` 是 CI 和新工作区的标准安装命令。它严格使用 `package-lock.json`，不会把本机已有依赖状态带入验证。只有依赖确实变化时才运行 `npm install`，并始终一起提交 `package.json` 与 `package-lock.json`。

## 分支和 Pull Request

- 从最新 `main` 创建短生命周期分支：`feature/<topic>`、`fix/<topic>` 或 `docs/<topic>`。
- `main` 只通过 Pull Request 合并，启用至少一名代码所有者审批和 CI 必须通过。
- 一个 Pull Request 聚焦一个可回滚主题；跨层改动要在描述中写出依赖方向和原因。
- 提交信息使用动词开头并说明范围，例如 `feat: add provider profile persistence`、`fix: preserve provider errors in chat`。
- 生成目录、运行数据、本地 Key 和外部下载统一留在 `dist/`、`runs/`、`.proofblade/`、`tmp/` 或用户目录，不提交到仓库。

## 分层边界

```text
apps/cli + apps/gui -> packages/materials -> packages/molecules -> packages/atoms
```

- `atoms` 只放通用类型、值对象、哈希和最小存储原语。
- `molecules` 只组合通用的信息获取、处理和传递流程，不认识 Run、CTF 或具体 Provider。
- `materials` 承担 ProofBlade 运行语义、Context、Tool、Effect、Skill、MCP 和 Pi 适配。
- `apps/cli` 与 `apps/gui` 负责用户意图、HTTP/命令装配和展示，不向下层泄漏应用状态。

新增接口优先通过扩展类型和适配器递进，而不是修改底层类型来满足单一业务。涉及 Control Store、Pi Session、Tool Contract、Skill 或 MCP 的行为变化，需要同时更新对应契约文档和回归测试。

## 验证门槛

提交前运行：

```powershell
npm run verify
```

该命令依次执行完整构建与测试、六靶场评测和生产依赖审计。按改动范围还应运行：

```powershell
npm run test:atoms
npm run test:molecules
npm run typecheck
```

GUI 改动还需要覆盖 1440px 桌面和 390px 移动视口，检查真实模型对话、错误展示、控制台异常和页面溢出。Fixture、Context、Recovery 或 Tool Contract 改动需要保留确定性评测和重放一致性。

## 责任边界

默认代码所有者见 `.github/CODEOWNERS`。建议团队按以下信息边界分工：

| 区域 | 主要责任 |
| --- | --- |
| `packages/atoms`、`packages/molecules` | 稳定基础契约和通用组合 |
| `packages/materials/src/control`、`context`、`recovery` | durable state、上下文和恢复不变量 |
| `packages/materials/src/tools`、`mcp`、`skills`、`runtime` | Tool、MCP、Skill、Pi 和 Provider 适配 |
| `apps/cli` | 可脚本化命令和发布入口 |
| `apps/gui` | 对话工作区、调试投影和浏览器交互 |
| `docs`、评测和 CI | 契约说明、回归门槛和协作质量 |

同一功能尽量由一名负责人完成跨层装配，其他成员通过底层契约、测试和文档协作，减少多人同时修改应用入口造成的冲突。

## 配置和密钥

Provider Key 只放在环境变量或用户目录 `.proofblade/` 中。提交前检查 `git diff --cached`，不要把 `.env`、Key、代理凭据、`runs/` 内容或 `tmp/` 快照加入暂存区。模型、Base URL 和代理通过配置文件或 GUI Profile 注入，源代码保持 Provider 无关。
