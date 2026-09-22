# ProofBlade 真实模型消融实验功能更新开发计划

> 状态：开发计划 / 待实现。
>
> 编写日期：2026-08-31。
>
> 关联研究：[信息论上下文与 RAG 研究证据总结](INFORMATION_THEORETIC_CONTEXT_RAG_RESEARCH_ZH.md)、[持久化上下文与 RAG 开发计划](PERSISTENT_CONTEXT_RAG_DEVELOPMENT_PLAN_ZH.md)、[评测协议](eval-protocol.md)。
>
> 本文只规划功能，不代表功能已经实现，也不代表任何 Harness、RAG 或信息论策略已经被证明有效。

## 1. 目标

为 ProofBlade 增加一套中文可操作、支持真实 Provider、可选择模型、可重复比较的消融实验系统，用于回答以下问题：

1. 当前 Harness 的哪些机制真正提高了已验证成功率？
2. 哪些机制只是增加提示词、阻止探索或延迟模型动作？
3. 持久化 Artifact、Receipt、Recall 和 Evidence Broker 是否比直接注入完整 Tool Result 更有效？
4. 信息价值、去重、压缩和自适应停止是否能减少 Token、时间和重复 Tool，同时不损失 Evidence？
5. 这些收益是否来自 Harness 策略本身，而不是模型、Provider、题目、预算或随机顺序差异？

最终用户应当能够：

- 在 GUI 中选择 Provider 配置、具体模型和思考等级；
- 选择一个中文实验方案或创建自定义实验方案；
- 使用用户自己提供的真实 API Key 执行真实模型实验；
- 明确看到每个 Variant 的运行状态、成功/失败、Token、费用、耗时、Tool、Evidence 和阻断信息；
- 比较基线与实验组，并看到配对结果、置信区间、失败分类和实验有效性警告；
- 中断后继续实验，不重复计入已经完成的 Attempt；
- 导出不包含 Key、答案明文和敏感请求内容的中文报告。

## 2. 设计结论

### 2.1 消融实验不是普通回归测试

普通测试回答“代码是否按预期运行”。消融实验回答“去掉一个机制后，模型行为和最终结果如何变化”。因此必须同时保存：

```text
相同题目 + 相同模型 + 相同预算 + 相同验证器
                    |
             只改变一个因素
                    |
        配对比较成功率、成本、证据和延迟
```

不能把 Provider 更换、模型更换、题目更换和 Harness 更换放在同一个 Variant 中，然后把差异归因于 Harness。

### 2.2 Harness 的两类职责

实验系统必须把 Harness 行为分成两类：

**可以消融的认知辅助策略**：

- 首次动作建议或硬门；
- 阶段路线建议或硬门；
- Action Bundle；
- 重复/无进展提示和终止策略；
- 上下文候选排序；
- Receipt、Recall 和自动 Evidence 整理；
- 信息价值估计；
- 自适应停止建议；
- Tool 导航、结果摘要和状态提示。

**不能通过消融关闭的安全与正确性边界**：

- 工作区、网络、权限和用户授权范围；
- Secret 隔离；
- generation fencing；
- Effect、Lease、幂等和崩溃恢复；
- 真实费用和资源硬上限；
- 用户暂停、取消和审批；
- Tool Schema 校验和结果完整性；
- 独立 Verifier 对 Completion 的最终判定；
- 候选答案不进入事件日志和非授权 Artifact 的规则。

消融系统可以比较“安全范围内更自由或更受引导的模型探索”，不能通过关闭安全边界制造不可审计的实验。

### 2.3 单 Agent 优先

本计划只实现单 Agent 真实实验。多 Agent 只预留 `agentTopology`、`delegationPolicy` 和 `sharedKnowledgePolicy` 字段，不启用、不创建第二条解题 Lane，也不把多 Agent 结果与单 Agent 结果混合比较。

## 3. 当前基础与缺口

### 3.1 可以直接复用的基础

当前仓库已经具备：

- `FixtureEvaluationRunner` 和 `RealModelEvaluationRunner`；
- `eval-real` 多 Variant 入口；
- 27 个本地 Holdout 与六类本地 Fixture；
- 每个 Case 多次 Attempt；
- Fixture 重置、答案隔离、语料哈希和候选泄漏检查；
- 独立 Verifier、Completion、Evidence Graph 和 Replay parity；
- Provider 请求、Token、成本、Tool、Effect、Evidence、首个 Evidence 时间和失败分类遥测；
- GUI Provider Profile、模型发现、Key 本地保存和会话级模型选择；
- Context Manifest、ArtifactStore、Evidence 检索、Compaction 和持久化运行记录。

这些基础足以避免另起一套求解器或评分器。

### 3.2 当前缺口

需要增加：

1. 中文消融实验定义和配置校验；
2. 同一 Provider/模型下只切换 Harness Policy 的 Variant 机制；
3. 真实 Key 的安全预检、模型选择和请求确认；
4. 首次动作、阶段路线、重复阻断和上下文选择的可配置策略；
5. “模型请求了什么、Harness 做了什么、为什么做、结果如何”的决策遥测；
6. RAG 和信息论策略的候选、评分、压缩和召回遥测；
7. 交错或分层运行、配对结果和统计置信度；
8. 实验中断、恢复、重试和失败后续跑；
9. 中文 GUI、CLI、机器可读报告和状态面板；
10. 实验中的费用保护、脱敏和结果导出。

当前 `eval-real` 要求不同 Variant 具有不同 Provider Profile 指纹，这适合 Provider 对比，但不适合严格的 Harness 消融。新实现应把“模型指纹”和“策略指纹”拆开，允许模型指纹相同、策略指纹不同。

## 4. 核心概念

### 4.1 实验

一个实验是不可变的研究计划，包含：

- 实验编号、中文名称、研究问题和假设；
- 语料库及其哈希；
- Provider Profile 和具体模型；
- 思考等级、采样参数、上下文窗口和输出预算；
- 全局时间、费用、请求、Tool 和提交限制；
- Variant 列表及每个 Variant 的策略差异；
- Attempt 数量、运行顺序种子和统计方法；
- 实验创建时的 Prompt、Tool、Skill、MCP、Runtime 和 Verifier 版本快照。

实验创建后，语料、模型身份、公共预算和 Variant 策略不可静默修改。需要修改时创建新的实验版本。

### 4.2 Variant

Variant 是在公共实验条件下运行的一组策略。每个 Variant 必须声明：

- 稳定 ID；
- 中文显示名称；
- 研究假设；
- 相对于基线改变的因素；
- 策略配置哈希；
- 是否为基线；
- 允许的模型覆盖项；
- 与公共条件的差异说明。

严格消融要求一个实验中每个 Variant 只改变一个主要因素。多因素组合可以存在，但必须标记为 `组合实验`，不能当作单因素因果证据。

### 4.3 Case、Attempt 和配对单元

- `Case`：一个不泄漏答案的任务样本。
- `Attempt`：一个 Case 在一个 Variant 下的一次独立运行。
- `配对单元`：同一 Case、同一 Attempt 编号或同一固定随机分组下的不同 Variant 结果。

比较成功率时，应优先使用同 Case 配对差异，而不是只比较所有运行的平均值。

### 4.4 Provider Profile、Key 和模型

Provider Profile 是用户本地保存的连接配置。实验只保存：

- Profile ID；
- Provider 名称；
- API 类型；
- Base URL 或端点模式；
- 模型名称；
- 模型发现时间和模型列表哈希；
- Key 是否存在；
- Key 环境变量名或本地配置引用；
- 请求参数和定价快照。

实验、事件、Artifact、日志、报告和导出文件中禁止保存 Key 明文、Authorization Header、完整 URL 中的 Token、答案明文和未脱敏 Provider 请求体。

## 5. 实验配置设计

### 5.1 中文功能界面与稳定机器字段

GUI 标签、说明、警告、状态、表格、报告和错误信息全部使用中文。内部事件类型、JSON 字段、命令参数和哈希协议可以使用稳定 ASCII 标识，以保持 API、重放和跨平台兼容。

中文名称不能替代稳定 ID。名称可以修改，实验 ID、Variant ID、Case ID 和策略哈希不能因显示名称变化而改变。

### 5.2 建议配置结构

下面是逻辑结构示例，不是当前可直接执行的配置文件：

```json
{
  "schemaVersion": 1,
  "experimentId": "AB-20260831-001",
  "name": "Receipt 与直接 Tool 结果比较",
  "question": "持久化 Receipt 和按需 Recall 是否提高证据支持成功率？",
  "corpus": {
    "path": "fixtures/private-holdout/manifest.json",
    "hash": "由系统计算"
  },
  "model": {
    "profileId": "relay-a",
    "model": "用户选择的具体模型",
    "thinkingLevel": "high",
    "sampling": {
      "temperature": 0.2,
      "seed": 17
    }
  },
  "budget": {
    "attempts": 5,
    "maxTurns": 12,
    "maxCostUsd": 20,
    "deadlineMs": 600000
  },
  "variants": [
    {
      "id": "baseline",
      "name": "完整结果基线",
      "baseline": true,
      "changedFactor": "none",
      "policy": {}
    },
    {
      "id": "receipt-recall",
      "name": "Receipt 加按需 Recall",
      "baseline": false,
      "changedFactor": "context_delivery",
      "policy": {
        "contextDelivery": "bounded_receipt_recall"
      }
    }
  ],
  "runOrder": {
    "mode": "交错",
    "seed": 17
  }
}
```

实际实现必须再次校验所有字段，不能信任实验文件中自称的“基线”“信息增益”或“真实模型”标签。

### 5.3 Harness Policy

建议将以下策略配置为明确的三态或多态，而不是隐含布尔值：

| 策略 | 建议取值 | 含义 |
| --- | --- | --- |
| 首次动作 | `硬门` / `软建议` / `关闭` | 是否阻止首次非预期 Tool |
| 阶段路线 | `硬门` / `软建议` / `关闭` | 是否限制模型跨阶段探索 |
| Action Bundle | `硬门` / `软建议` / `关闭` | 是否把准备好的动作包变成约束 |
| 重复失败 | `硬停` / `提示` / `记录` | 是否阻止重复失败动作 |
| 实验断路器 | `硬停` / `自适应` / `提示` / `关闭` | 如何处理长时间、超时和同族实验 |
| 上下文选择 | `固定最近` / `Receipt` / `确定性 Broker` | 如何选择注入内容 |
| Recall | `手动` / `建议` / `按需自动` | 是否辅助模型取回 Artifact |
| Evidence 整理 | `手动` / `建议` / `自动生成草稿` | 是否生成结构化整理草稿 |
| 信息价值 | `关闭` / `启发式` / `已验证提升` / `PMI` / `posterior EIG` | 使用哪种估计器 |
| 压缩 | `关闭` / `有界摘要` / `问题相关压缩` / `率失真实验` | 如何压缩 Tool Result |
| 停止建议 | `关闭` / `软建议` / `Verifier 驱动` | 是否提示模型停止探索 |

`posterior EIG` 只有在显式 Hypothesis、先验和结果分布存在时才允许选择。当前规则化 `[0,1]` 分数必须标识为启发式，不能显示为已校准信息增益。

### 5.4 不可关闭的安全策略

以下配置不进入普通消融因子列表，界面显示为“固定安全边界”：

```text
workspaceScope = enforced
secretIsolation = enforced
generationFence = enforced
effectJournal = enforced
userCancellation = enforced
costHardCap = enforced
verifierCompletion = enforced
candidateLeakCheck = enforced
```

如果未来确实需要测试安全机制本身，必须创建单独的安全故障注入测试，不得把它与模型能力消融混用。

## 6. 真实 Provider、Key 和模型选择

### 6.1 真实实验必须显式确认

真实 Provider 实验必须使用显式 `--allow-live` 或 GUI 的“开始真实实验”确认。界面在开始前显示：

- Provider 名称和端点；
- 具体模型；
- Attempt 总数；
- 预计最大请求数；
- 费用上限；
- 是否会发送真实任务内容；
- 结果保存位置；
- Key 不会进入实验文件和报告的说明。

未确认时只能执行配置预检、离线 Fixture 或 Provider-free 框架测试。

### 6.2 模型选择流程

GUI 和 CLI 都应支持：

1. 选择一个已有 Provider Profile；
2. 从 Profile 已发现的模型列表中选择具体模型；
3. 对不支持模型发现的端点手工填写模型名；
4. 选择思考等级；
5. 选择可用的上下文窗口和输出上限；
6. 显示模型是否支持温度、随机种子、缓存和推理参数；
7. 运行一次不含任务答案的连接预检；
8. 将最终接受的模型参数写入实验快照。

`model: "auto"` 只能用于交互探索，不能用于正式消融实验，因为实际加载模型可能在实验期间变化。正式实验必须记录具体模型名称和 Provider 返回的模型身份。

### 6.3 Key 来源和生命周期

支持的 Key 来源按优先级建议为：

- GUI Provider Profile 中的本地用户配置；
- 用户指定的环境变量；
- 仅当前进程有效的临时输入。

禁止：

- 将 Key 放在实验 JSON；
- 将 Key 放在命令行参数；
- 将 Key 写入 `runs/`、Artifact、Event、Prompt、报告或截图；
- 将完整 Provider 请求转储到共享实验目录；
- 在错误信息中回显 Authorization Header。

实验结束后，报告只显示 `hasApiKey`、Provider ID 和脱敏连接状态。用户删除 Profile 时，已完成报告仍可读取，但不得恢复出 Key。

### 6.4 Provider 变动保护

如果 Provider 返回的模型身份、上下文窗口、定价、API 版本或端点行为与预检快照不一致，系统应：

- 默认暂停实验；
- 把变化标记为 `provider_drift`；
- 不把后续结果静默并入原实验；
- 允许用户明确创建新实验版本后继续。

## 7. 第一批消融方案

### 7.1 Harness 自由度实验

第一批建议使用同一个具体模型、同一个 Profile、同一个语料和同一个预算：

| Variant | 中文名称 | 变化 |
| --- | --- | --- |
| A | 当前严格策略 | 当前行为，作为基线 |
| B | 认知策略软建议 | 首次动作、阶段路线、Action Bundle 和重复策略改为建议 |
| C | 仅安全硬边界 | 关闭认知型硬门，保留权限、资源、恢复和 Verifier |
| D | 软建议加状态辅助 | B 加入后台状态、证据缺口和 Tool 导航 |
| E | 自适应策略 | D 加入可解释的停止、Recall 和边际价值建议 |

B、C 的差异必须通过决策遥测确认，不能只依赖配置文件名称。

### 7.2 RAG 与上下文交付实验

单因素顺序建议为：

| Variant | 中文名称 | Tool 结果如何进入模型 |
| --- | --- | --- |
| R0 | 完整结果基线 | 有界完整结果直接进入上下文 |
| R1 | 仅路径 | 返回持久化路径，不提供摘要 |
| R2 | Receipt | 返回有界 Receipt、hash、范围和恢复入口 |
| R3 | Receipt 加 Recall | Receipt 加模型可调用的按需范围读取 |
| R4 | 确定性 Broker | 相关性、覆盖、重复、来源和冲突分项选择 |
| R5 | 问题相关压缩 | R4 加查询相关摘要或问题相关压缩 |
| R6 | 向量检索试验 | 仅作为可选对照，不能默认启用 |

R1 是必要负面对照。它可以验证“只给路径”是否因为模型不主动读取而降低结果，而不是预先假定路径化一定有效。

### 7.3 信息价值和选择实验

建议分开验证：

| 实验 | 变化 | 需要回答的问题 |
| --- | --- | --- |
| I0 | 无信息价值路由 | 没有额外选择器时的基线 |
| I1 | 确定性相关/覆盖/冲突评分 | 可解释排序是否减少无效注入 |
| I2 | 启发式探索价值 | 当前 `[0,1]` 规则是否有实际预测力 |
| I3 | Verifier-backed 已验证提升 | 历史结果能否预测下一动作价值 |
| I4 | 显式 Hypothesis posterior EIG | 有先验和结果分布时是否改善探索 |
| I5 | 决策 VOI | 信息是否真的改变并改善下一动作 |
| I6 | 自适应停止 | 是否减少无效 Tool，同时不减少必要 Evidence |

I2 不能被标记为严格信息论实验。I4、I5 只有在实验快照保存先验、假设空间、结果分布、效用函数和估计器版本时才可进入正式比较。

### 7.4 压缩和主动遗忘实验

需要比较：

- 无压缩；
- 固定长度摘要；
- 问题相关抽取；
- Receipt 加摘要加原文恢复；
- 主动 Forget 后只保留总结；
- Forget 后恢复原文并重建 Evidence；
- 摘要失败、负面结果、冲突和行号/hash 保留情况。

压缩实验的主要结果不能只看 Token。必须同时检查 verified success、Evidence source closure、负面结果保留、恢复成功率和错误 Claim 比例。

## 8. 实验执行器

### 8.1 执行流程

```text
创建实验
  -> 校验语料、模型、Key 引用和预算
  -> 预检 Provider 与具体模型
  -> 固化公共快照和 Variant 策略哈希
  -> 按 Case/Attempt 分配配对单元
  -> 交错或分层执行 Variant
  -> 每次运行独立 Fixture、Run、generation 和 Verifier
  -> 保存遥测、Artifact 引用和结果状态
  -> 失败可恢复，已完成 Attempt 不重复执行
  -> 生成中文比较报告
```

### 8.2 运行顺序

默认采用分层交错顺序：

- 每个 Case 的不同 Variant 尽量交错；
- 使用实验种子生成稳定顺序；
- Provider 有并发限制时按 Profile FIFO 排队；
- 不让同一个 Provider 的某个 Variant 长时间连续占满队列；
- 运行顺序写入实验快照；
- 不能把不同顺序的结果混写成同一个配对 Attempt。

如果 Provider 没有随机种子能力，系统必须将随机性标记为未控制，并扩大 Attempt 或 Case 数量，而不是声称完全可重复。

### 8.3 重试与失败

重试必须区分：

- Provider 网络重试；
- Provider 限流重试；
- 模型输出失败；
- Tool 失败；
- Harness 阻断；
- Verifier 拒绝；
- 超时或费用耗尽；
- 实验宿主中断。

Provider 传输层重试不自动创建新的 Attempt。模型决策已经开始后，如果发生不可恢复失败，应保留该 Attempt 的失败状态和已有 Evidence，不能静默重跑并覆盖原结果。

### 8.4 中断和恢复

实验器应持久化：

- 实验状态；
- 每个 Variant 状态；
- 每个 Case/Attempt 状态；
- Provider 请求和费用累计；
- 当前租约和恢复信息；
- 已生成报告的版本。

重启后只能继续 `READY` 或可恢复的 `UNKNOWN` 单元。`SUCCEEDED`、`FAILED`、`CANCELLED` 的 Attempt 不得重复执行，除非用户显式创建新 Attempt。

## 9. 决策与信息遥测

这是本功能最关键的新增部分。没有决策遥测，只能看到“成功率变化”，看不到 Harness 为什么帮助或伤害模型。

### 9.1 Harness 决策事件

每次认知策略介入时记录结构化事件：

```text
experimentId
variantId
caseId
attempt
runId
turn
requestedAction
requestedTool
decision = allow | advise | block | terminate
policyName
policyMode
reasonCode
reasonInputsHash
suggestedAlternative
modelAcceptedSuggestion
subsequentEvidenceIds
subsequentOutcome
```

默认不保存完整敏感参数；需要调试时保存脱敏参数或参数哈希。`requestedAction` 不能被改写成 Harness 建议后的动作，否则无法计算反事实损失。

### 9.2 RAG 事件

每次检索、选择、压缩和 Recall 记录：

- 候选数量和候选 ID 哈希；
- 选中、拒绝和省略的 Artifact/Evidence ID；
- 相关性、覆盖、新颖性、来源、冲突、信任和成本分项；
- 重复判定及来源依赖关系；
- 输入/输出字节和估算 Token；
- Receipt 范围、hash、generation 和恢复入口；
- 压缩器、估计器、版本和失败原因；
- Recall 是否真正发生；
- Recall 后新增的 Evidence、Claim 或动作变化。

### 9.3 信息价值事件

每次信息价值估计必须保存：

- `estimatorKind`；
- 估计器版本；
- 输入 Hypothesis、Evidence gap、候选动作和预算摘要的哈希；
- 原始分项，不只保存最终总分；
- 是否有校准状态和置信区间；
- 预测的 EIG、VOI 或 uplift；
- 之后真实观察到的 Evidence、动作变化和 Verifier 结果；
- 估计器是否在线使用或仅用于离线 Shadow 评测。

`heuristic`、`pmi`、`posterior_eig`、`decision_voi` 和 `verified_uplift` 不能共用一个无类型的 `informationGain` 数值。

### 9.4 关键派生指标

建议系统直接计算：

- `guard_induced_regret`：被 Harness 阻止的动作是否可能带来有效 Evidence 或成功；
- `advice_acceptance_rate`：模型接受软建议的比例；
- `block_rate`：模型请求被阻止的比例；
- `productive_block_rate`：被阻止动作之后仍然成功的比例；
- `duplicate_action_ratio`；
- `duplicate_recall_ratio`；
- `receipt_recall_hit_rate`；
- `omitted_required_evidence_rate`；
- `negative_result_retention_rate`；
- `conflict_retention_rate`；
- `source_closure_rate`；
- `predicted_value_calibration_error`；
- `stop_regret`：停止后发现仍有必要 Evidence 的比例。

## 10. 中文 GUI 与 CLI

### 10.1 GUI 页面

新增“消融实验”工作区，分为以下区域：

**实验创建**

- 实验名称、研究问题、假设；
- 语料选择和语料完整性检查；
- Provider Profile 下拉选择；
- 具体模型下拉选择或手工填写；
- 思考等级和可用采样参数；
- Attempt、轮数、费用和时间预算；
- 单因素 Variant 模板；
- “只做预检”和“开始真实实验”按钮。

**运行监控**

- 实验、Variant、Case、Attempt 三层进度；
- 等待 Provider、运行中、完成、失败、暂停和需恢复状态；
- 当前请求数、Token、费用、剩余预算和预计完成时间；
- 首个 Evidence、Tool 调用和 Verifier 状态；
- Harness 允许、建议、阻止和终止数量；
- 正在运行的后台 Job 数量及关联 Run。

**结果比较**

- 基线和 Variant 的成功率及置信区间；
- 配对成功/失败转移表；
- Token、费用、耗时、Tool 和 Provider 请求；
- Evidence 覆盖、来源闭包、冲突保留和恢复成功率；
- 阻断动作及后续结果；
- RAG 候选选择和 Recall 命中；
- 信息估计值与实际提升；
- 统计有效性和 Provider 漂移警告。

**单次运行详情**

- 中文执行时间线；
- 模型请求、Tool 调用、Harness 决策和 Evidence 关联；
- 上下文清单、Receipt、Recall 和压缩记录；
- 原文 Artifact 的安全打开入口；
- 完整 JSON 作为二级调试入口；
- Key、答案、Secret 和未脱敏请求正文永远不在默认界面显示。

### 10.2 CLI 建议

命令名称可以保持稳定的 ASCII 机器接口，但所有帮助、状态、错误和报告内容使用中文：

```text
proofblade ablation list
proofblade ablation create <实验配置>
proofblade ablation preflight <实验ID>
proofblade ablation run <实验ID> --allow-live
proofblade ablation status <实验ID>
proofblade ablation report <实验ID>
proofblade ablation resume <实验ID> --allow-live
proofblade ablation export <实验ID> <输出文件>
```

推荐示例：

```powershell
proofblade ablation create docs/experiments/receipt-vs-direct.json
proofblade ablation preflight AB-20260831-001
proofblade ablation run AB-20260831-001 --allow-live
proofblade ablation report AB-20260831-001
```

Key 不通过上述命令直接传入。实验配置只引用本地 Profile ID 或环境变量名称。

## 11. 报告与统计

### 11.1 首要结果

每个 Variant 必须至少报告：

- 总 Attempt 数；
- 完成 Attempt 数；
- `verified_success_rate`；
- `evidence_backed_success_rate`；
- Candidate leak 数；
- Verifier 拒绝数；
- Provider 请求数；
- 总 Token 和每次成功成本；
- 总耗时、中位数和 P95；
- 首个 Evidence 时间；
- Tool 调用数和重复 Tool 比例；
- Context 输入 Token 和缓存字段；
- 主失败分类。

### 11.2 RAG 专项指标

- 必要 Evidence 覆盖率；
- Claim 原子支持率；
- Artifact/ Evidence source closure；
- Receipt 命中率；
- Recall 后有效新增信息比例；
- 省略项中必要 Evidence 比例；
- 负面结果保留率；
- 冲突证据保留率；
- 近重复 Token 比例；
- 每个有效 Evidence 的输入 Token；
- 恢复原文成功率；
- Forget/Restore 后 Replay parity。

### 11.3 信息论专项指标

- 预测 EIG 与离线实际信息增益的相关性；
- 预测 NetVOI 与实际决策提升的校准；
- 相对 oracle 的 regret；
- 停止时尚未获取的最大实际边际收益；
- Token 增量与 verified success、Evidence coverage 的边际曲线；
- 不同压缩率下的率失真曲线；
- 关键 Evidence 在开头、中间和末尾时的位置敏感度。

### 11.4 统计要求

建议分三层运行：

1. **开发烟雾实验**：少量 Case、每 Variant 1 次，只检查链路，不做结论。
2. **探索实验**：至少 20 个有区分度的 Case，每个 Variant 每 Case 至少 3～5 次，用于发现趋势。
3. **确认实验**：扩大 Attempt，固定模型和 Provider 版本，使用配对 Bootstrap、Wilson 区间、McNemar 或适合的混合效应模型，确认效果是否稳定。

报告必须显示样本量和不确定性。单次成功或失败不能被描述为“策略有效”或“策略无效”。

默认比较优先级：

```text
先比较同 Case 配对成功差异
  -> 再比较 Evidence 和成本差异
  -> 再报告总体平均值和 P95
  -> 最后解释机制事件和失败案例
```

### 11.5 实验有效性检查

报告必须在结论前执行：

- 模型指纹是否相同；
- Provider 端点和 API 是否相同；
- 语料哈希是否相同；
- Task Contract 和 Verifier 哈希是否相同；
- 公共预算是否相同；
- 安全边界是否相同；
- Provider 漂移是否发生；
- 实际 Variant 是否只改变声明因素；
- 每个 Variant 是否覆盖相同 Case/Attempt；
- 是否存在候选泄漏；
- 是否存在 Provider-free 或确定性 Lane 冒充真实模型结果。

有一项失败时，报告可以展示描述性结果，但必须标记为“不可用于严格因果比较”。

## 12. 语料与真实实验数据

### 12.1 语料分层

建议使用三层语料：

| 层级 | 用途 | 能否得出模型能力结论 |
| --- | --- | --- |
| 本地确定性 Fixture | 检查 Verifier、事件、重放、报告和策略链路 | 不能 |
| 公共或变形 Holdout | 探索模型与策略差异 | 有限，需防训练集污染 |
| 私有真实 Holdout | 确认实验 | 可以作为当前模型版本的实验依据 |

本地 `eval-holdout` 仍用于框架回归，但不能当作真实模型智能分数。真实模型实验必须显示 Provider 请求确实发生，并记录具体模型。

### 12.2 防止答案泄漏

- 目标文件不能包含 expected literal；
- `.proofblade/scorer.json`、验证器私有目录和答案不进入模型工作区；
- Event 和 Artifact 默认不写候选明文；
- 共享报告只保留 expected hash；
- 题目、变形方法、答案和评分器版本分别记录哈希；
- 导出前执行答案字面量和高风险 Secret 扫描。

### 12.3 题目分层

语料至少按以下维度分层：

- Web、Pwn、Reverse、Crypto、Forensics、Misc；
- 需要一次读取、多步探索、长输出、后台任务、状态会话或多次验证；
- Evidence 密度和冲突程度；
- Tool 可用性和外部副作用风险；
- 难度和模型先验可见程度。

如果某个策略只在简单读取题上有效，不能外推到需要长程探索的任务。

## 13. 分阶段开发计划

### P0：实验领域模型和配置校验

交付：

- Experiment、Variant、Case、Attempt、Pairing、ModelSnapshot、PolicySnapshot 类型；
- 实验文件 schema 和严格校验；
- 单因素检查和公共条件检查；
- 实验状态机和不可变版本；
- 模型指纹与策略指纹分离。

测试：

- 缺字段、重复 ID、非法预算和非法策略拒绝；
- 相同模型不同策略允许；
- 不同模型却声明为 Harness 消融时产生警告或拒绝；
- 多因素 Variant 被正确标记；
- 快照哈希稳定；
- 不可关闭的安全策略无法被实验文件覆盖。

### P1：真实 Provider 与模型选择

交付：

- 复用现有 Provider Profile；
- Profile、具体模型、思考等级和采样能力选择；
- Key 来源预检和脱敏；
- `--allow-live` 和 GUI 二次确认；
- Provider/model drift 检查；
- 定价和费用上限预检。

测试：

- Key 不进入配置、事件、Artifact 和报告；
- 不存在 Key 时真实实验拒绝启动；
- 具体模型快照不使用 `auto`；
- Provider 返回模型变化时实验暂停；
- 费用预算不足时预检失败；
- Provider mock 只测试协议，不被计入真实模型指标。

### P2：Harness 策略可配置化

交付：

- 首次动作、阶段路线、Action Bundle、重复断路器和停止策略支持硬门/建议/关闭；
- 保留安全、资源、恢复和 Verifier 硬边界；
- 每次 allow/advise/block/terminate 都产生决策事件；
- 旧单 Agent 默认行为保持可选基线。

测试：

- 同一模型在三种模式下动作行为可观察；
- 软建议不会被错误计为阻断；
- 安全边界在所有模式下保持生效；
- 阻断动作不会绕过 Effect、Evidence 和 Verifier；
- 恢复后策略快照不漂移。

### P3：RAG、Receipt 和 Recall 消融

交付：

- 完整结果、仅路径、Receipt、Receipt+Recall、确定性 Broker 五个基础模式；
- 候选、分项、选择原因、省略原因和 Recall 事件；
- Artifact 原文、Receipt 和 Evidence 的稳定引用；
- Forget/Restore 和 source closure 计量接口；
- 向量检索只作为实验插件，不作为默认依赖。

测试：

- 长结果有稳定 Receipt 和原文 hash；
- 仅路径模式确实不偷偷自动注入原文；
- Receipt 可以按范围恢复原文；
- 负面结果、冲突和来源字段不会被摘要静默删除；
- Recall 后模型可见内容与 Artifact 一致；
- RAG 模式不改变 Verifier 结论和 generation 隔离。

### P4：信息价值和自适应选择

交付：

- `estimatorKind` 类型化；
- 确定性相关、覆盖、冲突和成本分项；
- 启发式 value baseline；
- Verifier-backed uplift 离线 Shadow；
- 显式 Hypothesis posterior EIG 实验接口；
- 决策 VOI 和停止建议接口；
- 在线估计与离线真实结果严格分离。

测试：

- 启发式分数不会被标识为 entropy/EIG；
- 没有 prior/likelihood 时 posterior EIG 被拒绝；
- 每个估计器保存原始分项和版本；
- Shadow 计算不改变主 Run；
- 停止建议不能绕过 Verifier 和用户取消；
- 估计器输入的 generation、Evidence 和 Hypothesis 正确绑定。

### P5：实验编排、恢复和配对运行

交付：

- Case/Attempt/Variant 配对调度；
- 交错或分层运行顺序；
- Provider 并发和费用共享；
- 中断恢复、单元级重试和已完成单元保护；
- 真实实验进度状态。

测试：

- 同一配对单元使用相同 Case、Task、Verifier 和公共预算；
- 中断后不重复计入已完成 Attempt；
- 重启恢复不重新发送已完成请求；
- 一个 Variant 失败不破坏其他 Variant；
- 费用和并发上限在整个实验而不是单个进程内生效；
- Provider 限流不会导致重复实验单元。

### P6：中文 GUI、CLI 和报告

交付：

- 中文实验创建、预检、确认、监控和比较页面；
- 中文 CLI 帮助、错误和状态输出；
- 机器可读 JSON 与人类可读 Markdown 报告；
- Harness 决策、RAG 选择和信息估计详情；
- 报告有效性警告和导出脱敏。

测试：

- GUI 能选择 Profile、具体模型和思考等级；
- GUI 不显示 Key 明文；
- 运行状态刷新不会丢失已完成结果；
- 报告显示样本量、区间、失败分类和配置哈希；
- 导出文件无 Key、候选答案和未脱敏 Header；
- 中英文系统环境下路径和时间显示稳定。

### P7：真实小规模试验

交付：

- 使用用户提供的 Profile 和具体模型执行少量真实 Case；
- 完成 R0/R1/R2 或 A/B/C 三组最小实验；
- 生成第一份带不确定性的中文报告；
- 记录 Provider 成本和模型漂移。

测试：

- 真实请求数量、模型名称和费用可以从报告核对；
- Provider-free 结果不能进入真实模型成功率；
- 取消、限额、超时和恢复可用；
- 原始证据仍能从 Artifact 恢复；
- 该阶段只验证功能，不宣布策略结论。

## 14. 验收标准

### 功能验收

- 能创建中文实验并选择具体 Provider Profile 和模型；
- 同一个模型可以运行多个 Harness/RAG/信息论 Variant；
- 真实实验必须显式确认且能显示费用上限；
- 每个 Attempt 都有 Run、Case、Variant 和模型指纹；
- 运行中可看到 Provider、Tool、Evidence、Recall 和 Harness 决策状态；
- 中断后可恢复，不重复完成单元；
- 报告能比较成功率、证据、Token、成本、延迟和失败。

### 科学有效性验收

- 模型指纹和策略指纹分开；
- 同因素消融不意外改变安全、Verifier 和公共预算；
- Variant 覆盖相同 Case/Attempt；
- 报告包含样本量、配对差异和不确定性；
- Provider drift、答案泄漏和覆盖不完整会使严格比较标记为无效；
- 不把确定性 Fixture 结果描述为真实模型智能结果；
- 不把启发式分数描述成标准 EIG/VOI。

### 安全验收

- Key 不进入仓库、实验文件、Event、Artifact、日志和报告；
- 答案明文不进入模型工作区、Event 和共享报告；
- 实验不能关闭 Workspace、Secret、generation、Effect、费用和 Verifier 边界；
- 外部副作用继续遵守审批和恢复协议；
- 导出报告通过敏感信息和答案泄漏扫描。

### 可用性验收

- 用户不需要手工编辑 Key 或把 Key 放到命令行；
- 用户能在一个页面知道当前用了哪个模型和 Profile；
- 用户能看到“哪些 Tool 正在运行、哪些已返回、哪些失败”；
- 用户能看到 Harness 阻止了什么，而不是只看到最终失败；
- 用户能打开 Receipt、Artifact 和 Evidence 的来源；
- 长实验不会因为界面刷新丢失进度。

## 15. 性能与成本要求

消融系统本身不能成为新的慢点。要求：

- 创建实验和列出 Profile 不触发 Provider 推理请求；
- 预检只执行必要的模型/连接检查；
- 实验列表和状态使用持久化摘要，不扫描全部原文 Artifact；
- 报告生成优先读取索引和遥测，不重新请求模型；
- RAG 索引建立与真实模型请求解耦；
- 长结果只在用户查看或模型 Recall 时读取原文；
- 费用和 Token 在每个请求前检查，而不是结束后才发现超额；
- GUI 使用增量事件或游标，不反复加载全部事件文件。

性能指标至少包括：

- 创建实验到可开始时间；
- Provider 预检耗时；
- 单次状态刷新耗时；
- 首个运行状态显示时间；
- 实验启动到首个 Provider 请求时间；
- 报告生成 p50/p95；
- Receipt/Recall p50/p95；
- 索引建立耗时和磁盘占用。

## 16. 默认策略和发布门槛

开发完成后默认行为建议为：

- 单 Agent；
- 安全和 Verifier 硬边界；
- 认知型策略默认保持当前基线，直到消融结果证明软建议更好；
- 确定性 Receipt/Recall 可在实验中启用，但不自动成为生产默认；
- 向量检索、LLM Reranker、posterior EIG 和多 Agent 默认关闭；
- `model: "auto"` 不允许进入确认实验；
- 真实实验必须有费用上限、具体模型和完整配置快照。

策略进入默认生产路径前，至少满足：

1. 在 20 个以上有区分度的 Holdout 上完成配对实验；
2. 每个 Variant 有足够 Attempt 并报告置信区间；
3. verified success 不下降，或成本/延迟有稳定改善；
4. Evidence coverage、source closure 和负面结果保留不下降；
5. 没有新增 Candidate leak、generation、恢复或 Verifier 回归；
6. 结果在至少两个目标类型或两个独立数据分层上方向一致；
7. 失败分类和 Harness 决策日志足以解释收益来源。

## 17. 已知风险

### 模型随机性

同一模型不同采样仍可能产生不同轨迹。随机种子不可用时，必须扩大样本并标记随机性未控制。

### Provider 漂移

中转站可能更换模型、系统模板、缓存策略或限流规则。必须记录模型身份和 Provider 快照，漂移后不能继续合并原实验。

### 语料污染

公开 CTF 题目可能进入模型训练集。公开基准只能作为参考，关键结论应使用私有或变形 Holdout。

### 选择偏差

如果只运行成功题，RAG 或 Harness 的收益会被高估。必须保留失败题、重复题、冲突题和长输出题。

### 多因素混淆

Receipt、压缩、Recall 和自动 Evidence 可能同时改变上下文。每次新增能力都先做单因素实验，再做组合实验。

### 信息价值概念混淆

新颖性、相关性、模型自评、PMI、EIG 和 VOI 不是同一个概念。报告必须保留估计器类型，不允许用一个漂亮分数代替定义。

### 观察者效应

给模型更多状态提示本身可能改变行为。所有 Variant 必须记录可见提示和 Tool Schema 哈希，并把它们作为实验条件的一部分。

## 18. 开发顺序结论

推荐实际执行顺序：

```text
先做实验配置和模型/Key 选择
  -> 再做策略开关和决策遥测
  -> 再做 RAG Receipt/Recall 消融
  -> 再做信息价值和停止 Shadow
  -> 再做配对编排、恢复和统计报告
  -> 最后做 GUI 完整化和真实小规模试验
```

不建议一开始同时实现向量库、LLM Judge、posterior EIG、多 Agent 和复杂 GUI。第一批真正有价值的实验是：

```text
同一个具体模型
同一个私有或无泄漏语料
同一个预算
当前严格策略 vs 认知软建议 vs Receipt/Recall
```

只有这组结果能够稳定记录并解释，后续的信息论算法实验才有可信的比较基础。
