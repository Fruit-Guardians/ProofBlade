# ProofBlade / 证锋

[English](README.en.md)

ProofBlade（证锋）是一个基于 Pi AgentHarness 的证据驱动型 CTF Agent 框架。它把 Pi 会话与 CTF 控制存储分离，用只追加事件记录每一次状态变化，并且只允许独立验证器作出任务完成判定。

## 当前能力

- Pi `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 固定为 `0.83.0`。
- 四层依赖漏斗：可复用原子、通用分子、ProofBlade 物资层和交付 CLI。
- 支持确定性重放和投影哈希的 JSONL Control Store。
- 单写者事件序列、原子化持久投影和崩溃后可恢复的效果日志。
- Run/Phase 状态机，以及事实、证据、假设、意图、租约、靶场代次和不可变制品。
- 六层上下文编译器、确定性清单和不可信观察边界。
- 支持 Auto 与 Assist 模式的模型驱动单 Agent 执行循环。
- 确定性 Observer、带事实依据的完成提案和独立隐藏评分验证器。
- 六个本地工作流测试靶场：三个合成 Web 任务和三个合成逆向任务。
- 带预算的六层上下文、常驻指令/任务记忆分离、50/60/80/90% 分级维护、制品首尾检索、工具调用配对修复、空闲压缩、机械检查点和上下文溢出恢复。
- 配置模型可用时启用的 Pi JSONL Session 适配器。
- 带规范哈希的稳定能力目录、经过效果日志的 `invoke_capability` 和可取消、可恢复的后台任务。
- 确定性规划通道和带知识版本的 Planner-to-Executor handoff；执行前会淘汰过期计划，并把当前 handoff 编入上下文索引。
- 机器可读的六靶场评测器，检查成功率、证据绑定、重放一致性和候选答案泄漏。

Provider 和模型选择由 `proofblade.config.json` 管理。仓库内配置使用 `model: "auto"` 发现 LM Studio 当前已加载的聊天模型，源码中不包含具体模型 ID。Pi 0.83.0 要求 Node.js 22.19 或更高版本。

## 快速开始

```powershell
npm install
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- fixtures
npm run cli -- solve web-source-1 WEB-001 auto 2
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm test
npm run test:atoms
npm run test:molecules
npm run eval
```

运行数据和制品写入 `runs/`。下载内容和外部源码快照统一放在 `tmp/`，该目录默认被 Git 忽略。

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade eval [--attempts N] [--max-turns N] [--run-prefix ID]
proofblade capabilities
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id>
proofblade reconcile <run-id>
proofblade checkpoint <run-id> [reason]
proofblade compact <run-id> [reason]
proofblade history <run-id> <query>
proofblade handoff <run-id> [show|prepare]
proofblade jobs <run-id> [list|recover|read|stop] [job-id] [max-chars]
proofblade artifact <run-id> <artifact-id> [max-chars]
proofblade fixture-build <run-id>
proofblade fixture-reset <run-id>
proofblade fixture-score <run-id> <candidate>
proofblade agent <run-id> [prompt]
```

## 分层结构

```text
apps/cli                     用户意图与交付入口
   -> packages/materials     ProofBlade、CTF、Pi 和 Provider 知识
      -> packages/molecules  通用的信息获取与处理组合
         -> packages/atoms   最小类型、值对象和存储原语
```

依赖只能沿图中箭头向下。每一层通过增加信息来扩展下层契约，而不是反向修改下层；删除任意上层后，下层仍可独立构建和测试。

## 如何扩展

扩展前先判断功能处于哪一个信息层级：

| 需求 | 扩展方式 | 放置位置 | 适合场景 |
| --- | --- | --- | --- |
| 最小类型、哈希、序列化或存储原语 | 原子 | `packages/atoms` | 完全不知道 Agent 和 CTF 业务 |
| 通用的信息获取、处理或传递流程 | 分子 | `packages/molecules` | 知道原子契约，不知道具体任务 |
| 需要进入证据链的 ProofBlade 操作 | 内建 Tool / Capability | `packages/materials` | 读写 Run、制品、靶场或任务状态 |
| 外部进程或独立服务提供的工具 | MCP Server | 项目根目录 `.mcp.json` | 希望延迟发现工具规范，并隔离服务生命周期（下一代码阶段） |
| 可按需注入的工作方法和领域知识 | Skill | `skills/<name>/SKILL.md` | 希望常驻元数据、使用时才加载正文（下一代码阶段） |

当前已经实现内建 Tool、Capability Router 和 Effect Journal。MCP 接入将复用同一条审计路径；Skill 只负责向当前推理提供指令和引用资源，不绕过工具效果控制。完整接口、目录示例、实现状态、检查清单和测试方法见 `docs/extensions.md`。

## 设计文档

- `docs/architecture.md`：依赖方向、运行时组件和上下文层级。
- `docs/task-contract.md`：任务、事实、证据和完成条件。
- `docs/tool-contract.md`：工具契约、效果、重放和制品规则。
- `docs/eval-protocol.md`：确定性评测指标和回归门槛。
- `docs/extensions.md`：分层判断、工具开发、MCP、Skill 和扩展验收。
- `pi-ctf-agent-harness-design.md`：ProofBlade 的完整设计依据。
