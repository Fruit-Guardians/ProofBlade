# ProofBlade 统一 Agent 基础设施开发安排

> 状态：实施计划
>
> 日期：2026-08-29
>
> 适用范围：普通 Chat、CTF Chat、Fixture、Competition、Coding Lane、工具调用、异步运行、上下文、知识投影、Evidence、压缩、恢复和持续演化。
>
> 依据文档：
> - `docs/filesystem-knowledge-projection.md`
> - `docs/context-volatility-ordering.md`
> - `docs/CODING_AGENT_CHAPTER5_DEV_SUGGESTIONS_ZH.md`
> - `docs/AGENT_INTERACTION_CHAPTER6_DEV_SUGGESTIONS_ZH.md`
> - `docs/AGENT_EVOLUTION_CHAPTER6_9_DEV_SUGGESTIONS_ZH.md`
> - `docs/cordis-paper-reference.md`
> - `docs/deepseek-harness-reference.md`
> - `tmp/ai-agent-chapter7.md`（Agent 评估）
> - `tmp/ai-agent-chapter10.md`（多 Agent 协作）

## 1. 执行摘要

ProofBlade 目前已经具备 ControlStore、Effect Journal、ArtifactStore、Evidence Graph、ContextCompiler、Work Graph、Provider 调度、Tool Contract 和持久化 GUI 等基础设施。前述参考文档提出的建议不应被实现成互相竞争的系统，而应收敛为一个统一的长期运行闭环：

```text
用户/Provider/Tool/Job/外部回调/定时器/维护
                         |
                 一个 RunEvent 流
                         |
                  一个安全点循环
                         |
  一个 RunCoordinator + 一个 Coding Lane + 一个 Work Graph
                         |
 ContextCompiler + Knowledge Projection + Evidence + Verifier
                         |
             GUI/CLI/Replay/Telemetry 只做投影
```

本计划的核心顺序是：

```text
契约和观测
  -> 工具基础能力和失败分类
  -> 长任务状态和自动恢复
  -> 事件驱动与监控唤醒
  -> 知识 URI 与 L0/L1/L2 投影
  -> ContextBlock、压缩和手动维护点
  -> Evidence consolidate 与集中整理
  -> 可验证的持续更新和能力保鲜
```

### 1.1 必须坚持的架构结论

1. ControlStore 是唯一可重放的任务状态权威，不能新增第二个事件日志或知识数据库作为事实来源。
2. ArtifactStore 保存原始输入、Tool 输出、Provider 记录和中间文件；摘要、索引和 placeholder 都可以从它重建。
3. Evidence Graph 保存来源、支持、反驳、依赖和验证关系；Knowledge Projection 只提供导航视图，不拥有事实。
4. 普通 Chat、CTF、Fixture 和 Competition 共用同一套事件、Tool、Evidence、Completion、压缩和恢复契约；目标类型差异只能由 TaskContract 和能力策略表达。
5. 新动态内容继续追加到 transcript 尾部。动态尾部内部按稳定性排序只影响本地裁剪、压缩和投影重建，不直接提高 Provider KV Cache 命中。
6. 上下文整理可以同时是一次压缩，但压缩只改变 Provider 视图，不删除原始 Artifact，也不提升内容可信度。
7. recoverable 问题进入 retry、reconcile、compact、replan、wait 或 `NEED_HUMAN`，不能静默强停 Agent。
8. 完成确认始终由统一 verifier 决定，LLM 文本、摘要、置信度和 Evidence 草案不能绕过验证器。
9. 每个真实模型请求都必须有可重建的 RequestEpoch；Session、ControlStore、Artifact 和 Telemetry 通过 ID 关联，不互相夺取事实权威。
10. 动态能力通过 Definition/Provider/Consumer 和 Scope 接入；注册、依赖变化、卸载、替换和部分失败都必须有可回放的生命周期节点。

### 1.2 本计划不做的事情

- 不为普通 Chat、CTF、Fixture 或 Competition 分别建立 Agent loop。
- 不把 Knowledge Projection、向量检索、Reasoning Forest 和 Markdown 导出实现为三份真相。
- 不把所有动态状态写入 System Prompt。
- 不因为上下文压力而直接删除当前任务、当前用户消息、Tool pair、unknown Effect、运行中 Job、租约或验证链。
- 不把 Provider attempt 的超时等同于整个 Run 的终止。
- 不在每一次 Tool 调用后强制模型进行长篇证据文书工作。
- 不在没有触发集、保留集和安全集的情况下自动发布 Prompt、Skill、Tool 或 verifier 修改。
- 不先实现复杂世界模型、全双工语音或机器人控制；这些属于后续能力验证，不是当前长任务可靠性的前置条件。

## 2. 九份文档的统一归纳

### 2.1 知识投影文档解决“内容如何被找到”

`filesystem-knowledge-projection.md` 提供以下基础设计：

- 用 `pb://` URI 将 Task、Forest、Tree、Evidence、Fact、Hypothesis、Artifact、Session 和 Skill 组织成逻辑目录；
- 用 L0、L1、L2 表示摘要、概览和原始内容访问深度；
- 通过 source IDs、content hash、generation、knowledgeVersion 和 trust 保证摘要可追溯；
- 从 Forest 入口逐步导航到 Tree、Evidence 和 Artifact，而不是把所有全文一次加载；
- L2 通过 ArtifactStore 有界读取，原始数据保持不可信和可审计；
- 在没有新思路或处于空闲窗口时集中做去重、链接、摘要、冲突和索引整理。

它回答的是“Agent 需要的信息在哪里、应该看到多少”，不回答“哪些内容已经被验证”。

### 2.2 变更频率文档解决“内容如何排列和处理”

`context-volatility-ordering.md` 将现有层次区分为：

```text
Context Layer:   L0-L5
Knowledge Level: K0-K2
Placement Band:  P0-P10
```

推荐排列：

```text
P0  Global stable prefix
P1  Run-stable configuration
P2  Immutable TaskContract
P3  K0 root/schema index
P4  L3A durable reasoning ledger
P5  Task runtime state
P6  K0 volatile state + selected K1
P7  L3B active controls
P8  L5 Artifact pointers
P9  L4 recent Tool placeholders
P10 K2 on-demand raw content
```

关键限制是：当前动态内容在 transcript 之后追加。因此 P2-P10 的内部排序不会改变 Provider 已经拥有的完整历史前缀，也不能被当作 Provider KV Cache 的局部命中优化。它主要决定本地裁剪优先级、压缩顺序、块级 hash 和 replay 的可解释性。

### 2.3 第 5 章建议解决“Coding Agent 的工具闭环”

`CODING_AGENT_CHAPTER5_DEV_SUGGESTIONS_ZH.md` 的建议可按优先级归纳为：

| 建议 | 本计划归属 |
| --- | --- |
| Glob/Grep 结构化搜索 | Tool 基础能力阶段 |
| read 行号、head/tail 截断 | Tool 结果投影阶段 |
| Run/Phase/预算状态栏 | 统一事件和上下文投影阶段 |
| write/edit 后语法反馈 | Tool 生命周期和质量反馈阶段 |
| 会话级 shell 状态 | Tool/Job 运行时阶段 |
| 跨 Run 教训库和信任审查 | Knowledge/Evolution 阶段 |
| shell 命令写目标解析 | Effect 预检查和恢复阶段 |
| 死亡螺旋防护 | Event loop 和 Work Graph 阶段 |
| 中立轨迹和跨 Provider 接管 | Replay/Evaluation 阶段 |
| 符号计算和约束求解 | 可选能力包阶段 |
| `proofblade doctor` | 运行时诊断阶段 |
| 解题计划和提交前自审 | Work Graph/Verifier 阶段 |

这些能力都必须进入现有 Tool Contract、Effect、Artifact、Evidence 和 WorkItem 链，不能通过模型直接操作 Host 或绕过权限控制。

### 2.4 第 6 章建议解决“世界不会等待模型”

`AGENT_INTERACTION_CHAPTER6_DEV_SUGGESTIONS_ZH.md` 的核心是：

- 后台 Job 通过新增输出、关键词、退出和心跳事件唤醒 Agent，减少主动轮询；
- 观察队列在安全点批量注入，不破坏正在进行的 Provider 或 Tool pair；
- 长 Tool 以占位符开始，完成或失败时再以结构化结果回填；
- 快速状态层与慢速推理/整理层分工，但共享同一个 ControlStore；
- 用户通知、暂停、取消、恢复和召回都应变成结构化事件；
- Web 观察可以逐步发展为关键帧、DOM/文本摘要、变化检测和动作后确认；
- 连续思考和世界模型属于后续优化，前提是先具备稳定的状态、事件和观察接口。

### 2.5 第 9 章建议解决“经验如何真正改变系统”

`AGENT_EVOLUTION_CHAPTER6_9_DEV_SUGGESTIONS_ZH.md` 的核心是：

- 评价先于总结，结果验证、过程验证和质量 Rubric 分层；
- 原始轨迹、单次运行分析和跨轨迹经验不能混成一个对象；
- 经验可以进入知识、Skill/Prompt、程序/Harness 或模型参数，但应选择最合适的载体；
- 在线执行只记录证据，空闲或离线阶段再整合、验证、发布和回滚；
- 失败、负面结果、被拒假设和适用条件必须保留；
- 更新成功率与更新被正确激活、遵循的成功率必须分开测量；
- 新版本必须在触发失败集、保留集、迁移集和安全集上验证。

### 2.6 Cordis 与 DeepSeek Harness 的共同增补

两份参考文档分别从运行时组合和 Agent Harness 约束补齐了本计划此前没有完全展开的边界。它们应被映射到同一个 `ControlStore -> RunEvent -> RunCoordinator -> ContextCompiler -> Artifact/Evidence/Verifier` 闭环：

| 需要解决的问题 | Cordis 提供的约束 | DeepSeek Harness 提供的约束 | ProofBlade 统一落点 |
| --- | --- | --- | --- |
| 动态能力如何加入和退出 | Effect 在创建点携带 inverse，按依赖顺序撤销 | 插件、Tool、Provider、监听器和 Job 属于 Scope | `Disposable`、`Run/Lane/JobScope`、Effect Journal 和孤儿扫描 |
| Provider 替换如何不污染调用 | Provider identity 独立于 value，Consumer 先 teardown | Definition/Provider/Consumer 接缝和能力声明 | `providerId + providerVersion + registrationId + scopeId` 绑定与 stable CapabilityRouter |
| 模型究竟看到了什么 | Context 变化经过可识别边界 | Session append-only，`request/header` 和 `request/context` 可重建 | Pi Session 中的 `RequestEpoch`，ControlStore 只保存业务事实 |
| 工具结果如何兼顾上下文和审计 | 派生 Context 与原地 Context 分开 | canonical value、model presentation、durable content 三态输出 | Tool Contract + Artifact/Spill + Evidence 投影 |
| 压缩或维护中途崩溃如何恢复 | 中间生命周期状态和部分 inverse | `start/summary/end` 事务括号与 orphan recovery | OperationRef、Compaction/Curation/Sandbox 统一开始/完成配对 |
| 依赖和配置如何热变化 | reactive coeffect、isolation/interception、confluence | Profile/Bundles/Patches、Workflow 生命周期 | 统一 Resolver、Scope metadata、字段级 reconciliation、Replay |
| 观测失败如何不拖垮主流程 | 变化通知进入可重放边界 | Telemetry 是可替换、脱敏、带游标的旁路 | RunTelemetry capture/redact/backend/cursor，尽力而为 |

#### 2.6.1 必须吸收的六个运行时不变量

1. **请求可重建**：每个实际 Provider 请求都记录 `RequestEpoch`，包含实际发送请求的 hash、系统提示/Tool Catalog/Context Manifest 的 hash、Provider/模型/Adapter、Lane、父请求和响应终态；密钥和敏感原文只保留允许的 hash 或引用。
2. **注册可逆**：动态注册、订阅、Transport、Job、Sandbox、临时 Spill 和定时器都由 Scope 持有 `Disposable`；dispose 必须幂等，子 Scope 先于父 Scope 释放。
3. **绑定不漂移**：一次调用开始后固定 Provider binding；配置变化只影响后续调用。Provider 正在卸载时先进入 quiescing，依赖它的 Consumer 使用旧 committed view 完成 teardown，之后才删除注册。
4. **输出分层**：Tool 必须同时定义规范值、模型展示和长期制品/证据策略。大结果外置不等于丢失，摘要也不等于验证；三者都从同一 Tool Call 产生。
5. **操作可发现**：Compaction、Evidence consolidate、Effect、Sandbox、MCP reconnect 和 Subagent 都使用开始/完成配对。只有完成事件存在时才提升新投影；孤儿操作进入恢复器，不被默认为成功。
6. **观测旁路**：Telemetry、GUI 推送和导出后端失败只生成可见诊断，不阻止主 Event、Tool 或 Provider terminal event；重放和状态恢复不能依赖内存监听器。

#### 2.6.2 不引入的结构

- 不整体迁移 Cordis，不把论文的形式化 Context 变成第二个事实库。
- 不把 Pi Session 与 CTF ControlStore 合并；前者回答“模型见过什么”，后者回答“任务、证据和效果状态是什么”。
- 不建立新的全局巨型 Registry；各 Registry 可以独立，但 Definition/Provider/Consumer、availability、版本、priority、Scope 和 dispose 语义必须一致。
- 不把 Spill、Knowledge Projection、Evidence Forest 或 Workflow 变成独立 Agent transcript；它们都是同一 Run 的 Artifact、Projection 或维护 WorkItem。
- 不把语言级 Proxy 当作 Sandbox；不受信任脚本、native reverse 和外部工具仍必须走真实进程/容器隔离。

### 2.7 第 7 章建议解决“如何知道系统真的变好了”

第 7 章的评估方法应成为 S0、S7 和 S8 的公共协议，而不是只给某一种任务类型建立独立评测。每个评估任务都必须能还原以下五元组：

```text
Dataset              初始数据、用户目标、环境状态和验收条件
Environment State    可重置的外部状态、权限、时钟和随机种子
Tools                版本化 Tool/Capability Catalog 及允许的副作用
Rubric               确定性断言、质量维度、禁止项和人工/LLM 评审规则
Interaction Protocol 用户模拟器、事件注入、步数/时间/费用和终止协议
```

#### 2.7.1 成功率必须区分能力上限和生产可靠性

- `Pass@k` 表示同一用例运行 `k` 次至少一次通过，适合衡量探索能力上限。
- `Pass^k` 表示连续 `k` 次全部通过，且没有安全、合规或幻觉一票否决项，适合关键生产动作的可靠性。
- `Pass@1`、verified success、evidence-backed success、成本和 p95 延迟必须同时报告，不能用一次最佳结果替代稳定性。
- 任何“修复完成”都拆成 `FAIL_TO_PASS` 和 `PASS_TO_PASS`：前者证明目标问题被修复，后者证明没有引入回归；测试自身还要进行 flaky 检测。

确定性验证器优先检查最终环境、文件、进程、数据库、网络或 API 状态；只有不存在可靠机械断言时，才使用 Rubric 或 LLM-as-a-Judge。评审输入必须引用脱敏 Artifact 和轨迹节点，不能让 Agent 自我声明成为唯一依据。

#### 2.7.2 失败归因和回归必须定位首错

端到端失败只说明结果不满足条件，不能说明应修复哪里。系统应在生产轨迹脱敏后记录以下归因对象：

```ts
interface FailureAttribution {
  taskId: string;
  firstErrorStep: number;
  errorCategory: string;
  rootCauseOwner: "model" | "harness" | "tool" | "provider" | "environment" | "verifier";
  primaryCause: string;
  secondaryCauses: string[];
  supportingEvidenceIds: string[];
  recoverability: "recoverable" | "needs_human" | "terminal";
  confidence: number;
}
```

首错是第一个使任务偏离且能解释后续连锁失败的节点，不能把最后一个报错当根因。规则先筛选，再由人工或标注 Agent 复核；标注结果必须保留任务、环境、版本、工具集和完整轨迹引用。

每个高价值失败至少生成两类回归：

1. 端到端回归，验证完整流程的 `FAIL_TO_PASS`、`PASS_TO_PASS` 和真实终态。
2. trajectory-prefix 回归，冻结首错前的 Context、Tool 返回和环境状态，只验证下一步决策边界，降低成本并隔离根因。

#### 2.7.3 评估结果必须能解释变化来源

评估集由公开基准、自建业务集和生产失败轨迹回流组成，并需要难度分层、参数化实例、数据泄漏检查、人工质量筛选、环境重置和独立验证器。每次比较至少支持 model swap、组件 ablation、A/B 和提示敏感性测试；关键结论要报告样本量、置信区间或显著性，而不是只比较一次平均值。

观测采用统一 Trace/Span 投影：一个 Run 是 Trace，Provider、Tool、Job、检索、压缩、Evidence、验证器和子 WorkItem 是 Span，记录父子关系、耗时、Token、成本、错误、恢复动作和输入输出引用。Telemetry 通过异步批量旁路发送，后端失败不能阻断主循环。脱敏后的失败轨迹回流到评估集和回归集，但原始 Artifact 仍由 ArtifactStore 保留。

### 2.8 第 10 章建议解决“什么时候值得协作以及如何协作不失控”

多 Agent 不是默认的性能升级。是否引入协作，第一判断标准是它是否带来单 Agent 无法获得的新信息、不同工具视角或独立验证；如果模型、上下文、工具和证据都相同，只增加 Agent 数量通常只增加 Token、延迟和共因失效。

#### 2.8.1 统一系统中的两类边界

多 Agent 只作为同一个 Run 内的策略层、WorkItem 或 Lane 组合，不创建第二套 Loop、ControlStore、Evidence Graph、Verifier 或持久事实库：

```text
统一 ControlStore / RunEvent / Work Graph / Artifact / Evidence / Verifier
                         |
       Manager、Planner、Executor、Reviewer 作为策略或维护 Lane
                         |
                 结构化 handoff + 共享 Artifact 引用
```

上下文可以在 Lane 间隔离，但事实和控制状态必须回到同一个 ControlStore。handoff 只交换结构化数据，不复制完整思考历史：

```ts
interface AgentHandoff {
  taskId: string;
  workItemId: string;
  goal: string;
  constraints: string[];
  acceptedFacts: string[];
  artifactRefs: string[];
  evidenceRefs: string[];
  remainingBudget: { tokens?: number; timeMs?: number; cost?: number };
  visitedAgents: string[];
  expectedOutput: string;
  generation: number;
}
```

结构化 handoff 必须校验 `generation`、权限、Artifact 可见性、预算和已访问链；禁止把不透明的“我已经完成”当成状态提交。

#### 2.8.2 Manager、并行和结算

- Manager 负责拆解、调度、监控、重试、重规划和聚合，但不能绕过统一 Verifier；Manager 的计划质量应进入评估和 trajectory-prefix 回归。
- 并行候选以“第一个已验证成功”为结算点，不以第一个声称成功为结算点。结算使用持久化、幂等的 `settle_once(workItemId, winnerId, evidenceRefs)`，同时成功时只有一个 winner 生效。
- 结算后广播优雅取消，子 Agent 在安全点停止新 Tool，清理 Scope、释放锁、写入未完成状态并返回 ACK；超时后才进入强制回收。强制回收不能删除原始事件，也不能伪造子任务完成。
- 父 Run 的取消沿 Scope/Context 向下级联，避免孤儿 Agent；真正需要脱离父 Run 的后台任务必须显式创建新的生命周期根并拥有独立预算和回收入口。
- 调度同时约束 Token、Provider 并发、时间、费用、子 Agent 数量和抢占；预算耗尽进入 `NEED_HUMAN`、等待、重规划或明确终态，不静默停止。

#### 2.8.3 数据平面、控制平面和冲突治理

共享 Artifact/Workspace 是数据平面，结构化消息和 RunEvent 是控制平面。Agent 私有 scratchpad、Run 共享空间、外部挂载和内置只读资源要分区表达；共享文件使用工作副本或乐观锁，跨文件语义冲突由 Verifier 或专门审计 WorkItem 检查。消息总线必须带 sender、target、messageType、correlationId、generation 和幂等键。

需要显式防护文件并发冲突、跨文件语义冲突、错误级联、同质 Agent 共因失效、角色推诿、handoff 循环、子 Agent 无限扩张、命名空间污染和“理解债”。访问链做 cycle detection，角色差异必须体现为模型、工具、可见证据、环境或职责的真实差异；提议者和审核者必须依据独立 Artifact，审核者不能修改测试、Verifier 或发布门槛。

跨组织 A2A 只作为统一 Run 的适配协议，交换 Agent Card、Task 状态和不透明 Artifact 引用，不暴露内部 Prompt、思考过程或工具实现。外部 Agent 的返回必须经过同一套 Evidence、Verifier、预算和生命周期处理。

## 3. 当前基线与依赖关系

### 3.1 已有能力，第一阶段不重复实现

当前代码中已经存在以下能力，后续应围绕它们扩展：

| 能力 | 当前落点 | 处理原则 |
| --- | --- | --- |
| 上下文编译 | `packages/materials/src/context/compiler.ts` | 在现有 L0-L5 上增加块元数据，不另建编译器 |
| 动态尾部 | `packages/materials/src/runtime/coding-lane.ts` | 继续 append-only，不插入旧 transcript 中间 |
| 压缩和 Tool pair 修复 | `context/maintenance-coordinator.ts`、`agent-pruner.ts`、`durable-compaction.ts` | 统一 band 和状态，不破坏现有安全点 |
| Provider 调度 | `runtime/provider-scheduler.ts` | 保留队列、idle watchdog、stream-boundary retry |
| Provider 观测 | `observability/pi-events.ts` | 增加延迟、事件和恢复维度 |
| 后台 Job | `tools/runtime.ts`、`runtime/solver-tools.ts` | 在现有 Job 上添加 monitor cursor/trigger |
| 结构化 Tool 错误 | `tools/errors.ts` | 直接接入自动恢复矩阵 |
| 运行协调 | `orchestration/run-coordinator.ts`、`single-agent-loop.ts` | 承载统一事件消费和 WorkItem 生命周期 |
| Work Graph/Handoff | `orchestration/run-work-scheduler.ts`、`refiner.ts` | 承载维护、重规划和持续更新任务 |
| 证据和验证 | `Evidence`、Verifier、Completion、Artifact | 不改变 authority，只增加投影和整理 |
| GUI 事件流 | `apps/gui/src/server.ts`、共享状态/事件投影 | 展示同一事件流，不维护 GUI 私有任务状态 |

### 3.2 现有项目计划的依赖映射

本安排不是替代已有项目计划，而是把它们串成一条实施顺序：

```text
PLAN-110  Phase Gate 与运行护栏
PLAN-120  Provider 调度、预算和重试
PLAN-220  Work Graph 与可恢复编排
    |
    +--> 统一 Event Envelope 和安全点循环
              |
              +--> PLAN-100 Reverse/Artifact 能力接入
              +--> PLAN-200 Replay/Tool Replay/Shadow 评测
              |
              +--> Knowledge Projection + ContextBlock + consolidate
                              |
                              +--> 持续更新、激活、遵循和回滚
```

已有 `PLAN-230` 记录了统一事件、上下文维护、工具恢复、证据整理和持续演化的建议。本计划提供更细的实施拆分和门禁，实施时应更新同一个计划或建立明确的子任务引用，不要产生互相矛盾的第二份路线图。

### 3.3 依赖图

```text
S0  版本、事件和指标基线
 |
 +--> S1  Tool 搜索、读写反馈和命令预检查
 |      |
 |      +--> S2  Tool/Effect/Job 生命周期和恢复矩阵
 |                     |
 |                     +--> S3  安全点事件循环、监控和用户事件
 |                                      |
 |                                      +--> S4  pb:// 知识目录和 L0/L1/L2
 |                                                       |
 |                                                       +--> S5  ContextBlock/P0-P10/压缩
 |                                                                      |
 |                                                                      +--> S6 Evidence consolidate
 |                                                                                     |
 |                                                                                     +--> S7 持续演化闭环
 |
 +--> S8  Replay、doctor、评测和文档门禁（全程横向）
```

不能跳过 S0-S3 直接实现复杂的知识或持续学习功能。没有稳定事件、Tool 状态和恢复语义，摘要只会把不完整的运行状态包装成更难发现的错误。

## 4. 统一运行模型

### 4.1 RunEventEnvelope

在现有事件类型之上定义统一 envelope。它是通用元数据，不是新的状态存储：

```ts
interface RunEventEnvelope {
  id: string;
  runId: string;
  generation: number;
  source: "user" | "provider" | "tool" | "job" | "external" | "timer" | "maintenance" | "verifier";
  kind: string;
  priority: "urgent" | "normal" | "background";
  status: "queued" | "admitted" | "deferred" | "applied" | "coalesced" | "failed";
  sequence: number;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  coalescingKey?: string;
  operationId?: string;
  requestEpochId?: string;
  deadlineAt?: string;
  replayPolicy: "pure" | "idempotent" | "unknown" | "never";
  payloadRef?: { artifactId?: string; eventType: string; hash: string };
  createdAt: string;
}
```

payload 大于上下文预算时只传 `payloadRef`、短摘要和统计量。完整内容仍由 ArtifactStore、Pi Session 或 Job 输出保存。

### 4.2 事件来源统一表

| 来源 | 事件例子 | 默认上下文处理 |
| --- | --- | --- |
| 用户 | `user.message`、`user.pause`、`user.cancel`、`user.resume` | 当前安全点优先消费，保持用户原文和 TaskContract 边界 |
| Provider | `queued`、`started`、`first_event`、`retrying`、`stalled`、`completed` | 记录延迟和状态，半截流不进入最终 transcript；请求绑定 `RequestEpoch` |
| Tool | `planned`、`started`、`progress`、`end`、`error` | 保留 Tool pair，失败进入结构化恢复；结果分为 canonical/presentation/durable 三态 |
| Job | `output`、`keyword`、`exit`、`heartbeat`、`unknown` | 通过游标合并，减少重复唤醒 |
| 外部 | `callback`、`channel.message` | 校验来源、scope、generation 后进入队列 |
| 定时器 | `maintenance.due`、`reconcile.due` | 低优先级，不能抢占紧急用户事件 |
| 维护 | `context.pressure`、`context_rot`、`consolidate.requested` | 触发整理或压缩，不直接终止 Run |
| Verifier | `verification.result`、`completion.accepted` | 只由统一 verifier 推进完成状态 |

### 4.3 安全点事件循环

事件循环必须遵循以下边界：

```text
1. 输入先 append 到 ControlStore。
2. Reducer 生成队列和状态投影。
3. 当前 Provider stream 或不可取消 Effect 期间只 defer，不修改旧 pair。
4. 在 Provider terminal、Tool end、Job safe point 或用户显式 cancel 边界消费批次。
5. 按 priority、generation、dependency 和 idempotency 判断可应用事件。
6. 产生 retry、reconcile、compact、replan、wait 或 resume 动作。
7. 从当前快照重新编译 ContextManifest 和 dynamic suffix。
8. 将处理结果、指标和下一动作写回同一事件流。
```

内存队列可以加速，但重启后必须能够根据 ControlStore 重建；GUI 不能把自己的待处理列表当作事实。

### 4.4 可恢复问题与终态

| 问题 | 不应做 | 应做 |
| --- | --- | --- |
| 上下文压力 | 强制结束 Agent | snip、consolidate、compact、重新编译并继续 |
| Tool 超时 | 立即重放可能有副作用的操作 | 查询 Effect/Job，标记 unknown，reconcile 后决定 |
| Provider 暂停 | 静默断开 UI | 记录 stalled，重试或进入可恢复等待 |
| 证据不足 | 阻塞所有探索 | 轻量 `evidence_gap`，继续记录观察 |
| 重复失败 | 原样无限重试 | 改变参数、范围、工具、Backend 或创建 replan |
| 用户暂停 | 丢弃当前上下文 | 写入 PAUSED，保留队列、快照和恢复入口 |
| 用户取消 | 当成系统故障 | 记录 cancel requested，回收可取消资源 |
| 外部状态未知 | 伪造成功或失败 | 进入 reconcile/NEED_HUMAN，并持续显示原因 |

只有用户明确取消、Verifier 判定失败或不可恢复的资源/权限条件，才允许进入终止型状态。即使终止，事件、证据、Artifact 和恢复信息仍须保留。

## 5. 分阶段实施安排

### S0：基线、版本和观测契约

**优先级**：P0。**前置条件**：无。**目标**：让所有后续改动可比较、可重放、可回滚。

#### 实现内容

- 为 Event、ContextBlock、Knowledge Projection、Job、Provider attempt、Evidence consolidation 和 Update Proposal 定义稳定 schema version。
- 为 Provider、Tool、Effect、Job、Compaction、Evidence 和 WorkItem 统一补齐 `runId`、`generation`、`correlationId`、`causationId`、source hash 和 replay policy。
- ContextManifest 增加 block IDs、content hashes、first changed block、dropped reason、compression target 和 source IDs。
- RunTelemetry 增加 queue wait、execution、first event/token、inter-event idle、recovery、maintenance 和 time-to-first-evidence。
- 为每个实际模型请求持久化 `RequestEpoch`：记录实际请求的 Provider、模型、Adapter、Tool/Capability Catalog、系统提示、ContextManifest、`stablePrefixHash` 和 `requestBodyHash`；密钥只允许以脱敏配置 hash 或引用出现。
- 为 Compaction、Evidence consolidate、Effect、Sandbox、MCP reconnect 和 Subagent 统一生成 `OperationRef`，要求 `started` 与 `finished`/`failed` 配对，启动时扫描孤儿操作并交给恢复器。
- 为 Definition/Provider/Consumer 统一记录 `providerId`、`providerVersion`、`registrationId`、`scopeId`、availability、priority 和 capabilities，Provider value 不能替代 binding identity。
- 固定一次 baseline-v4 provider-free scenario catalog，覆盖现有 30 项基线并增加事件/恢复场景占位。
- 为评估任务固定五元组 schema：Dataset、Environment State、Tools、Rubric、Interaction Protocol；每个任务声明可重置条件、独立验证器和脱敏规则。
- 为每个 Run 建立 Trace，为 Provider、Tool、Job、Context、Evidence、Verifier 和 WorkItem 建立可关联 Span；遥测记录首错候选、恢复动作、Token、费用、延迟和输入输出引用。
- 为生产失败轨迹定义 `FailureAttribution`、端到端回归和 trajectory-prefix 回归的持久化格式，首错归因不能只依赖最后的报错或模型自述。

#### 代码落点

```text
packages/materials/src/domain/types.ts
packages/materials/src/domain/utils.ts
packages/materials/src/observability/pi-events.ts
packages/materials/src/runtime/request-epoch.ts 或现有对应模块
packages/materials/src/runtime/scope.ts
packages/materials/src/capabilities/backend.ts
packages/materials/src/capabilities/router.ts
packages/materials/tests/runtime-scenario-evaluator.test.ts
docs/architecture.md
docs/eval-protocol.md
```

#### 完成门槛

- 同一录制轨迹重放后 projection hash 稳定。
- 没有源码行为变更时，旧的 Provider/Tool/Context 指标仍可读取。
- 所有新字段能兼容旧事件，旧 Run 不因缺少 envelope 字段而无法打开。
- 从 Session/ControlStore/Artifact 重建的 `RequestEpoch` 与实际发送请求规范 JSON 一致，日志中不存在测试 API Key。
- 任一动态注册都能找到幂等 dispose；Consumer teardown 未完成前，旧 Provider committed view 仍可读取。
- `cacheRead` 仍只来自 Provider usage，不能用估算值补齐。

#### 回滚点

保留旧事件解析器和 manifest v1 读取路径；只在新 schema 写入完整验证通过后启用新投影。

### S1：Coding Agent 基础 Tool 能力

**优先级**：P0。**前置条件**：S0。**目标**：减少模型因搜索、读取和编辑接口不足产生的无效回合。

#### 实现内容

1. 增加结构化 `glob` 和 `grep`，返回排序后的路径/匹配索引、数量、截断信息和 Artifact 引用。
2. 改进 `read` 输出：行号、head/tail、有界范围、文件 hash、字节数和截断原因进入结构化 details。
3. 为 `write`/`edit` 增加即时语法或类型反馈入口；反馈失败是 Tool 诊断，不自动提升为任务失败。
4. 为 shell 保留会话级 cwd、环境摘要和 session id，但不泄漏 Key 或 Host 配置。
5. 增加 `proofblade doctor`，只做运行环境、Tool catalog、MCP、Provider、Sandbox、权限和版本诊断。
6. 增加 shell 命令写目标集合解析，作为 Effect 预检查和上下文提示，不把模型解析结果当作最终权限判定。
7. 为每个 Tool 定义三种输出：程序和 Replay 使用的规范 JSON、模型使用的有界稳定展示、GUI/Evidence 使用的完整 Artifact 或 Spill 引用。
8. 在现有 ArtifactStore 之上增加轻量 Spill 接缝；超大结果只把 head/tail、字节数、content hash 和取回提示放入 Context，完整内容仍可通过有界 URI 读取。

#### 统一边界

所有新 Tool 都必须经过现有 Tool Contract、ToolPreflight、Effect Journal、ArtifactStore、敏感度和 Evidence 链。新增能力只能扩展现有能力目录，不能为普通 Chat 另外复制一套工具表。

#### 完成门槛

- 搜索结果大于预算时只返回索引和 Artifact ref，不把全文全部放入上下文。
- read 同一文件同一范围具有确定性输出和稳定 hash。
- 同一 Tool Call 的 canonical value、model presentation 和 durable content 能由同一个结果 hash 关联，三态不会由 GUI 或模型分别重算。
- Spill 保存失败时保留 Tool 的真实成功/失败语义，返回受控截断结果并记录 `spill_failed`，不伪造完整 Artifact。
- edit/write 失败不会留下成功的 Effect 或悬挂 Tool pair。
- shell 命令的写目标解析错误只作为诊断，最终 scope 仍由代码校验。
- doctor 的结果不包含 Provider Key 和敏感候选值。

#### 回滚点

保留现有 `read`/`bash` 路径；新 Tool 目录条目可以禁用，不能改变旧 Tool Schema 的参数含义。

### S2：Tool、Effect、Job 和 Provider 的可靠生命周期

**优先级**：P0。**前置条件**：S0、S1。**目标**：任何调用失败、超时或延迟都能形成可见节点和恢复动作。

#### 统一生命周期

```text
planned -> queued -> started -> progress*
        -> succeeded
        -> failed | timeout | cancelled | unknown
        -> reconciled | superseded
```

能力注册和外部资源另用生命周期状态表示，不能把所有失败压缩成一个 `error`：

```text
INACTIVE -> REGISTERING -> ACTIVE
ACTIVE -> RELOADING -> ACTIVE
ACTIVE -> QUIESCING -> UNREGISTERING -> INACTIVE
任何阶段 -> FAILED -> retry | reconcile | NEED_HUMAN
```

`ApplicationScope -> ProviderScope -> ProjectScope -> RunScope -> LaneScope/JobScope` 负责持有注册、订阅、AbortController、MCP transport、Sandbox、子进程、临时 Spill 和维护定时器。释放按 child-first 执行；每个 `Disposable` 幂等，单项清理失败不能阻塞其他清理，但必须汇总为可恢复记录。

#### 实现内容

- Tool/Effect/Job 都记录开始、完成、失败、超时、取消请求、实际取消和 unknown。
- 结构化错误直接映射到恢复矩阵：参数错误、工具不存在、超时、中止、权限错误、执行失败、状态未知。
- 使用 `operation + argsHash + errorSignature + generation` 形成重复检测键。
- 仅对 pure/idempotent/replay-safe 操作自动重试；unknown Effect 禁止直接重放。
- Provider scheduler 保留 stream-boundary retry，补齐 attempt、Retry-After、退避、首事件、流间空闲和 recovery required 事件。
- 观察者或 telemetry 失败时不能阻断消费者收到 terminal event。
- 对每个 pending request、Job 和 Effect 设恢复扫描，不让资源槽位永久占用。
- `Registry.register`、`EventBus.subscribe`、`McpTransport.open`、`JobScheduler.schedule`、`sandbox.start` 和 `modelProvider.openSession` 都返回或接受 Scope 持有的 `Disposable`；注册点必须同时写入撤销策略。
- Resolver 用 `providerId + providerVersion + registrationId + scopeId` 识别 binding，并在 capability 变化时发送 typed `registered/available/reloading/unavailable/unregistered` 事件；不得只比较 Provider 返回值。
- Provider 卸载先进入 `QUIESCING`，停止新绑定，通知 Consumer deactivating，待 Consumer teardown 后再删除旧 binding；多个 Provider 通过稳定 `CapabilityRouter` 路由，不让模型 Tool Schema 随后端轮换。
- Provider、MCP、Skill、workspace、routingPolicy 和 toolContract 的配置变更先经过字段级 `reconcileRuntimeConfig(previous, desired)`，只重建真正受影响的 Scope；Tool Contract 变化必须刷新 Catalog hash 和缓存纪元。
- Effect 按 `read-only`、`reversible`、`compensatable`、`irreversible` 分类；外部提交、答案提交或已发出的请求不伪造 inverse，执行前遵守确认边界，执行后保留事实和补偿入口。
- Subagent/Planner/Executor 的创建、handoff、终止、ACK、预算和回收复用同一 WorkItem、Scope、RunEvent 和 OperationRef；未声明能力、预算或权限时产生结构化失败，不隐式创建另一条运行链。

#### Provider 延迟模型

```text
queueWaitMs
connectMs
timeToFirstEventMs
timeToFirstTokenMs
interEventIdleMs
retryCount / retryDelayMs
providerTotalMs
```

Provider attempt 因 watchdog 结束不等于 Run 结束。重试上限耗尽后生成 `provider.recovery_required`，同一个 Run 选择等待、切换已允许 Provider、降级输出或请求用户输入。

#### 完成门槛

- HTTP 200 后中途断流不会泄漏重复的半截 assistant/tool 内容。
- Provider 无 terminal event 时最终释放并发槽位，留下 stalled/recovery 节点。
- Tool timeout 后不伪造成功，不盲重放未知副作用。
- Provider 替换后新调用不会复用旧 `registrationId`；旧调用在固定 binding 上完成或进入明确 unknown/reconcile。
- Consumer teardown 未结束时旧 Provider view 保持可读；同一最终配置的不同注册/卸载顺序最终产生相同 Registry 和 Projection hash。
- 同一错误重复出现时系统改变输入/范围/策略，或创建重规划 WorkItem。
- GUI 能显示 queued、started、progress、retrying、stalled、reconcile 和 completed。

#### 回滚点

保留旧 Tool/Provider 生命周期事件的兼容 reducer；新恢复器只处理拥有完整 replay policy 的调用，旧记录按保守 unknown 处理。

### S3：安全点事件循环、后台监控和用户事件

**优先级**：P0。**前置条件**：S2、PLAN-220。**目标**：从“Agent 主动轮询”变成“世界变化时唤醒同一个 Coding Lane”。

#### 实现内容

1. 在 `RunCoordinator`/`SingleAgentLoop` 增加统一 event ingress 和 bounded drain。
2. 所有用户消息、后台 Job 变化、Provider terminal、Tool end、外部回调和维护信号先 append，再在安全点消费。
3. 在现有 `run_background`、`read_job_output`、`stop_job` 基础上增加 `monitor_job` 语义：

```text
monitor_job(jobId, sinceCursor, triggers)
triggers = new_output | keyword | exit | error | heartbeat
```

4. Job 使用单调 cursor；多个输出在时间/字节窗口内合并，避免每一行唤醒模型。
5. 用户 `pause`、`resume`、`cancel` 变成高优先级事件；后台维护和 heartbeat 为低优先级。
6. 增加 coalescing：同一 Job 的连续 progress、同一维护原因和重复状态只保留最新投影，但原始事件仍可重放。
7. 当事件与当前 generation 不一致时拒绝进入当前上下文，并保留历史引用。
8. 在安全点之后自动选择 continue、retry、compact、replan、wait 或 need-human，禁止 recoverable guard 直接终止。
9. 并行 WorkItem 以统一 Verifier 确认的结果作为结算依据；`settle_once` 后向未获胜的子任务发送优雅取消，ACK 超时才进入强制回收。
10. 父 Run 取消沿 Scope/Context 级联，子任务退出前保存未完成状态并释放资源；所有 handoff 校验 generation、预算、权限和 cycle detection。

#### 快慢分离边界

快路径只做事件接收、状态投影、轻量通知和恢复选择；慢路径可以做深度分析、Evidence consolidate、跨轨迹归纳和评测。但慢路径仍是同一 Run 的维护 WorkItem，不建立第二个 Agent transcript 或第二个知识真相。

#### 完成门槛

- Provider 思考或后台 Job 执行期间到达的用户消息不会丢失。
- Job 完成/关键词命中能自动产生可见事件，不依赖模型反复调用 read。
- cancel 不会伪造不可取消 Effect 已停止；pause 后可从快照恢复。
- 第二次 recovery pass 不产生重复事件、重复 Effect 或重复 Evidence。
- 长任务中遇到上下文压力、Provider stall、Tool failure 或无进展时，Run 不静默消失。

#### 回滚点

保留现有同步调用入口作为 event ingress 的适配器；出现异常时只关闭新增事件源，不绕过现有 Run/Tool/Verifier 路径。

### S4：知识 URI、目录和 L0/L1/L2 投影

**优先级**：P1。**前置条件**：S0、S2、S3。**目标**：让模型可以按需导航知识，而不是依赖巨大动态文本。

#### 统一 URI

```text
pb://run/<runId>/task/current
pb://run/<runId>/forest
pb://run/<runId>/tree/<treeId>
pb://run/<runId>/evidence/<evidenceId>
pb://run/<runId>/fact/<factId>
pb://run/<runId>/hypothesis/<hypothesisId>
pb://run/<runId>/artifact/<artifactId>
pb://run/<runId>/artifact/<artifactId>/content
pb://run/<runId>/session/<sessionId>
pb://project/skills/<skillName>
pb://project/index
```

#### 投影模型

```ts
interface KnowledgeProjection {
  uri: string;
  kind: "task" | "forest" | "tree" | "evidence" | "fact" | "hypothesis" | "artifact" | "session" | "skill";
  runId?: string;
  generation?: number;
  sourceIds: string[];
  contentHash: string;
  knowledgeVersion: string;
  levels: { L0: string; L1: string; L2?: { uri: string; bytes?: number; truncated?: boolean } };
  links: { forward: string[]; backlinks: string[] };
  trust: "untrusted" | "observed" | "proposed" | "verified";
  stale: boolean;
}
```

#### 读取协议

```text
inspect forest L0
  -> search current task
  -> inspect selected node L1
  -> follow explicit links
  -> read Artifact L2 only when needed
```

L0/L1/L2 只表示看到多少，不表示可信程度；`proposed` 的 L0 仍然不是 `verified`。所有 URI 必须做规范化、Run/generation/scope 校验和有界读取。

#### 完成门槛

- 同一对象只有一个规范 URI，别名不会进入持久化链接或 ContextManifest。
- Forest 入口不加载原始 Artifact，默认 token 有界。
- L1 包含来源、版本、冲突和下一步，但不把 observation 变成 confirmed Fact。
- L2 读取有范围和字节限制，仍保留 Artifact hash 和不可信数据标签。
- 投影可以由当前 snapshot、事件和 Artifact 完整重建，不需要手工维护索引文件。

#### 回滚点

先提供只读 URI 解析和投影；任何物理导出都只能作为快照导出，禁用导出不会影响 ControlStore 和 ArtifactStore。

### S5：ContextBlock、P0-P10 和统一压缩

**优先级**：P1。**前置条件**：S4、S3。**目标**：降低动态内容对模型的噪声和本地重建成本，同时不破坏当前缓存语义。

#### ContextBlock

在现有 `ContextCompiler` 内部增加统一块模型：

```ts
interface ContextBlock {
  id: string;
  band: "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";
  layer: "L0" | "L1" | "L2" | "L3A" | "L3B" | "L4" | "L5" | "K0" | "K1" | "K2";
  content: string;
  required: boolean;
  volatility: "immutable" | "run_stable" | "low" | "medium" | "high" | "very_high";
  sourceIds: string[];
  contentHash: string;
  estimatedTokens: number;
  compressible: boolean;
}
```

#### 动态尾部布局

保持：

```text
System + fixed tools
  -> persisted transcript in original order
  -> P2 TaskContract
  -> P3 K0 root
  -> P4 L3A durable ledger
  -> P5/P6 runtime and selected K1
  -> P7 active controls
  -> P8 Artifact pointers
  -> P9 recent Tool placeholders
  -> P10 explicitly requested K2
```

P4 位于 P7 之前是为了本地预算和压缩优先级，不是 Provider 的分段缓存承诺。真实 Provider 缓存仍以 `cacheRead/cacheWrite` 为准。

ContextCompiler 在发送前必须先产出可重建的 `RequestEpoch`，再生成 Provider payload：

```text
Stable Context
  = system prompt
  + fixed Tool/Capability Catalog
  + provider protocol contract
  + stable scope policy

Dynamic Context
  = persisted transcript projection
  + task/runtime state
  + selected K1/L3 projection
  + Artifact/Spill previews
  + lifecycle and recovery changes
```

Provider、模型、Tool Contract 或权限策略只有在确实变化时才允许改变稳定前缀；MCP 重连、Evidence Tree 更新和 Job heartbeat 默认只更新动态部分。`requestBodyHash` 必须基于实际发送的规范请求计算，不能用编译前对象或估算值代替。

#### L3 拆分

```text
L3A durable ledger:
  confirmed/proposed/rejected reasoning, durable evidence links, long-lived blockers

L3B active controls:
  Lease heartbeat, Job progress, queue state, temporary maintenance and active handoff
```

Lease heartbeat 和 Job 状态变化不能重写 L3A。

#### 统一压缩策略

用户只选择一个 `ContextMaintenancePolicy`，其他 notice、snip、prune、compact 和 force 边界由策略派生：

```ts
interface ContextMaintenancePolicy {
  targetRatio: number;
  hardRatio: number;
  autoConsolidate: boolean;
  keepRecentTurns: number;
  selectedTarget?: "tool-results" | "recent-transcript" | "ledger" | "all";
}
```

硬保留：TaskContract、当前用户任务、未完成 Tool pair、STARTED/UNKNOWN Effect、运行中 Job、候选验证链、唯一失败诊断、Artifact URI/hash/generation、rejected hypothesis 索引。

优先压缩：大体积且已有摘要的 P9/P10、重复搜索结果、已进入 L3A 的旧原始输出、与当前任务无关的 Artifact 正文。

#### 缓存诊断

同时记录：

```text
stablePrefixHash
dynamicSuffixHash
blockHashes
firstChangedBlock
firstChangedMessage
localProjectionReuse
Provider cacheRead/cacheWrite
```

请求日志还必须保存 `RequestEpoch` 与 ContextManifest 的关联，至少可以回答“本轮使用了哪个系统提示、Tool 顺序、Provider binding、Scope policy 和 Evidence projection”。Provider 未提供 cache 字段时显示“未报告”，不显示 0 或沿用旧值。

当前模式不实现 checkpoint-prefix，除非真实 Provider 指标证明有收益。若将来实现，只能在 consolidate、compaction、明确整理或 generation reset 时更新 checkpoint。

#### 完成门槛

- 同一 snapshot 重复编译得到相同消息、块顺序和 manifest hash。
- Evidence 增加不改变 P0/P1 hash。
- Lease heartbeat 只改变 L3B，不改变 L3A。
- 相同稳定前缀的连续请求具有相同 `stablePrefixHash`；真实命中仍只以 Provider `cacheRead` 为准。
- 从事件日志、Session 和 Artifact 重建的 RequestEpoch 与原请求规范 JSON 一致，且不包含 API Key。
- P9/P10 压缩后 Tool pair、当前用户任务、unknown Effect 和 Artifact refs 仍完整。
- 动态尾部内部换序不会被报告成 Provider cacheRead 增益。
- GUI 能显示 used/available、remaining、target point、hard boundary、next action 和最大可压缩 band。

#### 回滚点

先在 ContextManifest 中旁路记录 block metadata，不改变 Provider payload；确认 hash、预算和 replay 稳定后再启用新裁剪顺序。

### S6：Evidence consolidate 与集中整理

**优先级**：P1。**前置条件**：S4、S5、S3。**目标**：把证据整理同时用作上下文压缩，但不让探索被文书工作阻塞。

#### 在线路径

每次 Tool 调用只做：

1. 原始结果写入 Artifact；
2. 写入 Tool/Effect/Job 结构化结果；
3. 有新信号时写简短 Observation/Evidence；
4. 关联 Fact、Hypothesis、Tree、WorkItem；
5. 计算是否产生 `context_rot` 或维护事件。

在线路径不要求长篇总结。

#### 集中整理触发条件

- P9/P10 达到策略目标比例；
- 新增多个 Artifact/Evidence；
- 相同 URI、命令、参数或错误重复；
- Evidence 没有被后续推理引用；
- Hypothesis 长时间无支持或反驳；
- 连续动作没有 durable progress；
- 用户明确要求整理；
- Provider/Tool 空闲且没有 urgent event。

#### consolidate 输出

```text
Knowledge result:
  L0/L1, source ids, conflicts, hypothesis changes, next action

Context result:
  replaceable message ids, placeholder, retained refs,
  before/after tokens, policy hash, projection hash
```

整理必须作为可恢复事务记录：

```text
consolidate/start
consolidate/summary
consolidate/end
```

`start` 后没有 `end` 时，启动恢复器保留旧 Context view，丢弃未完成的新摘要，重新检查 Artifact/Evidence 来源并决定 retry、reconcile 或等待。只有 `end` 同时确认新 L0/L1、source IDs、policy hash 和 projection hash 后，才能把原始 Tool Result 替换为 placeholder。这个规则与 Compaction、Sandbox 和 Effect 的操作括号共用 `OperationRef`，但不把它们合并成一个业务状态机。

Knowledge result 持久化成功后，才可以把 Provider 视图中的原始 Tool Result 替换为 placeholder。整理失败保持原视图，不产生半提交。

#### 证据软门控

```text
observation  可以低成本记录
evidence     需要来源和关系
completion   必须由统一 verifier 确认
```

证据不足只生成轻量 gap 提示并继续探索；最后的可信完成仍需要统一验证。不要因为普通探索尚未形成完整文书而停止整个 Run。

#### 完成门槛

- 三条重复 Tool 结果可以合并为带 Artifact refs 的 L1。
- 同一 consolidate 请求幂等，不产生重复 Evidence。
- 未验证 observation 不能变成 confirmed Fact 或可信 Completion。
- 原始 Tool/Provider 输出可通过 Artifact/Session URI 有界读取。
- 负面结果、失败原因和 rejected hypothesis 在整理后仍可检索。
- 进程在 `consolidate/start`、摘要生成和提交前任一节点退出，恢复后都保留旧视图且不提升草稿 Evidence。

#### 回滚点

保留原始 Tool view 和 checkpoint；只有新 L1、source IDs、policy hash 和 projection hash 一起写成功时才替换 placeholder。

### S7：持续演化、评测、发布和回滚

**优先级**：P2。**前置条件**：S0-S6、PLAN-200。**目标**：让运行经验真正改善后续行为，而不是只增长日志。

#### 更新载体选择

| 现象 | 更新载体 |
| --- | --- |
| 某类事实或行动经验稳定重复 | Knowledge K1 |
| 作用域明确、可用一句规则表达 | Skill 或局部 Prompt |
| 权限、预算、幂等、状态转换 | 程序/Harness |
| 语言风格、感知、隐式策略 | 模型评估/训练管线 |

所有更新先进入 pending proposal，不直接覆盖正式版本。Proposal 至少包含：

```text
proposalId
triggered failures
supporting and refuting traces
scope and preconditions
minimal diff
before/after hashes
trigger set
retention set
transfer set
safety set
evaluation result
approval status
rollback pointer
```

评测结果在提案提交前完成，不允许用“某一次成功”替代回归证明。每项提案至少关联触发失败集、保留集、迁移集和安全集，并分别记录 `Pass@k`、`Pass^k`、FAIL_TO_PASS、PASS_TO_PASS、成本、p95 延迟和 flaky 率。

#### 双循环

```text
Online execution:
  execute -> observe -> persist Artifact/Evidence -> continue

Maintenance/evolution:
  evaluate -> compare traces -> propose minimal diff
  -> validate -> approve -> publish or rollback
```

维护循环通过同一 Work Graph 和 ControlStore 执行，不新增第二个 Agent 真相。可以使用不同成本的模型做整理，但生成结果必须回到同一 schema、Artifact、Evidence 和审批边界。

#### Planner/Executor 与 Workflow 边界

如果评测证明需要 Planner，第一版只允许 Planner/Executor 两个具名角色：

- 两个 Lane 使用独立 Session、独立稳定前缀和独立 `RequestEpoch`；
- Planner 只输出版本化结构化计划，Executor 只接收计划、必要事实和 Evidence 投影；
- 父 Run 负责授权、暂停、取消、恢复和 child-first 收尾，Provider 必须先声明结构化输出、Tool Filter 和深度能力；
- Planner 故障时是否回落由 TaskContract/策略决定，不能隐式改变 plan-only 或等待确认语义；
- Workflow 第一版只支持顺序 phase、显式 parallel、条件 guard、agent/capability step 和 Artifact/Evidence checkpoint，定义必须是可验证数据，不能执行任意脚本。

Planner、Executor、Curator 和 Summary 都只是同一 Run 的策略或维护 Lane；它们的结果回到同一 ControlStore、Work Graph、Artifact、Evidence 和 Verifier，不产生共享的不断变化消息历史，也不产生第二套 Agent loop。

#### 指标

```text
passAtK
passConsecutiveK
failToPass
passToPass
flakyRate
firstErrorAttributionCoverage
trajectoryPrefixRepairRate
proposalAcceptanceRate
activationRate
followingRate
triggered-set gain
retention-set regression
transfer-set gain
safety delta
token/cost/latency delta
negative-result retention
trace/span completeness
handoff cycle rate
verified-winner settle latency
graceful-cancel ack rate
orphan-agent recovery rate
```

#### 完成门槛

- 提案改善触发失败集，保留集不退化。
- 新 Skill/知识在正确任务中被激活，并且模型实际遵循；三者分别计量。
- 发布失败可按 hash 回滚，回滚后 replay/projection 行为一致。
- 更新器不能修改 verifier、测试基线、审计日志或稳定版本备份。
- 被拒提案、失败轨迹和负面结果不会从长期索引中消失。
- 不支持所需 Subagent 能力时生成结构化失败，不能静默降级为另一种行为。
- Planner/Executor 的独立 Session 可以通过父 Run 暂停、取消、恢复和重放，子 Scope 先于父 Scope 释放。
- 多 Agent 只有在新增信息或独立验证带来可重复增益时才发布；否则保留单 Lane 路径，避免同质协作增加成本和共因失效。
- 并行成功竞态、优雅取消、ACK 超时、父子级联取消和超预算恢复均可重放，且不产生第二个任务真相。

#### 回滚点

发布使用版本指针而不是覆盖文件；任何正式版本都保留前一个可运行版本、来源证据、评测结果和恢复命令。

### S8：横向 Replay、doctor、文档和质量门禁

**优先级**：P0-P1 横向。**前置条件**：从 S0 开始持续建设。**目标**：确保每个阶段的收益可验证、可接管、可审计。

#### 持续执行

- 每个新增事件、Tool、ContextBlock、Knowledge Projection 和维护操作都有 replay 测试。
- 每个新增 Agent 策略都有确定性评估任务、首错归因样例、端到端和 trajectory-prefix 回归；评估器优先使用机械断言，LLM 评审必须记录版本和引用。
- 评估支持固定 Harness 的 model swap、单组件 ablation、A/B 和提示敏感性比较；关键差异记录样本量和统计不确定性。
- `proofblade doctor` 检查本地运行环境，不能成为第二套配置中心。
- Protocol Replay、Tool Replay 和 Shadow 路由使用中立轨迹格式。
- GUI/CLI/报告都从同一 RunTelemetry 和 ContextManifest 投影。
- 源码、TSDoc、API mapping、组件说明、README 和 project reports 同步维护。

#### 完成门槛

- 录制轨迹可在另一 Provider 或 deterministic lane 中重放。
- Shadow 计算不影响主 Run，不产生副作用。
- API index、component docs、change contracts、project reports 通过 CI。
- 文档只描述已交付实现或明确标注 proposal/planned，不把建议写成现状。
- 评估、Telemetry、Evidence 和多 Agent 结果都可从同一 RunEvent/Artifact/ControlStore 重建，旁路后端或 UI 不成为事实来源。

## 6. 文件级实施地图

### 6.1 Domain 与 ControlStore

```text
packages/materials/src/domain/types.ts
  RunEventEnvelope、ContextBlock、MaintenancePolicy、Projection、UpdateProposal

packages/materials/src/domain/utils.ts
  canonical hash、stable sort、版本和 ID 校验

packages/materials/src/runtime/request-epoch.ts
  实际模型请求快照、request/header、request/context、requestBodyHash

packages/materials/src/runtime/scope.ts
  Run/Lane/Job Scope、Disposable、child-first dispose 和孤儿操作索引

packages/materials/src/control/
  envelope append/reduce、idempotency、generation fencing、replay

packages/materials/src/orchestration/run-coordinator.ts
  event ingress、safe-point drain、recover/replan/wait

packages/materials/src/orchestration/run-work-scheduler.ts
  monitor、maintenance、consolidate、evaluation WorkItem
```

### 6.2 Context、Knowledge 和 Evidence

```text
packages/materials/src/context/compiler.ts
  ContextBlock、P0-P10、L3A/L3B、block hash、统一 serializer

packages/materials/src/context/maintenance-coordinator.ts
  pressure 分类、policy 派生、nextAction、safe-point compact

packages/materials/src/context/agent-pruner.ts
  band/相关性/恢复重要性裁剪、Tool pair repair

packages/materials/src/context/durable-compaction.ts
  checkpoint、placeholder、L0/L1 持久化和失败恢复

packages/materials/src/knowledge/
  pb URI parser、directory index、projection、L0/L1/L2、backlinks

packages/materials/src/evidence/
  consolidate、source coverage、冲突、负面结果、幂等整理

packages/materials/src/storage/spill-store.ts
  大 Tool Result 的不透明引用、预览、大小、hash 和有界读取
```

### 6.3 Tool、Provider 和运行时

```text
packages/materials/src/tools/catalog.ts
  glob/grep/read/edit/write/doctor/monitor 能力目录

packages/materials/src/tools/runtime.ts
  Job cursor、monitor trigger、stalled、reconcile、session cwd

packages/materials/src/tools/errors.ts
  结构化错误到恢复动作的稳定分类

packages/materials/src/runtime/solver-tools.ts
  统一 Tool proxy schema，不能按 Chat/CTF 分叉

packages/materials/src/runtime/provider-scheduler.ts
  queue、attempt、retry、stall、Retry-After、terminal event

packages/materials/src/capabilities/backend.ts
  Definition/Provider/Consumer 接缝、能力声明、availability 和 registration identity

packages/materials/src/capabilities/router.ts
  stable CapabilityRouter、Provider broker、binding fencing 和路由策略

packages/materials/src/observability/pi-events.ts
  Provider/Tool/Job/Context/maintenance telemetry

packages/materials/src/observability/telemetry-backend.ts
  capture、redaction、backend、cursor 和 Provider/进程恢复 handoff

packages/materials/src/runtime/coding-turn-projection.ts
  advisory、recoverable、replan、terminal 投影区分
```

### 6.4 GUI、CLI、文档和生成产物

```text
apps/gui/src/server.ts
  事件 SSE、消息到达、pause/resume/cancel、context policy

apps/gui/src/
  队列、Job、Provider stall、压缩点、知识 URI 和 Evidence 投影

apps/cli/src/
  doctor、inspect/search/consolidate、timeline、cost、replay、context

docs/architecture.md
docs/recovery.md
docs/gui.md
docs/tool-contract.md
docs/eval-protocol.md
README.md
  同步现状、配置、命令和统一系统边界

docs/generated/
  只通过 npm run api:index 生成，不手工编辑
```

## 7. 统一 API 和工具设计原则

### 7.1 顶层工具面保持稳定

新增能力优先接入现有代理或能力目录：

```text
固定代理：
  read / edit / write / bash
  discover_capabilities / invoke_capability
  run_background / read_job_output / stop_job
  evidence / verify_claim / report_status

通过参数或 operation 扩展：
  glob / grep / monitor / inspect / search / consolidate / doctor
```

只有当现有 Tool Contract 无法表达新的权限、输入或生命周期时，才新增顶层 schema。新增 schema 必须同步 atoms/molecules/materials、API mapping、TSDoc、测试和文档。

### 7.2 `inspect`、`search`、`consolidate` 不是第三套知识系统

建议统一为 Knowledge Projection 的访问入口：

```text
inspect(uri, level=L0|L1|L2)
search(query, scope=current-task|run|project)
consolidate(scope, target, policy)
```

它们只读取或更新现有 ControlStore/Evidence/Artifact 的投影；不能直接创建没有来源的知识文件。`consolidate` 的更新必须通过同一 Effect/Artifact/Evidence 和 WorkItem 链。

### 7.3 长任务必须用 Job，而不是伪装成同步 Tool

耗时动作返回：

```text
jobId
effectId
status
startedAt
progressCursor
artifactId?
replayPolicy
nextMonitorAt?
```

模型可以继续处理其它可独立 WorkItem；Job 完成或异常由事件循环唤醒。单个 Tool 调用只做一个清晰动作，执行后重新观察。

### 7.4 多 Agent 只扩展统一 Work Graph 的策略面

需要协作时，优先复用以下现有原语：

```text
spawn -> WorkItem/Scope -> structured handoff -> execute
      -> Artifact/Evidence -> unified verifier -> settle_once
      -> graceful cancel/ACK -> dispose or recover
```

`spawn`、`list`、`send_message`、`cancel` 和 `wait` 必须都映射为同一 RunEvent/WorkItem 状态，不能维护一份只存在于 Manager 内存中的 Agent 列表。子 Agent 返回 `workItemId`、状态、Artifact/Evidence refs、剩余预算、下一动作和恢复要求；默认不返回完整轨迹。完整轨迹通过 Artifact/Session URI 按需读取。

默认采用 Manager/Planner/Executor 的最小策略组合，只有评估证明存在信息增量时才启用并行或 Reviewer。共享文件走 Workspace 的工作副本和乐观锁；跨 Agent 的消息、预算、取消、ACK 和 winner 结算全部经过父 Run 的 Scope 和 Verifier。这样不同角色仍然是一套运行时、一套缓存诊断、一套证据链和一套回滚路径。

## 8. 上下文与缓存的专项安排

### 8.1 现阶段模式 A

```text
System + fixed tools
  -> old transcript
  -> latest user/tool interaction
  -> dynamic ProofBlade suffix
```

在此模式下：

- 动态内容统一放在尾部，避免破坏旧消息和 Tool pair；
- 动态尾部内部排序不直接改变 Provider 共同前缀；
- P0/P1 的稳定 hash 与 P2-P10 的动态 hash 分开；
- 本地可以按 block hash 做增量重建；
- Provider 命中只能依据 `cacheRead`，不能依据字符串长度或 stable hash 推断。

### 8.2 未来模式 B 的准入条件

只有同时满足以下条件，才评估 checkpoint-prefix：

1. 真实 Provider `cacheRead` 在当前模式 A 中有稳定基线。
2. 目标 Provider 对 checkpoint 前缀有明确复用行为。
3. checkpoint 更新频率足够低，不会因每个 heartbeat 使后续 transcript 全部失效。
4. Replay 和恢复可以处理 checkpoint 与 transcript 的版本关系。
5. 对成功率、延迟、成本和上下文一致性的收益大于失效代价。

### 8.3 用户可见的上下文控制

GUI/CLI 统一显示：

```text
context used / available / remaining
target compression point
hard boundary
largest compressible band
current L3A/L3B/K0/K1/K2 sizes
last consolidation
next maintenance action
stablePrefixHash / cacheRead
```

手动选择只改变 `ContextMaintenancePolicy`，不能绕过 TaskContract、权限、Verifier、Tool pair 或 unknown Effect 保留规则。

## 9. 失败恢复矩阵

| 类别 | 发现方式 | 自动动作 | Agent 是否继续 |
| --- | --- | --- | --- |
| Provider 排队过久 | queue wait p95/Deadline | 更新状态、等待或切换允许 Provider | 是 |
| Provider 流空闲 | inter-event watchdog | stream boundary retry，保留原 turn | 是 |
| Provider 无终态 | drain attempt | 合成 terminal error，写 recovery event | 是，除非无可用路径 |
| 429/5xx/连接断开 | Provider error classifier | Retry-After/指数退避/累计预算 | 是 |
| Tool 参数错误 | schema validator | 读取 schema，改参数后重试 | 是 |
| Tool 不存在 | catalog/preflight | 刷新目录或选择 Backend | 是 |
| Tool 超时 | Effect/Job state | 转后台、缩小范围或 reconcile | 是 |
| Effect unknown | journal/reconcile | 禁止盲重放，等待确认 | 是 |
| Job 卡死 | monitor heartbeat/idle | 写 stalled，尝试 stop/reconcile | 是 |
| 上下文溢出 | ContextCompiler | snip/prune/consolidate/compact | 是 |
| 上下文腐化 | repeat/no-progress/ignored evidence | evidence consolidate/replan | 是 |
| Evidence 不完整 | source coverage | 写 gap，继续观察 | 是 |
| 任务目标冲突 | TaskContract/user event | 暂停并请求用户确认 | 等待 |
| 不可恢复权限/环境 | preflight/reconcile | `NEED_HUMAN`，保留恢复入口 | 可恢复等待 |

## 10. 测试安排

### 10.1 单元和契约测试

- Event envelope canonical hash、版本兼容、generation fencing 和 idempotency。
- ContextBlock 稳定排序、block hash、P0-P10 变化传播和 L3A/L3B 分离。
- URI 规范化、越界、过期 generation、scope 和 L0/L1/L2 访问。
- Tool Contract、结构化错误、错误分类和恢复动作。
- Job cursor、关键词匹配、退出、心跳、重复 progress 合并。
- Provider attempt 缓冲、idle watchdog、retry、terminal event 和 slot release。
- Evidence consolidate 幂等、来源闭包、冲突、负面结果和失败回滚。
- RequestEpoch 实际请求重建、`requestBodyHash`、`stablePrefixHash`、Tool Catalog hash 漂移和敏感字段脱敏。
- Definition/Provider/Consumer 版本解析、availability、priority、binding identity、依赖变化通知和循环检测。
- Disposable/Scope 的 LIFO、child-first、重复 dispose、部分初始化 inverse、Consumer teardown 和 Provider quiescing。
- Tool canonical value、model presentation、Artifact/Spill 三态一致性，以及 Spill 失败时的受控回退。
- `operation/start` 无 `end` 的孤儿扫描，Compaction、Curation、Effect、Sandbox、MCP reconnect 和 Subagent 的恢复选择。
- 评估任务五元组解析、独立验证器、FAIL_TO_PASS/PASS_TO_PASS、flaky 检测、Pass@k/Pass^k 和统计报告。
- FailureAttribution 的首错定位、主因/次因、owner、可恢复性和证据引用；端到端与 trajectory-prefix 回归保持一致。
- `settle_once` 同时成功竞态、优雅取消 ACK、ACK 超时兜底、父子 Scope 级联取消、预算耗尽和孤儿 Agent 恢复。
- structured handoff 的 generation/权限/预算校验、访问链 cycle detection、共享 Workspace 乐观锁和跨文件语义冲突。

### 10.2 Provider-free 运行时场景

至少加入以下场景：

```text
user message during provider stream
job completion during model reasoning
urgent cancel on non-cancellable effect
generation reset with stale event
crash and queue rebuild
duplicate event delivery
provider HTTP 200 mid-stream failure
provider stream without terminal event
tool timeout with unknown effect
large tool output and artifact placeholder
monitor keyword trigger
context pressure with successful compact
context pressure with consolidate failure
rejected hypothesis after compaction
evidence gap without forced stop
proposal regression on retention set
skill accepted but not activated
request epoch reconstruction after process restart
provider replacement with old binding teardown
provider dependency unavailable and reactivation
scope disposal after partial registration
orphan compaction/curation recovery
spill persistence failure with canonical result retained
telemetry backend failure without main-loop failure
unsupported subagent capability with explicit error
parallel candidates with one verified winner
parallel candidates with simultaneous verified winners
winner settle followed by graceful cancellation ACK
forced cleanup after cancellation ACK timeout
parent cancellation cascading to child Scopes
handoff generation mismatch and cycle detection
shared workspace optimistic-lock conflict
cross-file semantic conflict after parallel edits
homogeneous agents with no information gain
budget exhaustion with replan or NEED_HUMAN
rollback and replay parity
```

### 10.3 集成和 GUI 测试

- Chat、CTF、Fixture、Competition 创建的 Run 使用相同 Event/Tool/Evidence/Completion 类型。
- SSE 连接断开后，GUI 可从 `/events` 或 Run snapshot 恢复，不丢失节点。
- Provider queued/stalled/retry/reconcile 状态有可见投影。
- 手动压缩点只修改维护策略，不修改任务契约。
- 删除或替换 dynamic suffix 后，历史 transcript 和 Artifact 仍可查看。
- 长 Job 期间用户新消息进入同一 Run，未创建后台私有 transcript。
- GUI 能从 RequestEpoch 显示实际 Provider、模型、Tool Catalog、Context Manifest 和前缀变化来源，但不显示敏感配置。
- Provider/Consumer 的激活、停用、重载和孤儿恢复都能在同一事件时间线解释，不依赖 GUI 私有状态。
- 多 Agent 的私有 scratchpad、共享 Workspace、外部挂载和内置只读资源具有清晰投影；并行编辑冲突、winner、取消 ACK 和 child-first dispose 可见。
- Manager/Planner/Executor 之间只显示结构化 handoff 与 Artifact/Evidence 引用；用户可以按 URI 查看完整轨迹，但默认上下文不复制子 Agent 原始输出。

### 10.4 评测指标

每个版本至少报告：

```text
completion success / verified success
evidence-backed success
replay parity
candidate leak count
Provider request count
queue wait / p95 provider latency
tool failure / timeout / unknown counts
time to first evidence
context tokens and compression count
stable prefix drift and Provider cacheRead
duplicate action ratio
context rot signals
activation/following rate
Pass@k / Pass^k
FAIL_TO_PASS / PASS_TO_PASS
flaky rate and first-error coverage
trajectory-prefix repair rate
handoff cycle / orphan recovery rate
verified winner settle latency / cancel ACK rate
cost and safety regressions
```

## 11. 每阶段发布流程

每个阶段都遵循相同流程，避免实现和验证分裂：

```text
1. 在现有源码和 API index 中确认没有重复原语。
2. 先补 domain contract 和失败路径测试。
3. 实现单一 ControlStore/Work Graph 路径。
4. 添加 provider-free replay/scenario。
5. 更新 TSDoc、API mapping、组件文档和用户文档。
6. 运行 reports:project，确认 project-status 同步。
7. 运行 typecheck/build/targeted tests/CI gates。
8. 在真实 Provider 上单独测 cacheRead、延迟和成本，不把外部数据混入本地门禁。
9. 观察一段时间后再扩大启用范围。
10. 保留旧 projection/replay 兼容和明确 rollback pointer。
```

推荐的合并粒度：每个阶段拆成若干小 PR，但所有 PR 都继续落在同一个统一系统中。不要把“事件系统”“压缩系统”“证据系统”分别实现成独立运行时。

## 12. 项目状态和文档同步要求

每次完成阶段都要更新同一个 `project-status.json`：

- plan：目标、依赖、交付物和验收条件；
- update：实际变更、分支、提交、验证命令和结果；
- completion：只有通过门槛后才能记录完成；
- maintenance：记录缓存、上下文、Evidence、恢复和生命周期复查。

治理文档变更后必须执行：

```powershell
npm run reports:project
npm run check:project-reports
```

公共源码或 TSDoc 变更后必须执行：

```powershell
npm run api:index
npm run api:index:check:all
npm run api:duplicates:all
```

完整合并前至少执行：

```powershell
npm run typecheck
npm run build
npm run test:ci-gates
npm test
npm run eval -- --enforce-gate
npm audit --omit=dev
```

真实 Provider 的缓存命中、延迟和费用报告单独执行，并保留 Provider、模型、endpoint、配置 hash 和成本信息，不能用 provider-free 结果替代。

## 13. 优先级总表

| 顺序 | 阶段 | 优先级 | 主要价值 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | S0 基线/契约/观测 | P0 | 后续可解释和可回滚 | 无 |
| 2 | S1 搜索/读写/doctor/命令预检查 | P0 | 降低无效 Tool 回合 | S0 |
| 3 | S2 Tool/Job/Provider 生命周期 | P0 | 消除失败静默和资源卡死 | S0/S1 |
| 4 | S3 安全点事件循环/monitor | P0 | 支持长期运行和外部唤醒 | S2/PLAN-220 |
| 5 | S4 Knowledge URI/L0-L2 | P1 | 让信息按需可导航 | S0/S2/S3 |
| 6 | S5 ContextBlock/压缩 | P1 | 降低动态上下文噪声和本地成本 | S4/S3 |
| 7 | S6 Evidence consolidate | P1 | 在低打扰下完成集中整理 | S4/S5/S3 |
| 8 | S8 Replay/doctor/门禁横向完善 | P0-P1 | 保护每阶段质量 | S0 起持续 |
| 9 | S7 持续演化 | P2 | 让经验实际改善后续行为 | S0-S6/PLAN-200 |
| 10 | checkpoint-prefix、世界模型、多模态 | P2/P3 | 只有实测收益后再投入 | S5/S8 |

## 14. 最终 Definition of Done

本整合计划全部完成时，系统应达到以下状态：

1. 用户、Provider、Tool、Job、外部回调、定时器和维护都通过一个可重放事件模型进入同一个 Run。
2. 事件在安全点消费，Tool pair、Effect、generation 和权限边界不被打乱。
3. Tool 失败、Provider 延迟、Job 卡死、unknown Effect 和上下文压力都会产生明确节点、自动恢复动作和用户可见状态。
4. 普通 Chat、CTF、Fixture、Competition 使用同一套 Coding Lane、Evidence、Completion、ContextCompiler 和恢复路径。
5. 知识通过 `pb://` URI 访问，L0/L1/L2 控制内容深度，trust 与访问深度严格分离。
6. 动态上下文仍位于 transcript 尾部；P0-P10 只作为确定性本地布局和维护优先级，不虚构 Provider KV Cache 收益。
7. Evidence 整理可以在没有新思路时集中执行，并能把大 Tool Result 转成可恢复 placeholder；原始 Artifact 永久可检索。
8. 证据门控不会阻塞正常探索，可信 Completion 仍只能由统一 verifier 确认。
9. Prompt、Skill、知识、程序或模型更新都经过评价、独立验证、保留集回归、版本发布和回滚。
10. 所有收益都能通过 replay、telemetry、provider-free scenario 和真实 Provider 指标分别证明。
11. 评估任务具备 Dataset、Environment State、Tools、Rubric 和 Interaction Protocol 五元组，结果同时覆盖 Pass@k、Pass^k、FAIL_TO_PASS、PASS_TO_PASS 和 flaky 检查。
12. 生产失败能够定位首错并回流为端到端和 trajectory-prefix 回归；Trace/Span、Artifact 和 Evidence 引用可以重建归因。
13. 多 Agent 仅作为同一 Work Graph 的可选策略；winner 结算、优雅取消、ACK、级联回收、预算和 handoff 循环都由同一 ControlStore/Scope/Verifier 管理。

最终目标不是让上下文越来越复杂，而是让系统在长时间运行中保持：状态可见、失败可恢复、信息可导航、压缩可回滚、证据可追溯、缓存事实可测量，并且所有模式仍然只有一套系统。
