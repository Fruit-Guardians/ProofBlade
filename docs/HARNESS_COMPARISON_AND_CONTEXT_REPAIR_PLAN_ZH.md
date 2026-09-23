# ProofBlade Harness 对比审查与上下文修复开发计划

状态：设计与整改计划

本文档记录 ProofBlade 与以下两个开源 Harness 的源码对比结果，并将当前“工具结果已经返回但模型不知道”“上下文在较大规模后不再增长”“模型受到过多流程约束”“启动等待时间过长”等问题转化为可实施的开发计划：

- [OpenAI Codex](https://github.com/openai/codex/tree/ddf8a67ab09cd76b8adc0969f11ee1271179aba7)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/4e84901e6471b79ec0338099867ebb4606d12bb5)
- [AI Agents in Depth 第 7 章：Agent 的评估](https://bojieli.github.io/ai-agent-book/book/chapter7)

对比仓库核对基线：

```text
OpenAI Codex       ddf8a67ab09cd76b8adc0969f11ee1271179aba7
DeepSeek Harness   4e84901e6471b79ec0338099867ebb4606d12bb5
ProofBlade         当前工作区最新提交，以本地源码为准
```

本文档只描述 ProofBlade 的改进方向，不复制两个仓库的完整实现，也不建议为了追求架构相似而重写现有的 Evidence、Verifier、Effect Journal 和 generation fencing。

## 1. 执行摘要

### 1.1 核心判断

当前 ProofBlade 的安全控制并非全部过重，但认知辅助控制、任务流程控制和上下文投影耦合过深，导致模型自由探索能力下降，且模型无法可靠知道哪些持久信息仍然可用。

最关键的问题不是“系统没有保存结果”，而是：

```text
保存了结果
 !=
下一次 Provider 请求一定看到了结果
```

当前系统中至少存在以下四种内容：

1. Pi Session 中的原始交互消息。
2. ControlStore 中的事实、观察、证据、任务和状态投影。
3. ArtifactStore 中的完整工具结果。
4. ContextCompiler 生成的本轮动态上下文。

它们各自保存正确内容，但没有一个统一、可回放、可直接检查的 `ModelContextFrame` 表示“这一次请求最终实际发送给 Provider 的内容”。

### 1.2 主要整改方向

本次整改分为三个平面：

```text
Safety Plane      安全与正确性，固定启用
Cognitive Plane   认知辅助，可配置、可消融、默认不阻断
Context Plane     模型可见上下文，单一最终组装与可审计
```

目标行为：

- 普通 Coding Assistant 可以自然读文件、运行命令、编辑代码和反复探索。
- CTF 模式仍保留作用域、提交、候选泄漏、Verifier、代次和预算保护。
- 重复、无进展、阶段偏离和首动作建议默认只提醒，不直接阻断。
- 被压缩的工具结果必须在模型可见文本中携带明确可执行的回取入口。
- 每次 Provider 请求都能在 GUI 中看到最终模型可见消息的结构、来源、大小、是否被裁剪和回取路径。
- 大结果进入持久存储后，不再依赖模型记住某个隐藏的 `details` 字段。
- MCP、Skill、工具预检和历史详情不阻塞新建对话。
- 单 Agent 继续是唯一启用执行路径；多 Agent 只保留接口字段，不启用并行协作。

## 2. 评估依据与对比范围

第 7 章要求评估对象是“模型与 Harness 的组合”，而不是只评估底层模型。本文因此比较以下五个方面：

1. Harness 允许模型做什么。
2. Harness 在什么时候拒绝模型的动作。
3. 工具结果怎样进入模型上下文。
4. 上下文压缩后怎样恢复信息。
5. 模型和 Harness 的行为怎样被观测、回放和评估。

本文没有把以下内容作为普通能力问题：

- 工作区越界。
- 未授权网络访问。
- 凭据泄漏。
- 跨 generation 写入。
- 非幂等 Effect 重复执行。
- 错误的 Completion。
- 取消后后台进程继续运行。

这些是安全和正确性问题，应由固定安全平面处理，不应为了让模型“更自由”而关闭。

## 3. 三个 Harness 的结构差异

| 维度 | OpenAI Codex | DeepSeek Harness | ProofBlade 当前实现 |
| --- | --- | --- | --- |
| 核心模型 | 单一 ContextManager 管理模型历史 | Session Event Log 派生模型历史 | Pi Session、ControlStore、ContextCompiler 并存 |
| 上下文来源 | 历史 Item 和 Context Fragment | Session Event 的 `deriveMessages()` | Pi 消息、Durable Ledger、Observation Queue、动态投影 |
| 模型可见内容 | 进入请求的内容属于历史或明确的上下文 Fragment | “模型可见即已记录” | 部分内容只在 Artifact、`details` 或 ControlStore 中 |
| 工具结果 | 由 Tool Output 统一截断并加入明确提示 | 由 Tool Pipeline 处理，超大文本可 Spill | 工具自身先处理，之后还会被 Agent Pruner 再处理 |
| 大结果恢复 | 输出截断提示、路径、offset 或显式读取机制 | Spill locator、读取提示、Session 保留 | Artifact 存在，但部分回取信息不一定在模型可见文本中 |
| 重复调用 | 主要依靠模型、工具状态和用户控制 | 默认建议性提醒，不阻止调用 | 重复、失败风暴、预算和实验策略共同介入 |
| 工具限制 | 主要由权限、沙箱和审批控制 | 由插件作用域与工具流水线控制 | 任务类别、Phase、Action Bundle、首动作和预算共同控制 |
| 工具发现 | 支持工具搜索和动态能力 | 插件化、作用域化、可异步发现 | MCP 一等工具可能在 Lane 创建时同步 describe |
| 轮次预算 | 不是默认的认知阻断核心 | 文档明确没有内置轮次预算 | Run、Effect、Tool 和 Provider 预算同时存在 |
| 上下文观测 | Context Manager 和请求 Item 可检查 | Session Log 可回放 | 主要保存 manifest、哈希和计数，缺少最终内容快照 |
| UI 反馈 | 以请求、Tool、审批和上下文状态为中心 | 以 Agent、Session、插件和事件为中心 | 以 Run、Phase、Evidence、Tool 调试和 Control 事件为中心 |

### 3.1 Codex 的可借鉴部分

Codex 的重点不是“完全不限制模型”，而是将限制集中在权限、沙箱、审批和 Tool Runtime，而不是在每个普通探索动作前增加领域流程判断。

可借鉴的实现原则：

- ContextManager 作为模型历史的中心 owner。
- 不随意重写历史；需要改变上下文时使用明确的 compaction 或 context item。
- 工具输出在统一边界执行有界处理。
- 大输出有清晰的截断原因和继续读取方式。
- 上下文片段有类型、来源和可测试的模型可见语义。
- 允许模型通过权限请求处理真实工作中的额外权限需求。
- Tool、权限和沙箱控制不依赖 CTF 领域分类。

Codex 自身也有严格的沙箱和权限边界，因此它不是“没有限制”，而是把限制放在更接近真正风险的位置。

### 3.2 DeepSeek Harness 的可借鉴部分

DeepSeek Harness 将 Agent、Session、工具、模型、提示词、插件和 UI 都作为可替换 seam，最重要的约定是：

```text
任何模型实际看到的内容，都必须可以从 Session Log 重建。
```

可借鉴的实现原则：

- Session Event Log 是模型消息的单一真源。
- `agent/pre-step` 是模型上下文正式进入步骤前的唯一扩展点。
- 工具结果通过 `tools/pre-execute -> tools/execute -> tools/post-execute -> tools/result` 流程处理。
- 重复调用提醒默认是追加建议，不是阻断。
- 超大工具结果通过 Spill 保存完整内容，并在模型可见结果中给出 locator 和读取方法。
- MCP 工具和插件可以异步发现，工具加载不必阻塞整个 UI 或新会话。
- Session、Agent 和工具作用域独立，生命周期由明确 owner 管理。

DeepSeek Harness 的 PTC 模式会将部分中间子调用结果留在外层程序中，只把必要结果交给模型。这说明“持久保存”和“模型立即可见”本来就可以是两个不同层次，但两者之间必须有可靠的选取、摘要和回取协议。

## 4. 当前 ProofBlade 的实际调用链

### 4.1 正常工具结果的进入路径

当前 Pi Agent Loop 的正常路径是：

```text
Provider 返回 assistant toolCall
 -> 执行 Tool
 -> 生成 toolResult
 -> append 到当前 Agent context
 -> message_end 写入 Pi Session
 -> prepareNextTurn 重新读取 Session
 -> context hook 再次处理 messages
 -> convertToLlm
 -> Provider 请求
```

因此，短小且未触发维护的 Tool Result 通常会进入下一次请求。这一点不能简单描述为“工具结果从来没有进入上下文”。

### 4.2 结果被改变的路径

在进入 Provider 前，`PiCodingLane` 的 `context` hook 会：

1. 从 ControlStore 读取当前 Snapshot。
2. 重建 Observation Queue。
3. 重建 ContextCompiler 的 L0-L5 投影。
4. 把 Reasoning Forest 追加到消息列表。
5. 调用 `prepareContextMaintenance()`。
6. 返回维护后的消息加上一个动态投影消息。

对应文件：

```text
packages/materials/src/runtime/coding-lane.ts:608-649
packages/materials/src/context/compiler.ts:20-233
packages/materials/src/context/maintenance-coordinator.ts:34-68
```

问题在于：模型最终看到的不是原始 Session 消息，而是上述多个来源重新组合后的副本。

## 5. 已确认的问题

### P0：没有最终模型可见上下文快照

当前 Provider 观测主要记录：

- request body hash。
- request context hash。
- stable prefix hash。
- dynamic suffix hash。
- manifest hash。
- 层级 Token 数。
- 工具名和模型名。

对应实现：

```text
packages/materials/src/observability/pi-events.ts:200-209
packages/materials/src/observability/pi-events.ts:264-355
packages/materials/src/runtime/request-epoch.ts:1-188
```

这些信息可以证明请求发生过，也可以比较两个请求是否不同，但不能回答：

- 第 7 条消息是不是被保留。
- 某个 Tool Result 的正文是否被裁剪。
- Artifact id 是否出现在模型可见文本中。
- 某条 Evidence 摘要是否被动态投影截断。
- 模型看到的是 Tool Result、Ledger 摘要还是仅有 Artifact 索引。
- 上下文丢失发生在 Session、Pruner、Compiler 还是 Provider Adapter。

这是当前最严重的可诊断性缺口。

### P0：上下文维护会在模型请求前再次压缩 Tool Result

`agent-pruner.ts:79-96` 在维护阶段会对成功的 Tool Result 执行二次 snip：

```text
<= 768 字符       保留
> 768 字符        压缩为约 768 字符
> 12000 字符      使用更强的压缩
```

该逻辑对旧结果和最新结果都会生效。它不是只压缩历史旧消息。

被省略的正文不会自动进入 L3A。L3A 主要保留：

- Observation summary。
- Evidence summary。
- Fact statement。
- Hypothesis statement。
- Artifact id 和关系。

对应实现：

```text
packages/materials/src/context/agent-pruner.ts:74-105
packages/materials/src/context/compiler.ts:370-430
packages/materials/src/context/compiler.ts:621-634
```

如果关键事实位于 Tool Result 中部，模型在下一次请求中可能只看到首尾和一个泛化的 archived 标记。

### P1：Artifact 引用不是始终模型可见

`createCodingReadTool()` 会把完整读取结果存入 Artifact，并把 `artifactId` 放在 Tool Result 的 `details` 中：

```text
packages/materials/src/runtime/coding-resources.ts:1167-1203
```

但 `details` 主要服务于 Control telemetry、GUI 和调试。Provider 的 Tool Result 通常以 `content` 为模型输入，不能假设模型一定能看到 `details`。

因此存在以下不一致：

```text
GUI 看到了 artifactId
ControlStore 看到了 artifactId
模型只看到了正文，或者只看到了被裁剪后的正文
```

只有 Bash 输出在确实有字节被省略时才通过 `artifactAnchor()` 加入模型可见的回取提示：

```text
packages/materials/src/runtime/coding-resources.ts:1448-1458
```

Read、部分 Capability、MCP 和上下文维护路径没有统一使用同一种模型可见回取协议。

### P1：动态上下文本身也可能丢失中间内容

`contextProjectionMessage()` 将多个动态块合并成一条消息，并将最终消息限制在 10,000 Token：

```text
packages/materials/src/runtime/coding-lane.ts:991-1020
```

这条消息包含：

- Phase 和预算。
- Durable Ledger。
- Active Controls。
- Observation Queue。
- Artifact 索引。
- 当前轮指导。

这些内容混合后再整体截断，可能造成“manifest 声明有来源，但模型看不到对应正文”的情况。

### P1：`evidence.search` 查询时扫描全部文本 Artifact

当前 `CodingEvidenceGraph.search()` 在查询时构造所有 Artifact 行，并在元数据没有命中时读取全部文本 Artifact：

```text
packages/materials/src/knowledge/evidence-graph.ts:438-472
```

这使一次搜索的复杂度近似为：

```text
O(Artifact 数量 + 可搜索 Artifact 总字节数)
```

每次搜索都重新读取 Artifact，随着运行时间增长会越来越慢。这可以直接解释“证据搜索或整理工具需要等待很久”。

### P1：模型可见信息和持久信息没有单一 owner

当前各层 owner 分散：

| 内容 | 当前 owner |
| --- | --- |
| Tool Result 消息 | Pi Session / Agent context |
| Observation | ControlStore |
| Evidence | ControlStore / Evidence Graph |
| 完整文本 | ArtifactStore |
| 模型上下文选择 | ContextCompiler + Agent Pruner |
| Provider 观测 | RequestEpoch + telemetry |
| UI 展示 | GUI debug-data 二次投影 |

没有一项对象同时记录：

```text
原始来源 -> 选择决策 -> 最终模型可见内容 -> 被省略内容 -> 回取方式
```

### P1：认知约束和安全约束没有彻底分离

以下安全边界应保持：

- 工作区范围。
- 网络范围。
- 凭据隔离。
- generation fencing。
- Effect Journal。
- 提交预算。
- Candidate 防泄漏。
- Verifier Completion。

但以下控制不应在普通 Coding Assistant 中默认形成阻断：

- 首动作规划。
- Phase Route。
- Action Bundle。
- 重复失败阻断。
- 失败风暴阻断。
- 证据整理时机。
- 信息价值排序。
- 固定 CTF 工作流。

当前 `coding-turn-projection.ts:290-338` 仍保留工具调用硬预算；`coding-lane.ts:565-605` 还将一次 Lane 中的工具调用和上下文维护预算绑定到当前 TaskContract。

### P1：工具和 MCP 初始化可能阻塞启动

Lane 创建阶段会：

- 加载 Session。
- 加载 Skill Registry。
- 加载 MCP Registry。
- 加载 Tool Catalog。
- 执行目标类型相关的工具预检。
- 创建 MCP 一等工具。
- 对启用的 MCP Server 执行 describe。

MCP 一等工具创建路径在：

```text
packages/materials/src/runtime/coding-resources.ts:183-234
packages/materials/src/runtime/coding-lane.ts:276-285
```

如果 MCP server 响应慢、进程握手慢或某个工具描述异常，新建对话可能需要等待整个 Lane 创建完成。

## 6. 当前限制的正确分层

### 6.1 Safety Plane：固定启用

安全平面只负责不可由模型自行改变的约束：

```text
工作区 / 网络 / 权限
凭据和敏感值脱敏
generation fence
Effect Journal 和幂等
Job、Session、MCP 生命周期
时间、费用和资源硬上限
暂停、取消、审批
Verifier 和 Completion gate
候选答案防泄漏
```

模型可以请求改变任务范围，但不能通过工具输出、Skill 正文、网页内容或普通文本改变这些规则。

### 6.2 Cognitive Plane：默认辅助，不默认阻断

认知平面包括：

```text
首动作建议
阶段路线建议
Action Bundle
重复提醒
无进展提醒
失败风暴提醒
Evidence 整理建议
信息价值估计
上下文选择
RAG 召回
停止建议
```

默认策略：

```text
普通 Coding Assistant：advisory 或 off
CTF Solve：advisory，提交和验证仍由 Safety Plane 控制
正式消融实验：由 Variant 明确选择 hard/advisory/off
```

认知平面可以提供理由和下一步建议，但不能静默改写模型历史，不能删除原始 Artifact，也不能修改安全平面。

### 6.3 Context Plane：模型请求前的唯一组装者

所有模型可见内容必须经过一个明确的最终组装器：

```text
Session history
 + durable observations
 + evidence summaries
 + pending job status
 + RAG receipts
 + user steering
 + active task
 -> ContextAssembler
 -> ModelContextFrame
 -> Provider Adapter
```

`ContextCompiler` 可以保留，但需要从“同时负责业务投影、维护和消息替换”调整为“提供带来源的候选 Context Block”；最终是否进入 Provider 必须由 `ContextAssembler` 完成。

## 7. 目标上下文协议

### 7.1 `ModelContextFrame`

建议新增一个内部对象：

```ts
type ContextSourceKind =
  | "session"
  | "task"
  | "ledger"
  | "observation"
  | "evidence"
  | "artifact"
  | "job"
  | "queue"
  | "user"
  | "system";

type ModelContextItem = {
  itemId: string;
  role: "system" | "user" | "assistant" | "tool";
  source: ContextSourceKind;
  sourceIds: string[];
  contentHash: string;
  visibleChars: number;
  estimatedTokens: number;
  included: boolean;
  omittedReason?:
    | "budget"
    | "duplicate"
    | "stale_generation"
    | "sensitivity"
    | "superseded"
    | "policy";
  artifactRefs: string[];
  evidenceRefs: string[];
  recall?: {
    tool: "evidence" | "knowledge" | "read";
    operation: string;
    arguments: Record<string, string | number | boolean>;
  };
};

type ModelContextFrame = {
  schemaVersion: 1;
  runId: string;
  generation: number;
  requestId: string;
  turnId?: string;
  model: string;
  provider: string;
  systemPromptHash: string;
  toolCatalogHash: string;
  contextManifestHash: string;
  sourceMessages: ModelContextItem[];
  finalMessages: ModelContextItem[];
  omittedItems: ModelContextItem[];
  totalVisibleChars: number;
  estimatedVisibleTokens: number;
  createdAt: string;
};
```

这个对象记录的是“模型可见性决定”，不是把全部敏感原文写入 ControlStore。

### 7.2 内容保存规则

普通内容可以保存一份有界脱敏 Context Artifact：

```text
每条消息的 role、source、contentHash、正文上限、Artifact/Evidence 引用
```

敏感内容只保存：

```text
contentHash
sourceRef
visibleLength
redactionReason
```

候选 flag、API Key、Cookie、私有 Token 和隐藏评分逻辑不能写入普通诊断报告。调试模式只能在本机明确开启，并继续按 sensitivity 处理。

### 7.3 Provider Adapter 的最终一致性

`ModelContextFrame` 必须在 Provider Adapter 转换完成之后生成，至少覆盖：

- OpenAI Chat Completions 的最终 `messages`。
- OpenAI Responses 的最终 `input`。
- Anthropic Messages 的最终 system、messages 和 tool blocks。
- Tool Schema 的最终顺序和内容哈希。

不能只记录 ContextCompiler 的中间消息，因为 Provider Adapter 还可能改变角色、工具结果格式、图片块和错误结果。

## 8. 工具结果与回取协议

### 8.1 统一 Tool Result Envelope

所有工具的模型可见结果统一为以下语义：

```text
[ProofBlade tool result]
operation=<tool name>
state=<success|error|partial|running>
visible=<complete|bounded|receipt>
content_sha256=<hash>
artifact=<A-id or none>
omitted=<bytes or 0>
next=<explicit next action>

<bounded content or receipt>
```

稳定字段名可以保留为机器协议，界面和帮助文案使用中文。

### 8.2 三种展示级别

| 级别 | 模型看到什么 | 使用场景 |
| --- | --- | --- |
| `complete` | 有界完整结果 | 小型 Tool Result、最新关键结果 |
| `bounded` | 首尾或结构化裁剪结果加回取入口 | 较大文件和命令输出 |
| `receipt` | 摘要、关键字段、Artifact/Evidence 引用、明确回取命令 | 超大结果、后台 Job、持久化检索 |

禁止出现“正文已存储，但模型只收到一个没有动作说明的内部 Artifact id”。

### 8.3 Read 工具行为

Read 工具需要遵守以下规则：

1. 小于模型可见上限时，直接返回正文。
2. 超过上限时，返回首尾、行范围、总行数、Artifact id 和精确的 `evidence.read` 或 `knowledge.inspect_uri` 参数。
3. 关键行可以通过确定性结构化提取单独保留。
4. 最新一次 Read 结果在下一次 Provider 请求前优先保留，不应先被压缩到 768 字符。
5. 模型回取后，回取记录必须进入 Session 和 `ModelContextFrame`。
6. 重复回取相同范围不应复制相同正文；应返回已读取标记和新的范围建议。

### 8.4 后台 Job 行为

后台 Job 完成时，应在模型可见上下文追加一条短状态：

```text
后台任务已完成：job=<id>
状态：成功
新增输出：<bytes>
Artifact：<A-id>
建议：读取 Artifact 的首尾，或使用 evidence.search 查询关键词。
```

Job 状态不能只停留在 GUI Observation Queue 中，否则模型不知道后台任务已经结束。

## 9. 上下文维护与压缩策略

### 9.1 维护顺序

推荐顺序：

```text
1. 去除重复的动态投影
2. 去除已经被明确引用的重复正文
3. 压缩旧的普通 Tool Result
4. 保留最新 Tool Result 的完整有界版本
5. 保留确认事实、拒绝假设和验证失败原因
6. 保留所有 Artifact/Evidence 回取路径
7. 仍超预算时再做 compaction
```

当前流程对所有成功 Tool Result 统一先 snip，需要改成带优先级的 Context Item 维护。

### 9.2 内容保留优先级

```text
P0 当前用户请求
P0 最新 Tool Result
P0 当前未处理的错误和状态变化
P1 已确认事实
P1 Verifier 失败原因
P1 与当前假设直接相关的 Evidence
P2 最近的 Tool Call/Result 配对
P2 后台 Job 完成摘要
P3 被拒绝假设和重复记录
P4 旧的普通探索输出
```

“最新”不能只按时间判断。应结合：

- 当前用户问题。
- 当前 Phase。
- 当前假设。
- Evidence 支持/反驳关系。
- 是否为最新状态变化。
- 是否包含错误或候选。
- 是否已经被模型 Recall。

### 9.3 Compaction 要保留的内容

Compaction 摘要至少需要包含：

```text
当前用户任务
当前 generation
已确认事实及其证据
已拒绝假设及拒绝原因
最近工具结果的 Artifact refs
尚未读取的重要 Artifact refs
后台任务状态
下一步可选动作
不可重复的副作用说明
```

Compaction 不应只保留“某次读取产生了 N 字节”，还要保留模型重新获得这些字节的方法。

## 10. 认知策略放宽方案

### 10.1 普通 Coding Assistant

当 TaskContract 为 `coding_assistant` 且 `target_kind=unknown` 时，默认：

```text
firstAction       off
phaseRoute        off
actionBundle      off
duplicateFailure  advice
circuitBreaker    advice
contextSelection  receipt-aware
recall            automatic-status + manual-content
evidenceCuration  off 或 advice
informationValue  off
compression       bounded_summary
stopSuggestion    off
```

普通 Coding Assistant 允许：

- 先解释再读文件。
- 先读多个文件再决定是否编辑。
- 运行交互式命令，但必须有超时和取消路径。
- 因新证据重复读取不同范围。
- 自行改变分析顺序。
- 不使用 Evidence 工具完成普通代码编辑。

### 10.2 CTF Solve

CTF 模式保留：

- workspace 和网络范围。
- 候选答案保护。
- `verify_claim`。
- 平台提交审批和提交预算。
- generation、Effect、Job 和 Session 隔离。

但以下默认变为建议：

- 首动作。
- Phase 路线。
- CTF Skill 选择。
- 重复探测。
- Evidence 整理时机。

只有正式消融 Variant 选择 `hard_gate` 时，才允许进行认知硬阻断。

### 10.3 工具预算拆分

当前 `max_tool_calls` 不应同时表达所有含义。建议拆为：

```text
maxModelToolInvocations   模型工具调用总量，可为软提醒或较高上限
maxEffectCalls            Journal Effect 总量，真正的硬上限
maxSubmissions            平台提交硬上限
maxProviderCost           Provider 费用硬上限
maxWallTime               运行时间硬上限
```

普通 `read`、`glob`、`grep`、`evidence.search` 不应消耗与平台提交同等语义的 Effect 预算。

## 11. 启动与异步加载方案

### 11.1 启动阶段拆分

```text
快速启动：
  读取配置
  打开 Run/Session 索引
  创建 GUI/CLI 可用的 Conversation
  显示 Provider 和能力状态

异步准备：
  Skill 元数据
  Tool Catalog
  MCP Server health
  MCP Tool describe
  任务类别预检
  历史 Artifact 索引
```

### 11.2 MCP 行为

MCP Server 状态必须支持：

```text
未加载
加载中
已就绪
降级
不可用
已关闭
```

MCP 工具在加载完成前可以不出现在 Provider Tool Schema 中，但 GUI 要显示状态；加载完成后通过明确的 `tool_catalog_changed` 事件刷新下一次请求。

如果任务依赖某个 MCP 工具，Provider 请求可以等待该工具；普通对话不能因为无关 MCP server 未响应而整体阻塞。

### 11.3 Skill 行为

启动时只加载：

- Skill 名称。
- 中文短描述。
- content hash。
- 是否可用。

Skill 正文只有在模型显式请求或 Harness 确定性路由命中时读取。读取失败只影响该 Skill，不影响普通新建对话。

## 12. Evidence 和 RAG 索引方案

### 12.1 Artifact 注册时建立索引

不再在每次 `evidence.search` 时扫描全部 Artifact。Artifact 注册流程应异步写入：

```text
artifact_id
run_id
generation
mime
bytes
content_hash
token_windows
normalized_terms
line_offsets
semantic_tags
observation_id
evidence_ids
```

索引失败不能破坏已经成功的 Tool Result，但必须在 GUI 和 telemetry 中显示 `index_pending` 或 `index_failed`。

### 12.2 查询层级

```text
精确 Artifact id
 -> Evidence id / Fact id
 -> 结构化字段
 -> 关键词倒排索引
 -> 字符 n-gram 或 BM25
 -> 可选向量检索
```

向量检索不是第一步。只有确定性索引已经通过 Recall 命中、误召回、遗漏、延迟和总 Token 对照后，才允许作为可选实验。

### 12.3 RAG 命中和使用分开统计

必须分别记录：

- 检索是否命中关键 Artifact。
- 检索结果是否进入 ModelContextFrame。
- 模型是否调用 Recall。
- Recall 内容是否被模型后续动作使用。
- 错误召回是否影响决策。
- 关键 Evidence 是否被遗漏。

“RAG 返回了结果”不等于“模型使用了结果”。

## 13. 可观测性与 GUI 改造

### 13.1 新增请求上下文面板

每次 Provider 请求都要能查看：

```text
请求编号
模型和 Provider
当前 Run/generation
消息数量
每条消息的 role/source
每条消息的字符数和估算 Token
被保留的 Tool Result
被裁剪的 Tool Result
被裁剪原因
Artifact/Evidence 引用
Recall 入口
Context Manifest hash
Request body hash
```

默认不展示敏感原文，只展示脱敏正文或 hash。用户开启本地调试详情后，仍要按 sensitivity 过滤。

### 13.2 新增“模型实际看到什么”视图

GUI 应提供三个视图：

1. **模型视图**：最终发送的模型消息，按 Provider 适配器格式展示。
2. **来源视图**：每段内容来自哪个 Session、Observation、Evidence、Artifact 或 Queue。
3. **裁剪视图**：被省略的内容、原因、保留字节数和回取命令。

这三个视图解决不同问题，不能只给一个“上下文 Token 数”。

### 13.3 Observation Queue 改造

Observation Queue 显示：

- 待消费数量。
- 已进入最近一次 ModelContextFrame 的项目。
- 尚未进入模型上下文的项目。
- 已确认消费的项目。
- 被裁剪但可回取的项目。
- generation 和来源事件。

不能把“已进入队列”显示成“模型已知道”。

## 14. API 与组件边界

建议增加以下接口：

```ts
interface ContextAssembler {
  assemble(input: ContextAssemblyInput): Promise<ModelContextFrame>;
}

interface ContextFrameStore {
  put(frame: ModelContextFrame): Promise<{ frameId: string; artifactId?: string }>;
  get(frameId: string): Promise<ModelContextFrame | undefined>;
}

interface ModelVisibleResult {
  content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  visibility: "complete" | "bounded" | "receipt";
  sourceRefs: string[];
  recall?: {
    tool: string;
    operation: string;
    arguments: Record<string, unknown>;
  };
}

interface RetrievalIndex {
  enqueue(ref: { runId: string; generation: number; artifactId: string }): Promise<void>;
  search(input: { runId: string; generation: number; query: string; maxResults: number }): Promise<RetrievalHit[]>;
}
```

这些接口只处理上下文和检索，不修改 Verifier、Effect Journal 或 TaskContract 的安全语义。

## 15. 分阶段实施计划

### P0：先证明当前模型实际看到了什么

交付：

- `ModelContextFrame` 类型和规范化哈希。
- Provider Adapter 最终消息捕获。
- 安全脱敏 Context Artifact。
- `request_epoch_context` 增加 frame 引用、消息统计和裁剪统计。
- GUI 显示模型实际消息、来源和裁剪原因。

测试：

- Tool Result 经过 Context hook 后的最终内容与 Provider payload 一致。
- `details` 中的 Artifact id 不存在时，模型可见内容仍有回取信息。
- Provider 角色转换前后 frame 来源仍可关联。
- 敏感候选和 Key 不进入 Context Artifact。
- 重启后可以读取上一条 frame 的结构化内容。

### P1：统一 Tool Result Envelope 和 Recall

交付：

- `complete`、`bounded`、`receipt` 三种展示级别。
- Read、Bash、Capability、MCP、Job 统一回取协议。
- 新增或统一 `evidence.read` / `knowledge.inspect_uri` 的模型可见参数提示。
- 最新 Tool Result 优先保留策略。

测试：

- 小结果不产生无意义 Artifact 回取提示。
- 大结果正文被裁剪时，模型可见文本包含正确 Artifact id 和操作参数。
- 读取回取内容后，Recall 事件进入 Session 和 frame。
- 重复 Recall 不重复注入相同正文。
- generation 不一致的 Artifact 不能回取。
- 后台 Job 完成后下一次 Provider 请求一定有状态摘要。

### P2：上下文维护改为来源感知的 Item 维护

交付：

- 用 `ContextItem` 替代对完整消息数组的无差别 snip。
- 最新结果、错误、Confirmed Fact、Verifier 失败和活动 Queue 的优先级规则。
- 旧 Tool Result 的结构化摘要和来源闭包。
- Compaction 保留回取路径、假设和下一步。

测试：

- 最新大结果不会在首次维护时直接变成 768 字符摘要。
- 关键 Evidence 不会因为动态投影整体截断而消失。
- 裁剪后每个重要来源都有回取路径。
- Tool Call/Tool Result 配对始终合法。
- 多次 compaction 后 frame、Session 和 Artifact 引用仍一致。
- 回放和第二次恢复不重复添加上下文。

### P3：普通 Coding Assistant 与 CTF 策略分离

交付：

- `SafetyPolicy` 与 `CognitivePolicy` 独立快照。
- 普通 Coding Assistant 默认关闭 CTF cognitive path。
- 重复、无进展、阶段偏离默认 advice。
- `maxToolInvocations` 与 `maxEffectCalls` 分离。
- 交互式 Bash 由超时、取消和后台建议控制，不由统一 CTF 规则直接拒绝。

测试：

- 普通 Coding Assistant 可以连续读取多个文件、编辑文件和运行测试。
- 普通 Coding Assistant 不会出现 CTF 首动作和提交提示。
- CTF 仍保留安全、Verifier、候选和提交边界。
- 认知策略变化不会修改 SafetySnapshot。
- 工具调用预算和 Effect 预算分别统计。
- 正式消融可以只改变 CognitivePolicy。

### P4：Artifact 倒排索引和 RAG Broker

交付：

- Artifact 注册后的异步索引队列。
- 精确 id、结构化字段、关键词和可选 n-gram 查询。
- `RetrievalIndex` 和 `ContextAssembler` 集成。
- RAG 命中、进入上下文、模型采纳和后续结果指标。

测试：

- 查询不再读取所有文本 Artifact。
- 索引延迟期间工具结果仍可用。
- 索引失败不会导致 Tool Result 失败。
- 查询结果受 run/generation 隔离。
- 关键词命中与旧全扫描实现结果一致。
- 召回结果可以从 frame 追溯到 Artifact。

### P5：启动异步化和能力状态

交付：

- 新建对话不等待无关 MCP describe。
- Skill 正文延迟加载。
- Tool Catalog、MCP、Job、索引统一状态事件。
- GUI 先显示 Conversation，再显示能力加载进度。

测试：

- 慢 MCP server 不阻塞新建对话。
- MCP server 启动失败只影响相关能力。
- 任务需要的 MCP 工具未就绪时给出明确等待状态。
- 重启后能力状态可以恢复或变为 `UNKNOWN`。
- 启动耗时按阶段记录，不能只记录总耗时。

### P6：消融实验接入

交付：

- Harness CognitivePolicy 进入实验快照。
- 固定 SafetySnapshot。
- 支持 direct、receipt、recall、RAG、compression、information value 的单因素消融。
- Context Frame、Recall、裁剪、检索和最终结果进入实验报告。

测试：

- 同模型同安全边界的两个策略可以配对运行。
- 一个实验只能改变声明的主因素。
- RAG 命中增加但结果不变时报告为机制变化，不报告为成功率提升。
- 失败归因可以定位到模型不可见、模型未使用或工具未返回。
- `Pass@k`、`Pass^k`、成本和 p95 延迟可重建。

### P7：持续失败回流和发布门禁

交付：

- 失败首错自动生成 prefix 草案。
- 模型不可见信息和 Harness 错误分开归因。
- 生产失败回流到触发集和保留集。
- 发布前自动运行安全、上下文、回取和消融回归。

测试：

- 失败轨迹不携带隐藏答案。
- prefix 不重复副作用 Tool。
- 修复后的失败可以生成 FAIL_TO_PASS 回归。
- Prompt、Tool Schema、Context Frame 和策略 hash 绑定。
- 回滚后原有模型可见性和安全边界恢复。

## 16. 消融实验矩阵

完成 P0-P2 后，先进行上下文链路消融，再研究更复杂的 RAG 和信息论功能。

| 实验 | Control | Treatment | 主要问题 |
| --- | --- | --- | --- |
| C1 | 当前直接 Tool Result | 统一 Tool Result Envelope | 统一回取协议是否减少遗忘 |
| C2 | 当前 Pruner | 最新结果优先保留 | 关键结果是否不再被立即压缩 |
| C3 | Artifact 仅作索引 | Artifact 可见 Recall | 模型是否能正确回取全文 |
| C4 | 当前动态投影 | 分块 Context Frame | 是否减少整体截断造成的信息丢失 |
| C5 | 全量扫描 Evidence Search | 倒排索引 | 延迟和结果是否改善 |
| C6 | 无自动召回 | 状态摘要自动注入 | 后台结果是否能及时进入模型上下文 |
| C7 | 认知硬约束 | 认知建议模式 | 限制是否导致成功率下降或无效动作增加 |
| C8 | CTF 规则作用于所有 Lane | 普通 Coding 与 CTF 分离 | 普通使用是否恢复自然行为 |
| C9 | 固定预算 | 工具预算与 Effect 预算分离 | 读取是否不再挤占副作用预算 |
| C10 | 同一 Harness 模型 A | 同一 Harness 模型 B | 区分模型瓶颈和 Harness 瓶颈 |

每个实验至少记录：

```text
最终模型可见消息
被省略消息及原因
Recall 次数和命中率
Evidence 进入上下文的次数
模型后续是否使用召回内容
Verified Success
Evidence-backed Success
Pass@k / Pass^k
Token / 成本 / p95 延迟
重复调用、无进展和阻断次数
```

## 17. 失败归因模型

### 17.1 六类归因

```text
model            模型看到信息后做错决策
harness          信息没有进入最终模型上下文，或认知策略错误阻断
tool             工具未返回正确结果或返回格式破坏语义
provider         Provider 转换、超时、模型漂移或协议错误
environment      工作区、目标、网络或运行时状态异常
verifier         验证器、任务契约或证据关系错误
```

### 17.2 归因优先顺序

```text
1. 检查 ModelContextFrame 是否包含支持正确决策的内容
2. 检查工具是否成功返回该内容
3. 检查模型是否有可执行的 Recall 入口
4. 检查模型是否调用并使用 Recall
5. 检查模型动作是否符合当前安全边界
6. 检查 Verifier 和环境状态
```

如果 frame 中没有关键事实，不能把失败归因给模型推理能力。

## 18. 统计与验收口径

### 18.1 不同指标回答不同问题

```text
Pass@k       能否在多次探索中偶尔找到成功路径
Pass^k       能否连续稳定交付
Verified     最终状态是否被独立验证
Evidence     结论是否有可追溯依据
Recall hit   持久信息是否被找到
Recall use   找到的信息是否改变后续正确行动
```

### 18.2 上下文修复的最低门槛

必须满足：

1. 对任何进入 Provider 的消息，都能从 `ModelContextFrame` 重建。
2. 被裁剪的 Tool Result 都有明确回取入口。
3. 最新关键 Tool Result 不会在首次维护时无理由压缩到 768 字符。
4. Context Artifact、Session、ControlStore 和 Provider 观测可以通过 request id 关联。
5. UI 能显示模型实际看到的内容和被省略的内容。
6. 任何 RAG 命中都能区分“命中”“进入上下文”“模型使用”。
7. 普通 Coding Assistant 不因 CTF 认知策略被拒绝正常读写和测试。
8. 安全边界、Verifier、generation 和候选防泄漏回归不下降。

### 18.3 性能门槛

新增以下指标：

```text
conversation_ready_ms
lane_ready_ms
mcp_ready_ms
context_assembly_ms
context_frame_persist_ms
artifact_register_ms
artifact_index_ms
retrieval_ms
recall_ms
provider_payload_build_ms
report_summary_ready_ms
```

性能报告同时给出：

- p50、p95、p99。
- Artifact 数量和总字节数。
- Context Frame 消息数和 Token。
- RAG 候选数和读取字节数。
- Provider 排队时间和执行时间。

## 19. 数据迁移和兼容策略

当前是破坏性更新，可以采用新协议，但仍需要明确旧数据行为：

- 旧 Pi Session 可以继续读取。
- 旧 ControlStore 没有 `ModelContextFrame` 时标记为 `legacy_context_unavailable`。
- 旧 Artifact 可以建立新索引。
- 旧事件不补写伪造的 frame。
- 旧上下文只在恢复时生成新的 frame，不改变原始事件。
- 旧的 CTF TaskContract 不自动推断为普通 Coding Assistant。
- 新的普通 Coding Assistant 不继承旧的 CTF cognitive policy。

### 19.1 回滚

每个 Run 保存：

```text
contextAssemblerVersion
contextCompilerVersion
prunerVersion
toolEnvelopeVersion
retrievalIndexVersion
cognitivePolicyFingerprint
safetyPolicyFingerprint
```

回滚时：

1. 停止新 ContextAssembler。
2. 保留已经生成的 Artifact、Evidence 和 frame。
3. 使用旧版本读取 Session 和 ControlStore。
4. 禁止旧版本把新 frame 当作旧消息写回。
5. 新旧模型请求分别统计，不混入同一实验组。

## 20. 推荐开发顺序

```text
第一步：实现 ModelContextFrame 和最终 Provider payload 可视化
第二步：统一大结果回取协议，先修 Read 和 Bash
第三步：调整上下文维护，保护最新结果和关键 Evidence
第四步：普通 Coding Assistant 与 CTF cognitive policy 分离
第五步：建立 Artifact 倒排索引，解决 Evidence Search 慢问题
第六步：MCP、Skill、Tool Catalog 启动异步化
第七步：接入消融实验和真实 Provider 评估
第八步：用真实问题验证用户体验和实际成功率
```

不建议先做以下工作：

- 先增加更多信息论公式。
- 先引入向量数据库。
- 先增加更多 Evidence 类型。
- 先增加更多阶段和 Action Bundle。
- 先增加更多“模型必须遵守”的提示词。

如果模型连当前工具结果是否进入最终请求都无法确认，继续增加高级 RAG 或信息价值算法不会产生可信的实验结论。

## 21. 开发调试命令

建议新增以下命令：

```text
proofblade context-frame <run-id> [request-id]
proofblade context-frame <run-id> --show-included
proofblade context-frame <run-id> --show-omitted
proofblade context-frame <run-id> --show-sources
proofblade artifact <run-id> <artifact-id> --recall-plan
proofblade knowledge <run-id> search <query> --explain
proofblade knowledge <run-id> index-status
proofblade doctor startup
proofblade doctor context
proofblade doctor retrieval
proofblade ablation run <experiment-id> --record-context-frames
proofblade ablation report <experiment-id> --include-context-loss
```

输出必须说明：

```text
模型看到的正文
模型没有看到的正文
为什么没有看到
正文在哪里
怎样读取
读取后是否进入了下一次上下文
```

## 22. 最终完成标准

本计划完成后，ProofBlade 应该能够对任何一次模型决策给出完整回答：

```text
模型使用了哪个 Provider 和具体模型？
当时处于哪个 Run 和 generation？
模型最终看到了哪些消息？
每条消息来自哪里？
哪些 Tool Result 被裁剪了？
裁剪原因是什么？
完整结果存在哪里？
模型是否拥有明确的 Recall 方法？
模型是否执行了 Recall？
模型是否使用了 Recall 内容？
哪个安全边界影响了动作？
最终状态由哪个 Verifier 判定？
失败属于模型、Harness、工具、Provider、环境还是 Verifier？
这个结论能否通过回放复现？
```

如果不能回答这些问题，系统只能说明“某次运行失败了”，还不能说明“为什么失败”。

ProofBlade 的目标不是成为限制最多的 Agent，而是让安全边界足够坚固、认知辅助足够可撤销、上下文传递足够透明，使模型能够在真实工作中自由探索，并且让每一次改动都可以通过真实模型消融实验验证。
