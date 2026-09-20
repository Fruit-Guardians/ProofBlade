# ProofBlade 基于第 7 章的 Agent 评估与消融实验开发计划

状态：设计阶段，尚未修改运行时代码

本文档依据 [《AI Agents in Depth》第 7 章：Agent 的评估](https://bojieli.github.io/ai-agent-book/book/chapter7) 编写，并结合 ProofBlade 当前的 [评测协议](eval-protocol.md)、[统一 Agent 开发计划](UNIFIED_AGENT_DEVELOPMENT_PLAN_ZH.md) 和 [消融实验开发计划](ABLATION_EVALUATION_DEVELOPMENT_PLAN_ZH.md) 落地。

本文档的目的不是再创建一套独立的评测系统，而是规定如何把第 7 章的方法收敛到现有的：

```text
任务数据集 -> 可重置环境 -> 单 Agent Coding Lane
         -> Control Store / Artifact / Evidence
         -> 独立 Verifier -> 轨迹、指标、失败归因
         -> 消融比较 -> 下一轮改进
```

## 1. 结论摘要

第 7 章最重要的结论有六条，必须成为实现约束：

1. 评估对象是“模型与 Harness 的组合”，不能只看模型名称或最后一段回答。
2. 任务必须同时定义初始状态、可用工具、成功标准和交互终止协议，否则结果不可重复。
3. `Pass@k` 衡量在多次尝试中至少成功一次的能力上限，`Pass^k` 衡量连续可靠性，二者不能混为一个“成功率”。
4. 确定性 Verifier 应优先于 LLM 评审；模型评审只能补充开放式质量维度，不能绕过状态验证、证据验证或安全检查。
5. 端到端回归用于发现整体退化，trajectory prefix 回归用于定位首个错误的决策边界；二者都要持久化。
6. 消融、模型替换、AB、多臂比较和提示词敏感性评估必须可复现、可配对、可统计，并且能将结果转化为下一项可验证改动。

本项目的具体实现原则是：

- 单 Agent 是唯一启用的执行路径。
- 多 Agent 只预留实验字段、接口和数据格式，不创建并行执行分支。
- Harness 的认知辅助功能可以消融。
- 生成隔离、权限、凭据、代次隔离、幂等、恢复、预算、取消、Verifier 和候选答案防泄漏属于固定安全与正确性边界，不允许用普通消融开关关闭。
- 真实实验允许使用用户提供的 Provider Key，并允许每个实验选择 Provider、具体模型、思考等级、采样参数和预算；Key 只能进入本地凭据配置或进程环境，不能进入实验记录、事件、Artifact、Evidence、日志、截图和报告。
- 结果必须显示“改了什么、没有改什么、观察到了什么、证据支持到什么范围”，不能用一次成功轨迹代替结论。

## 2. 第 7 章到 ProofBlade 的映射

| 第 7 章概念 | ProofBlade 对应物 | 本次开发要求 |
| --- | --- | --- |
| 评估任务 | Fixture、TaskContract、Scenario Catalog | 统一为可版本化、可重置、可验证的任务记录 |
| 数据集 | Fixture Catalog、公开集、自建集、生产失败回流集 | 明确训练/开发/触发/保留/迁移/安全分区，防答案泄漏 |
| 环境状态 | Fixture、workspace、Coding Lane、Verifier session | 每次 Attempt 在独立 run/generation 中从确定初态开始 |
| Agent 工具 | Tool Contract、Capability、MCP、后台 Job | 记录工具目录、Schema、策略哈希和完整生命周期 |
| 用户模拟器 | 可选的交互环境或逐步信息提供器 | 与 Agent 知识边界分开建模，不能预先泄漏全部答案 |
| Rubric | TaskContract、Verifier、Evidence 规则、可选评审器 | 确定性检查优先，开放式维度单独统计 |
| Interaction Protocol | RunCoordinator、事件 ingress、结束条件 | 记录每个事件、轮次、暂停/取消、超时和终止原因 |
| Pass@k | 同一用例的至少一次通过 | 用于探索能力上限，不作为生产可靠性结论 |
| Pass^k | 同一任务连续 k 次全部通过 | 用于稳定性、回归和关键动作可靠性 |
| Best@k | 同一任务多次运行的最佳得分 | 只报告探索场景，必须同时报告所有尝试分布 |
| 确定性验证器 | CodingClaimVerifier、Fixture scorer、Completion gate | 终态和关键动作由独立验证器判定 |
| LLM-as-a-Judge | 新增的可选评审层 | 只评开放式质量，必须记录评审模型与校准结果 |
| 失败归因 | FailureAttribution、RunTelemetry、首错事件 | 区分模型、Harness、工具、Provider、环境、Verifier |
| trajectory prefix | 冻结到某事件的 Run 前缀重放 | 只验证下一步选择，不重新跑完整任务 |
| 模型替换 | 固定 Harness、替换 Provider/model | 与 Harness 消融分开标记和分析 |
| 消融开关 | Harness Policy Snapshot | 单因素改变，策略哈希进入 Run 与报告 |
| AB/多臂实验 | Experiment、Variant、Pairing、Attempt | 支持配对随机、交错运行和分组统计 |
| 提示词敏感性 | System Prompt / Tool Prompt Snapshot | 同配置确定性渲染，哈希变化可定位到具体块 |
| 内部评估 | 持久化实验工作区、指标和回流任务 | 将失败归因转成新回归用例和下一项假设 |
| 仿真环境 | Fixture + reset + verifier + 可控工具 | 先支持评估级吞吐和确定性，再考虑训练级吞吐 |

## 3. 目标与非目标

### 3.1 目标

本功能交付后，开发者应能回答以下问题：

1. 同一个模型在当前 Harness 下是否比裸模型或较弱 Harness 更好？
2. 上下文裁剪、RAG、Receipt、Recall、Evidence 整理、信息价值估计和停止策略各自贡献多少？
3. 某项功能提升的是最终成功率、证据质量、成本、延迟，还是只改变了中间过程？
4. 同一个 Harness 换模型后，提升是否仍然存在？
5. 某次失败最早发生在哪个决策边界，模型当时看到了什么，Harness 做了什么选择？
6. 一项改动是否只在少数用例上有效，是否损害了其他能力或固定护栏？
7. 真实 Provider 请求是否使用了声明的模型、版本、采样参数和策略快照？
8. 结果在中断、重启、重试、上下文压缩和恢复后是否仍可重建？

### 3.2 非目标

本阶段不做以下事情：

- 不把全部实验结果直接塞进模型上下文。
- 不在同一项实验中同时改变模型、系统提示、工具 Schema、RAG 算法和预算后声称得到单因素因果结论。
- 不把 LLM 评审分数当作任务完成判定。
- 不通过关闭安全边界来制造“裸模型”结果。
- 不启用多 Agent 并行、Manager/Worker 竞速或跨 Run 共享工作区。
- 不自动根据一次实验结果修改生产 Prompt、Skill、Tool 或 Verifier。
- 不把真实 Key 写入 JSON 配置、命令行历史、事件流、Artifact、截图或错误消息。
- 不用 `model: "auto"` 作为正式实验的模型身份。

## 4. 评估对象：模型、Harness 与固定边界

### 4.1 三层实验对象

每个 Attempt 必须将配置拆成三个快照：

```text
ModelSnapshot       = Provider + concrete model + reasoning + sampling + model metadata
HarnessSnapshot     = prompt + skills + tools + context policy + RAG policy + evidence policy
SafetySnapshot      = verifier + permission + generation fence + budget + recovery + redaction
```

其中：

- `ModelSnapshot` 用于模型替换实验。
- `HarnessSnapshot` 用于 Harness 消融实验。
- `SafetySnapshot` 默认固定，任何变化都必须进入单独的安全/正确性回归，不得与普通能力消融混淆。

同一个模型允许对应多个 Harness Variant，因此不能再用 Provider Profile 指纹判断两个 Variant 必然不同。应分别计算：

```text
modelFingerprint
harnessFingerprint
safetyFingerprint
experimentFingerprint
```

正式 Harness 消融要求 `modelFingerprint` 和 `safetyFingerprint` 相同，只允许 `harnessFingerprint` 改变。正式模型替换要求 `harnessFingerprint` 和 `safetyFingerprint` 相同，只允许 `modelFingerprint` 改变。

### 4.2 可消融的 Harness 因子

下列因素可以作为实验因子，前提是每次只改变一个主要因素：

| 因子 | 中文显示名 | 示例水平 | 主要假设 |
| --- | --- | --- | --- |
| `context_selection` | 上下文选择 | 全量、确定性裁剪、查询感知裁剪 | 减少无关信息可降低成本而不损害成功率 |
| `receipt` | 工具结果回执 | 直接结果、最小回执、结构化回执 | 小型回执能保留行动所需信息并降低上下文占用 |
| `recall` | 按需回忆 | 关闭、精确路径、混合检索 | 需要时读取持久结果能减少重复工具调用 |
| `rag` | 持久知识检索 | 关闭、确定性检索、向量检索 | 外部持久知识能改善长任务和跨轮恢复 |
| `evidence_curation` | 证据整理 | 原始、去重、带冲突保留、验证器筛选 | 结构化证据能减少遗漏和错误提交 |
| `information_value` | 信息价值估计 | 关闭、启发式、后验增益、决策价值 | 只获取高价值信息能提高有效动作比 |
| `repeat_guard` | 重复与无进展检测 | 关闭、提醒、阻断 | 能减少重复读取和同一错误循环 |
| `stop_policy` | 停止策略 | 固定预算、证据覆盖停止、价值阈值停止 | 在证据充分后停止可降低尾部成本 |
| `tool_status` | 工具状态反馈 | 无、单条状态、聚合状态面板 | 工具状态可见性可降低模型等待和误判 |
| `prompt_variant` | 提示词版本 | 基线、单块增删、顺序变化 | 定位系统提示对行为的敏感性 |
| `skill_loading` | Skill 加载 | 全部常驻、元数据常驻、按需正文 | 延迟加载可降低常驻上下文成本 |

### 4.3 固定安全与正确性边界

以下功能无论 Variant 如何配置都必须存在：

- 工作区边界、路径校验、网络与权限策略。
- API Key 脱敏、候选答案防泄漏、敏感 Artifact 引用保护。
- Run/generation fencing、Fixture reset、Effect Journal 和幂等键。
- Tool Contract Schema 校验、资源租约、超时、取消和恢复。
- 硬 Token/时间/成本/进程/磁盘预算。
- 暂停、取消、人工批准和危险动作前确认。
- 独立 Verifier、Evidence 关联、Completion gate 和失败终态。
- 事件序列、审计日志、原始 Artifact 哈希和可重放记录。

如果需要研究某个安全边界是否会造成性能损失，应建立单独的“安全故障注入实验”，输出安全回归报告，不能将其标记为普通 Harness 消融。

## 5. 任务定义协议

第 7 章中的任务五元组在 ProofBlade 中必须完整表达：

```text
Dataset
Environment State
Tools
Rubric
Interaction Protocol
```

建议的中文配置结构如下，字段名作为稳定机器协议保留，所有界面标签和错误提示使用中文：

```json
{
  "taskId": "fixture-web-001",
  "title": "中文任务标题",
  "datasetSplit": "holdout",
  "difficulty": "medium",
  "initialState": {
    "fixtureId": "web-source-1",
    "resetCommand": "fixture_reset",
    "stateHash": "sha256:..."
  },
  "agentInstruction": "不包含答案的任务说明",
  "knownInformation": ["任务开始时模型确实可以看到的信息"],
  "hiddenInformation": ["只能通过合法工具或用户交互获取的信息"],
  "tools": {
    "agent": ["read", "bash", "evidence", "knowledge"],
    "environment": ["assert_state", "respond_progressively"]
  },
  "rubric": {
    "requiredStateAssertions": ["..."],
    "requiredActions": ["..."],
    "requiredEvidenceKinds": ["..."],
    "forbiddenEvents": ["..."],
    "rewardBasis": "verified_state_and_evidence"
  },
  "interactionProtocol": {
    "maxTurns": 40,
    "maxWallTimeMs": 600000,
    "termination": ["verified_completion", "budget_exhausted", "cancelled"]
  }
}
```

### 5.1 信息边界

每条任务应显式区分：

- 初始可见信息：进入首轮模型上下文前已知的内容。
- 工具可得信息：只有调用特定 Tool 后才可见的内容。
- 用户可得信息：必须由 Agent 询问或引导用户执行操作才能获得的内容。
- 隐藏验收信息：Verifier 使用但模型不能直接读取的目标状态或答案。
- 禁止泄漏信息：候选答案、评分脚本、隐藏文件、秘密参数和测试预期。

任务文案不能暗示隐藏字段，测试 Fixture 不能通过文件名、日志路径、错误文本或 Tool Schema 透露答案。

### 5.2 难度标签

每个任务至少包含以下标签：

```text
single_turn / multi_turn
stateless / stateful
tool_free / tool_use / sandbox
direct_observation / progressive_disclosure
low / medium / high / adversarial
evidence_light / evidence_required / evidence_conflict
short_context / long_context / recovery_required
```

报告必须按标签分层，不能只给全量平均值。RAG、信息价值和上下文消融尤其要覆盖 `long_context`、`progressive_disclosure`、`evidence_conflict` 和 `recovery_required`。

## 6. 评估指标体系

### 6.1 结果指标

每个 Attempt 至少产生以下结果：

| 指标 | 含义 | 计算要求 |
| --- | --- | --- |
| `verified_success` | 统一 Verifier 确认完成 | 不能由 Agent 自述决定 |
| `evidence_backed_success` | 成功且关键结论有可追溯证据 | 证据引用、来源和验证关系完整 |
| `Pass@k` | k 次中至少一次通过 | 报告任务级和总体值 |
| `Pass^k` | 连续 k 次全部通过 | 明确 k、顺序和是否独立重置 |
| `Best@k` | k 次中的最高分 | 只用于探索上限，不能代替稳定性 |
| `failure_rate` | 失败比例 | 按失败类别分解 |
| `flaky_rate` | 相同配置重复结果不稳定的比例 | 至少有重复 Attempt 才能计算 |
| `forbidden_action_rate` | 触发禁止动作的比例 | 任意一票否决项单独记录 |

若每次独立成功率为 (p)，则：

```text
Pass@k = 1 - (1 - p)^k
Pass^k = p^k
```

运行器不得把 `Pass@k` 转换成“平均成功率”，也不得把“某次成功”写成系统已经可靠。

### 6.2 过程指标

过程指标必须与结果指标同时报告：

- 首个有效动作时间。
- 首个有效证据时间。
- 首个候选生成时间。
- 总轮数、模型请求数、工具调用数、有效工具调用数。
- 重复调用次数、重复阻断次数、无进展轮数。
- Recall 命中率、Receipt 命中率、持久 Artifact 读取次数。
- 输入 Token、输出 Token、推理 Token、缓存读取 Token、缓存写入 Token。
- Provider 排队、执行、重试、恢复和总墙钟时间。
- 证据去重数、冲突保留数、引用完整率、来源闭包率。
- 上下文压缩次数、主动遗忘次数、恢复读取次数。
- 暂停、取消、超时、预算耗尽和人为批准次数。

### 6.3 机制指标与目标指标

实验配置必须将指标分成两类：

**机制指标**：实验直接改变或预期影响的量，例如回执字节数、检索候选数、常驻上下文 Token、提示词长度、Recall 次数。

**目标指标**：真正决定是否采用该功能的量，例如 Verified Success、Evidence-backed Success、成本、p95 延迟、错误率和用户可接受的交互轮数。

机制指标改善但目标指标不改善时，不能宣布实验成功。例如 Receipt 变短不等于任务更好；RAG 命中增加不等于模型正确使用了检索内容。

### 6.4 护栏指标

任何 Variant 只要出现以下情况之一，默认标记为不可发布：

- `verified_success` 下降超过预设非劣效界限。
- `evidence_backed_success` 下降或关键证据遗漏增加。
- 禁止动作、越权访问、候选泄漏、错误代次写入或恢复不一致增加。
- p95 墙钟时间或成本超过预算上限。
- 取消、暂停、重启后出现未回收 Job、未完成 ingress 或错误终态。
- 结果对 Provider 瞬时错误、运行顺序或随机种子过度敏感。

## 7. 实验类型与设计

### 7.1 单因素消融

标准流程：

```text
定义假设
 -> 选择一个主因素
 -> 固定 ModelSnapshot 和 SafetySnapshot
 -> 生成 Control 与 Treatment
 -> 预检
 -> 随机交错运行配对任务
 -> 验证并归档轨迹
 -> 统计差异和失败归因
 -> 形成下一轮假设
```

每个消融 Variant 必须声明：

- `factor`：改变的唯一主因素。
- `controlValue` 与 `treatmentValue`。
- 预期改善的目标指标。
- 可能变差的护栏指标。
- 适用的任务标签。
- 不支持推断的范围。
- 回滚方式。

### 7.2 模型替换

模型替换固定 Harness，只替换 ModelSnapshot。至少要支持：

- 同一 Provider 的不同具体模型。
- 不同 Provider 的兼容模型。
- 思考等级和最大输出配置的单独比较。
- 采样参数的单独比较。

正式实验必须记录 Provider 返回的模型身份、响应能力、上下文限制和实际用量。`model: "auto"` 仅允许交互探索、探针或本地开发，不允许进入正式对比报告。

### 7.3 AB 与多臂实验

第 7 章建议多臂而不是只做“有/无”。ProofBlade 应支持：

- 两臂配对：Control 对 Treatment。
- 三臂或多臂剂量实验：例如提示约束弱、中、强。
- 任务级随机化：同一任务的不同 Attempt 交错分配。
- Provider 级分层：避免某个 Provider 总是运行在某个时段。
- 每个会话最多记录一次 Feature Exposure，避免重复曝光污染统计。

多臂结果先做总体检验，再做经校正的两两比较。若样本量不足，只输出探索性结果，不做部署结论。

### 7.4 提示词敏感性

每次 Provider 请求前保存渲染快照的结构化哈希，不保存敏感提示正文到报告：

```text
systemStaticHash
systemDynamicHash
developerHash
toolSchemaHash
skillCatalogHash
taskBlockHash
contextSelectionHash
```

需要支持：

1. 指定 Git revision 渲染最终提示词。
2. 对一个 Prompt block 做增删、替换和排序实验。
3. 检查相同配置是否确定性渲染。
4. 将首个行为差异映射到发生变化的提示块。
5. 将提示词变化与 Token、缓存和成功率变化分开报告。

### 7.5 trajectory prefix 回归

当完整任务失败时，保存首错前的最小前缀：

```text
Run generation
TaskContract hash
ModelSnapshot hash
HarnessSnapshot hash
SafetySnapshot hash
visible context manifest
tool contracts
observations and artifacts refs
last verified state
next decision boundary
```

前缀回归从冻结状态恢复，只请求模型做下一步决策，不重新执行已经验证过的工具调用。它用于回答：

- 模型是否看到了支持正确决策的证据？
- Receipt 或 RAG 是否遗漏了关键内容？
- Harness 是否把无关内容放在更显眼的位置？
- 工具错误是否提供了可恢复信息？
- 当前策略是继续获取信息、回滚、澄清，还是提交？

前缀回归不是完整任务成功率，报告必须单独命名和统计。

## 8. RAG、Receipt 与信息论功能的专门实验

### 8.1 RAG 不是单一开关

RAG 实验至少拆成四个独立层次：

1. 持久化：工具原始结果是否写入 Artifact/Knowledge。
2. 表示：模型上下文中返回原文、摘要、Receipt 还是稳定引用。
3. 检索：按路径、关键词、结构化字段、确定性相关性或向量召回。
4. 使用：模型是否主动 Recall，Recall 后是否正确改变下一步行动。

建议第一批 Variant：

| Variant | 中文配置 | 目的 |
| --- | --- | --- |
| `R0` | 直接把完整 Tool Result 放入上下文 | 过程基线，成本可能很高 |
| `R1` | 只返回 Artifact/Knowledge 路径 | 测试路径引用是否足够 |
| `R2` | 路径加结构化 Receipt | 测试最小行动摘要 |
| `R3` | Receipt 加精确 Recall | 测试按需读取 |
| `R4` | 确定性检索 Broker | 测试可复现的自动召回 |
| `R5` | 查询感知裁剪与证据去重 | 测试信息密度和无重复输入 |
| `R6` | 向量召回试验 | 只有在 R0-R5 有明确瓶颈时启用 |

每个 RAG Variant 必须同时测量：召回命中、Recall 后的模型采纳、错误召回、关键证据遗漏、重复读取、输入 Token、首证据时间和最终验证结果。只看“召回率”不足以证明 RAG 有用。

### 8.2 信息价值实验分层

信息论相关功能不能都叫“信息增益”。实现中应明确区分：

| 层次 | 中文名称 | 适合回答的问题 | 实现状态要求 |
| --- | --- | --- | --- |
| `none` | 不估计价值 | 没有选择机制时的基线 | 必须支持 |
| `heuristic` | 启发式信息价值 | 简单相关性是否比盲目读取好 | 允许作为工程基线 |
| `deterministic_gain` | 确定性增量 | 新证据是否增加覆盖、减少冲突或缩小候选 | 优先实现 |
| `posterior_eig` | 后验期望信息增益 | 观测后不确定性期望下降多少 | 需要明确概率模型 |
| `decision_voi` | 决策价值 | 信息是否改变下一步最优动作和结果 | 需要动作结果模型 |
| `verified_uplift` | 验证器支持的实际收益 | 获取该信息是否提高后续验证成功 | 需要历史实验数据 |

当前代码中若存在返回 `[0,1]` 的 `calculateInformationGain()`，不得直接标注为熵、互信息或 EIG。报告必须显示其真实语义为“启发式分数”，直到补齐概率空间、候选动作、先验和后验定义。

### 8.3 价值估计的最小接口

```ts
type InformationCandidate = {
  candidateId: string;
  sourceRef: string;
  expectedCost: number;
  expectedLatencyMs: number;
  expectedRisk: number;
  affectedClaims: string[];
  availableActions: string[];
};

type InformationValueEstimate = {
  candidateId: string;
  method: "none" | "heuristic" | "deterministic_gain" | "posterior_eig" | "decision_voi" | "verified_uplift";
  score: number;
  uncertainty?: number;
  selected: boolean;
  reason: string;
  estimatorVersion: string;
};
```

该接口是内部协议，界面统一显示中文：估计方法、分数、置信范围、预计成本、选择结果和选择理由。

### 8.4 是否主动遗忘

“主动遗忘”不能物理删除原始证据。正确语义是：

```text
原始 Artifact 永久保留
 -> Context Manifest 移除大块正文
 -> 写入可验证 Summary/Receipt
 -> 保留 sourceRef、contentHash、evidenceRefs
 -> 允许按需 Restore/Recall
```

主动遗忘实验需要比较：

- 不遗忘。
- 达到上下文阈值后自动压缩。
- 模型或用户显式请求归纳后压缩。
- 验证器确认无关后移出当前上下文。
- 错误压缩后能否恢复原始内容并修复决策。

核心指标不是“上下文变小了多少”，而是“在减少上下文的同时，关键证据遗漏率是否增加、错误恢复是否可用”。

## 9. Verifier、Rubric 与 LLM 评审

### 9.1 验证层级

评分器按可信度分层：

1. **状态断言**：文件、数据库、Fixture、进程、协议状态等机器可验证状态。
2. **动作断言**：关键 Tool、Effect、提交、回滚和审批是否发生。
3. **证据断言**：结论是否引用已存在 Artifact，来源是否可追溯，冲突是否被保留或解释。
4. **格式断言**：输出是否符合目标 schema、作用域和字段要求。
5. **Rubric 评审**：清晰度、帮助性、沟通质量、解释质量等开放式维度。
6. **LLM-as-a-Judge**：只作为第 5 层的自动化辅助，并需要校准集和人工抽检。

前四层失败时，LLM 评审不能覆盖结果。LLM 评审失败时，必须区分“任务失败”和“开放式质量未评定”。

### 9.2 Judge 协议

可选 Judge 运行必须独立于被测 Agent 的主要轨迹：

- 输入为脱敏的任务、必要上下文、候选输出和证据引用。
- Judge 不能看到隐藏答案或尚未公开的 Verifier 实现细节。
- 每个维度使用自包含 Rubric，禁止只给“整体感觉分”。
- 保存 Judge Provider、具体模型、版本、提示词哈希和采样参数。
- 报告 Judge 与人工标注的相关性、一致率、偏差和拒评率。
- Judge 结果不能写入 `verified_success`，只能写入 `quality_scores`。

### 9.3 失败首错归因

每个失败必须尽量产生：

```json
{
  "attemptId": "AT-...",
  "firstIncorrectEventId": "EV-...",
  "failureStage": "decision|tool|context|evidence|verification|environment",
  "owner": "model|harness|tool|provider|environment|verifier",
  "severity": "P0|P1|P2|P3",
  "knownEvidenceAtDecision": ["pb://..."],
  "omittedEvidence": ["pb://..."],
  "expectedNextAction": "...",
  "actualAction": "...",
  "recoverable": true,
  "prefixRef": "pb://run/.../prefix/..."
}
```

归因必须根据事件、状态和 Evidence 引用完成，不能只根据模型最后的自我解释判断。

## 10. 真实 Provider、Key 与模型选择

### 10.1 用户选择模型

消融工作区必须提供以下中文操作：

- 选择 Provider Profile。
- 选择具体模型。
- 选择思考等级。
- 设置温度、Top-p、最大输出和并发数。
- 查看 Provider 能力探针结果。
- 查看预计成本和预算。
- 锁定模型快照。

创建正式实验后，模型选择不可静默变化。若 Provider 返回的模型身份、上下文限制或能力与快照不一致，Attempt 应进入 `MODEL_DRIFT`，而不是继续合并统计。

### 10.2 Key 来源

按优先级支持：

1. 已保存的本地 Provider Profile。
2. 环境变量，例如 `OPENAI_API_KEY` 或用户配置的自定义变量名。
3. 一次性进程凭据，不持久化到项目。

实验配置只保存：

```json
{
  "providerProfileId": "profile-local-1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "credentialPresent": true,
  "credentialSource": "profile|environment|transient"
}
```

禁止保存：Key 明文、Authorization Header、完整请求 URL 中的凭据、Provider 错误中的请求头、屏幕截图中的密钥和完整错误上下文。

### 10.3 真实实验确认门

正式运行必须经过两步：

1. `preflight`：检查任务、模型、预算、凭据存在性、Provider 能力、数据集分区和安全边界；默认不发送题目内容。
2. `allow-live` 或 GUI 中文确认：明确即将产生真实 Provider 请求、预计次数、预算和模型。

预检失败不产生 Provider 题目请求。探针模式只允许访问模型元数据接口，不能把真实任务内容发送出去。

## 11. 实验配置与持久化

### 11.1 实验配置示例

```json
{
  "experimentId": "AB-20260831-RAG-001",
  "name": "Receipt 与完整工具结果比较",
  "language": "zh-CN",
  "purpose": "判断结构化回执能否在不降低验证成功率的前提下减少上下文",
  "dataset": {
    "catalogId": "baseline-v4",
    "splits": ["holdout", "recovery"],
    "taskIds": ["fixture-web-001", "fixture-reverse-002"],
    "excludeAnswerLeak": true
  },
  "model": {
    "providerProfileId": "profile-local-1",
    "model": "具体模型名称",
    "thinkingLevel": "medium",
    "temperature": 0,
    "maxTokens": 8192,
    "cacheRetention": "long"
  },
  "safety": {
    "policy": "baseline-safety-v1",
    "allowDisable": false
  },
  "variants": [
    {
      "id": "control",
      "labelZh": "完整工具结果",
      "factor": "receipt",
      "value": "direct"
    },
    {
      "id": "treatment",
      "labelZh": "结构化回执与按需读取",
      "factor": "receipt",
      "value": "receipt_plus_recall"
    }
  ],
  "sampling": {
    "attemptsPerTask": 5,
    "pairing": "task_seed_interleaved",
    "seeds": [11, 23, 37, 41, 59],
    "maxTurns": 40
  },
  "stopping": {
    "mode": "verified_or_budget",
    "maxWallTimeMs": 900000,
    "maxCost": 20
  },
  "report": {
    "includeTrajectory": true,
    "includeRawToolOutput": false,
    "includeJudge": false
  }
}
```

### 11.2 持久化对象

```text
ExperimentDefinition
ExperimentSnapshot
VariantDefinition
TaskAssignment
AttemptRecord
ModelSnapshot
HarnessSnapshot
SafetySnapshot
ExposureRecord
RunReference
MetricRecord
FailureAttribution
JudgeRecord
ComparisonRecord
ExperimentReport
```

所有对象都必须带：

- `schemaVersion`。
- `createdAt`、`updatedAt`。
- `experimentId`、`variantId`、`taskId`、`attemptId` 的关联。
- 配置规范化哈希。
- Run/generation 引用。
- 数据来源和分区。
- 是否真实 Provider、Provider/model 身份。
- 可恢复状态和最后事件序号。

### 11.3 原始数据与摘要

报告默认只展示中文摘要和引用：

```text
报告 -> Attempt 摘要 -> Run/Trace -> Artifact/Evidence -> 原始内容
```

原始 Tool Result 不应被重复复制到每一层。报告中的每个数字都应能回到机器可读的 `MetricRecord`，每个失败结论都应能回到 `FailureAttribution` 和 prefix 引用。

## 12. 执行器设计

### 12.1 生命周期

```text
创建实验
 -> 规范化配置
 -> 预检
 -> 锁定模型与 Harness 快照
 -> 生成任务配对
 -> 创建独立 Run/generation
 -> 执行 Attempt
 -> 完成 Verifier
 -> 写入指标与归因
 -> 释放资源
 -> 汇总报告
```

### 12.2 任务配对

同一任务的 Control 和 Treatment 应尽量共享：

- 相同任务内容和版本。
- 相同初始状态哈希。
- 相同模型配置，除非是模型替换实验。
- 相同预算与终止规则。
- 不同随机种子按预先声明的映射分配。

带副作用的任务必须每次独立 reset，不能把 Control 的文件、Cookie、进程、缓存或 Evidence 带入 Treatment。

### 12.3 失败分类

执行器把失败分为：

```text
CONFIG_INVALID
PREFLIGHT_FAILED
CREDENTIAL_MISSING
MODEL_DRIFT
PROVIDER_ERROR
PROVIDER_TIMEOUT
TOOL_ERROR
TASK_TIMEOUT
BUDGET_EXHAUSTED
SAFETY_VIOLATION
VERIFIER_FAILED
ENVIRONMENT_RESET_FAILED
RECOVERY_FAILED
HARNESS_POLICY_ERROR
UNKNOWN
```

配置、凭据、Provider、环境和 Harness 基础设施失败不得直接作为模型失败计入；报告要分别展示“可归因失败”和“不可解释失败”。

### 12.4 恢复与重试

实验执行器必须支持：

- 在 Attempt 之间重启进程后继续。
- 从最后一个持久事件恢复，而不是从内存状态恢复。
- Provider 超时按声明策略重试，并区分同一次请求的重试与新 Attempt。
- Tool 结果已经持久化但模型请求未完成时，恢复后不能重复产生副作用。
- generation reset 后拒绝旧任务、旧 ingress、旧 Effect 和旧 completion。
- 无法确认的运行状态标记为 `UNKNOWN`，不能伪装成成功或正常结束。

## 13. 可观测性与中文报告

### 13.1 实时状态

GUI 的“消融实验”工作区显示：

- 实验名称、状态、数据集、模型和思考等级。
- Variant 中文名称与固定因素。
- 已分配任务数、已完成 Attempt、运行中 Attempt、等待 Provider 数。
- 已成功、已失败、待恢复、模型漂移和预检失败数量。
- 当前预算、预计剩余成本和墙钟时间。
- 每个 Run 的工具、Artifact、Evidence、Verifier 和上下文摘要。
- 失败首错、归因类型和 trajectory prefix 入口。

界面只显示 Key 是否存在，不显示 Key 内容。实时状态应从持久化事件重建，不能只依赖前端内存。

### 13.2 中文报告章节

报告固定包含：

1. 实验目的与假设。
2. 实验范围、数据集分区、任务数量和排除规则。
3. Provider、具体模型、思考等级、采样参数和快照哈希。
4. Control/Treatment 的唯一变化。
5. 结果指标、过程指标、机制指标和护栏指标。
6. Pass@k、Pass^k、Best@k、flaky 和样本量。
7. 成本、Token、缓存、延迟和资源消耗。
8. 失败归因、首错事件和 prefix 回归结果。
9. RAG/信息价值/压缩的命中、使用、遗漏和恢复情况。
10. 统计不确定性、配对差异和适用范围。
11. 是否支持进入下一轮实验、扩大样本、部署或回滚。
12. 未完成项、数据质量问题和下一步假设。

### 13.3 报告结论模板

```text
结论等级：探索性 / 有条件支持 / 支持扩大复测 / 支持发布 / 不支持

本实验只改变：...
模型与安全边界保持：...
主要目标指标变化：...
护栏指标变化：...
最强证据来源：...
首错归因是否改变：...
结论可以推广到：...
结论不能推广到：...
下一步需要验证：...
```

## 14. 统计与决策规则

### 14.1 阶段划分

实验分三阶段：

1. **冒烟阶段**：每个 Variant 1-2 个任务，验证配置、Provider、reset、记录和报告链路。
2. **探索阶段**：覆盖任务难度和标签，寻找可能有价值的因素，允许较宽松的统计结论。
3. **确认阶段**：固定假设、扩大保留集、增加重复次数，判断是否值得发布或进入更大规模复测。

冒烟阶段不能生成部署结论，确认阶段不能临时改变目标指标、任务分区和失败排除规则。

### 14.2 推荐分析

按实验类型选择：

- 二元任务结果：配对差异、McNemar 检验、Wilson 区间。
- 连续成本/延迟：中位数、p50/p95/p99、配对 Bootstrap 区间。
- 多臂实验：总体检验、校正后的两两比较、剂量效应曲线。
- 多任务多次运行：按任务聚合，并使用任务作为随机效应或分层 Bootstrap。
- 模型和 Harness 交互：报告 `model × harness` 交互，不把差异错误归因给单一因素。
- Judge 与人工标签：一致率、相关性、分歧样例、分层偏差。

### 14.3 不允许的结论

- 不能由一次成功或一次失败证明某组件有用或无用。
- 不能只比较平均 Token 而忽略成功率和证据覆盖。
- 不能只比较 Pass@k 而忽略 Pass^k、flaky 和一票否决项。
- 不能将 Provider 断线、reset 失败、Key 缺失当成模型能力退化。
- 不能把一个任务上的结果推广到所有任务类型。
- 不能把 Judge 的偏好分数当作环境事实。

## 15. 分阶段实现计划

### P0：协议和快照边界

交付：

- `ExperimentDefinition`、`VariantDefinition`、`AttemptRecord` 类型。
- Model/Harness/Safety 三类 Snapshot 和独立指纹。
- 单因素校验、组合实验标记和安全边界拒绝。
- 中文错误码、中文预检结果和配置规范化。
- 实验状态机与持久化事件。

重点测试：

- 相同模型不同 Harness 可以合法创建。
- 不同模型但声明 Harness 消融会被拒绝或标记错误。
- 关闭 Verifier、generation fence、凭据脱敏等安全边界会被拒绝。
- 配置重排后规范化哈希稳定。
- 中断后实验状态和 Attempt 状态可重建。

### P1：评估执行与配对账本

交付：

- 任务五元组加载和校验。
- Fixture reset、独立 Run/generation 和任务分配。
- Control/Treatment 交错调度。
- Provider Profile、具体模型、思考等级和预算锁定。
- Provider 能力探针和 `allow-live` 确认门。

重点测试：

- 同一任务的配对 Attempt 具有相同初态哈希。
- reset 失败不会被计为模型失败。
- `model: "auto"` 在正式实验中被拒绝。
- 缺少 Key 时不发送题目内容。
- Provider 模型身份漂移会停止该 Attempt 并生成中文原因。
- 真实请求与声明的模型、采样参数和快照一致。

### P2：指标、验证和轨迹

交付：

- Verified Success、Evidence-backed Success、Pass@k、Pass^k、Best@k。
- Token、缓存、成本、延迟、工具和证据过程指标。
- FailureAttribution 和首错事件。
- Attempt 级完整 Run 引用和 Artifact/Evidence 引用。

重点测试：

- Verifier 未通过时模型文本不能产生成功。
- Pass@k 与 Pass^k 在已知样本上计算正确。
- 失败分类不会把 Provider 错误错误归为模型失败。
- 同一事件可重放且指标不重复累计。
- 首错前缀能准确冻结到目标事件。

### P3：RAG、Receipt、Recall 与上下文消融

交付：

- R0-R6 RAG Variant。
- 工具结果 Artifact 化、Receipt、Recall、Restore 和压缩策略。
- RAG 命中、采纳、遗漏、冲突和重复读取指标。
- 上下文 Manifest 与模型实际可见内容的审计。

重点测试：

- 原始 Artifact 永久可恢复，主动遗忘只移除当前上下文正文。
- Receipt 引用的 Artifact、Evidence 和 contentHash 一致。
- 重复 Recall 不导致上下文线性复制。
- 错误召回不会替代更高优先级证据。
- 压缩后 prefix 回归能恢复被移出的关键内容。
- 工具返回过大时模型可见部分有明确上限，完整内容仍可按路径读取。

### P4：信息价值和自适应停止

交付：

- 启发式、确定性增量、后验 EIG、决策 VOI 的接口隔离。
- 候选信息成本、风险、预期收益和选择理由。
- “获取信息”和“正确使用信息”两个指标。
- 价值阈值停止、证据覆盖停止和固定预算对照。

重点测试：

- 各估计方法不会互相冒充语义。
- 选择理由与实际候选排序可重建。
- 低价值信息不会因排序不稳定被优先执行。
- 停止后仍保留必要证据和可恢复状态。
- 误停止可以通过回放识别，不能伪装成成功。

### P5：trajectory prefix 与失败归因

交付：

- 首错候选、最小前缀、决策边界和预期动作记录。
- 只请求下一步决策的 prefix runner。
- 模型、Harness、Tool、Provider、Environment、Verifier 的归因。
- 失败案例一键转为回归任务草案。

重点测试：

- prefix 不会重复执行已有副作用 Tool。
- prefix 的可见上下文与原 Attempt 一致。
- 归因依据包含事件和证据引用。
- 回归任务不携带隐藏答案。
- 原始失败与 prefix 结果都能在报告中关联。

### P6：中文 GUI 与 CLI

交付：

- 中文实验创建、模型选择、预检、运行、暂停、恢复、报告和导出。
- 实时显示任务、Variant、Attempt、Provider 和预算状态。
- 中文过滤：成功、失败、首错、RAG 命中、证据遗漏、模型漂移。
- 报告打开原始 Run、Artifact、Evidence 和 prefix。

建议命令：

```text
proofblade ablation list
proofblade ablation create <实验配置>
proofblade ablation preflight <实验编号> [--probe]
proofblade ablation init <实验编号>
proofblade ablation run <实验编号> --allow-live
proofblade ablation status <实验编号>
proofblade ablation pause <实验编号>
proofblade ablation resume <实验编号>
proofblade ablation report <实验编号> --markdown
proofblade ablation prefix <实验编号> <失败编号>
proofblade ablation export <实验编号> <输出路径>
```

CLI 名称遵循现有稳定协议，所有帮助文本、参数说明、状态值说明和错误消息使用中文。

重点测试：

- GUI 与 CLI 创建出的实验快照规范化后相同。
- 新建实验不必等待所有历史事件或完整报告加载完成。
- 状态页面显示的是持久化状态，不是前端缓存的旧状态。
- 暂停、恢复和取消在重启后仍然有效。
- 导出的报告不包含 Key、Authorization Header 或隐藏答案。

### P7：LLM 评审、AB 与持续回流

交付：

- 可选 Judge、Rubric、人工校准和偏差报告。
- 多臂实验和曝光去重。
- 生产失败轨迹脱敏回流为触发集或 prefix 集。
- 实验结论生成下一轮假设和回归任务草案。

重点测试：

- Judge 不可直接修改 Completion。
- 同一会话 Feature Exposure 最多一条。
- 失败轨迹脱敏后不含 Key、答案和隐藏评分逻辑。
- 回流任务保留首错证据但不泄漏最终答案。
- 报告明确区分探索性结论和确认性结论。

## 16. 开发者测试与用户真实实验的边界

开发阶段测试与用户之后的真实问题测试用途不同：

| 类型 | 目的 | 数据 | 是否可替代真实实验 |
| --- | --- | --- | --- |
| 单元测试 | 校验类型、公式、状态机和哈希 | 固定小样本 | 不能 |
| 协议测试 | 校验 reset、事件、恢复和配对 | 合成 Fixture | 不能 |
| 离线评测 | 校验确定性基线和回归 | 本地任务集 | 不能 |
| Provider 连接测试 | 校验真实模型配置和请求协议 | 用户提供 Key，可只做探针 | 不能 |
| 冒烟消融 | 校验实验链路可运行 | 少量任务 | 不能 |
| 确认性消融 | 比较功能因果贡献 | 保留集、多次采样 | 不能替代用户真实问题 |
| 用户真实问题测试 | 检查实际工作流价值和体验 | 用户真实任务 | 是最终产品判断的重要证据 |

代码测试要证明“系统确实按协议工作”；用户的真实问题测试要证明“协议和功能解决了用户真正遇到的问题”。二者都要保留，不能用其中一种代替另一种。

## 17. 性能与可靠性要求

本系统本身不能成为新的慢点，尤其要针对当前反馈中的“读文件慢、上下文到固定节点后反复读取、启动加载慢、证据整理不可见”建立实验运行时指标：

- 创建实验、读取实验状态和查看报告摘要不应等待全部历史 Artifact 加载。
- 实验列表先返回持久化索引，再异步加载详情。
- 单个 Tool Result 进入模型上下文前必须有可见上限和溢出引用。
- 所有大结果先持久化，再返回 Receipt/路径；原文通过明确 Recall 获取。
- 多个并行或后台 Tool 以聚合状态追加到上下文尾部，不能阻塞当前 Agent 等待每个原文。
- 每个异步任务显示排队、运行、已完成、失败、待消费和待恢复状态。
- 报告先显示指标和错误摘要，点击后才读取完整轨迹。
- RAG 和信息价值估计本身记录耗时、候选数量、命中率和额外 Token。
- 任何“减少上下文”的方案都要报告它是否增加了 Recall 次数和总墙钟时间。
- GUI 初始启动只加载实验索引和最近状态，完整事件、Artifact 和历史报告延迟加载。

建议新增性能指标：

```text
experiment_list_ready_ms
experiment_detail_ready_ms
preflight_ms
first_attempt_start_ms
first_status_update_ms
artifact_register_ms
receipt_build_ms
recall_ms
context_compile_ms
report_summary_ready_ms
report_full_trace_ready_ms
```

## 18. 验收标准

功能达到可进入真实实验阶段前，必须满足：

1. 可用中文创建包含至少两个 Variant 的实验。
2. 可以选择已配置的 Provider、具体模型和思考等级。
3. 正式实验拒绝 `model: "auto"`，并锁定 ModelSnapshot。
4. 同模型不同 Harness 能够合法运行并正确形成配对账本。
5. 每个 Attempt 都能关联 Run、generation、ContextManifest、Tool、Artifact、Evidence 和 Verifier 结果。
6. `Pass@k`、`Pass^k`、Best@k、成本、Token、延迟和 flaky 指标计算正确。
7. 失败能看到首错事件、可见证据、缺失证据、预期动作和归因。
8. RAG/Receipt/Recall/压缩实验能保留原始数据并支持恢复。
9. 信息价值实验能区分启发式、确定性增量、后验 EIG 和决策 VOI。
10. 真实 Key 不出现在实验文件、事件、Artifact、Evidence、日志、报告、截图和 API 返回中。
11. 重启、暂停、恢复、取消和 generation reset 不会产生跨代次副作用。
12. GUI 与 CLI 的实验定义、状态和报告一致。
13. CI 包含各实现阶段的聚焦测试，且完整评测通过后才允许扩大真实实验。
14. 最少完成一轮真实 Provider 的冒烟实验，并在报告中明确标记为真实请求而非模拟。

## 19. 首批建议实验矩阵

第一轮不要同时研究所有因素。建议按以下顺序缩小问题：

| 实验 | Control | Treatment | 目的 |
| --- | --- | --- | --- |
| E1 | 当前基线 Harness | 只增加 Receipt | 判断结构化结果是否降低上下文 |
| E2 | Receipt | Receipt + 精确 Recall | 判断路径读取是否减少重复 Tool |
| E3 | Receipt + Recall | 加确定性 Evidence 整理 | 判断证据组织是否改善提交质量 |
| E4 | 当前上下文 | 查询感知裁剪 | 判断减少上下文是否影响首错和成功率 |
| E5 | 无信息价值 | 启发式信息价值 | 判断选择信息是否减少无效动作 |
| E6 | 启发式信息价值 | 验证器支持的实际收益 | 判断启发式是否与真实收益一致 |
| E7 | 固定预算停止 | 证据覆盖停止 | 判断自适应停止是否降低尾部成本 |
| E8 | 同一 Harness + 模型 A | 同一 Harness + 模型 B | 区分模型瓶颈与 Harness 瓶颈 |
| E9 | 基线 Prompt | 单块 Prompt 修改 | 识别提示词敏感性 |
| E10 | 完整任务回归 | 首错 prefix 回归 | 验证失败定位是否降低分析成本 |

每个实验先做冒烟，再扩展到至少 20 个任务或有明确理由的分层子集；确认阶段建议每个任务每个 Variant 至少 3-5 次 Attempt，具体次数由成本预算和任务副作用决定。

## 20. 实施顺序建议

推荐执行顺序：

```text
先完成 P0/P1 的协议、快照、配对和真实模型选择
 -> 再完成 P2 的指标、Verifier 和首错归因
 -> 用 E1/E2 验证 Receipt/Recall
 -> 用 E3/E4 验证 Evidence 与上下文裁剪
 -> 再实现 P4 的信息价值和停止策略
 -> 最后接入 Judge、AB、多臂和持续回流
```

这样做的理由是：如果没有稳定的 Model/Harness/Safety 边界、独立 reset、可重放事件和首错归因，RAG 或信息论实验即使出现分数变化，也不能判断变化来自哪里。

本计划的完成标志不是“消融开关数量多”，而是能对一项改动给出可审计的因果证据：

```text
固定了什么
改变了什么
模型当时看到了什么
模型之后做了什么
环境状态如何变化
Verifier 如何判定
结果差异有多大
差异是否稳定
下一步该扩大、修改、回滚还是放弃
```
