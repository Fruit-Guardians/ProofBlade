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
- 稳定前缀缓存指纹：区分可复用的 L0/L1 与动态 L2-L5，并把前缀/动态哈希写入 ContextManifest。
- Reasonix 风格的追加式上下文：Solver 将每轮状态作为当前用户轮的持久尾部，避免把变化的状态放到历史前面反复打断缓存；Provider 的 `cacheRetention` 可在配置中选择。
- 配置驱动的 Coding `bash` 输出改写：`builtin | rtk` 保持同一 Tool Schema，记录改写版本、命令哈希、原始/可见字节、压缩率和 Artifact 引用。
- 支持 Auto 与 Assist 模式的模型驱动单 Agent 执行循环。
- 确定性 Observer、带事实依据的完成提案和独立隐藏评分验证器。
- 六个本地工作流测试靶场：三个合成 Web 任务和三个合成逆向任务。
- 带预算的六层上下文、常驻指令/任务记忆分离、55/60/75/80/90% 分级维护、制品首尾检索、工具调用配对修复、空闲压缩、机械检查点和上下文溢出恢复。
- 配置模型可用时启用的 Pi JSONL Session 适配器。
- 带规范哈希的稳定能力目录、经过效果日志的 `invoke_capability` 和可取消、可恢复的后台任务。
- 项目级 Skill Registry：元数据常驻 ContextManifest，正文通过 `load_skill` 或 Pi 原生 Skill Turn 按需加载。
- 项目级 MCP stdio：`.mcp.json` 配置、延迟发现、固定 `mcp_call` 代理、Capability 映射、效果日志、脱敏和进程回收。
- 完整 Tool Contract 规范哈希：版本、超时、资源键、敏感度和重放策略均进入快照；失败以结构化错误和 Pi `isError` 返回。
- Durable 运行观测：Provider/Tool/Effect 指标、成本与缓存 Token 汇总、主失败分类，以及 Prompt/Tool/Skill/MCP/Runtime 版本快照。
- 对话式 Coding Agent GUI：通过 SSE 与真实配置模型持续对话，实时显示文本、思考和 Tool 生命周期；每次调用可展开 Arguments、Result、Pi Entry、Control telemetry、完整关联 JSON 和浏览器 Worker 脚本处理。
- 六类中断恢复：过期租约回收、Fixture 生命周期核对、旧代次 Effect 隔离、Tool 批次配对修复和两阶段 Pi compaction。
- 确定性规划通道和带知识版本的 Planner-to-Executor handoff；执行前会淘汰过期计划，并把当前 handoff 编入上下文索引。
- 统一 RunEvent envelope 与有界 ingress：用户、Provider、Tool、Job、维护和外部信号可按 priority、generation、幂等键和 coalescing key 重放；单 Agent 默认在安全点消费，多 Agent 并行暂不启用。
- Durable 观察队列：后台 Job 的完成、关键词、退出、错误和心跳事件以脱敏摘要进入同一事件流，在 Provider/Tool 安全点注入 Coding Lane；GUI 可直接查看待消费数量、优先级、来源、序号和 Artifact/ref，确认结果可幂等重放。
- Run/Lane/Job Scope 的 child-first、LIFO、幂等释放，以及评测驱动的 UpdateProposal 创建、评估、批准、激活和 hash 绑定回滚。
- 机器可读的 `baseline-v4` 评测器，默认执行六个靶场各三次并追加 19 个 provider-free 运行时场景（合计 37 项），覆盖缓存、上下文、收敛、证据、持久化、事件 ingress、Job monitor 观察队列和恢复契约；同时汇总耗时、Token、成本、有效动作、首个证据时间、事实证据覆盖率和 Replay parity，并用规范化 Fixture/Scenario Catalog 哈希绑定题目内容、预算和稳定报告哈希。

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

### 新成员日常开发命令

仓库安装依赖时会自动运行 `prepare`，生成 API 索引和重复实现报告。它不会启动 Agent、GUI、Docker 或外部服务：

```powershell
# 第一次拉取或切换分支
npm ci
npm run build
npm run api:index:check

# 修改共享代码前：先搜索已有原语，避免重复实现
npm run api:search -- canonical json
npm run api:explain -- canonicalJson

# 修改源码或 TSDoc 后：重新生成并检查全部索引
npm run api:index
npm run api:duplicates:all
npm run api:index:check

# 修改 atoms 时的最小回归
npm run test:atoms

# 提交前完整门禁
npm run verify
```

API 索引位于 `docs/generated/`：

- `api/*.json`：机器可读的公共函数、类、方法、类型和常量；
- `api/*.md`：开发者可阅读的签名、来源、测试和总结；
- `agent/*-context.json`：给 AI 编码代理检索的精简上下文；
- `duplicates/*.json`：精确重复和结构相似候选。

不要手工编辑 `docs/generated/`。源码或 TSDoc 变更后运行 `npm run api:index`，再提交生成结果。每个符号都有 `summarySource`：`tsdoc` 表示来自源码 TSDoc，`inferred` 表示生成器根据名称、类型和实现行为生成的确定性兜底总结；新增公共符号仍应补充真实 TSDoc。精确重复需要处理，结构相似报告是候选，不会自动删除代码。

原子层开发入口见 [`packages/atoms/COMPONENT.md`](packages/atoms/COMPONENT.md)，索引插件和完整设计见 [`docs/FUNCTION_INDEX_AND_DUPLICATE_GUARD_PROPOSAL_ZH.md`](docs/FUNCTION_INDEX_AND_DUPLICATE_GUARD_PROPOSAL_ZH.md) 与 [`plugins/proofblade-api-index/README.md`](plugins/proofblade-api-index/README.md)。

## 项目计划与维护状态

项目使用 `project-status.json` 统一记录当前计划、每次更新、完成结果和维护活动，并确定性生成以下中文报表：

- `docs/project/PLAN.md`：当前计划、优先级、依赖、进度、交付物和验收条件；
- `docs/project/UPDATE_LOG.md`：每次更新的变更内容、关联计划、分支、提交和验证；
- `docs/project/COMPLETION_REPORT.md`：已经完成的计划、实际交付和验证结果；
- `docs/project/MAINTENANCE_REPORT.md`：维护记录以及 25 个组件的版本、检查次数、时间和源码指纹。

```powershell
npm run reports:project
npm run check:project-reports
```

生成的 Markdown 不直接编辑。CI 会在临时工作区重生成报表后再检查；普通 `packages/`、`apps/` 和 `scripts/` PR 不需要修改共享 `project-status.json` 或生成报表，只有项目计划、维护记录和 README 等治理文件变更才需要新增项目状态记录。

## 动态调试 GUI

```powershell
npm run gui -- --port 4173
npm run gui -- --config proofblade.config.json --port 4173
```

打开 `http://127.0.0.1:4173` 后默认进入 Agent 对话。“新建对话”可输入或浏览选择绝对工作目录，并可选填任务验证命令；填写后该命令会写入不可变 `TaskContract`，与 CTF/Fixture 使用同一 `CodingClaimVerifier`、verifier journal、Completion 和 Evidence 投影链。未填写时仍可继续普通探索，但候选只会显示为未验证，不能产生可信 Completion。“Fixture 测试”使用相同 Coding Lane 和验证链，自动模式只是在外层增加多轮 Coordinator 编排；不再存在普通 Chat 与 CTF 的第二套执行或完成判定系统。模型文本、思考与 Tool start/end 会边生成边显示，结束后由持久化 Pi Session 接管。

右上角齿轮打开“中转站与模型”，可创建多个 OpenAI-compatible Profile。每个 Profile 分别保存名称、Base URL、API Key、可选代理 URL、模型列表、默认思考等级和并发请求上限（1-32，默认 1）；模型发现和真实对话共用该代理。相同 Provider/模型的对话共用 FIFO 并发槽，排队请求可暂停取消且不会先占用成本预算。Windows 本地配置默认位于 `%USERPROFILE%\.proofblade\gui-provider.json`；服务端响应只返回 `hasApiKey`，不会返回 Key 内容。保存后可在输入框下方按对话切换中转站、模型与思考等级，无需改动仓库文件。

对话可以放入自定义文件夹并在侧栏筛选，也可从输入框下方随时切换工作目录。能力按钮会列出当前项目的内建 Tool、Skill 和 MCP Server，可为每个对话分别启停。Coding Agent 的 `load_skill` 与 `mcp_call` Schema 始终固定，启用集合只控制运行时可加载或调用的资源；MCP Server 数量变化不会扩展 Provider 顶层 Tool 列表。工作目录、文件夹和会话偏好保存在 `%USERPROFILE%\.proofblade\gui-workspace.json`。

长任务通过 `shell_background` 或 `run_background` 立即返回 Job ID；`shell_job monitor` / `monitor_job` 使用单调 UTF-8 字节游标等待新增输出、关键词、退出、错误、心跳或有界超时，不需要模型紧密重复 `read`。Job 完成事件仍保存在 Control Store，下一次安全点会把有界脱敏摘要注入同一个单 Agent 上下文；原始输出只通过已有 Artifact/Session 读取。GUI 的“待处理观察”面板直接从事件流重建，显示待消费与 urgent 数量及每条观察的来源、序号和关联对象；消费标记也写入事件流，重启后不会丢失或重复确认。

上下文面板把 Provider 实际上报的输入、输出、推理、缓存读取和缓存写入 Token 分开显示，同时给出发往 Provider 的可见消息、Tool Schema 和字符数估算。部分中转站会在极短提示上仍报告数千输入 Token，这是网关或模型模板的固定开销；若上游响应没有缓存字段，缓存读取与写入显示为“未报告”，不会用估算值伪装成缓存命中。

右侧“缓存前缀”诊断直接从最终 Provider payload 计算 System/Developer 指令和 Tool Schema 的规范哈希，不保存提示正文。稳定率用于发现系统提示、工具名称、顺序或 Schema 在相邻请求间漂移；它只说明客户端前缀是否稳定。真实缓存命中仍以模型响应中的 `cacheRead / (input + cacheRead + cacheWrite)` 为准，两项指标应一起判断：前缀稳定但 `cacheRead` 不增长通常表示中转站或模型没有复用缓存，而前缀变化会直接指出 `system`、`tools` 或 `rewrite` 原因。

缓存保留策略可在 GUI 的“中转站与模型”里按 Provider 配置：`short`（默认行为）、`long`（请求稳定的会话缓存键与更长 TTL）或 `none`。无 GUI 时也可在 `modelProfiles.executor.cacheRetention` 中设置；不同中转站是否返回缓存字段仍以 Provider 实际响应为准。对话旁会显示每轮的提示词总量、缓存读取和命中率，右侧指标显示累计值。

### RTK 工具输出改写

仓库配置默认请求 [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk)，RTK 未安装或命令未命中时按 `fallback: "builtin"` 保留 Pi 原有行为。RTK 应安装在 Coding `bash` 使用的同一个 Shell 中；Windows 上若 Pi 选择 WSL，可用 `wsl rtk --version` 核对，或把 `rtkCommand` 配成该 Shell 可执行的路径。官方预编译包和安装方法见 RTK release 页面。

```json
{
  "tools": {
    "outputRewrite": {
      "provider": "rtk",
      "rtkCommand": "rtk",
      "fallback": "builtin",
      "rewriteTimeoutMs": 5000,
      "maxRawBytes": 1048576
    }
  }
}
```

RTK 只包装普通 Coding Agent 的 `bash`；`read/edit/write` 和 Solver 的 Effect/Capability 链保持原样。同一 Run 只走这一条输出改写链，后续上下文维护不会再次对刚产生的结果套 RTK。RTK 提供 tee 原文时，ProofBlade 先把它注册为 Artifact 再返回压缩内容；某些 RTK handler 不生成 tee，此时保存 Pi 可见的有界输出，并以 `rawCapture: "visible-output"` 明确标记。调试 Tool Result 的 `details.outputRewrite` 包含 provider/version/hash、字节数、实测压缩率和 Artifact id。RTK 主要减少后续请求中的动态 Tool 结果，不会直接增加 Provider 的 `cacheRead`。

- 真实模型多轮对话、流式响应和消息内 Tool 调用；
- Tool 卡片直接展示实际指令/参数、返回结果、耗时和 Artifact/Evidence/Effect 引用，完整 JSON 作为二级检查入口；
- 普通对话提供用户、AI、Tool 和 Control 记录合并的执行轨迹，并独立汇总 Tool 结果、结构化证据和产物；
- `Run -> Pi Session -> assistant 轮次 -> Tool 调用` 的逐级选择；
- `Arguments`、`Result`、`Pi Entry`、`Telemetry` 和完整调试对象的树形/原文 JSON；
- 同一 `toolCallId` 下 Pi Session 与 Control Store 事件的关联，以及 Artifact、Evidence、Effect 引用；
- 浏览器 Web Worker Script Lab，内置调用摘要、证据提取和 Effect 摘要预设，输出可切换 JSON、表格和文本；
- Chat、CTF 和 Fixture 共用 Coding Lane、上下文维护、Tool 调用、Evidence、Completion 和恢复路径；Fixture 仅额外提供恢复核对、机械 Checkpoint 和验证账本视图；
- 多中转站 Profile、会话级模型切换、对话文件夹，以及 Tool/Skill/MCP 能力开关；
- Provider Token、可见上下文和缓存字段的独立统计。

Script Lab 的 `input` 始终是当前选中的完整 Tool 调试对象。脚本使用普通 JavaScript `return` 返回结果，执行上限为 1500 ms；代码只进入临时浏览器 Worker，不发送给服务端。完整对象结构和 API 见 `docs/gui.md`。

## CLI

```text
proofblade init <task-id>
proofblade run demo
proofblade fixtures
proofblade eval [--attempts N] [--max-turns N] [--run-prefix ID] [--enforce-gate]
proofblade eval-holdout [manifest.json] [--attempts N] [--max-turns N] [--enforce-gate]
proofblade eval-real <corpus.json> --allow-live --variant ID=config.json --variant ID=config.json
proofblade ablation list
proofblade ablation create <experiment.json>
proofblade ablation preflight <experiment-id> [--probe]
proofblade ablation init <experiment-id>
proofblade ablation status <experiment-id>
proofblade ablation resume <experiment-id>
proofblade ablation report <experiment-id> [--results results.json] [--markdown]
proofblade tools [list|probe|init|preflight|show] [profile|tool-id]
proofblade competition-api inspect <journal.jsonl>
proofblade competition-api replay <journal.jsonl> --script <requests.json>
proofblade doctor
proofblade capabilities
proofblade mcp [list|describe|call] [run-id] [server] [tool] [json-arguments]
proofblade skills [list|show] [skill-name] [max-chars]
proofblade skill <run-id> <skill-name> [additional instructions]
proofblade solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]
proofblade show <run-id>
proofblade timeline <run-id>
proofblade ledger <run-id>
proofblade context <run-id>
proofblade replay <run-id> [projection|protocol|tools|stats|shadow]
proofblade replay compare <baseline-run-id> <candidate-run-id>
proofblade reconcile <run-id>
proofblade cost <run-id>
proofblade checkpoint <run-id> [reason]
proofblade compact <run-id> [reason]
proofblade history <run-id> <query>
proofblade knowledge <run-id> [search|inspect] [query|pb://uri] [L0|L1|L2]
proofblade consolidate <run-id> [deduplicate|summarize|all]
proofblade handoff <run-id> [show|prepare]
proofblade jobs <run-id> [list|recover|monitor|read|stop] [job-id] [max-chars]
proofblade artifact <run-id> <artifact-id> [max-chars]
proofblade fixture-build <run-id>
proofblade fixture-reset <run-id>
proofblade fixture-score <run-id> <candidate>  # verifier-backed diagnostic
proofblade agent <run-id> [prompt]
```

### 消融实验

消融实验配置使用 `profileId`、具体模型名和策略 Variant；正式实验不能使用 `model: "auto"`。先创建并预检，再初始化配对账本：

```powershell
proofblade ablation create docs/experiments/receipt-vs-direct.json
proofblade ablation preflight AB-20260831-001 --probe
proofblade ablation init AB-20260831-001
proofblade ablation status AB-20260831-001
proofblade ablation report AB-20260831-001 --results runs/ablation-results.json --markdown
```

`--probe` 只访问 Provider 的模型元数据接口，不发送题目内容。API Key 只能通过 Provider Profile 或环境变量提供；实验快照、事件、Artifact、账本和报告只保存环境变量名及 `credentialPresent`，不会保存 Key 明文、Authorization Header 或候选答案。

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

- `docs/components.md`：25 个组件的开发入口、文档版本与强制更新规则。
- `docs/architecture.md`：依赖方向、运行时组件和上下文层级。
- `docs/task-contract.md`：任务、事实、证据和完成条件。
- `docs/tool-contract.md`：工具契约、效果、重放和制品规则。
- `docs/eval-protocol.md`：确定性评测指标和回归门槛。
- `docs/extensions.md`：分层判断、工具开发、MCP、Skill 和扩展验收。
- `docs/recovery.md`：六个故障注入窗口、恢复顺序和收敛不变量。
- `docs/gui.md`：动态调试 GUI、Tool 调试对象、Script Lab 和本地 API。
- `docs/FUNCTION_INDEX_AND_DUPLICATE_GUARD_PROPOSAL_ZH.md`：API 索引、TSDoc 总结、AI 复用流程和重复实现检测方案。
- `docs/deepseek-harness-reference.md`：DeepSeek Harness 架构调研、ProofBlade 差距映射、落地优先级与验收标准。
- `docs/cordis-paper-reference.md`：Cordis 时空可组合性论文、可逆效果、反应式依赖与 ProofBlade 落地分析。
- `docs/pentagi-reference-development-proposal.md`：PentAGI 架构调研、ProofBlade 能力映射、Work Graph/专家委派/持久 Fleet 与容器/经验索引/观测和报告的分阶段开发建议。
- `docs/project/PLAN.md`：当前开发计划和依赖关系。
- `docs/project/UPDATE_LOG.md`：按时间排列的更新记录。
- `docs/project/COMPLETION_REPORT.md`：完成情况和验证证据。
- `docs/project/MAINTENANCE_REPORT.md`：维护活动和组件审计状态。
- `pi-ctf-agent-harness-design.md`：ProofBlade 的完整设计依据。
