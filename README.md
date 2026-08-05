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
- 项目级 Skill Registry：元数据常驻 ContextManifest，正文通过 `load_skill` 或 Pi 原生 Skill Turn 按需加载。
- 项目级 MCP stdio：`.mcp.json` 配置、延迟发现、Capability 映射、效果日志、脱敏和进程回收。
- 完整 Tool Contract 规范哈希：版本、超时、资源键、敏感度和重放策略均进入快照；失败以结构化错误和 Pi `isError` 返回。
- Durable 运行观测：Provider/Tool/Effect 指标、成本与缓存 Token 汇总、主失败分类，以及 Prompt/Tool/Skill/MCP/Runtime 版本快照。
- 对话式 Coding Agent GUI：通过 SSE 与真实配置模型持续对话，实时显示文本、思考和 Tool 生命周期；每次调用可展开 Arguments、Result、Pi Entry、Control telemetry、完整关联 JSON 和浏览器 Worker 脚本处理。
- 六类中断恢复：过期租约回收、Fixture 生命周期核对、旧代次 Effect 隔离、Tool 批次配对修复和两阶段 Pi compaction。
- 确定性规划通道和带知识版本的 Planner-to-Executor handoff；执行前会淘汰过期计划，并把当前 handoff 编入上下文索引。
- 机器可读的六靶场评测器，检查成功率、证据绑定、重放一致性和候选答案泄漏。

Provider、模型、思考级别和 OpenAI 兼容参数的基础值由 `proofblade.config.json` 管理。仓库内配置使用 `model: "auto"` 发现 LM Studio 当前已加载的聊天模型；其他 Provider 可配置 `thinkingLevel`、`reasoning`、`supportsReasoningEffort` 和 `maxTokensField`。CLI 通过 `apiKeyEnv` 指向的环境变量读取 Key；GUI 可管理多个中转站或本地模型 Profile，并为每个对话独立选择 Provider、模型和思考等级。Profile 和 Key 只写入用户目录 `.proofblade/gui-provider.json`，文件夹与对话偏好写入 `.proofblade/gui-workspace.json`，两者都不会进入仓库，Key 也不会进入 API 响应。Pi 0.83.0 要求 Node.js 22.19 或更高版本。

## 快速开始

```powershell
npm ci
npm run build
npm run cli -- run demo DEMO-001
npm run cli -- fixtures
npm run cli -- solve web-source-1 WEB-001 auto 2
npm run cli -- show DEMO-001
npm run cli -- timeline DEMO-001
npm run cli -- cost DEMO-001
npm run cli -- replay DEMO-001
npm run cli -- agent DEMO-001 "Summarize the verified facts"
npm run gui -- --port 4173
npm test
npm run test:atoms
npm run test:molecules
npm run eval
```

团队成员从干净工作区开始使用 `npm ci`，它严格按 `package-lock.json` 安装依赖。修改依赖后提交 `package.json` 和锁文件，并在合并前运行 `npm run verify`。

运行数据和制品写入 `runs/`。下载内容和外部源码快照统一放在 `tmp/`，该目录默认被 Git 忽略。

## 动态调试 GUI

```powershell
npm run gui -- --port 4173
npm run gui -- --config proofblade.config.json --port 4173
```

打开 `http://127.0.0.1:4173` 后默认进入 Agent 对话。“新建对话”创建不绑定 Fixture 的普通 Coding Agent 会话，通过 SSE 调用配置文件中的真实模型，并按需使用工作区 `read`、`bash`、`edit` 和 `write` 工具。“Fixture 测试”是独立入口，可选择交互调试或自动执行；只有该路径会加载靶场、证据验证和恢复流程。模型文本、思考与 Tool start/end 会边生成边显示，结束后由持久化 Pi Session 接管。

右上角齿轮打开“中转站与模型”，可创建多个 OpenAI-compatible Profile。每个 Profile 分别保存名称、Base URL、API Key、可选代理 URL、模型列表和默认思考等级；模型发现和真实对话共用该代理。Windows 本地配置默认位于 `%USERPROFILE%\.proofblade\gui-provider.json`；服务端响应只返回 `hasApiKey`，不会返回 Key 内容。保存后可在输入框下方按对话切换中转站、模型与思考等级，无需改动仓库文件。

对话可以放入自定义文件夹并在侧栏筛选。输入框下方的能力按钮会列出当前项目的内建 Tool、Skill 和 MCP Server，可为每个对话分别启停；Coding Agent 只把已启用能力装配到本轮。文件夹和会话偏好保存在 `%USERPROFILE%\.proofblade\gui-workspace.json`。

上下文面板把 Provider 实际上报的输入、输出、推理、缓存读取和缓存写入 Token 分开显示，同时给出发往 Provider 的可见消息、Tool Schema 和字符数估算。部分中转站会在极短提示上仍报告数千输入 Token，这是网关或模型模板的固定开销；若上游响应没有缓存字段，缓存读取与写入会明确显示为 `0`，不会用估算值伪装成缓存命中。

- 真实模型多轮对话、流式响应和消息内 Tool 调用；
- `Run -> Pi Session -> assistant 轮次 -> Tool 调用` 的逐级选择；
- `Arguments`、`Result`、`Pi Entry`、`Telemetry` 和完整调试对象的树形/原文 JSON；
- 同一 `toolCallId` 下 Pi Session 与 Control Store 事件的关联，以及 Artifact、Evidence、Effect 引用；
- 浏览器 Web Worker Script Lab，内置调用摘要、证据提取和 Effect 摘要预设，输出可切换 JSON、表格和文本；
- 普通 Coding Agent 与 Fixture 测试分离；Fixture 模式提供恢复核对、机械 Checkpoint、证据账本和 Artifact 内容查看；
- 多中转站 Profile、会话级模型切换、对话文件夹，以及 Tool/Skill/MCP 能力开关；
- Provider Token、可见上下文和缓存字段的独立统计。

Script Lab 的 `input` 始终是当前选中的完整 Tool 调试对象。脚本使用普通 JavaScript `return` 返回结果，执行上限为 1500 ms；代码只进入临时浏览器 Worker，不发送给服务端。完整对象结构和 API 见 `docs/gui.md`。

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade eval [--attempts N] [--max-turns N] [--run-prefix ID]
proofblade capabilities
proofblade mcp [list|describe|call] [run-id] [server] [tool] [json-arguments]
proofblade skills [list|show] [skill-name] [max-chars]
proofblade skill <run-id> <skill-name> [additional instructions]
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id>
proofblade reconcile <run-id>
proofblade cost <run-id>
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
apps/cli + apps/gui          用户意图、调试与交付入口
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
| 外部进程或独立服务提供的工具 | MCP Server | 项目根目录 `.mcp.json` | 希望延迟发现工具规范，并隔离服务生命周期 |
| 可按需注入的工作方法和领域知识 | Skill | `skills/<name>/SKILL.md` | 希望常驻元数据、使用时才加载正文 |

当前已经实现内建 Tool、Capability Router、Effect Journal、项目级 Skill Registry 和 MCP stdio。Skill 与 MCP 只把目录元数据及哈希放入 ContextManifest；正文和完整 Tool Schema 按需加载。MCP 调用复用 `Capability Router -> Effect Journal -> Artifact/Evidence` 审计路径。完整接口、目录示例、实现状态、检查清单和测试方法见 `docs/extensions.md`。

## 设计文档

- `docs/architecture.md`：依赖方向、运行时组件和上下文层级。
- `docs/task-contract.md`：任务、事实、证据和完成条件。
- `docs/tool-contract.md`：工具契约、效果、重放和制品规则。
- `docs/eval-protocol.md`：确定性评测指标和回归门槛。
- `docs/extensions.md`：分层判断、工具开发、MCP、Skill 和扩展验收。
- `docs/recovery.md`：六个故障注入窗口、恢复顺序和收敛不变量。
- `docs/gui.md`：动态调试 GUI、Tool 调试对象、Script Lab 和本地 API。
- `pi-ctf-agent-harness-design.md`：ProofBlade 的完整设计依据。
