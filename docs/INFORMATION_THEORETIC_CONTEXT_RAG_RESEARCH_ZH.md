# ProofBlade 信息论上下文与 RAG 研究证据总结

> 状态：Research Evidence / Design Input。
>
> 核验日期：2026-08-31。
>
> 目的：总结“持久化上下文、分级召回、信息价值选择、上下文压缩、主动遗忘和证据整理”相关论文证据，为 `docs/PERSISTENT_CONTEXT_RAG_DEVELOPMENT_PLAN_ZH.md` 提供研究依据。
>
> 边界：本文记录论文已经证明什么、尚未证明什么，以及这些证据如何映射到 ProofBlade。它不是完成声明，也不表示文中算法已经实现。

## 1. 执行摘要

本次研究得到五个主要结论。

第一，RAG 本身不会创造新信息。Tool、文件系统、网页、调试器、反编译器、Provider 和用户反馈决定 Agent 能获得什么；RAG 和外部记忆主要解决已获得信息如何保存、去重、筛选、定位和重新送入有限上下文。

第二，长上下文不等于有效注意力。`Lost in the Middle` 等实验证明，即使内容没有超过模型窗口，关键证据的位置、数量和周围噪声也会显著影响使用效果。因此 ProofBlade 不应只测“是否放得下”，还要测关键证据覆盖率、位置敏感度、重复率和每个有效 Token 的决策价值。

第三，不存在一篇成熟论文完整实现以下六项：

```text
原文持久化
  -> 有界且可寻址的 Model Receipt
  -> 按需召回
  -> 自动选择下一信息源
  -> 可恢复的主动遗忘
  -> 来源绑定和独立验证
```

最接近的实现需要组合多条研究路线：

- 用 Value of Information（VOI）或 Expected Information Gain（EIG）选择下一次查询；
- 用 MMR、覆盖函数或子模边际收益在预算内选择不重复的信息集合；
- 用 Information Bottleneck（IB）或 Rate-Distortion 控制摘要和上下文压缩；
- 用 MemGPT、ReadAgent、RAPTOR 等模式实现外部存储、地址化摘要和分层召回；
- 用 ALCE、AIS、RARR 和 FActScore 区分引用、支持、事实性和最小修订；
- 最终 Completion 仍由 ProofBlade 的独立 verifier 决定。

第四，真实 Agent 运行时通常不知道标准答案，因此许多论文中的“真实信息增益”只能用于离线训练和评测。在线系统需要使用显式 Hypothesis 分布、Verifier-backed 历史、PMI、覆盖率、来源独立性、冲突发现、动作变化和成本作为代理，并保留每个代理的原始含义。

第五，ProofBlade 当前 `IntentScorer.calculateInformationGain()` 是规则化 `[0,1]` 启发式，不是 Shannon entropy、互信息、贝叶斯 posterior EIG 或决策 VOI。后续开发必须明确改名或增加 estimator 类型，不能让 Telemetry 和 GUI 把启发式分数显示成经过概率校准的信息增益。

## 2. 研究问题

本次研究围绕六个问题展开：

1. 能否用信息论量化某条信息对 Agent 的价值？
2. 能否在 Token、时间和副作用预算内自动选择下一 Tool、查询或 Artifact？
3. 能否在多个候选结果中自动避免重复，同时保留独立来源和冲突证据？
4. 能否压缩 Tool Result 而不损失当前决策所需内容和 provenance？
5. 能否把原文移出活动上下文，并通过稳定地址和摘要按需恢复？
6. 如何证明系统得到的是更高质量的注意力分配，而不只是更少的 Token？

## 3. 核验方法和证据等级

### 3.1 来源

本次只读核验使用以下原始或权威来源：

- ACL Anthology；
- ACM、AAAI、JMLR、JAIR、PMLR、TACL 和 NeurIPS 正式页面；
- OpenReview；
- arXiv Atom/HTML 原文；
- DOI/Crossref 和 OpenAlex 元数据。

论文标题、作者、年份、venue、DOI、公式和算法触发条件尽量由正式页面与论文正文交叉核对。博客、厂商宣传和二手综述不作为关键结论的唯一证据。

### 3.2 证据等级

| 等级 | 定义 | 本文用法 |
| --- | --- | --- |
| A | 同行评审正式论文，且方法和结论直接对应问题 | 可作为默认设计或正式评测依据 |
| B | 同行评审论文，但场景、模型或任务与 ProofBlade 有明显差异 | 可借鉴机制，需要本地验证 |
| C | 已公开预印本、Workshop 或初步实验 | 只进入实验分支，不作为默认保证 |
| T | 经典理论结果 | 提供数学框架，不能自动证明自然语言系统满足前提 |

### 3.3 “使用信息论”的严格定义

只有 entropy、KL divergence、mutual information、information gain、value of information、information bottleneck 或 rate-distortion 直接参与算法目标、触发或选择时，本文才称其为信息论方法。

以下情况不单独算作信息论方法：

- 普通 softmax probability threshold；
- 分类器使用 cross-entropy loss；
- cosine similarity；
- embedding 距离；
- 模型自评的 `Yes/No` 概率；
- 将任意 `[0,1]` 启发式命名为 information gain。

## 4. 理论基础

### 4.1 Expected Information Gain

[On a Measure of the Information Provided by an Experiment](https://doi.org/10.1214/aoms/1177728069)，D. V. Lindley，1956，证据等级 T。

现代记法下，对候选查询或实验 `x`：

```text
EIG(x)
  = E_y KL[p(theta | y, x) || p(theta)]
  = H(Theta) - E_y H(Theta | y, x)
  = I(Theta; Y | x)
```

它回答：“执行 `x` 并观察结果后，关于隐藏状态 `Theta` 的预期不确定性下降多少？”

对 ProofBlade 的直接启示：`Theta` 可以是候选 Hypothesis、错误根因、漏洞位置、目标服务状态或某个 Claim 的真假；`x` 可以是 Tool Call、文件范围读取、实验、复现或向用户提问。

限制：需要可信 prior、likelihood 和候选结果分布。真实 Coding/CTF 环境通常无法直接给出这些分布，LLM 自己生成的概率也未必校准。

### 4.2 Value of Information

[Information Value Theory](https://doi.org/10.1109/TSSC.1966.300074)，Ronald A. Howard，1966，证据等级 T。

```text
VOI(Y)
  = E_Y[max_a E(u(a, Theta) | Y)]
  - max_a E(u(a, Theta))
```

VOI 与 EIG 的区别是：EIG 奖励减少不确定性，VOI 奖励改变并改善决策。某条信息可能很新奇、熵下降很大，却不改变下一动作，此时它的决策 VOI 可以接近零。

对 ProofBlade 而言，生产目标应优先采用净决策价值：

```text
NetVOI(action)
  = expected decision improvement
  - token cost
  - latency cost
  - monetary cost
  - side-effect risk
  - security risk
```

只有 `NetVOI > 0` 时，系统才应继续获取该信息。无法建立效用函数时，再把 EIG 作为代理。

### 4.3 Information Bottleneck

[The Information Bottleneck Method](https://arxiv.org/abs/physics/0004057)，Naftali Tishby、Fernando C. Pereira、William Bialek，1999/2000，证据等级 T。

```text
min I(X; X_tilde) - beta I(X_tilde; Y)
```

`X` 是原始信息，`X_tilde` 是压缩表示，`Y` 是下游任务。第一项鼓励压缩，第二项要求保留与任务有关的信息。

对 ProofBlade 的意义：摘要不应该努力复现原文表面形式，而应在固定 Token 预算内保留对当前 Task、Hypothesis、Evidence、Verifier 和下一动作有用的信息。

限制：未知真实 `Y` 时无法直接估计目标；纯 IB 还可能压掉行号、hash、来源、失败记录和冲突，这些字段对审计和恢复重要，但未必提高当前答案概率。

### 4.4 Rate-Distortion

[Lossy Source Coding](https://doi.org/10.1109/18.720552)，Thomas Berger、Jerry D. Gibson，1998，证据等级 T。

```text
R(D) = min I(X; X_hat)
       subject to E[d(X, X_hat)] <= D
```

把 Token、带宽和加载时间视为 rate，把任务性能、证据覆盖、引用完整性和下一动作变化视为 distortion，可以得到“压缩到什么程度才不值得继续”的曲线。

[Fundamental Limits of Prompt Compression: A Rate-Distortion Framework for Black-Box Language Models](https://arxiv.org/abs/2407.15504)，Alliot Nagle 等，2024，证据等级 C，进一步把 prompt compression 定义为黑盒模型上的失真率优化，并强调 query-aware compression 明显优于 query-agnostic compression。

关键工程结论：ProofBlade 的 distortion 不能使用普通文本重构误差。至少要包含：

- verified outcome 是否改变；
- Evidence source coverage 是否下降；
- 关键路径、行号、命令、退出码和错误是否丢失；
- 负面结果和 rejected hypothesis 是否丢失；
- next-action ranking 是否改变；
- restore 是否仍可定位原文。

### 4.5 子模选择和递减收益

[Adaptive Submodularity: Theory and Applications in Active Learning and Stochastic Optimization](https://jair.org/index.php/jair/article/view/10731)，Daniel Golovin、Andreas Krause，2011，证据等级 T。

对候选信息 `e` 和已观察集合 `psi`：

```text
Delta(e | psi)
  = E[f(dom(psi) union {e}, Phi) - f(dom(psi), Phi) | Phi ~ psi]
```

若观察越多，同一候选的边际收益不增加，则具有 adaptive diminishing returns。满足单调、自适应子模等前提时，适应性贪心可以获得近似保证。

对 ProofBlade 的意义：每得到一次 Tool 结果后，重新计算剩余查询的边际价值，天然适合单 Agent 的 `observe -> update -> choose next` 循环。

限制：自然语言 Tool Result、含噪网页和 LLM 自评并不自动满足子模条件。不能因为评分里出现 MI 或 novelty，就声称拥有 `1 - 1/e` 保证。

## 5. 直接使用信息论的 LLM/RAG 论文

### 5.1 RAG 噪声过滤的信息瓶颈

[An Information Bottleneck Perspective for Effective Noise Filtering on Retrieval-Augmented Generation](https://aclanthology.org/2024.acl-long.59/)，Kun Zhu 等，ACL 2024，证据等级 A。

目标：

```text
min L_IB
  = I(X_tilde; X | Q)
  - beta I(X_tilde; Y | Q)
```

论文把第一项解释为简洁性，把第二项解释为正确性，在问答数据上实现极高压缩率并改善答案。

适用于 ProofBlade：训练或校准 Tool Result filter、summary evaluator 和 compression policy。

不能直接外推：训练使用 ground-truth output `Y` 或其代理；真实 Agent 在执行时不知道最终答案。QA 上的 conciseness 也不等于 Evidence provenance 完整。

### 5.2 无需答案的 PMI 排序

[Pointwise Mutual Information as a Performance Gauge for Retrieval-Augmented Generation](https://aclanthology.org/2025.naacl-long.78/)，Tianyu Liu 等，NAACL 2025，证据等级 A。

```text
PMI(q, c) = log p(q | c) / p(q)
```

论文发现问题与上下文之间的 PMI 和回答性能具有经验相关性，并用它选择、排列文档，不需要提前知道答案。

适用于 ProofBlade：对已经获得的 Artifact、Receipt 和 Evidence 进行 query-aware 排序，尤其可用于动态尾部和召回结果顺序。

不能直接外推：PMI 是已知上下文与问题的关联量，不是未来 Tool Result 的 EIG；复述问题或语言风格匹配也可能得到高 PMI，它不证明内容正确。

### 5.3 Relevant Information Gain 和结果多样性

[Dartboard: Better RAG using Relevant Information Gain](https://arxiv.org/abs/2407.12101)，Marc Pickett 等，2024/2025，证据等级 C。

论文在概率化目标下选择一组能覆盖潜在相关目标的结果，使多样性作为边际覆盖的结果自然出现，而不是单独添加 diversity 奖励。

适用于 ProofBlade：从大量搜索命中、文件片段、日志区域或同一 Evidence 的候选来源中选择有限集合。

限制：实验集中于一个 RAG benchmark 和一个模型；运行成本、超参数和跨任务泛化仍需验证。它的“relevant information gain”也不是 Lindley 意义下对未知状态 posterior 的标准 EIG。

### 5.4 在线 entropy 触发检索

[DRAGIN: Dynamic Retrieval Augmented Generation based on the Real-time Information Needs of Large Language Models](https://aclanthology.org/2024.acl-long.702/)，Weihang Su 等，ACL 2024，证据等级 A。

它对生成 token 计算：

```text
H_i = -sum_v p_i(v) log p_i(v)
```

再结合该 token 对后续上下文的 attention 影响和语义权重决定何时检索，并用全上下文 attention 构造 query。

适用于 ProofBlade：本地开放权重模型的实验性 turn 内 recall trigger。

限制：需要完整词表分布和 attention；多数 OpenAI-compatible API 不提供后者。Token entropy 会受温度、词表和校准影响，也不等于 Task/Hypothesis uncertainty。

### 5.5 贝叶斯信息获取

[BED-LLM: Intelligent Information Gathering with LLMs and Bayesian Experimental Design](https://arxiv.org/abs/2508.21184)，Deepro Choudhury 等，ICLR 2026，证据等级 A/B。

```text
EIG_theta(x; h)
  = H[p(theta | h)]
  - E_y H[p(theta | h, x, y)]
```

论文使用 LLM predictive distributions 和粒子近似，依次生成候选问题、更新后验并选择下一查询。它是本次研究中最接近通用 Information Broker 的完整蓝图。

适用于 ProofBlade：显式候选 Hypothesis 数量有限、查询结果可枚举或采样的场景，例如二分定位、配置诊断、候选漏洞路径和用户澄清。

限制：实验的 latent space 相对可控；LLM likelihood 未必校准；真实 Tool 还包含异构成本、权限、副作用、恶意内容和不可逆 Effect。

### 5.6 成本感知的信息获取

[The Curious Language Model: Strategic Test-Time Information Acquisition](https://arxiv.org/abs/2506.09173)，Michael Cooper 等，ICML 2025 Test-Time Adaptation Workshop，证据等级 C。

```text
a_t = argmax_a [EIG(a | X_t) - lambda cost(a)]
```

它直接研究不同信息源、不同成本和下一步查什么，与 ProofBlade Tool/Capability 选择高度相关。

限制：主要在模拟诊断环境验证，概率由 LLM rollout/self-evaluation 近似；对真实网页污染、工具错误和来源可信度没有通用保证。

## 6. 主动和自适应 RAG

这一组论文主要解决“什么时候检索、检索什么、何时停止”。其中只有 DRAGIN 的在线核心触发明确使用 Shannon entropy；其他方法虽有价值，但不能笼统标成信息论。

| 论文 | 触发机制 | 信息论 | 对 ProofBlade 的用途 | 主要风险 |
| --- | --- | --- | --- | --- |
| [FLARE](https://aclanthology.org/2023.emnlp-main.495/) | 下一句预测中出现低概率 token 时检索 | 否 | 只有 logprob 时的 recall trigger 基线 | 依赖校准，预生成再生成增加成本 |
| [Self-RAG](https://openreview.net/forum?id=hSyW5go0v8) | `Retrieve/IsRel/IsSup/IsUse` reflection token | 否 | 结构化 necessity/relevance/support/utility 字段 | 单模型自评有共因偏差，不能代替 verifier |
| [Adaptive-RAG](https://aclanthology.org/2024.naacl-long.389/) | 分类为不检索、单次检索、多步检索 | 否 | Task/Intent 级路线选择 | QA complexity 标签不能直接迁移到 Coding/CTF |
| [DRAGIN](https://aclanthology.org/2024.acl-long.702/) | entropy × attention × semantic weight | 是 | 开放模型在线触发实验 | Provider API 通常缺少 attention |
| [CRAG](https://arxiv.org/abs/2401.15884) | relevance evaluator 双阈值 | 否 | accept/refine/alternate-source 质量门 | 域外失准和 Web prompt injection |
| [SKR](https://aclanthology.org/2023.findings-emnlp.691/) | 历史上检索是否改善结果 | 否 | 用 verifier-backed 轨迹训练轻量路由 | 标签不是认识论不确定性 |
| [SeaKR](https://aclanthology.org/2025.acl-long.1312/) | 多次采样 hidden-state Gram determinant | 严格说否 | 研究性不确定性和 passage reranking | 成本高，需要 hidden state；一致不等于正确 |
| [IRCoT](https://aclanthology.org/2023.acl-long.557/) | 每个 CoT 句子后检索 | 否 | 迭代 Evidence 基线 | 幻觉 CoT 会污染下一 query |
| [EfficientRAG](https://aclanthology.org/2024.emnlp-main.199/) | 轻量 tagger 决定 Continue/Terminate | 否 | 可作为软停止信号 | learned terminate 不等于证据闭合 |

研究支持的组合不是选择其中一篇完整照搬，而是：

```text
Adaptive-RAG/SKR：选择 no recall / exact recall / iterative recall
CRAG：召回后判断 accept / refine / alternate source
Self-RAG：提供可审计的软评价字段
EfficientRAG：提供 continue/stop 软信号
Evidence closure + budget + verifier：提供硬停止条件
```

## 7. 外部记忆、压缩和主动遗忘

### 7.1 证据矩阵

“有界回执”在本文中指原文移出活动上下文后，留下长度受控且可定位原文的摘要或索引。“主动遗忘”主要指活动 Provider view 的可恢复逐出，不指删除 Artifact。

| 论文 | 原文外置 | 有界回执 | 按需召回 | 主动遗忘 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| [MemGPT](https://arxiv.org/abs/2310.08560) | 强 | 强 | 强 | 中 | C |
| [ReadAgent](https://proceedings.mlr.press/v235/lee24c.html) | 强 | 中 | 强 | 无 | A |
| [MemoryBank](https://doi.org/10.1609/aaai.v38i17.29946) | 强 | 中 | 强 | 中/强 | A/B |
| [Generative Agents](https://doi.org/10.1145/3586183.3606763) | 中 | 中 | 强 | 弱 | A/B |
| [RECOMP](https://openreview.net/forum?id=mlJLVigNHp) | 中 | 中 | 强 | 弱 | A |
| [RAPTOR](https://openreview.net/forum?id=GN921JHCRw) | 强 | 中 | 强 | 无 | A |
| [HippoRAG](https://proceedings.neurips.cc/paper_files/paper/2024/hash/6ddc001d07ca4f319af96a3024f6dbd1-Abstract-Conference.html) | 强 | 弱 | 强 | 无 | A |
| [Selective Context](https://aclanthology.org/2023.emnlp-main.391/) | 无 | 中 | 无 | 弱 | A/B |
| [LLMLingua](https://aclanthology.org/2023.emnlp-main.825/) | 无 | 中 | 无 | 弱 | A |
| [LongLLMLingua](https://aclanthology.org/2024.acl-long.91/) | 无 | 中 | 中 | 弱 | A |

### 7.2 MemGPT

MemGPT 把上下文当作分层内存：固定 working context、消息队列、recall storage 和 archival storage。接近窗口阈值时发 memory-pressure 警告，逐出消息并生成递归摘要；原始消息仍留在外部存储，可由函数调用重新加载。

它最支持 ProofBlade 的以下方向：

- Context pressure 是显式事件；
- 活动上下文逐出和持久原文分离；
- 摘要可以递归更新；
- Agent 可以主动 recall。

它没有解决 ProofBlade 特有的 generation fencing、Tool pair、Effect unknown、Artifact hash、Evidence trust 和独立 verifier。

### 7.3 ReadAgent

ReadAgent 先为长文分页，并生成带页号的 gist；回答时先看 gists，再自主选择要重新打开的原始页。它是“原文外置 + 地址化摘要 + 按需回读”最直接的同行评审证据。

限制：所有 gist 仍可能随文档增长；它没有跨 Run 权限、主动遗忘、Evidence Graph 或崩溃恢复。

### 7.4 MemoryBank 和 Generative Agents

MemoryBank 使用外部完整对话、每日/全局摘要、向量召回和随时间衰减、随复习增强的记忆强度：

```text
R = exp(-t / S)
```

Generative Agents 的 memory stream 按 relevance、importance 和 recency 召回，并通过 reflection 形成高层记忆。

这些论文支持“召回权重可以动态变化”，但时间衰减不能成为 ProofBlade 删除证据的理由。旧 Evidence 可能低频但仍是唯一失败诊断、反例或审计依据。

### 7.5 RECOMP、RAPTOR 和 HippoRAG

- RECOMP 在 retrieval 之后生成 query-focused extractive/abstractive compression，无帮助时可以不注入内容；适合 Model Receipt。
- RAPTOR 将原始 chunk、聚类摘要和更高层摘要组织为树；适合 ProofBlade L0/L1/L2 projection。
- HippoRAG 使用 OpenIE、知识图谱和 Personalized PageRank 支持单步多跳召回；适合未来的 Evidence relation retrieval。

三者都不能替代 ArtifactStore：摘要树和图索引是派生导航，不是原始事实源。

### 7.6 Selective Context 和 LLMLingua 系列

Selective Context 依据 self-information 删除低信息 token、短语或句子；LLMLingua 用 budget controller、perplexity 和粗到细压缩；LongLLMLingua 增加 question-aware 文档选择、contrastive perplexity 和位置重排。

这些方法支持“减少输入 Token”，但不天然支持：

- 稳定 URI；
- 原文 hash；
- 按范围恢复；
- 负面结果保留；
- Evidence source closure；
- 可恢复的 forget transaction。

因此它们不能单独构成 ProofBlade 的持久化上下文系统。Selective Context 的 arXiv 页面另有 substantial text overlap 管理员注记，引用时应使用正式 EMNLP 版本并保留这一风险说明。

## 8. 去重、覆盖和边际信息价值

### 8.1 MMR

[The use of MMR, diversity-based reranking for reordering documents and producing summaries](https://doi.org/10.1145/290941.291025)，Jaime Carbonell、Jade Goldstein，SIGIR 1998，证据等级 T/B。

```text
e* = argmax_e [
  lambda rel(e, q)
  - (1 - lambda) max_s sim(e, s)
]
```

它可以作为第一版确定性 reranker：兼顾与当前任务的相关性以及相对已选结果的新颖性。

限制：MMR 的相似度只检测内容重复，不能判断两个相似文本是否来自独立来源。两个独立来源共同支持一个 Claim 时，不应因语义相似而丢失 provenance。

### 8.2 子模摘要

[A Class of Submodular Functions for Document Summarization](https://aclanthology.org/P11-1052/)，Hui Lin、Jeff Bilmes，ACL-HLT 2011，证据等级 T/B。

一个适合 ProofBlade 的可解释目标可以写成：

```text
F_q(S)
  = alpha * subproblem coverage
  + beta  * source/topic diversity
  + gamma * trust/recency utility
  + delta * contradiction coverage

subject to sum tokenCost(e) <= B
```

每一步选择最大 `Delta(e | S)` 的候选，并保留每一项分数和选择原因。

必须区分：

```text
内容重复：可合并或只留一个 preview
来源重复：同一 hash/同一上游，通常只需一个
独立佐证：内容可能相似，但来源独立，应保留关系
冲突证据：与主假设不相似或相反，价值可能更高
```

## 9. 注意力、引用和事实性证据

### 9.1 Lost in the Middle

[Lost in the Middle: How Language Models Use Long Contexts](https://doi.org/10.1162/tacl_a_00638)，Nelson F. Liu 等，TACL 2024，证据等级 A。

论文在多文档 QA 和 key-value retrieval 中发现：关键内容位于上下文开头或末尾时性能通常较好，位于中间时显著下降；增加文档数量产生的收益很快饱和，但成本继续增长。

对 ProofBlade 的直接要求：

- 测试相同 Evidence 放在不同位置时的准确率；
- 把当前任务、关键失败诊断和最相关 Evidence 放在稳定显著位置；
- 不把“模型窗口还有空间”当作继续注入的充分理由；
- 建立基于边际收益的停止规则。

### 9.2 ALCE

[Enabling Large Language Models to Generate Text with Citations](https://aclanthology.org/2023.emnlp-main.398/)，Tianyu Gao 等，EMNLP 2023，证据等级 A。

ALCE 分别测量：

- 回答正确性；
- citation completeness；
- citation correctness/precision。

论文表明即使系统能生成引用，很多陈述仍没有完整支持。ProofBlade GUI 不能把“存在 Artifact/Evidence link”显示成“Claim 已验证”。

### 9.3 FActScore

[FActScore: Fine-grained Atomic Evaluation of Factual Precision in Long Form Text Generation](https://aclanthology.org/2023.emnlp-main.741/)，Sewon Min 等，EMNLP 2023，证据等级 A。

```text
FActScore(y)
  = average over atomic facts a in y
    of 1[a is supported by knowledge source]
```

它支持把 Agent summary、Evidence summary 和最终报告拆成原子 Claim 逐项核验。

限制：只测 precision 会鼓励极短回答或拒答。必须同时报告 Claim coverage、required evidence coverage 和 answer completeness。

### 9.4 RARR 和最小修订

[RARR: Researching and Revising What Language Models Say, Using Language Models](https://aclanthology.org/2023.acl-long.910/)，Luyu Gao 等，ACL 2023，证据等级 A。

RARR 先为输出寻找外部证据，再只修改无支持部分，并同时度量 attribution 和 preservation。它支持以下 ProofBlade 原则：

- Evidence 整理应最小修改已建立的事实结构；
- 新摘要不能为了“更像检索文本”而覆盖用户意图；
- 整理前后应比较来源支持和语义保真；
- 原始版本和修订版本都应保留。

## 10. 论文证据支持的 ProofBlade 架构

研究支持的 Information Broker 应是 Agent 外部的可审计服务，但不拥有第二套事实库或第二个 transcript：

```text
ControlStore / ArtifactStore / Evidence Graph
                  |
          Information Broker
                  |
   normalize -> index -> value estimate
      -> select -> compress -> receipt
      -> recommend recall/tool/stop
                  |
        ContextCompiler projection
                  |
            single Agent
```

### 10.1 获取前：选择信息动作

候选动作可以包括：

- 精确读取某个 `pb://` URI；
- 扩大文件范围；
- 运行 grep/glob；
- 调用调试器、反编译器或浏览器；
- 等待/监控 Job；
- 向用户澄清；
- 停止获取并进入验证。

理想目标：

```text
a_t* = argmax_a {
  ExpectedDecisionImprovement(a | state_t)
  - lambda_token * tokenCost(a)
  - lambda_time  * latency(a)
  - lambda_money * monetaryCost(a)
  - lambda_risk  * risk(a)
}
```

若没有可靠效用模型，可使用 EIG、历史 verifier uplift、Hypothesis coverage 和 contradiction potential 作为分项代理。

### 10.2 获取后：规范化和持久化

所有结果首先形成 canonical value、Artifact、hash、generation、scope、sensitivity、source Effect 和 OperationRef。信息评分只产生派生 metadata，不能修改 canonical result。

### 10.3 选择：预算内最大化边际价值

第一版应使用确定性、可解释的分项：

```text
task relevance
hypothesis coverage
evidence gap coverage
new source coverage
conflict/refutation value
novel fields/paths/lines
duplicate similarity
trust and sensitivity
token/latency cost
```

系统为每个候选保留原始分项和选择原因，不把不同量纲压成一个不可解释的“AI 分数”。

### 10.4 压缩：任务相关率失真

Model Receipt 和 Summary 必须硬保留：

- operation/status/error/exit code；
- 路径、行号、范围和符号；
- Artifact URI、hash、generation 和 sensitivity；
- 支持、反驳、depends_on 和 source IDs；
- 负面结果和 rejected hypothesis；
- omitted bytes/items 和 restore 方法；
- 下一步操作。

普通日志重复、无关格式、重复栈帧和已被高质量 summary 覆盖的旧正文可以优先压缩。

### 10.5 验证和停止

软信号：

- 模型 uncertainty；
- Self-RAG 风格 necessity/relevance/support/utility；
- learned continue/terminate；
- marginal information gain；
- no-progress 和 duplicate action。

硬信号：

- Task Contract；
- Evidence closure；
- generation 和 Effect 状态；
- 预算；
- 独立 verifier；
- 用户明确暂停/取消/变更目标。

停止条件不能是模型生成了“final answer”字符串，也不能仅因为 entropy 下降或内部采样一致。

## 11. 在线与离线信息增益必须分开

### 11.1 离线可使用真实结果

在 Fixture、回归轨迹和 verifier-backed 数据中，系统知道最终结果，可以计算：

- 某次 Tool Call 是否提高 verified success；
- 某个 Artifact 是否支持最终正确 Claim；
- recall 前后正确答案 log-likelihood 的变化；
- summary 是否保持 Evidence coverage；
- 某策略的 utility、成本和 regret。

这些数据适合训练或校准 route、filter、receipt、stop 和 risk 模型。

### 11.2 在线只能使用代理

真实执行中不能知道 gold `Y`。在线可用：

- 显式 Hypothesis posterior 或可解释权重；
- query-context PMI；
- 当前 Evidence gap；
- 新 source/hash/path/line coverage；
- contradiction/refutation detection；
- next-action distribution 的变化；
- verifier 的中间机械断言；
- 历史上相似 Intent 的 verified uplift；
- Tool 成本、失败率和 replay policy。

任何在线代理都必须记录 estimator 名称、版本、输入来源、置信区间或校准状态。

## 12. 对当前代码的审计结论

当前文件：

```text
packages/materials/src/orchestration/intent-scorer.ts
```

`calculateInformationGain()` 的实际逻辑是：

```text
0.5 baseline
+ recent fact ratio
- hypothesis penalty
+ high expected evidence confidence
+ critical priority
then clamp to [0, 1]
```

它没有：

- `p(theta)`；
- outcome distribution；
- posterior update；
- entropy；
- KL divergence；
- mutual information；
- expected utility；
- calibration。

因此后续实现应选择其一：

1. 将字段改名为 `heuristicInformationValue` 或 `explorationValue`；
2. 增加 `estimatorKind`，明确 `heuristic | posterior_eig | verified_uplift | pmi | decision_voi`；
3. 保留当前启发式作为 baseline，新增真正 EIG/VOI 的实验策略；
4. GUI 和 Telemetry 不把不同 estimator 的数值直接横向比较。

本文不要求立即修改该代码，只记录后续开发必须处理的语义债务。

## 13. 实验设计

### 13.1 消融组

使用同一批真实轨迹、provider-free Fixture 和相同模型/Tool 预算比较：

| 组 | 策略 |
| --- | --- |
| A | 完整 Tool Result 直接进入上下文 |
| B | 只返回路径，没有摘要和推荐 |
| C | 有界 Receipt + 显式 recall |
| D | C + 确定性相关性/覆盖/去重 Broker |
| E | D + 信息价值路由和停止策略 |
| F | E + query-aware compression/forget/restore |

`B` 是必要负面对照：它可以证明“只给路径”是否因模型不主动读取而降低成功率。

### 13.2 核心指标

```text
verified success
evidence-backed success
required evidence coverage
atomic claim support rate
citation completeness / precision
Tool calls per verified success
duplicate Tool action ratio
duplicate recall ratio
near-duplicate token ratio
independent source count
contradicting evidence retention
time to first evidence
Provider input tokens
context compile latency
recall p50/p95/p99
startup to new-chat-ready latency
summary distortion
restore success
replay parity
```

### 13.3 信息论专项指标

#### EIG/VOI 校准

- predicted EIG 与实际 entropy/verified uplift 的相关性；
- predicted NetVOI 与实际 utility improvement 的 calibration curve；
- 选择策略相对 oracle 的 regret；
- 停止时仍存在的最大实际边际收益。

#### 边际价值

```text
MV_k = [Metric(S_k) - Metric(S_(k-1))]
       / [tokens(S_k) - tokens(S_(k-1))]
```

绘制 accuracy、Evidence coverage、attribution 对 Token 和结果数量的饱和曲线。

#### 率失真

对不同压缩率报告：

- verified outcome distortion；
- Evidence source coverage distortion；
- next-action ranking distortion；
- negative-result retention；
- citation/line/hash retention；
- restore rate。

#### 位置敏感度

固定 Evidence 集合，轮换关键证据在上下文开头、中间和末尾的位置，报告：

- middle-edge accuracy gap；
- worst-position accuracy；
- position permutation standard deviation；
- reordered receipt 的收益和成本。

### 13.4 安全测试

- 高相关但错误的检索结果；
- 低 entropy 且错误的模型判断；
- prompt injection Artifact；
- 旧 generation 高分结果；
- secret Artifact 的召回请求；
- 相似但独立的多来源证据；
- 冲突来源、过期页面和更新/撤回内容；
- summary 丢失负面结果；
- score manipulation 和重复内容刷 coverage；
- Tool Result/Artifact hash mismatch。

## 14. 主要风险和不能外推的结论

### 14.1 不确定性不等于错误概率

模型可能高 entropy 但答案正确，也可能低 entropy 且自信地错误。Token-level uncertainty、semantic uncertainty、Hypothesis uncertainty 和决策风险必须分开。

### 14.2 信息增益不等于决策价值

减少大量无关不确定性可能完全不改变下一动作。生产调度应优先使用 VOI 或 verifier-backed utility，而不是最大化 novelty。

### 14.3 相似度不等于重复

多个独立来源可能内容相似，却提供更强的佐证；相反，同一上游被不同网站转载不能算独立证据。去重需要 provenance 和 source dependency。

### 14.4 引用不等于支持

ALCE、AIS 和 FActScore 共同表明：系统可以带 citation，却没有完整支持 Claim。Evidence edge 必须表达 supports/refutes/depends_on，Verifier 必须独立检查。

### 14.5 压缩收益不能只看 Token

一个压缩器可以降低 90% Token，同时删除唯一失败诊断、边界条件或反例。验收必须同时检查任务性能、来源闭包、负面结果和恢复能力。

### 14.6 理论保证有严格前提

子模贪心、Rate-Distortion 和 Bayesian EIG 的保证依赖分布、效用、单调性、条件独立或渐近假设。自然语言 Agent 只能把它们作为设计框架，除非在具体实现中证明前提。

## 15. 研究支持的实施顺序

研究证据支持以下保守顺序：

1. 保持 ArtifactStore、ControlStore、Evidence Graph 和 `pb://` 为唯一事实与导航基础。
2. 先实现有界 Receipt、稳定 URI、hash、generation 和范围读取。
3. 建立完整结果注入、只给路径、Receipt+Recall 三个基线。
4. 实现确定性的相关性、覆盖、来源、冲突和重复分项。
5. 用 Token 背包约束做可解释的边际选择，不急于加入向量或 LLM judge。
6. 使用 verifier-backed 轨迹离线训练/校准 route 和 stop policy。
7. 只在显式 Hypothesis 空间可建模时实验 posterior EIG。
8. 在开放模型可提供 logits/attention 时单独评估 DRAGIN 类触发。
9. 实现 query-aware compression、source-linked summary、forget transaction 和 restore。
10. 最后才评估 embedding、LLM reranker 或更复杂的贝叶斯 Information Broker。

## 16. 最终研究结论

论文证据支持 ProofBlade 建设 Agent 外部的信息处理层，但不支持“所有内容无条件向量化并只返回路径”。最有依据的目标是：

```text
VOI/EIG 决定下一步是否值得获取信息
  -> deterministic/submodular selection 决定预算内保留什么
  -> IB/rate-distortion 决定如何压缩
  -> addressable receipt 保证可以回到原文
  -> Evidence attribution 保证每个结论可追溯
  -> independent verifier 决定是否完成
```

这个系统真正优化的不是“保存了多少信息”，而是：

- 是否获取到了任务所需的新信息；
- 是否把有限注意力分配给了决策相关证据；
- 是否减少了重复 Tool 和重复读取；
- 是否保留了反例、冲突和来源；
- 是否在更少 Token 和可接受延迟下提高 verified success；
- 是否能在压缩、崩溃和主动遗忘后恢复原始证据。

如果 Token 下降但 verified success、Evidence coverage 或恢复能力下降，则 RAG 化失败。如果上下文更短、重复更少、关键证据更可见，并且真实任务成功率和证据完整性提高，才可以认为 Information Broker 带来了有效收益。

## 17. 核心参考文献索引

### 信息论与选择

- Lindley, 1956, [On a Measure of the Information Provided by an Experiment](https://doi.org/10.1214/aoms/1177728069).
- Howard, 1966, [Information Value Theory](https://doi.org/10.1109/TSSC.1966.300074).
- Berger and Gibson, 1998, [Lossy Source Coding](https://doi.org/10.1109/18.720552).
- Tishby, Pereira, and Bialek, 1999/2000, [The Information Bottleneck Method](https://arxiv.org/abs/physics/0004057).
- Golovin and Krause, 2011, [Adaptive Submodularity](https://jair.org/index.php/jair/article/view/10731).
- Carbonell and Goldstein, 1998, [MMR](https://doi.org/10.1145/290941.291025).
- Lin and Bilmes, 2011, [A Class of Submodular Functions for Document Summarization](https://aclanthology.org/P11-1052/).

### 信息论 RAG 与主动获取

- Zhu et al., 2024, [Information Bottleneck for RAG](https://aclanthology.org/2024.acl-long.59/).
- Pickett et al., 2024/2025, [Dartboard: Better RAG using Relevant Information Gain](https://arxiv.org/abs/2407.12101).
- Liu et al., 2025, [PMI as a Performance Gauge for RAG](https://aclanthology.org/2025.naacl-long.78/).
- Nagle et al., 2024, [Fundamental Limits of Prompt Compression](https://arxiv.org/abs/2407.15504).
- Choudhury et al., 2025/2026, [BED-LLM](https://arxiv.org/abs/2508.21184).
- Cooper et al., 2025, [The Curious Language Model](https://arxiv.org/abs/2506.09173).

### 自适应检索

- Jiang et al., 2023, [FLARE](https://aclanthology.org/2023.emnlp-main.495/).
- Asai et al., 2024, [Self-RAG](https://openreview.net/forum?id=hSyW5go0v8).
- Jeong et al., 2024, [Adaptive-RAG](https://aclanthology.org/2024.naacl-long.389/).
- Su et al., 2024, [DRAGIN](https://aclanthology.org/2024.acl-long.702/).
- Yan et al., 2024, [CRAG](https://arxiv.org/abs/2401.15884).
- Wang et al., 2023, [SKR](https://aclanthology.org/2023.findings-emnlp.691/).
- Yao et al., 2025, [SeaKR](https://aclanthology.org/2025.acl-long.1312/).
- Trivedi et al., 2023, [IRCoT](https://aclanthology.org/2023.acl-long.557/).
- Zhuang et al., 2024, [EfficientRAG](https://aclanthology.org/2024.emnlp-main.199/).

### 记忆与压缩

- Packer et al., 2023/2024, [MemGPT](https://arxiv.org/abs/2310.08560).
- Lee et al., 2024, [ReadAgent](https://proceedings.mlr.press/v235/lee24c.html).
- Zhong et al., 2024, [MemoryBank](https://doi.org/10.1609/aaai.v38i17.29946).
- Park et al., 2023, [Generative Agents](https://doi.org/10.1145/3586183.3606763).
- Xu et al., 2024, [RECOMP](https://openreview.net/forum?id=mlJLVigNHp).
- Sarthi et al., 2024, [RAPTOR](https://openreview.net/forum?id=GN921JHCRw).
- Gutiérrez et al., 2024, [HippoRAG](https://proceedings.neurips.cc/paper_files/paper/2024/hash/6ddc001d07ca4f319af96a3024f6dbd1-Abstract-Conference.html).
- Li et al., 2023, [Selective Context](https://aclanthology.org/2023.emnlp-main.391/).
- Jiang et al., 2023, [LLMLingua](https://aclanthology.org/2023.emnlp-main.825/).
- Jiang et al., 2024, [LongLLMLingua](https://aclanthology.org/2024.acl-long.91/).

### 注意力、归因和事实性

- Liu et al., 2024, [Lost in the Middle](https://doi.org/10.1162/tacl_a_00638).
- Rashkin et al., 2023, [Measuring Attribution in Natural Language Generation Models](https://doi.org/10.1162/coli_a_00486).
- Gao et al., 2023, [RARR](https://aclanthology.org/2023.acl-long.910/).
- Gao et al., 2023, [ALCE](https://aclanthology.org/2023.emnlp-main.398/).
- Min et al., 2023, [FActScore](https://aclanthology.org/2023.emnlp-main.741/).
