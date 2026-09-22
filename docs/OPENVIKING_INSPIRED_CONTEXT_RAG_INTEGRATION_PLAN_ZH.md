# ProofBlade 基于 OpenViking 的上下文数据库与 RAG 集成开发计划

状态：设计阶段，尚未修改运行时代码

本文档参考 [OpenViking](https://github.com/volcengine/OpenViking/tree/7b0482576cc105b4a8ce1ea011c6c0285e51a509) 的当前实现与文档，设计如何把它的上下文数据库思想引入 ProofBlade。重点不是复制 OpenViking 代码，而是吸收以下机制：

```text
虚拟文件系统式上下文组织
统一 URI
目录级语义摘要
L0 / L1 / L2 分层加载
层级检索
检索轨迹和来源
会话归档与长期记忆
源数据和派生索引分离
异步队列与崩溃恢复
```

与现有 ProofBlade 设计的关系：

- [Harness 对比与上下文修复计划](HARNESS_COMPARISON_AND_CONTEXT_REPAIR_PLAN_ZH.md) 负责解决模型实际看到什么、上下文为什么丢失。
- [持久化 Context RAG 计划](PERSISTENT_CONTEXT_RAG_DEVELOPMENT_PLAN_ZH.md) 负责持久化内容、Receipt、Recall 和上下文维护。
- [第 7 章评估与消融计划](CHAPTER7_AGENT_EVALUATION_ABLATION_DEVELOPMENT_PLAN_ZH.md) 负责验证 RAG 是否真的改善 Agent，而不是只增加了检索数量。
- [信息论 Context RAG 研究](INFORMATION_THEORETIC_CONTEXT_RAG_RESEARCH_ZH.md) 负责信息价值、后验增益、决策价值和自适应停止的实验语义。

## 1. 结论摘要

### 1.1 OpenViking 最值得借鉴的不是向量数据库

OpenViking 的核心抽象是“Context Database”：记忆、资源和技能不再以互相独立的数据库表存在，而是统一组织在 `viking://` 虚拟文件系统中。Agent 可以先浏览目录、读取摘要，再深入读取详情。

它把检索过程拆成：

```text
确定位置
 -> 浏览目录
 -> 读取目录摘要
 -> 定位候选文件
 -> 读取必要详情
 -> 返回带来源的上下文
```

这正好对应当前 ProofBlade 的缺口：ProofBlade 已经有 Artifact、Knowledge、Evidence 和 `pb://` 引用，但模型仍然很难知道这些对象之间的关系，也无法稳定地从一个结果继续回取详情。

### 1.2 不能直接照搬的部分

OpenViking 不能直接替代 ProofBlade 的以下组件：

- ControlStore 仍然是 Run 状态和事件事实的来源。
- ArtifactStore 仍然是工具原始结果的完整保存来源。
- Evidence Graph 仍然负责证据关系、冲突和支持链。
- Verifier 仍然是完成判定的唯一权威。
- generation fence 仍然隔离 Fixture reset 前后的数据。
- Effect Journal 仍然负责可能产生副作用的执行。

OpenViking 风格的 Context Database 只能作为：

```text
Artifact / Session / Evidence 的派生语义索引和模型上下文选择层
```

不能成为第二个事实数据库。

### 1.3 目标架构

```text
                         Safety Plane
     ControlStore / Effect Journal / Verifier / generation fence
                              |
                              v
Tool Result -> ArtifactStore -> Context Database
                    |              |
                    |              +-> L0 摘要
                    |              +-> L1 概览
                    |              +-> L2 完整详情
                    |              +-> 确定性/向量索引
                    |              +-> 检索轨迹
                    |
                    +-> Evidence Graph / Provenance
                                   |
                                   v
        ContextAssembler -> ModelContextFrame -> Provider
```

## 2. OpenViking 能力核对

核对版本：OpenViking `7b0482576cc105b4a8ce1ea011c6c0285e51a509`。

### 2.1 统一虚拟文件系统

OpenViking 将资源、用户记忆和技能组织成统一的 URI 层级：

```text
viking://resources/{project}/...
viking://user/{user_id}/memories/...
viking://user/{user_id}/skills/...
viking://user/{user_id}/sessions/...
```

URI 既是存储定位，也是模型理解上下文关系的导航语言。模型可以通过 `ls`、`tree`、`find`、`grep` 和 `read` 逐层探索，而不是只接收一个无法解释的向量检索结果。

参考：[Viking URI](https://docs.openviking.ai/zh/concepts/04-viking-uri)。

### 2.2 L0、L1、L2 分层加载

OpenViking 对目录上下文生成三层内容：

| 层级 | OpenViking 语义 | 作用 | ProofBlade 目标 |
| --- | --- | --- | --- |
| L0 | Abstract | 快速相关性判断 | 一句话判断该目录/证据集是否相关 |
| L1 | Overview | 导航、规划和重排 | 目录结构、关键事实、可用详情和入口 |
| L2 | Detail | 原始完整内容 | Artifact 正文、工具输出、会话片段 |

OpenViking 文档给出的默认上限是 L0 约 256 字符、L1 约 4000 字符，L2 保持原始详情并按需读取。[上下文层级说明](https://docs.openviking.ai/zh/concepts/03-context-layers)。

ProofBlade 不应直接复制这个数值，而应按 Provider 的实际上下文预算配置。重要原则是：

```text
L0/L1 用于选择
L2 用于证明和详细分析
```

不能把 L0/L1 摘要当成完整证据，也不能在 L0/L1 生成失败时删除 L2 原文。

### 2.3 目录递归检索

OpenViking 的 HierarchicalRetriever 可以先检索目录摘要，再沿得分较高的目录向下递归，最后返回资源、记忆或技能。它区分快速检索和带意图分析、Rerank 的复杂检索。

参考：[检索机制](https://docs.openviking.ai/zh/concepts/07-retrieval)。

对 ProofBlade 的启发：

- 当前 Evidence Graph 的树和 DAG 可以作为上下文目录的逻辑结构。
- 一个 Artifact 不应该只作为孤立的文本块出现。
- 目录级摘要可以先告诉模型“哪里可能有答案”。
- 只有命中候选后才读取 L2，避免一次搜索读取所有 Artifact。
- 检索结果必须带 `searchedDirectories`、候选评分和来源链。

### 2.4 会话归档与记忆提取

OpenViking 的 Session 在提交后可以异步提取用户偏好、Agent 经验、任务案例和可复用技能。Session 的完整消息先归档，再进行后续提取。

参考：[会话管理](https://docs.openviking.ai/zh/concepts/08-session)。

ProofBlade 应只吸收“归档和异步提取”的流程，不默认开启跨 Run 的自动长期记忆。原因是 ProofBlade 的 CTF/代码分析结果可能包含：

- 候选答案。
- 私有源码。
- 目标凭据。
- 目标网络信息。
- 未验证假设。
- 仅适用于一次 Fixture generation 的观察。

所有跨 Run 记忆都必须经过显式分类、脱敏、来源绑定、人工或验证器确认和发布评测。

### 2.5 源数据与派生索引分离

OpenViking 的设计将文件系统视为源数据，向量数据库视为可重建的派生索引。索引丢失可以从源数据重建，源文件丢失则不能靠向量数据库恢复。

参考：[存储和事务说明](https://docs.openviking.ai/zh/concepts/09-transaction)。

ProofBlade 应采用同样的优先级：

```text
ArtifactStore / Session / ControlStore = canonical source
L0/L1 / inverted index / vectors = derived index
ModelContextFrame = request-scoped projection
```

任何索引、摘要或向量异常，都不能覆盖原始 Artifact、Session 或 ControlStore 事件。

### 2.6 检索轨迹和来源

OpenViking 的 `FindResult`、`QueryResult` 和 `ThinkingTrace` 可以记录检索过的目录、命中的上下文、评分和检索过程。它解决了“结果为什么被召回”的问题。

ProofBlade 必须把检索轨迹扩展成可审计对象：

```text
用户问题
 -> 查询规范化
 -> 查询规划
 -> 搜索范围
 -> L0 候选
 -> L1 候选
 -> L2 读取
 -> 最终进入 ModelContextFrame 的内容
 -> 模型后续动作
```

参考：[OpenViking 检索来源测试](https://github.com/volcengine/OpenViking/tree/7b0482576cc105b4a8ce1ea011c6c0285e51a509/tests/retrieve)。

## 3. ProofBlade 目标命名空间

ProofBlade 已经使用 `pb://` 作为知识引用协议，因此不引入 `viking://` 作为第二套模型 URI。采用同样的文件系统式语义，但继续使用 ProofBlade 的 URI。

### 3.1 命名空间

```text
pb://
├── project/
│   ├── resources/
│   ├── skills/
│   └── tools/
├── run/{runId}/
│   ├── artifacts/
│   ├── observations/
│   ├── evidence/
│   ├── facts/
│   ├── hypotheses/
│   ├── jobs/
│   ├── sessions/
│   ├── context/
│   └── retrieval/
└── user/{userId}/
    ├── memories/
    ├── experiences/
    └── preferences/
```

### 3.2 生命周期

| 命名空间 | 生命周期 | 默认可见范围 | 是否本阶段启用 |
| --- | --- | --- | --- |
| `project` | 项目级 | 当前工作区和安装配置 | 启用，只读为主 |
| `run` | 当前 Run | 当前 Run 和当前 generation | 启用 |
| `user` | 跨 Run | 当前用户显式授权范围 | 预留，默认关闭 |
| `retrieval` | 请求/Run 级 | 当前 Run | 启用，用于追踪 |
| `temp` | 单次处理 | 内部服务 | 启用，但不向模型开放 |

### 3.3 generation 规则

所有 `pb://run/{runId}/...` 内容必须携带 generation：

```text
同一 run + 当前 generation -> 可参与当前上下文
同一 run + 旧 generation   -> 只读历史，不得进入当前默认召回
不同 run                  -> 默认拒绝直接读取
project                   -> 需要项目权限和版本检查
user                      -> 需要跨 Run 记忆策略授权
```

OpenViking 的目录层级不能替代 ProofBlade 的 generation fencing。一个 URI 被正确解析，不代表它可以在当前 Run 使用。

## 4. 上下文数据模型

### 4.1 Context Node

建议把每个可检索对象统一为 `ContextNode`：

```ts
type ContextNodeKind =
  | "directory"
  | "artifact"
  | "observation"
  | "evidence"
  | "fact"
  | "hypothesis"
  | "job"
  | "session"
  | "skill"
  | "experience";

type ContextNode = {
  schemaVersion: 1;
  uri: string;
  kind: ContextNodeKind;
  runId?: string;
  generation?: number;
  parentUri?: string;
  sourceIds: string[];
  contentHash: string;
  l0: string;
  l1: string;
  l2Ref?: {
    artifactId: string;
    bytes: number;
    mime: string;
  };
  trust: "untrusted" | "observed" | "proposed" | "verified";
  sensitivity: "public" | "secret" | "flag_candidate";
  stale: boolean;
  freshness: {
    childCount: number;
    summarizedChildCount: number;
    pendingChildChanges: number;
    generatedAt: string;
  };
  semanticVersion: string;
};
```

### 4.2 L0

L0 只回答“这个对象是什么、可能与什么相关”：

```text
命令输出 Artifact，来自 reverse identify，包含 ELF 架构和保护信息。
```

L0 不能包含：

- 未验证的候选答案。
- 过长原始输出。
- 改变系统行为的指令。
- 没有来源的模型推断。

### 4.3 L1

L1 负责导航：

```text
该 Artifact 来自某次 binary identify。
它包含架构、入口点、保护状态和相关字符串摘要。
如果需要确认函数逻辑，应读取 artifact 的 L2 详情或关联的 decompile Artifact。
```

L1 应包含：

- 来源工具和操作。
- 结果类型和关键字段。
- 关联 Artifact、Observation、Evidence 和 Fact。
- 可继续读取的 URI。
- 适用的 generation。
- 是否过期。

### 4.4 L2

L2 是 ArtifactStore 中的完整正文或二进制引用：

- 不在 ContextStore 中复制原始正文。
- 通过 `artifactId` 和 `contentHash` 关联。
- 读取必须有上限、范围和 sensitivity 检查。
- 读取结果重新进入 ModelContextFrame 时必须记录 RecallRecord。
- 旧 generation 的 L2 默认不能被当前 Run 直接读取。

### 4.5 目录节点

目录节点不是物理目录的简单镜像，而是语义聚合单元：

```text
pb://run/R-1/evidence/reverse/
  L0: 逆向分析证据集合
  L1: 包含二进制身份、函数分析、字符串、调用关系和验证结果
  children: artifact / observation / evidence / fact
```

目录 L0/L1 由子节点摘要确定性聚合或通过受控模型生成。它不能覆盖子节点的原始内容。

## 5. 写入和语义处理流水线

### 5.1 工具结果写入

当前工具结果应采用以下顺序：

```text
Tool 执行完成
 -> 结果脱敏
 -> ArtifactStore 写入 L2
 -> ControlStore 追加 artifact_registered
 -> 自动生成 Observation
 -> 生成初始 ContextNode L0/L1
 -> 加入语义处理队列
 -> 建立确定性索引
 -> 可选建立向量索引
 -> 更新父目录 freshness
```

模型不应等待 L0/L1 或向量索引生成完成后才收到工具结果。工具立即返回的结果必须可以直接使用，语义处理属于异步增强。

### 5.2 语义处理队列

建议新增可恢复队列：

```ts
type ContextProcessingJob = {
  schemaVersion: 1;
  jobId: string;
  runId: string;
  generation: number;
  sourceArtifactIds: string[];
  targetUris: string[];
  operation: "build_l0_l1" | "index_terms" | "index_vectors" | "refresh_parent";
  semanticVersion: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STALE";
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};
```

队列规则：

- 任务必须绑定 Run 和 generation。
- reset 后旧 generation 任务标记为 `STALE`，不能写入新 generation。
- 相同目录的父级刷新任务需要 coalescing。
- 语义生成失败不影响 L2 Artifact 和直接 Tool Result。
- 向量索引失败不影响确定性关键词索引。
- 任务结果写回前再次检查内容 hash 和 generation。
- 进程重启后从 durable queue 恢复。

### 5.3 模型生成摘要的边界

L0/L1 可以使用一个单独的轻量模型生成，但该模型不是 Verifier，也不是事实来源。摘要生成器必须：

- 只能读取已保存的 L2 内容。
- 不能修改 ControlStore 事实、Evidence 或 Completion。
- 不能将模型自述变成 Verified Evidence。
- 必须保留 source Artifact id 和 contentHash。
- 生成失败时返回确定性 fallback 摘要。
- 记录模型、Provider、Prompt hash 和生成版本。

建议第一版默认使用确定性摘要：文件名、工具名、类型、字节数、已有 Observation summary 和 Evidence summary。只有消融实验证明模型摘要有收益后，再启用真实摘要模型。

## 6. 检索设计

### 6.1 两类检索入口

ProofBlade 应提供两个语义明确的入口：

```text
find(query, scope, filters)
  快速、确定性、无额外 LLM 查询规划

search(query, sessionContext, scope, filters)
  可选查询扩展、多个 Typed Query、复杂层级检索
```

默认 Agent 路径优先使用 `find` 或确定性 `search`。查询规划模型只能作为显式可消融策略，不能在每次普通读取中自动调用。

### 6.2 检索流程

```text
1. 校验 query、run、generation 和 scope
2. 判断是否为空查询、闲聊或已有上下文足够
3. 规范化查询词、文件路径、工具名和 Evidence id
4. 先查精确 URI、Artifact id、Evidence id
5. 再查结构化字段和确定性倒排索引
6. 必要时查 L0/L1 向量索引
7. 在候选目录中递归查找子节点
8. 可选执行 Rerank
9. 生成 RetrievalTrace
10. 返回 L0/L1 结果和 L2 回取入口
```

### 6.3 检索模式

| 模式 | 默认 | 是否调用 Embedding | 是否读取 L2 | 用途 |
| --- | --- | --- | --- | --- |
| `exact` | 是 | 否 | 仅指定对象 | Artifact、Evidence、Fact 精确读取 |
| `keyword` | 是 | 否 | 可选 | 低延迟文本查询 |
| `hierarchical` | 可选 | 可选 | 候选后读取 | 目录式资源检索 |
| `semantic` | 可选 | 是 | 候选后读取 | 同义表达和长任务 |
| `hybrid` | 实验 | 是 | 候选后读取 | 关键词与向量组合 |
| `query_planned` | 实验 | 可选 | 候选后读取 | 复杂意图拆解 |

### 6.4 候选评分

第一版评分只作为排序信号，不代表信任：

```text
score =
  0.30 * lexicalRelevance
+ 0.20 * semanticRelevance
+ 0.18 * scopeMatch
+ 0.12 * claimCoverage
+ 0.08 * novelty
+ 0.06 * sourceIndependence
+ 0.06 * freshness
- 0.12 * estimatedCost
- 0.10 * staleRisk
```

如果某类检索没有语义分数，必须显式标记为 `semanticRelevance=unavailable`，不能用固定值伪装向量模型已经参与。

### 6.5 层级递归

ProofBlade 的目录递归搜索应采用有界优先队列：

```text
候选目录入队
 -> 读取目录 L0
 -> 选择高相关目录
 -> 读取目录 L1
 -> 选择子目录/文件
 -> 返回 top-k L0/L1
 -> 只有模型需要时读取 L2
```

必须有：

- 最大递归深度。
- 最大目录访问数。
- 最大候选数。
- 最大检索时间。
- 最大向量查询数。
- 最大 Rerank 输入 Token。
- 无结果或超时的确定性降级路径。

### 6.6 检索结果格式

```ts
type RetrievalHit = {
  uri: string;
  kind: ContextNodeKind;
  level: "L0" | "L1" | "L2_REF";
  score?: number;
  matchReason: "exact" | "keyword" | "semantic" | "parent_context" | "evidence_link";
  summary: string;
  sourceIds: string[];
  artifactRefs: string[];
  evidenceRefs: string[];
  generation?: number;
  stale: boolean;
  recallPlan?: {
    operation: "read" | "inspect_uri" | "search_uri";
    arguments: Record<string, string | number | boolean>;
  };
};
```

模型默认收到 `RetrievalHit` 的有界摘要，不收到无界原文。

## 7. RetrievalTrace 检索轨迹

### 7.1 轨迹对象

```ts
type RetrievalTrace = {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  generation: number;
  requestId?: string;
  query: string;
  normalizedQuery: string;
  mode: "exact" | "keyword" | "hierarchical" | "semantic" | "hybrid" | "query_planned";
  targetUris: string[];
  plannedQueries: Array<{
    query: string;
    contextType: "artifact" | "observation" | "evidence" | "skill" | "experience";
    priority: number;
  }>;
  visitedDirectories: Array<{
    uri: string;
    level: "L0" | "L1";
    score?: number;
    childCount: number;
    elapsedMs: number;
  }>;
  candidates: Array<{
    uri: string;
    level: "L0" | "L1" | "L2_REF";
    score?: number;
    reason: string;
    selected: boolean;
    omittedReason?: string;
  }>;
  selectedRefs: string[];
  injectedRefs: string[];
  modelUsedRecall: boolean;
  latencyMs: number;
  createdAt: string;
};
```

### 7.2 轨迹用途

RetrievalTrace 要能回答：

- 为什么召回了这个 Artifact？
- 哪个目录摘要让它进入候选集？
- 为什么没有召回另一个明显相关结果？
- 是关键词、向量、Evidence 链还是父目录传播命中的？
- 命中结果是否真正进入了模型上下文？
- 模型是否读取了 L2？
- 读取后是否改变了下一步动作？
- 检索耗时主要花在哪里？

### 7.3 隐私边界

轨迹默认保存：

- 查询 hash 或经过脱敏的查询。
- URI、Artifact id 和 Evidence id。
- 分数、候选数量、耗时和策略版本。
- 内容 hash。

轨迹默认不保存：

- API Key。
- Authorization Header。
- 未脱敏 Cookie。
- 候选 flag 明文。
- 隐藏评分脚本。
- 不必要的完整 Tool Result。

## 8. ModelContextFrame 集成

### 8.1 统一组装

OpenViking 风格的 Context Database 只能在 `ContextAssembler` 中发挥作用：

```text
Session history
 + 当前用户消息
 + Durable Ledger
 + Observation Queue
 + RAG L0/L1 hits
 + 必要的 L2 recall
 + Tool Result receipt
 -> ContextAssembler
 -> ModelContextFrame
 -> Provider payload
```

### 8.2 上下文内容策略

默认模型上下文只保留：

```text
当前用户任务
当前状态和预算
最近完整工具结果
高相关 L0/L1 候选
关键 Evidence/Facts
待处理后台任务
必要的 Recall 入口
```

完整 L2 只在以下情况下进入模型：

- 模型显式读取。
- 当前决策需要该详情。
- Verifier 要求展示相关原文。
- 确定性检索判断该详情是高价值信息。

### 8.3 关键规则

```text
Artifact 已写入 != 模型已经知道
检索命中       != 内容已进入上下文
内容进入上下文 != 模型使用了内容
模型使用内容   != 内容已经被验证
```

这四个状态必须在 Frame 和报告中分别记录。

### 8.4 自动召回

自动召回分为三个等级：

| 等级 | 行为 | 默认 |
| --- | --- | --- |
| `status_only` | 只告诉模型有多少结果、来源和 URI | 普通后台事件 |
| `summary_inject` | 注入 L0/L1 摘要和回取入口 | 当前默认推荐 |
| `detail_inject` | 直接注入 L2 有界正文 | 只有高价值或显式请求 |

自动召回不能在每轮无条件把所有历史结果重新注入，否则会重新制造上下文爆炸。

## 9. Tool Result 与 OpenViking 风格外部化

OpenViking 的 Agent 集成对大工具输出采用外部化：超过阈值的结果保存到 session tool-result 存储，模型只看到摘要 stub 和 `tool_output_ref`，之后可以通过专门入口读取。

参考：[OpenViking Pi 集成](https://docs.openviking.ai/zh/agent-integrations/11-pi) 和 [Codex 集成](https://docs.openviking.ai/zh/agent-integrations/04-codex)。

ProofBlade 应实现同样的语义，但使用自己的 Artifact URI：

```text
工具输出
 -> 完整 L2 Artifact
 -> 有界 Receipt
 -> pb://run/.../artifacts/...
 -> evidence.read / knowledge.inspect_uri
```

### 9.1 Receipt 必须包含

```text
操作名称
执行状态
摘要
关键字段
结果 hash
Artifact URI
已显示字节数
省略字节数
generation
信任级别
下一步回取操作
```

### 9.2 不能只返回路径

纯路径返回的问题是模型不知道：

- 路径是什么类型。
- 为什么应该读取。
- 读取时应该使用哪个工具。
- 读取的范围是什么。
- 该内容是否已过期。
- 该内容是否可信。

推荐返回：

```text
结果已保存为当前 Run 的 Artifact。
摘要：...
完整内容：pb://run/R-1/artifacts/A-123/content
状态：当前 generation，可读取
如需详情：调用 evidence.read，artifactId=A-123，maxChars=4000。
不要重新执行原命令。
```

### 9.3 与 ProofBlade Evidence 的关系

OpenViking 风格的 ContextNode 可以关联 Evidence，但不能自动将所有 Artifact 变成正式 Evidence：

```text
Tool Result -> Artifact -> Observation
                           |
                           +-> 可检索 ContextNode
                           |
                           +-> 只有模型/Verifier 显式确认后才成为 Evidence
```

这样既能让模型找回信息，也不会让噪声污染可信证据链。

## 10. 会话、记忆和经验

### 10.1 当前阶段的默认策略

当前阶段只启用 Run 内记忆：

```text
同一 Run + 同一 generation：自动可召回
同一 Run + 旧 generation：历史只读，默认不召回
不同 Run：默认不召回
用户记忆：默认关闭
Agent 经验：默认关闭
Skill 自动升级：默认关闭
```

### 10.2 跨 Run 记忆的后续接口

预留：

```ts
type MemoryCandidate = {
  candidateId: string;
  sourceRunId: string;
  sourceGeneration: number;
  sourceRefs: string[];
  kind: "preference" | "experience" | "case" | "skill_patch";
  summary: string;
  contentHash: string;
  sensitivity: "public" | "private" | "secret";
  status: "PROPOSED" | "REVIEWED" | "ACTIVATED" | "REJECTED";
  evaluationRefs: string[];
};
```

只有 `ACTIVATED` 的记忆才允许进入未来 Run 的默认 Context Database。激活必须关联：

- 触发失败集。
- 保留集。
- 迁移集。
- 安全集。
- 评测结果。
- 回滚版本。

### 10.3 会话提交

未来可以参考 OpenViking 的 Session Commit：

```text
Session active
 -> Session archive
 -> 提取 memory candidates
 -> 脱敏和来源校验
 -> 评测
 -> 人工/策略批准
 -> 激活到 project/user Context Database
```

这不能放在当前 Provider turn 的关键路径上。会话结束或空闲后异步处理，失败不能影响当前 Run 已经完成的结果。

## 11. OpenViking 风格目录与现有 Evidence Graph 的映射

### 11.1 映射关系

| OpenViking 概念 | ProofBlade 实现 |
| --- | --- |
| 虚拟目录 | `pb://` 逻辑目录 URI |
| 资源文件 | Artifact |
| 目录 L0/L1 | ContextNode 的摘要和概览 |
| L2 详情 | ArtifactStore 原文 |
| 记忆 | Future MemoryCandidate |
| 技能 | Skill Registry + project URI |
| session | Pi Session + Run Session |
| 检索轨迹 | RetrievalTrace |
| 目录递归 | Evidence/Artifact 关系和语义目录树 |
| 向量索引 | 可选派生 RetrievalIndex |
| QueueFS | ContextProcessingJob durable queue |
| Path Lock | ControlStore/Artifact 写入锁和 generation 校验 |

### 11.2 不做双重图谱

不能同时维护：

```text
一套 OpenViking graph
一套 ProofBlade Evidence Graph
一套 Knowledge projection graph
```

推荐：

```text
Evidence Graph = 可信关系和推理来源
Context Database = 面向导航和检索的派生视图
```

Context Database 的节点关系从 Evidence Graph、Artifact、Observation 和 Session 派生。它不能反向创造未经验证的 Evidence 关系。

## 12. 性能设计

OpenViking 的优点之一是通过目录摘要和分层加载降低 Token 与查询成本，但语义处理、Embedding、Rerank 和远程服务也可能引入新的延迟。ProofBlade 必须同时测量收益和代价。

### 12.1 低延迟原则

- Tool Result 先返回，L0/L1 后台生成。
- 先查精确 id 和关键词索引，再调用 Embedding。
- 查询规划模型默认关闭或设置极短超时。
- Rerank 只处理有界候选。
- 单次检索不读取全部 Artifact L2。
- 目录摘要按 coalescing 任务刷新。
- 索引读取使用缓存和版本号。
- UI 先显示目录和摘要，再延迟读取详情。
- 不在每次 Context 编译时重新扫描所有 Artifact。

### 12.2 性能指标

```text
context_node_write_ms
l0_l1_generation_ms
index_enqueue_ms
index_ready_ms
exact_lookup_ms
keyword_search_ms
hierarchical_search_ms
embedding_ms
rerank_ms
retrieval_trace_persist_ms
model_context_assembly_ms
model_context_frame_persist_ms
artifact_l2_recall_ms
```

### 12.3 目标阈值

初版建议目标：

| 操作 | p50 | p95 | 失败行为 |
| --- | ---: | ---: | --- |
| 精确 Artifact id 查询 | 20 ms | 100 ms | 返回结构化错误 |
| 已建关键词索引查询 | 50 ms | 250 ms | 回退到有限范围扫描 |
| L0/L1 层级检索 | 300 ms | 1500 ms | 返回已有摘要或空结果 |
| L2 有界读取 | 100 ms | 1000 ms | 保留 URI，显示读取失败 |
| 上下文组装 | 50 ms | 300 ms | 保留最近 Session history |
| MCP/Skill 状态查询 | 100 ms | 500 ms | 显示加载中/不可用 |

这些是工程目标，不是当前已测结果。真实 Provider 请求延迟必须单独报告。

## 13. 配置设计

### 13.1 初版配置

```json
{
  "contextDatabase": {
    "enabled": true,
    "namespace": "pb",
    "l0": {
      "enabled": true,
      "maxChars": 256,
      "generator": "deterministic"
    },
    "l1": {
      "enabled": true,
      "maxChars": 4000,
      "generator": "deterministic"
    },
    "l2": {
      "maxRecallBytes": 6000,
      "allowRange": true
    },
    "retrieval": {
      "defaultMode": "keyword",
      "maxResults": 8,
      "maxDirectories": 16,
      "maxDepth": 4,
      "queryPlanner": "off",
      "embedding": "off",
      "rerank": "off"
    },
    "memory": {
      "crossRun": false,
      "autoCommit": false
    },
    "startup": {
      "indexLoad": "async",
      "semanticProcessing": "async",
      "blockConversationOnIndex": false
    }
  }
}
```

### 13.2 真实模型配置

如果使用 OpenViking 的语义摘要、Embedding 或 Rerank Provider，必须独立配置：

```json
{
  "contextDatabase": {
    "l0": { "generator": "provider" },
    "l1": { "generator": "provider" },
    "retrieval": {
      "embedding": "provider",
      "rerank": "provider"
    }
  },
  "providers": {
    "contextSemantic": {
      "profileId": "local-or-gateway-profile",
      "model": "具体模型名称",
      "apiKeyEnv": "PROOFBLADE_CONTEXT_PROVIDER_KEY"
    }
  }
}
```

要求：

- 正式实验必须选择具体模型，不能使用 `auto`。
- 摘要模型与执行模型可以不同，但必须分别记录。
- 语义模型请求不能携带隐藏答案或候选 flag。
- Key 只通过本地 Profile、环境变量或一次性进程凭据提供。
- Context Database 的请求成本应从 Agent 执行成本中单独统计。
- Provider 失败时继续使用确定性 L0/L1 fallback。

## 14. API 设计

### 14.1 Context Database 服务

```ts
interface ContextDatabase {
  putArtifact(input: {
    runId: string;
    generation: number;
    artifactId: string;
  }): Promise<{ uri: string; node: ContextNode }>;

  list(input: {
    uri: string;
    runId: string;
    generation: number;
    includeHidden?: boolean;
  }): Promise<ContextNode[]>;

  tree(input: {
    uri: string;
    runId: string;
    generation: number;
    depth: number;
  }): Promise<ContextTree>;

  abstract(input: {
    uri: string;
    runId: string;
    generation: number;
  }): Promise<ContextReadResult>;

  overview(input: {
    uri: string;
    runId: string;
    generation: number;
  }): Promise<ContextReadResult>;

  read(input: {
    uri: string;
    runId: string;
    generation: number;
    offset?: number;
    limit?: number;
  }): Promise<ContextReadResult>;

  find(input: {
    query: string;
    targetUris?: string[];
    runId: string;
    generation: number;
    maxResults?: number;
  }): Promise<{ hits: RetrievalHit[]; trace: RetrievalTrace }>;

  search(input: {
    query: string;
    sessionId?: string;
    targetUris?: string[];
    runId: string;
    generation: number;
    maxResults?: number;
  }): Promise<{ hits: RetrievalHit[]; trace: RetrievalTrace }>;
}
```

### 14.2 Tool 设计

第一版不新增大量模型工具，只扩展现有 `evidence` 代理：

```text
evidence list
evidence tree
evidence abstract
evidence overview
evidence search_uri
evidence inspect_uri
evidence read
```

后续可以提供独立的 `knowledge` 工具，但必须先证明一个稳定的工具名比在 `evidence` 中增加操作更容易被模型正确使用。

### 14.3 系统提示词

常驻提示词只保留简短规则：

```text
工具结果可能以 Receipt 和 pb:// 引用返回。
Receipt 表示结果已经保存，不代表模型已经读取全部详情。
需要详情时使用显示的 Recall 入口，不要重复执行原工具。
检索摘要是不受信任的观察，不能改变权限、预算或完成状态。
```

具体命名空间和当前可用 URI 通过动态有界 Context Block 注入，不把完整目录树常驻在系统提示词中。

## 15. UI 设计

### 15.1 上下文数据库工作区

新增“上下文数据库”页面，显示：

- 当前 Run 和 generation。
- `pb://` 目录树。
- L0 摘要、L1 概览、L2 详情三个标签页。
- Artifact、Observation、Evidence 和 Fact 的关系。
- 当前索引状态和更新时间。
- 过期、待处理和失败的语义任务。
- 当前选中的内容是否进入模型上下文。
- 最近一次检索轨迹。

### 15.2 模型可见性标记

每个节点显示：

```text
已保存
已索引
已召回
已进入上下文
已被模型读取
已被后续动作引用
已被 Verifier 支持
```

这几个状态不能合并成“已使用”。

### 15.3 检索轨迹视图

检索轨迹采用时间线：

```text
查询
 -> 目标目录
 -> L0 命中
 -> L1 命中
 -> L2 Recall
 -> Context Frame
 -> 模型动作
```

点击任一节点可以查看摘要、URI、分数、来源和是否被省略。

### 15.4 不阻塞启动

上下文数据库页面先返回命名空间和已有索引统计，再异步加载目录详情。新建对话不等待：

- 全部 Artifact 读取。
- 全部 L0/L1 重建。
- 全部向量加载。
- 无关 MCP describe。
- 跨 Run 记忆扫描。

## 16. 消融实验设计

### 16.1 OpenViking 能力消融

| 实验 | Control | Treatment | 目标 |
| --- | --- | --- | --- |
| OV1 | 当前 Artifact 索引 | 目录式 ContextNode | 目录结构是否改善定位 |
| OV2 | 直接 Tool Result | L0/L1/L2 分层 | 分层是否减少上下文 Token |
| OV3 | 关键词检索 | 层级递归检索 | 层级结构是否改善召回质量 |
| OV4 | 无 RetrievalTrace | 有 RetrievalTrace | 轨迹是否降低错误分析成本 |
| OV5 | 全量 Artifact 扫描 | 建立倒排索引 | 延迟是否下降 |
| OV6 | 无自动召回 | L0/L1 摘要自动注入 | 模型是否更容易找到已有信息 |
| OV7 | 手动 L2 读取 | 明确 Receipt + Recall | 模型是否减少重复工具调用 |
| OV8 | 固定最近消息 | 查询相关 ContextNode | 长任务中是否减少信息丢失 |
| OV9 | 无会话归档 | 会话结束生成经验候选 | 经验是否提升后续任务 |
| OV10 | 无向量检索 | 向量检索 | 向量是否超过确定性检索的收益 |

### 16.2 必须区分的指标

```text
检索命中率
进入上下文率
模型 Recall 率
Recall 后动作改变率
Recall 后正确动作率
关键证据遗漏率
重复工具调用率
模型请求 Token
总 Recall Token
总墙钟时间
Verified Success
Evidence-backed Success
```

如果只看检索命中率，不能证明 OpenViking 风格设计改善了 Agent。

### 16.3 真实模型选择

消融实验必须支持：

- 执行模型选择。
- L0/L1 摘要模型选择。
- Embedding 模型选择。
- Rerank 模型选择。
- 查询规划模型选择。
- 思考等级和采样参数。

每个模型都要有独立的 ModelSnapshot 和成本统计。不能把 Context Database 的额外模型调用隐藏在 Agent 请求成本中。

## 17. 第 7 章评估协议映射

OpenViking 风格集成必须放入第 7 章要求的评估闭环：

```text
评估任务
 -> 可重置环境
 -> 工具结果和 Artifact
 -> Context Database 处理
 -> 检索/Recall
 -> Agent 动作
 -> Deterministic Verifier
 -> RetrievalTrace + ModelContextFrame
 -> 首错归因
 -> 下一轮消融
```

### 17.1 任务集要求

至少覆盖：

- 短任务与长任务。
- 工具结果在开头、中间和结尾含关键事实的任务。
- 需要多次范围读取的文件。
- 需要跨工具关联的证据。
- Evidence 冲突任务。
- 后台 Job 完成后继续分析的任务。
- Context compaction 后恢复的任务。
- 需要模型主动 Recall 的任务。
- 结果存在但摘要错误的任务。
- 检索命中错误目录的任务。

### 17.2 防止答案泄漏

L0、L1、RetrievalTrace 和实验报告都不能包含：

- 隐藏评分器目标。
- 候选 flag 明文。
- 任务答案文件的完整内容。
- Verifier 私有命令。
- 不应进入当前 generation 的旧答案。

测试必须确认“检索更方便”没有变成“评分答案泄漏”。

## 18. 分阶段实现计划

### P0：文档和数据模型冻结

交付：

- ContextNode、ContextTree、RetrievalHit、RetrievalTrace 类型。
- `pb://` 命名空间和 generation 规则。
- Context Database 与 Evidence Graph 的 owner 边界。
- 版本、敏感级别、freshness 和 stale 语义。

测试：

- URI 解析和规范化稳定。
- 不同 Run、旧 generation 和越界 URI 拒绝。
- Node 的 L0/L1/L2 关系完整。
- ContextNode 不能改变 ControlStore 事实。

### P1：ContextNode 和 L0/L1/L2

交付：

- Artifact 自动生成 ContextNode。
- 确定性 L0/L1 fallback。
- L2 通过 ArtifactStore 读取。
- 目录节点和 freshness。

测试：

- Tool Result 保存成功后立即可用，不等待语义任务。
- L0/L1 生成失败不影响 L2。
- L0/L1 不包含敏感候选。
- 子节点更新后父目录标记 pending。
- 相同输入和版本生成相同摘要。

### P2：异步语义处理队列

交付：

- ContextProcessingJob。
- Durable queue、重试和 stale fencing。
- 父目录刷新合并。
- 异步处理状态和错误分类。

测试：

- 崩溃后任务可以恢复。
- reset 后旧任务不能写入新 generation。
- 相同目录并发刷新只保留最新结果。
- 任务失败不会导致工具结果失败。
- 重放不会重复写入节点。

### P3：确定性检索和索引

交付：

- 精确 URI、id、结构化字段查询。
- Artifact 注册时写入倒排索引。
- `find` 和 `search` 的统一返回格式。
- RetrievalTrace。

测试：

- 查询不再遍历全部 Artifact 正文。
- 关键词结果与旧全扫描结果一致。
- 检索结果受 Run/generation 隔离。
- 每个候选都有来源和命中原因。
- 结果被 ContextAssembler 选中后可以关联 frame。

### P4：ModelContextFrame 和 Receipt/Recall

交付：

- Provider 最终 payload 的 frame 记录。
- Receipt 统一格式。
- 被省略结果的回取计划。
- 最新 Tool Result 保护。

测试：

- 大结果被外部化后，模型可见内容包含正确回取入口。
- `details` 丢失时，模型仍能读取必要的 URI。
- Recall 后内容进入下一次 Provider 请求。
- Recall 不重复注入相同正文。
- UI 显示模型看到和没有看到的内容。

### P5：层级检索和可选向量

交付：

- 目录 L0/L1 递归检索。
- Embedding 后端接口。
- Rerank 接口。
- 查询超时和确定性降级。

测试：

- 向量不可用时回退到关键词。
- Rerank 失败时保留向量排序。
- 超时不阻塞普通 Tool Result。
- 递归深度、候选数和 Token 上限有效。
- 语义搜索结果带完整路径和检索轨迹。

### P6：启动异步化和 UI

交付：

- 上下文数据库目录页面。
- L0/L1/L2 详情页面。
- RetrievalTrace 时间线。
- Index pending/ready/failed 状态。
- MCP、Skill 和 Context Database 协同异步加载。

测试：

- 新建对话不等待无关索引和 MCP。
- 慢索引不会阻塞模型首轮。
- UI 状态可以从持久事件恢复。
- 详情按需加载，不在列表页读取全部 L2。

### P7：会话归档和经验候选

交付：

- Session archive。
- MemoryCandidate 和 ExperienceCandidate。
- 脱敏、来源、评测和批准流程。
- 默认关闭跨 Run 召回。

测试：

- 会话归档失败不影响当前 Run。
- 候选记忆不自动进入未来上下文。
- 未验证推理不能变成长期记忆。
- 跨项目和跨用户访问被拒绝。
- 记忆候选可以回滚和停用。

### P8：消融和真实 Provider 评测

交付：

- OV1-OV10 实验配置。
- 执行模型、摘要模型、Embedding 模型和 Rerank 模型选择。
- RetrievalTrace、ModelContextFrame 和成本统计。
- Pass@k、Pass^k、Evidence-backed Success 和延迟报告。

测试：

- 同模型不同 RAG 策略可以配对。
- 同 RAG 策略不同模型可以替换。
- 真实 Provider 请求有明确模型快照。
- 检索命中、上下文进入和模型使用分别统计。
- 结果不包含 Key 或隐藏答案。

## 19. 测试矩阵

### 19.1 上下文可见性

| 场景 | 必须验证 |
| --- | --- |
| 小型工具结果 | 原文进入下一次 Provider 请求 |
| 大型工具结果 | Receipt、Artifact、Recall 入口都可见 |
| 最新大型结果 | 首次维护不被无理由压缩 |
| 旧工具结果 | 摘要、URI 和回取路径保留 |
| 后台 Job | 完成状态进入下一次上下文 |
| Context compaction | 事实、Evidence 和回取路径保留 |
| 进程重启 | Frame 和 Session 可重建 |
| Provider 角色转换 | 最终 payload 和 frame 一致 |

### 19.2 检索正确性

| 场景 | 必须验证 |
| --- | --- |
| 精确 Artifact id | O(1) 级直接定位，不扫描全文 |
| 关键词查询 | 结果与索引建立前的一致性基线相符 |
| 多目录查询 | 目录访问数和深度受限 |
| 向量不可用 | 回退到确定性检索 |
| Rerank 不可用 | 保留基础排序 |
| 旧 generation | 默认不进入当前召回 |
| 错误摘要 | L2 原文仍可以直接读取 |
| 索引落后 | freshness 显示 pending |

### 19.3 性能

| 场景 | 必须验证 |
| --- | --- |
| 100 个 Artifact | 查询不全量读取正文 |
| 1000 个 Artifact | 索引查询 p95 不线性增长到分钟级 |
| 10 个并发索引任务 | 父目录刷新合并，资源不会无限增长 |
| 慢摘要 Provider | Agent 仍可以继续使用工具 |
| MCP describe 慢 | 新建普通对话不被阻塞 |
| 大 L2 | 列表和 L0/L1 页面不加载全文 |

## 20. 故障和降级策略

### 20.1 摘要模型失败

```text
Provider 摘要失败
 -> 记录 semantic_generation_failed
 -> 使用确定性 L0/L1 fallback
 -> 保留 L2
 -> 不阻塞当前 Agent
```

### 20.2 Embedding 失败

```text
Embedding 失败
 -> RetrievalTrace 标记 vector_unavailable
 -> 使用 exact/keyword/hierarchical deterministic
 -> 不删除已有索引
```

### 20.3 索引损坏

```text
索引校验失败
 -> 标记 index_corrupt
 -> 临时使用有限范围确定性扫描
 -> 后台从 ArtifactStore 重建
 -> 重建后比较 index hash
```

### 20.4 Context Database 服务不可用

普通 Coding Assistant 必须继续工作：

- 直接使用 Pi Session。
- 使用 Artifact id 的基础读取。
- 使用当前 ControlStore Ledger。
- 禁止把“Context Database 不可用”伪装成“没有结果”。

CTF 模式可以在需要可信 Evidence 或提交时暂停，但不能因为 RAG 服务不可用而丢失已经返回的 Tool Result。

## 21. 安全与权限

### 21.1 URI 不是权限

模型拿到 `pb://run/R-1/artifacts/A-1` 不代表它可以读取。读取还需要：

```text
runId 匹配
generation 匹配
owner lane 匹配
sensitivity 允许
Artifact 存在
contentHash 校验
读取范围在上限内
```

### 21.2 不可信上下文

网页、命令输出、文件内容和外部 MCP 返回全部标记为不可信观察。L0/L1 生成也必须继承不可信属性，不能因为摘要是模型生成的就变成可信指令。

### 21.3 跨 Run 记忆

跨 Run 记忆必须明确：

- 用户身份。
- 项目范围。
- 读取授权。
- 数据敏感级别。
- 记忆来源。
- 是否经过确认。
- 是否已过期。

当前阶段默认不做自动跨 Run 记忆召回。

## 22. 与 OpenViking 的边界和集成方式

### 22.1 推荐集成方式

第一阶段不复制 OpenViking Python/Rust 代码，也不把 OpenViking 作为 ProofBlade 内部事实库。推荐三种逐步方式：

1. **思想兼容实现**：在 ProofBlade 内部实现 `pb://`、L0/L1/L2、RetrievalTrace 和确定性索引。
2. **HTTP/MCP 旁路集成**：把 OpenViking 作为可选外部 Context Database，通过明确 Adapter 访问。
3. **消融实验对比**：同一模型、同一任务、ProofBlade 内建 RAG 与 OpenViking Adapter 配对比较。

### 22.2 外部 OpenViking Adapter

预留：

```ts
interface ExternalContextDatabaseAdapter {
  readonly id: string;
  readonly version: string;
  health(signal?: AbortSignal): Promise<ContextDatabaseHealth>;
  find(input: ExternalFindInput, signal?: AbortSignal): Promise<ExternalFindResult>;
  read(input: ExternalReadInput, signal?: AbortSignal): Promise<ExternalReadResult>;
  writeSession(input: ExternalSessionInput, signal?: AbortSignal): Promise<ExternalSessionResult>;
  close(): Promise<void>;
}
```

外部 Adapter 返回的内容必须重新包装为 ProofBlade `ContextNode`、`RetrievalHit` 和 `RetrievalTrace`，并经过同样的 generation、scope、sensitivity 和 frame 校验。

### 22.3 不允许的集成方式

- 直接把 OpenViking 返回的所有 L2 内容注入系统提示词。
- 让外部向量分数直接决定 Verifier Completion。
- 让外部记忆覆盖当前 Run 的事实。
- 让远程服务持有未脱敏候选答案。
- 在当前 Agent turn 中同步等待所有语义处理。
- 同时启用 ProofBlade Evidence Graph 和外部图谱的双向自动写入。

### 22.4 许可证和依赖边界

OpenViking 主项目当前 README 标注为 AGPLv3，`crates/ov_cli` 和部分示例有不同许可证。ProofBlade 不应直接复制其受许可约束的源码；若采用外部服务、HTTP 或 MCP 边界，应在依赖引入和发布前进行许可证审查。

这不是功能正确性的替代品，仍需保留 Adapter 的版本、来源、配置 hash 和回滚能力。

## 23. 真实实验方案

### 23.1 第一轮只验证三个问题

不要一开始同时验证目录递归、向量、Rerank、自动记忆和查询规划。先验证：

1. L0/L1/L2 是否减少模型上下文，同时不增加关键证据遗漏。
2. Receipt + Recall 是否减少重复工具调用和模型“忘记结果”。
3. RetrievalTrace + ModelContextFrame 是否能解释失败。

### 23.2 推荐实验配置

```json
{
  "experimentId": "OV-INSPIRED-001",
  "name": "ProofBlade Context Database 基线实验",
  "language": "zh-CN",
  "model": {
    "providerProfileId": "profile-1",
    "model": "具体执行模型",
    "thinkingLevel": "medium"
  },
  "contextSemanticModel": {
    "providerProfileId": "profile-2",
    "model": "具体摘要模型",
    "enabled": false
  },
  "retrieval": {
    "mode": "keyword",
    "embedding": "off",
    "rerank": "off",
    "queryPlanner": "off"
  },
  "variants": [
    { "id": "direct", "contextDatabase": false, "receipt": false, "recall": false },
    { "id": "layered", "contextDatabase": true, "receipt": true, "recall": true },
    { "id": "layered_trace", "contextDatabase": true, "receipt": true, "recall": true, "trace": true }
  ],
  "budget": {
    "attemptsPerTask": 5,
    "maxTurns": 40,
    "maxCostUsd": 20,
    "deadlineMs": 900000
  }
}
```

### 23.3 通过标准

Treatment 至少需要满足：

- Verified Success 不下降超过非劣效界限。
- Evidence-backed Success 不下降。
- 关键 Artifact 遗漏率不增加。
- 重复工具调用减少。
- 总上下文 Token 减少，且 Recall Token 计入总成本。
- p95 延迟不超过预算。
- RetrievalTrace 能解释失败。
- Context Database 不可用时仍能降级。

## 24. 开发完成后的用户体验

用户不应再看到这样的行为：

```text
工具返回结果
 -> UI 显示结果
 -> 结果被存入 Artifact
 -> 模型下一轮只看到摘要或空白
 -> 模型重复读取同一文件
 -> Harness 再次阻断重复调用
```

目标行为是：

```text
工具返回结果
 -> 模型看到有界完整结果或 Receipt
 -> Receipt 明确给出 pb:// URI 和 Recall 操作
 -> 上下文维护保留最新结果和来源
 -> 模型需要时读取 L2
 -> RetrievalTrace 记录路径
 -> ModelContextFrame 记录最终可见内容
 -> 模型可以自由选择下一步
```

## 25. 最终验收清单

### 功能

- [ ] Artifact、Observation、Evidence、Fact 和 Skill 可以映射到 `pb://`。
- [ ] 每个对象都有 L0/L1/L2 或明确的不可用状态。
- [ ] L2 仍由 ArtifactStore 保持完整。
- [ ] 目录摘要可以导航，但不能替代原始证据。
- [ ] 精确、关键词、层级和可选语义检索接口分离。
- [ ] 检索轨迹可以回放。
- [ ] Receipt 和 Recall 对所有大结果统一。
- [ ] 会话归档和长期记忆默认不影响当前 Agent。

### 上下文

- [ ] 每个 Provider 请求有 ModelContextFrame。
- [ ] Frame 显示每条消息来源、大小和裁剪原因。
- [ ] 被裁剪结果有模型可见回取入口。
- [ ] 最新 Tool Result 不被无理由压缩。
- [ ] L0/L1 命中、L2 读取和模型使用分开统计。
- [ ] Compaction 后仍保留来源闭包和回取入口。

### 性能

- [ ] Evidence Search 不再每次全量读取所有 Artifact。
- [ ] L0/L1、索引和向量处理异步化。
- [ ] 无关 MCP 和 Skill 加载不阻塞新建对话。
- [ ] Context Database 不可用时有确定性降级。
- [ ] 查询、索引、Recall 和上下文组装都有 p50/p95。

### 安全

- [ ] URI 访问检查 Run、generation、scope 和 sensitivity。
- [ ] 旧 generation 不能污染当前 Context Database。
- [ ] L0/L1 生成内容保留不可信标记。
- [ ] Key、候选答案和隐藏评分信息不进入索引或报告。
- [ ] 外部 Adapter 不能修改 Completion 或 Verifier 结果。
- [ ] 多 Agent 仍未启用，只保留接口。

### 评估

- [ ] 支持 OpenViking 风格能力的单因素消融。
- [ ] 支持真实执行模型、摘要模型、Embedding 模型和 Rerank 模型选择。
- [ ] 报告命中、进入上下文、Recall、使用和验证五类状态。
- [ ] 报告 Pass@k、Pass^k、Evidence-backed Success、成本和延迟。
- [ ] 失败可以定位到模型、Harness、工具、检索、Provider、环境或 Verifier。

## 26. 推荐落地顺序

```text
P0 冻结 pb:// 与 ContextNode 数据模型
 -> P1 实现 L0/L1/L2 和 Artifact 关系
 -> P2 建立异步语义处理队列
 -> P3 先做确定性索引和 find
 -> P4 统一 Receipt、Recall 和 ModelContextFrame
 -> P5 再做目录递归和可选向量检索
 -> P6 改造 GUI、启动和状态展示
 -> P7 再做跨 Run 经验候选
 -> P8 用真实模型做消融和发布决策
```

最重要的开发顺序约束是：

```text
先保证结果一定能被模型看到或明确回取
再研究怎样更智能地检索
先保证检索路径可解释
再研究向量、Rerank 和信息论价值
先保证单 Agent 正常工作
再讨论多 Agent
```

OpenViking 的经验说明，目录式上下文、分层加载和会话记忆有潜力改善长任务；但 ProofBlade 是否真正受益，必须通过同模型、同任务、固定安全边界的真实消融实验确认。最终目标不是让系统拥有更多索引，而是让模型获得正确的信息、知道信息在哪里、能够在需要时取回，并且让开发者可以证明这些信息确实进入了模型的决策上下文。
