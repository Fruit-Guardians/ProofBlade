# ProofBlade 持久化上下文与分级召回开发计划

> 状态：Proposal / Planned，本文是待实施的开发计划，不代表所有能力已经交付。
>
> 依据：`docs/UNIFIED_AGENT_DEVELOPMENT_PLAN_ZH.md`、`README.md` 以及当前 `ArtifactStore`、`Knowledge Projection`、`ContextCompiler`、`SpillStore`、`DurableCompaction`、`Evidence Graph` 和单 Agent Coding Lane 的实现。
>
> 适用范围：普通 Chat、CTF、Fixture、Competition、Coding Lane、Skill、MCP、同步 Tool、异步 Job、Provider 上下文、Evidence、压缩、恢复和 GUI 调试。

## 1. 执行摘要

本计划评估并实现一种“持久化上下文引用”架构：工具、Skill、MCP、证据和模型输出的完整内容首先进入可审计的持久化存储，模型请求只携带必要的系统约束、当前任务、未闭合协议消息、有限的结构化回执和稳定的 `pb://` 引用。模型需要细节时，通过受权限和大小限制的召回接口读取，而不是让每次工具调用都把完整结果复制进后续上下文。

这个方向可行，但“所有内容一律只返回路径”不是可接受的第一版。路径本身不能帮助模型理解结果，也不能证明结果可信；强制外置小结果还会增加一次召回、增加延迟，并可能让模型忘记主动读取。Provider 的 Tool Call/Tool Result 配对也要求未完成的调用保持合法相邻结构。因此目标不是盲目把一切变成传统向量 RAG，而是建立以下闭环：

```text
canonical value
    -> durable Artifact / Operation / Evidence record
    -> bounded ModelReceipt
    -> optional recall through pb://
    -> read marker and source binding
    -> consolidate / forget / restore
```

默认策略如下：

| 内容 | 默认送入模型的内容 | 完整内容位置 |
| --- | --- | --- |
| 小型、低敏感度 Tool 结果 | 有界完整结果或完整结构化结果 | Artifact 可选保留 |
| 中型 Tool 结果 | 短摘要、head/tail 预览、统计、URI、hash | Artifact |
| 大型 Tool 结果 | 摘要、大小、hash、关键索引、URI | Artifact/Blob |
| 原始二进制、图片、压缩包 | 类型、尺寸、hash、分析摘要、URI | Artifact |
| 长时间 Job | Job 状态、进度、最新观察、Artifact refs | Job 输出 Artifact |
| Skill 正文 | 稳定元数据；正文按需召回 | Skill 资源/Artifact |
| Tool/MCP schema | 当前可调用 schema 必须保留 | Catalog 快照和源码 |
| Evidence | claim、trust、status、source IDs、摘要和URI | Evidence Graph + Artifact |
| 已整理的旧结果 | placeholder、summary、source refs、restore URI | 原始 Artifact 永久可审计 |

本计划不新建第二个事实库，不新建第二套 Agent transcript，不把 GUI 状态作为权威，也不在第一阶段强制引入向量数据库。现有 `ControlStore` 继续拥有任务和生命周期事实，`ArtifactStore` 继续保存原始内容，`Evidence Graph` 继续拥有证据关系，`Knowledge Projection` 继续提供导航，`ContextCompiler` 只负责从这些来源产生某一轮 Provider 视图。

## 2. 要解决的问题和不解决的问题

### 2.1 目标问题

当前用户反馈和现有架构暴露出几类需要单独测量的问题：

1. 文件搜索、读取和外部工具的完整结果进入上下文后，单次返回可能很大，多个结果会快速挤压动态上下文。
2. 长对话接近上下文边界后，模型重复读取相同内容、忽略已经整理的证据，或在固定节点继续循环。
3. 结果已经存在于运行目录或 Artifact 中，但模型和用户不能快速知道结果是什么、是否完成、如何取回。
4. 多个 Tool/Job 同时运行时，缺少一个有界、可重建的总状态视图。
5. Evidence 的来源、冲突、未查看结果和已整理结果不够直观，用户难以判断 Agent 究竟整理了什么。
6. Skill 和 Tool 的完整说明不应反复复制到每一轮，但必要 schema 和权限说明必须持续可见。
7. 启动或恢复时若一次读取过多历史内容，会把“恢复”变成新的启动瓶颈。

### 2.2 明确不承诺

- 外置内容不会自动提高模型能力；模型仍可能不召回、召回错误或误解摘要。
- 稳定 URI 不代表内容正确、可信或适合当前任务；可信度必须由 `trust`、来源、generation、hash 和 verifier 表达。
- 压缩不会删除原始 Artifact，也不会凭摘要改变事实权威。
- 动态状态条不会替代详细结果；它只告诉模型和用户下一步该检查什么。
- 服务器、Provider 或网络本身的慢不会被 RAG 自动消除；本计划会减少不必要的传输、重复读取和启动重建，但仍需独立的性能指标定位慢点。
- 向量相似度不能作为 Evidence 的真实性分数，也不能替代精确 URI、结构化索引和确定性过滤。
- “主动失忆”不能修改已经发给 Provider 的历史；它只能改变下一次请求的 Context Projection，并持久化一条可恢复的整理记录。

## 3. 技术评估结论

### 3.1 适合立即采用的部分

现有系统已经具备大部分基础设施：

- `ArtifactStore` 已能保存 Tool 输出、Provider 记录和中间文件，支持范围读取、大小和 hash。
- `SpillStore` 已区分 `canonical`、`presentation` 和 `durable` 三种 Tool 结果形态，适合作为新的 Model Receipt 接缝。
- `Knowledge Projection` 已有 `pb://run/...`、`pb://project/...` URI 和 L0/L1/L2 投影，适合承担召回入口。
- `ContextManifest` 已记录层级 token、来源 ID、块 hash、压缩状态、cache hash 和维护动作，适合扩展为引用视图清单。
- `DurableCompaction` 和 Evidence consolidate 已有事务括号、checkpoint、placeholder 和失败恢复方向。
- `RunEvent`、`Observation Queue`、Job 和 Provider 生命周期已经能为状态面板提供可重建来源。
- Skill 元数据常驻、正文按需加载的当前设计已经接近“Skill RAG 化”。

因此第一版应是现有 S4-S6 的升级，不应再添加一个与 Artifact、Knowledge 和 Evidence 平行的 RAG 子系统。

### 3.2 不能直接照搬的部分

#### 只给路径的问题

```text
Tool -> pb://.../artifact/A-1
```

这会丢失模型进行下一步决策所需的最小局部信息。可行的回执至少需要说明：操作是否成功、结果类型、关键统计、摘要、是否截断、hash、generation、下一步和召回 URI。

#### 每次结果都追加状态的问题

事件可以每次追加，但 Provider 视图不能每个心跳都追加一条消息。否则状态更新自身会变成上下文噪声，并再次导致上下文增长。事件层必须 append-only；Context 层必须按 `coalescingKey` 和安全点合并，只投影最新有意义的状态。

#### 把 RAG 等同于向量数据库的问题

ProofBlade 的第一需求是可靠、可审计、可按 generation 隔离的持久化引用，不是模糊语义搜索。精确 URI、结构化元数据、关键词、标签、source ID 和范围读取更容易重放、更容易定位首错，也更不容易把相似但错误的事实召回。

#### 直接把文件系统路径给模型的问题

宿主路径会泄露环境信息，绕过 scope 和权限，无法保证内容属于当前 Run，也无法提供稳定的跨平台语义。模型只接触 `pb://` 和结构化 Tool 接口，运行时负责解析、授权、generation fencing、范围和 hash 校验。

## 4. 架构不变量

以下规则是所有阶段的硬约束：

1. **单一事实来源**：ControlStore 是任务、RunEvent、Job、Effect 和 generation 的权威；ArtifactStore 是原始内容权威；Evidence Graph 是证据关系权威；Context 是派生视图。
2. **原文可恢复**：任何被摘要、placeholder 或 forget 的内容都保留原始 Artifact、source ID、hash 和审计事件。第一版不得物理删除以实现“失忆”。
3. **引用可寻址**：模型收到的每个 URI 都能在当前权限和 Run 范围内解析；同一对象使用一个规范 URI，别名不写入持久链接。
4. **generation 隔离**：旧 generation 的 Tool、Job、Effect、Artifact 和 Event 可以审计或显式读取，但不能自动作用于当前 generation，也不能被新 Run 的状态投影误认成当前结果。
5. **权限先于召回**：读取先检查 URI 语法、Run、scope、generation、sensitivity、Artifact 存在性、范围和调用者能力，再读取字节。
6. **hash 绑定**：回执、摘要、Evidence 和 Artifact 必须保留内容 hash 或 projection hash。读取后的标识必须说明读到的版本，不能只显示“已读取”。
7. **摘要不是验证**：Summary 只能改变可见程度，不能把 `untrusted` 提升为 `verified`；Completion 仍由统一 verifier 决定。
8. **Tool pair 合法**：未结束的 Tool Call/Tool Result 不可被 forget、prune 或替换成孤立 placeholder。整理只能在协议允许的安全点进行。
9. **原子生命周期**：Operation、Recall、Consolidate、Forget、Restore 都有 start/finished/failed 或等价的可恢复生命周期。只有完成事件存在时才提升新 Context Projection。
10. **单 Agent 默认**：所有新能力先服务同一个 Coding Lane 和同一个 Agent loop；多 Agent 只预留 WorkItem/handoff 接口，不注册、不调度、不启用。
11. **可重建状态**：状态面板、GUI、CLI 和 ContextManifest 都从 RunEvent、Artifact、Session 和 snapshot 投影，不依赖只存在于内存的计数器。
12. **有界优先**：任何模型展示、搜索、召回、状态更新和摘要都有字符、字节、token、条数、耗时或并发上限。

## 5. 目标数据流

### 5.1 普通短 Tool

```text
Agent
  -> Tool Call
  -> preflight / Effect / Tool execution
  -> canonical result
  -> Artifact registration when policy requires
  -> ModelReceipt (inline or preview + URI)
  -> Tool Result pair
  -> Context status suffix
```

短结果保留模型决策所需内容；规范值和 Artifact 始终保留，便于 replay、GUI 和 Evidence。

### 5.2 大 Tool 或长 Job

```text
Agent
  -> Tool Call
  -> Operation/Job started
  -> immediate receipt: jobId + status + operation URI
  -> event/observation queue
  -> bounded progress update at safe point
  -> completed receipt: summary + artifact/evidence refs
  -> optional recall(range/cursor)
```

大结果不得伪装成同步完整返回。模型可以继续做独立工作；Job 完成后由同一 Run 的安全点事件循环唤醒。

### 5.3 压缩和主动失忆

```text
raw Tool Result in persisted session
  -> context_memory.inspect
  -> consolidate/start
  -> summary Artifact + source closure
  -> consolidate/end
  -> next Provider projection uses placeholder + summary + URI
  -> context_memory.restore/recall can recover bounded original content
```

如果摘要生成或提交失败，下一次请求继续使用旧视图；不能留下“看起来已经忘记，但摘要不存在”的半提交状态。

## 6. 核心数据模型

以下类型是计划中的 domain contract。字段命名可以按现有代码风格调整，但语义不能缩减。

### 6.1 `OperationRef`

统一标识一次 Tool、Skill load、MCP call、Job、Recall、Consolidate、Forget 或 Restore 操作。

```ts
interface OperationRef {
  schemaVersion: 1;
  id: string;
  kind: "tool" | "skill" | "mcp" | "job" | "recall" | "consolidate" | "forget" | "restore";
  runId: string;
  generation: number;
  laneId: string;
  correlationId: string;
  causationId?: string;
  status: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  replayPolicy: "pure" | "idempotent" | "unknown" | "never";
  startedAt: string;
  finishedAt?: string;
  inputHash: string;
  resultHash?: string;
  sourceArtifactIds: string[];
  resultArtifactIds: string[];
  uri: string;
}
```

`OperationRef` 不是新的事实库记录；它由既有 RunEvent、Effect、Job 和 Artifact 事件投影而来，必要时可通过事件重建。

### 6.2 `ContextRef`

模型或 ContextManifest 中使用的稳定引用。

```ts
interface ContextRef {
  uri: string;
  kind: "operation" | "artifact" | "job" | "evidence" | "skill" | "session" | "task";
  runId?: string;
  generation?: number;
  scope: "current-run" | "same-project" | "public-project";
  level: "L0" | "L1" | "L2";
  contentHash: string;
  sourceIds: string[];
  trust: "untrusted" | "observed" | "proposed" | "verified";
  sensitivity: "public" | "secret" | "flag_candidate";
  stale: boolean;
  readPolicy: {
    maxChars: number;
    maxBytes: number;
    maxItems?: number;
    allowRange: boolean;
  };
}
```

`scope`、`generation`、`trust` 和 `level` 必须分别表达，不能用一个 `verified` 或一个 URI 字符串替代四种语义。

### 6.3 `ModelReceipt`

Tool/Job/Recall 返回给模型的有界内容。

```ts
interface ModelReceipt {
  schemaVersion: 1;
  operationId: string;
  state: "success" | "error" | "accepted" | "running" | "partial";
  title: string;
  summary: string;
  keyFacts: Array<{ key: string; value: string }>;
  refs: ContextRef[];
  preview?: {
    text?: string;
    head?: string;
    tail?: string;
    omittedChars?: number;
    omittedItems?: number;
  };
  nextActions: Array<"recall" | "monitor" | "inspect" | "record_evidence" | "retry" | "wait" | "none">;
  resultHash: string;
  presentationHash: string;
  generatedAt: string;
}
```

`ModelReceipt` 必须短而稳定；它不是对原始结果的第二份可变副本。`summary`、`preview` 和 `keyFacts` 均有独立长度限制。

### 6.4 `RecallRecord`

每次模型主动读取或系统按策略召回的审计记录。

```ts
interface RecallRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  generation: number;
  operationId?: string;
  requester: "agent" | "system" | "gui" | "cli";
  uri: string;
  requestedLevel: "L0" | "L1" | "L2";
  range?: { offset: number; limit: number };
  returnedBytes: number;
  returnedChars: number;
  contentHash: string;
  projectionHash: string;
  truncated: boolean;
  status: "SUCCEEDED" | "DENIED" | "NOT_FOUND" | "STALE" | "FAILED";
  reason?: string;
  createdAt: string;
}
```

读取回执必须包含“实际读了什么”的标识，例如 `uri`、`contentHash`、`level`、范围和 `projectionHash`。这样模型和 GUI 能区分“已查看摘要”和“已查看原文第 2000-4000 字节”。

### 6.5 Forget/Consolidate 记录

```ts
interface ContextCurationOperation {
  schemaVersion: 1;
  id: string;
  runId: string;
  generation: number;
  kind: "consolidate" | "forget" | "restore";
  targetOperationIds: string[];
  targetMessageIds: string[];
  sourceArtifactIds: string[];
  summaryArtifactId?: string;
  replacementRef?: ContextRef;
  beforeTokens: number;
  afterTokens?: number;
  policyHash: string;
  sourceClosureHash: string;
  projectionHash?: string;
  status: "STARTED" | "SUMMARIZED" | "COMMITTED" | "FAILED" | "ABANDONED";
  createdAt: string;
  completedAt?: string;
}
```

`forget` 的意思是从下一次 Provider view 中移除原始文本，不是删除数据。`restore` 可以恢复一个有界 preview，不能未经策略直接把整个历史结果重新塞回上下文。

## 7. URI 和召回协议

### 7.1 URI 设计

沿用现有 `pb://`，增加 Operation 和 Context 维护对象的规范入口：

```text
pb://run/<runId>/operation/<operationId>
pb://run/<runId>/operation/<operationId>/receipt
pb://run/<runId>/job/<jobId>
pb://run/<runId>/artifact/<artifactId>
pb://run/<runId>/artifact/<artifactId>/content
pb://run/<runId>/evidence/<evidenceId>
pb://run/<runId>/session/<sessionId>
pb://run/<runId>/context/curation/<curationId>
pb://project/skills/<skillName>
pb://project/tools/<toolName>
pb://project/mcp/<serverName>
pb://project/index
```

URI 必须是逻辑地址，不是宿主路径。Artifact 的实际文件路径只能在服务端内部使用，并且不能直接出现在模型默认回执中。

### 7.2 读取操作

第一版可以复用或扩展现有 `evidence` proxy 的 `inspect_uri`、`search_uri` 和 `read`，不必立即增加大量顶层 Tool。若现有 schema 无法清楚表达上下文管理，再增加固定的 `context_memory` proxy。

建议接口：

```text
context_memory(operation="inspect", uri?, level?, query?, maxChars?)
context_memory(operation="recall", uri, level="L0|L1|L2", offset?, limit?)
context_memory(operation="consolidate", targetIds?, policy?)
context_memory(operation="forget", operationIds?, messageIds?)
context_memory(operation="restore", uri, level="L0|L1", maxChars?)
```

返回值必须是 `ModelReceipt` 或 `ContextStatusReceipt`，而不是未限制的文件文本。

### 7.3 召回流程

```text
normalize URI
  -> verify project/run scope
  -> verify generation and stale policy
  -> verify sensitivity and capability
  -> resolve projection at requested level
  -> enforce byte/char/item/range budget
  -> verify Artifact hash
  -> append RecallRecord
  -> return bounded content + read marker + remaining refs
```

读取失败要返回可行动的结构化错误：`NOT_FOUND`、`STALE`、`DENIED`、`RANGE_EXCEEDED`、`HASH_MISMATCH`、`BUSY` 或 `FAILED`。不能用空字符串伪装成“没有内容”。

### 7.4 读取标识

每次读取结果在模型中追加一个短标记，例如：

```text
[recall]
uri=pb://run/R-1/artifact/A-7/content
level=L2 range=0..4000 returned=3981 chars truncated=true
content_sha256=...
projection=...
trust=untrusted generation=3
[/recall]
```

标记的目的是告诉模型它看过哪个版本和范围，不是重复结果内容。GUI 同时显示原始 Artifact、召回范围、摘要、hash、来源和 Evidence 关系。

## 8. Tool、Skill、MCP、Job 和 Evidence 的统一策略

### 8.1 Tool

每个 Tool 仍遵循三态输出：

```text
canonical value     程序、Verifier、Replay 使用
model presentation  当前 Provider 使用的有界回执
durable content     Artifact/Spill/Evidence 使用的完整内容
```

输出策略由 Tool Contract 声明：

```ts
interface ToolOutputPolicy {
  inlineThresholdChars: number;
  previewMaxChars: number;
  maxReceiptChars: number;
  durable: "always" | "over-threshold" | "on-error" | "never";
  autoEvidence: "none" | "observation" | "candidate";
  allowRecall: boolean;
  recallMaxChars: number;
}
```

`glob`、`grep` 和 `read` 必须首先修复模型可见输出上限，并把完整匹配集合或文件内容与回执分离。结果应包括匹配数、显示数、是否截断、Artifact id、hash、代表性路径/行号和下一步操作。

### 8.2 Skill

常驻上下文只包含 Skill name、version、summary、适用范围、权限、输入输出 schema、URI 和加载状态。Skill 正文、长示例和参考材料通过 `pb://project/skills/...` L1/L2 按需读取。

Skill 加载必须记录 `skillId`、version、contentHash、scope、operationId 和 activation state。仅读取 Skill 不等于启用 Skill；未启用的 Skill 不能改变 Tool catalog 或权限。

### 8.3 MCP

MCP 顶层代理 schema 保持固定。Server/tool directory 以 metadata 和 schema 形式提供，长帮助文本和返回结果进入 Artifact/Projection。MCP 进程生命周期、scope、敏感度和原始响应必须绑定到 OperationRef，重连不能改变已经开始的调用的 provider binding。

### 8.4 Job

Job 立即返回 `jobId`、状态、进度 cursor、operation URI、当前 generation 和下一次 monitor 建议。Job 的每个进程输出不能都进入上下文；只在关键字、退出、错误、进度变化或有界 heartbeat 时生成 Observation。连续 heartbeat 必须 coalesce。

Job 完成时提供：

```text
status, exitCode, duration, progressCursor,
newArtifactIds, evidenceIds, outputSummary,
outputHash, nextAction, stale/generation status
```

### 8.5 Evidence

Evidence projection 默认显示：claim、status、trust、source IDs、支持/反驳关系、冲突数、摘要、最新更新时间和 URI。原始命令输出、长文件和完整推理过程不直接复制进 Evidence L0。

Evidence consolidate 要产生来源闭包：摘要中每个可验证结论都能追溯到 Artifact、Observation、Tool Operation 或已有 Evidence。负面结果、rejected hypothesis 和未覆盖 gap 也必须进入索引，不能只保留正面结论。

### 8.6 Provider transcript

Provider 仍然接收合法的消息序列。Context RAG 只改变下一次请求的派生投影，不修改已持久化 Pi Session 的原始历史。对已经完成且完成 Tool pair 的旧结果，可以在新的 Context Projection 中使用 placeholder；当前 turn 尚未完成的 pair 必须保留原始必要内容。

## 9. 结果大小分级和回执规则

大小阈值必须配置化、进入 Tool Contract hash，并在 `RequestEpoch` 和 GUI 中可见。建议初始默认值如下，实际值需要用模型和 Provider 评测调整：

| 级别 | 文本大小 | 默认回执 |
| --- | ---: | --- |
| T0 | `<= 2 KiB` | 有界完整内容 + URI/hash |
| T1 | `> 2 KiB` 且 `<= 16 KiB` | 摘要 + head/tail + 统计 + URI/hash |
| T2 | `> 16 KiB` 且 `<= 1 MiB` | 摘要 +关键索引 + URI/hash；按需范围读取 |
| T3 | `> 1 MiB` 或二进制 | 类型/尺寸/hash/分析结果 + URI；禁止直接原文注入 |
| J0 | Job 已接受 | jobId/status/operation URI/next monitor |
| J1 | Job 完成 | status/summary/artifact/evidence refs/next action |

阈值不能取代内容感知策略：一个 1 KiB 的 secret 仍不可直接显示，一个 1 KiB 的 Tool pair 结果也不能因为压缩而被拆散。

每个回执必须能够回答：

1. 调用做了什么？
2. 成功、失败、部分完成还是仍在运行？
3. 最重要的结果是什么？
4. 有多少内容未显示？
5. 完整内容在哪里？
6. 当前结果属于哪个 Run/generation，是否 stale？
7. 下一步是读取、监控、记录证据、重试、等待还是结束？

## 10. 动态状态尾部协议

### 10.1 目标

让 Agent 在压缩、异步 Job 和多个工具并行期间知道系统状态，同时不把每条事件原样复制到上下文。

### 10.2 状态结构

```ts
interface ContextStatusReceipt {
  schemaVersion: 1;
  runId: string;
  generation: number;
  sequence: number;
  activeTools: number;
  completedTools: number;
  failedTools: number;
  runningJobs: number;
  pendingObservations: number;
  newArtifacts: number;
  newEvidence: number;
  attentionRequired: number;
  staleOperations: number;
  latestRefs: ContextRef[];
  changedSinceLastStatus: string[];
  nextAction: "continue" | "recall" | "monitor" | "consolidate" | "wait" | "needs_human";
  generatedAt: string;
}
```

Provider 中的文本投影保持有界：

```text
[context-status]
run=R-1 generation=3 active_tools=2 completed_tools=8 running_jobs=1
pending_observations=3 new_artifacts=2 new_evidence=1 attention_required=0
latest_refs: pb://run/R-1/operation/O-2/receipt, pb://run/R-1/job/J-1
next_action=monitor
[/context-status]
```

### 10.3 更新规则

- RunEvent 每次状态变化都可持久化。
- Provider 只在 Tool terminal、Job 关键观察、安全点、用户请求或维护动作结束时追加合并状态。
- 同一 `runId + generation + coalescingKey` 的 heartbeat 合并成一条。
- 状态只携带计数、差异类型和少量最新 URI，不重复摘要正文。
- 状态更新必须位于合法动态尾部，不能插入 System、历史用户消息或未闭合 Tool pair 中间。
- generation reset 后丢弃旧 generation 的 active count，旧事件只进入 stale/failed 统计。
- 状态失真时以 ControlStore snapshot 和 RunEvent 重建，不信任模型回传的计数。

## 11. 主动失忆、整理和恢复

### 11.1 建议 API

第一版优先扩展现有 `evidence` 的 `consolidate` 能力，并提供统一 `context_memory` 代理。操作可包括：

| 操作 | 作用 | 是否删除原文 |
| --- | --- | --- |
| `inspect` | 查看当前上下文占用、可整理对象和状态 | 否 |
| `recall` | 通过 URI 读取有界内容 | 否 |
| `summarize`/`consolidate` | 生成 source-linked summary 和替换计划 | 否 |
| `forget` | 从下一轮 Provider view 移除指定原始文本 | 否 |
| `restore` | 恢复 placeholder 或有界预览 | 否 |

### 11.2 Forget 前置检查

只有满足以下条件才可提交 forget：

- 目标 Tool Call 已完成，Tool pair 不再未闭合；
- 没有 `STARTED` 或 `UNKNOWN` Effect 依赖目标结果；
- 当前 turn 不再需要原始文本进行协议续接；
- 已生成并持久化 summary Artifact；
- Summary 拥有 source IDs、content hash、policy hash 和 projection hash；
- 当前 generation、scope 和 sensitivity 检查通过；
- 没有未处理的 urgent Observation 依赖该结果。

检查失败时返回 `not_ready`，不强行删除。

### 11.3 整理事务

```text
context_curation/start
  -> source snapshot and target message ids frozen
context_curation/summary
  -> summary Artifact, source closure, conflicts, gaps, next action
context_curation/commit
  -> replaceable message ids, placeholder, manifest update
```

如果进程在任一节点退出，恢复器保留旧 Context view，检查已有 summary 是否匹配 source hash；不匹配则丢弃草稿并重试。只有 commit 完成后，下一次 ContextCompiler 才允许使用 placeholder。

### 11.4 Summary 内容要求

摘要不能只写“已读取文件”。至少应包括：

```text
范围：哪些 operation/artifact/message 被整理
结论：已观察事实、假设、反驳和未决问题
关键值：路径、符号、行号、命令、状态、错误和数值
证据：source IDs、artifact URI、hash、trust、generation
缺口：没有验证什么，哪些内容可能过期
下一步：需要 recall、monitor、verify 还是继续探索
```

用户在 GUI 中必须能看到这份 summary、来源闭包、被替换的原始结果和恢复入口，避免“Agent 说整理过但用户看不到整理了什么”。

## 12. ContextCompiler 改造

### 12.1 保留现有分层

继续使用现有 L0-L5、K0-K2 和 P0-P10 语义，不因为引入 RAG 再创造一套层级：

```text
L0  常驻系统规范、固定 Tool schema、Scope/安全规则
L1  Task Contract、当前目标和必要约束
L2  Run 状态、WorkItem、恢复动作、状态尾部
L3A durable ledger、Evidence summary、已确认事实和阻塞
L3B active controls、Job、Lease、Observation、维护状态
L4  合法的近期 transcript 和未闭合 Tool pair
L5  Artifact/Operation/Knowledge refs、placeholder 和按需召回入口
```

Skill metadata 和 Tool schema 属于稳定前缀；Skill 正文、旧 Tool 原文和 Job 输出属于可替换动态内容。

### 12.2 新增编译步骤

```text
load ControlStore snapshot and generation
  -> load persisted transcript projection
  -> select mandatory blocks
  -> select ModelReceipt and status suffix
  -> apply curation replacements only after committed operation
  -> enforce Tool pair repair
  -> enforce per-block and total budget
  -> build ContextManifest with refs and hashes
  -> persist RequestEpoch
  -> serialize actual Provider payload
```

编译器不得在编译时隐式读取任意大 Artifact。需要召回的内容必须有明确的 `RecallRecord` 或显式系统策略，并在预算中计入。

### 12.3 Manifest 扩展

在现有 `ContextManifest` 上增加或派生：

```ts
interface ContextReferenceSummary {
  uri: string;
  operationId?: string;
  sourceIds: string[];
  level: "L0" | "L1" | "L2";
  includedAs: "inline" | "preview" | "placeholder" | "status" | "mandatory";
  contentHash: string;
  recalledAt?: string;
  stale: boolean;
}
```

Manifest 还应记录：inline/preview/placeholder 数量、可召回字节总量、被 forget 的 operation 数、最后一次 consolidate、状态 suffix sequence、recall failure 数和最大的可压缩来源。

### 12.4 硬保留和压缩优先级

硬保留：

- System/Developer 安全规范、当前 Tool schema 和权限约束；
- 当前用户目标和 Task Contract；
- 未闭合 Tool pair；
- `STARTED`/`UNKNOWN` Effect、运行中 Job 和 urgent Observation；
- 当前 Evidence/Verifier 所需来源和唯一失败诊断；
- Artifact/Operation URI、hash、generation、trust 和必要 placeholder；
- 尚未提交的 curation transaction 状态。

优先外置或整理：

- 已完成且重复的 glob/grep/read 结果；
- 已进入 L3A 的旧 Tool 原文；
- 已有 source-linked summary 的大结果；
- 与当前 Task Contract 无关的 Skill 正文和帮助材料；
- 已结束 Job 的冗余 heartbeat 和重复日志片段。

## 13. 检索策略和向量数据库决策

### 13.1 第一阶段：确定性检索

先实现以下索引和查询：

- exact URI / object ID；
- `runId`、generation、scope、kind、status、trust、sensitivity；
- operation、tool name、path、command hash、tag、time range；
- source ID、Evidence relation、artifact hash；
- 关键词和路径 glob；
- bounded cursor/range read。

每个搜索结果必须包含 URI、类型、摘要、trust、generation、hash、来源和是否 stale。搜索排序可以确定性地使用当前任务相关标签、最新状态和 source relation，但不能把排序分数当作可信度。

### 13.2 向量检索的准入条件

第一版不依赖 embedding 或 vector store。只有同时满足以下条件才实现可选适配器：

1. Artifact/Knowledge 数量足够大，确定性检索的召回率已有量化基线；
2. 评测显示关键词、标签和结构化过滤无法满足任务；
3. A/B 证明向量召回提高 verified success 或减少有效 Tool 回合，而不是只提高相似文本数；
4. 每个 embedding 有模型、版本、时间、source hash 和 scope 绑定；
5. 向量索引缺失或过期时有确定性 fallback；
6. 召回结果仍经过 URI 权限、generation、hash 和 trust 检查；
7. GUI/Replay 可以解释“为什么召回这个结果”；
8. 向量库不是事实源，不承载唯一原文，不绕过 ArtifactStore。

推荐接口：

```ts
interface KnowledgeRetriever {
  search(input: {
    runId: string;
    generation: number;
    query: string;
    scope: "current-task" | "run" | "project";
    maxResults: number;
  }): Promise<Array<{ ref: ContextRef; score?: number; reason: string }>>;
}
```

第一版由 `DeterministicKnowledgeRetriever` 实现，后续可以增加 `EmbeddingKnowledgeRetriever`，但二者都只返回引用。

## 14. GUI、CLI 和可见性设计

### 14.1 GUI 目标

GUI 不应要求用户在很多页面之间猜测“工具做了什么”。一次 Tool 操作应能直接看到：

```text
名称/用途 -> 输入摘要 -> 状态 -> Model Receipt -> 结果大小
-> 是否截断 -> Artifact/Evidence/Job refs -> hash/generation/trust
-> 已召回范围 -> 原始内容 -> 整理摘要 -> 恢复/读取入口
```

### 14.2 运行状态面板

从同一事件投影显示：

- active/completed/failed Tool 数；
- running/completed/stalled Job 数；
- pending/urgent Observation 数；
- 未处理结果和 attention required；
- 最新 Operation/Artifact/Evidence refs；
- 当前 generation 和 stale 数量；
- Context used/available/remaining、可压缩最大来源、last consolidate 和 next action；
- 启动恢复耗时分解：snapshot、Artifact index、projection、Provider warmup、GUI SSE。

计数必须可点击回到具体 Operation 或 Event，不能只显示不可解释的数字。

### 14.3 Evidence 视图

增加一个“整理结果”视图，至少支持：

- summary 与 source IDs 对照；
- claim、support、refute、depends_on、reproduces 关系；
- observed/proposed/verified/conflicted 状态；
- 未查看和未覆盖的 Artifact；
- 被 placeholder 替换的 Tool 结果；
- 一键打开 L0/L1/L2，读取范围和 hash 标记；
- consolidate 操作的 start/summary/commit/failed 轨迹。

### 14.4 CLI 计划

复用现有命令风格增加：

```text
proofblade context <run-id>
proofblade context <run-id> --refs
proofblade context <run-id> --pressure
proofblade recall <run-id> <pb-uri> --level L0|L1|L2 --max-chars N
proofblade consolidate <run-id> [--target ...]
proofblade operations <run-id> [--status ...]
proofblade evidence <run-id> --curation
```

CLI 默认只打印有界 receipt；`--raw` 也必须要求明确 URI、范围和最大字节数，不能提供无界 dump。

## 15. 启动、性能和资源预算

### 15.1 启动路径

启动时只加载：

1. ControlStore snapshot 和当前 generation；
2. 必要的 Task Contract、Tool schema 和 Skill metadata；
3. Operation/Job/Evidence/Artifact 的轻量索引；
4. 最近 status suffix 和未闭合 Tool pair；
5. 需要恢复的 Operation 状态。

Artifact 正文、旧 transcript、完整 Evidence tree 和 Skill 正文延迟到召回。启动不能为了生成一份 GUI 列表而读取所有大文件。

### 15.2 性能预算

第一版实施前先建立 baseline，实施后至少报告：

```text
tool execution latency: p50/p95/p99
artifact persist latency: p50/p95/p99
receipt build latency
recall latency: p50/p95/p99
context compile latency
startup to new-chat-ready latency
startup bytes read / files opened
Provider request input tokens
inline / preview / placeholder ratio
duplicate recall ratio
repeated tool result ratio
context pressure events
consolidate success/failure/recovery time
```

本计划不预先承诺具体毫秒数。阶段验收需以当前 baseline 为基线，并同时检查成功率、证据覆盖和错误率，不能只追求更短的回执。

### 15.3 慢工具保护

- Tool 执行和 Artifact 持久化应分开计时，避免把“读文件慢”和“写 Artifact 慢”混成一个数字。
- 大结果使用流式或分块写入，不能先在内存中复制多份完整字符串。
- 召回只读请求必须有 timeout、范围和取消语义。
- 相同 operation/result hash 的重复召回可返回已验证的 projection，但仍记录 RecallRecord。
- 进程重启后索引缺失可以重建，但不能阻塞新建对话读取所有历史正文。
- 失败的异步索引或 Telemetry 只能产生诊断，不阻断主 Tool/Provider loop。

## 16. 安全、隐私和 generation fencing

### 16.1 敏感内容

Secret、flag candidate、用户私有路径、Provider credential 和外部响应必须沿用 Artifact sensitivity。Model Receipt 可以只显示脱敏统计、hash 和受控摘要；GUI 也必须遵循调用者权限。不能因为内容已经有 URI 就默认可见。

### 16.2 跨 Run 和跨 generation

- `pb://run/R-1/...` 默认不能由 `R-2` 读取，除非显式 project/public policy 允许。
- generation 不一致的 operation 默认返回 stale，不自动作用于当前状态。
- reset 后旧 job、旧 ingress、旧 effect、旧 receipt 不得被当前状态计数为 active 或 completed。
- restore 旧 generation 内容时必须显式标注 `stale=true` 和原 generation，不能把它投影成当前 Fact。

### 16.3 完整性

Artifact 内容 hash、receipt resultHash、summary sourceClosureHash 和 ContextManifest projectionHash 必须可交叉检查。hash 不一致时停止提升投影，保留旧视图并生成需要人工处理的诊断。

### 16.4 Prompt 注入

Tool 原文、Skill 文本、外部网页和 Artifact 默认是不可信数据。召回回执必须明确边界：内容是数据，不是系统指令；外部内容不能修改 Tool 权限、Task Contract、Verifier 或 Context policy。摘要模型也不应被授予比主 Agent 更高的权限。

## 17. 单 Agent 分阶段实施计划

每个阶段完成后都要补 focused tests；这些测试用于验证实现契约，不替代用户对真实问题的端到端测试。

### R0：基线、契约和测量

**优先级：P0。前置：无。**

交付：

- 定义 `OperationRef`、`ContextRef`、`ModelReceipt`、`RecallRecord` 和 curation schema version；
- 建立 Tool 结果大小、Context compile、启动读取和召回延迟 baseline；
- 在 RequestEpoch/ContextManifest 中记录 policy hash、receipt counts、reference counts 和 curation state；
- 为所有新操作定义 start/finished/failed/orphan recovery 事件；
- 为 system prompt、Tool schema 和 receipt policy 建立规范 hash。

Focused tests：

- schema canonical hash、版本和未知字段拒绝；
- 同一 snapshot 重建相同 refs、receipt 和 manifest hash；
- generation/scope/sensitivity fencing；
- start 无 finish 的 orphan recovery；
- baseline 统计不读取 Artifact 正文。

门槛：不能改变现有 Provider payload 语义，只旁路记录指标和 projection metadata。

### R1：统一 Tool 三态输出和持久化回执

**优先级：P0。前置：R0。**

交付：

- 将 `SpillStore` 扩展为统一 receipt builder；
- glob/grep/read/bash/MCP 返回 bounded receipt；
- 所有模型可见 output 有硬上限，结果 Artifact 和 hash 可追溯；
- Tool error 也生成结构化 receipt 和可行动 next action；
- 小、中、大、二进制结果按策略分流。

Focused tests：

- T0/T1/T2/T3 的 inline、preview、spill 和失败回退；
- resultHash、contentHash、presentationHash 一致性；
- glob/grep 超出 max results 时模型输出仍有界且 Artifact 完整；
- spill 写入失败时不伪装成成功；
- Tool pair 合法性和大结果重放。

门槛：工具结果不再出现无上限模型可见文本；现有成功/失败语义和 verifier 输入保持一致。

### R2：URI、召回和读取标识

**优先级：P0-P1。前置：R1、现有 S4。**

交付：

- 扩展 `Knowledge Projection` 处理 Operation、Job、receipt 和 curation URI；
- 实现精确 URI、关键词、metadata 和 bounded range recall；
- 记录 RecallRecord；
- 返回 URI、范围、hash、trust、generation 的 read marker；
- 统一错误分类和取消/超时。

Focused tests：

- URI 规范化、越界、路径注入和未知 scheme；
- current-run/project scope、generation stale、sensitivity deny；
- L0/L1/L2 内容和 range 上限；
- Artifact hash mismatch、缺失、读取超时和取消；
- RecallRecord 重建与重复读取幂等。

门槛：模型通过 URI 可以取回必要内容，但未显式召回时不会自动读取大 Artifact。

### R3：ContextCompiler 引用投影和动态状态尾部

**优先级：P1。前置：R2、现有 S5。**

交付：

- ContextManifest 增加 references、receipt counts、status sequence 和 curation summary；
- 大 Tool 结果在下一轮只投影 receipt/preview/placeholder；
- 实现 coalesced `ContextStatusReceipt`；
- 保留未闭合 Tool pair、当前目标、unknown Effect、运行中 Job 和关键 refs；
- 不修改稳定 System/Tool schema 前缀。

Focused tests：

- 多 Tool/Job 完成后的计数和 latest refs；
- heartbeat 合并，状态不会每个进程输出一条；
- status suffix 只追加在合法尾部；
- Context pressure 下 placeholder 不断开 Tool pair；
- 相同 snapshot 的 block/hash/replay parity；
- 76K 附近的压力测试：不发生无界增长、重复完整结果注入或静默停滞。

门槛：Provider 请求的动态结果体积下降，同时 Tool 调用成功率、证据覆盖和 replay parity 不下降。

### R4：Skill、MCP 和 Job 的引用化

**优先级：P1。前置：R2、R3、现有 S2-S4。**

交付：

- Skill metadata 常驻，正文/长帮助按需召回；
- MCP directory、server status、调用结果统一 OperationRef；
- Job 只返回状态、cursor、summary 和 refs；
- Observation Queue 只注入 coalesced bounded observations；
- 恢复后 orphan Operation/Job 不被默认为成功。

Focused tests：

- Skill accepted/loaded/activated 状态区分；
- MCP reconnect、schema hash 和 binding 不漂移；
- Job heartbeat、完成、失败、stalled、generation reset；
- 事件重启恢复不会重复应用或漏掉 terminal state；
- 大日志只在显式 recall 时读取。

门槛：长任务不需要模型紧密循环 read；后台变化仍能通过同一 Run 唤醒并可见。

### R5：Evidence consolidate 和主动失忆

**优先级：P1。前置：R3、R4、现有 S6。**

交付：

- 扩展 consolidate 为 source-linked summary、context replacement 和 Evidence projection；
- 实现 `context_memory` 的 inspect/recall/consolidate/forget/restore；
- forget 只修改下一轮 Provider view，不删除原始 Artifact；
- summary 失败保留旧视图；
- GUI 显示 summary、来源闭包、冲突、gap、placeholder 和恢复入口。

Focused tests：

- 三个重复搜索结果合并为一份 L1 summary；
- source closure、负面结果、rejected hypothesis 和 gap 保留；
- start/summary/commit 中途崩溃恢复；
- forget 前置检查拒绝未完成 pair、unknown Effect 和未持久化 summary；
- restore 只恢复有界内容，并保留 original URI/hash/generation；
- consolidate 幂等且不产生重复 Evidence。

门槛：Agent 可以主动减少下一轮上下文；用户可以看到整理了什么；原始内容可恢复。

### R6：启动优化、GUI/CLI 和用户可见诊断

**优先级：P1。前置：R2-R5。**

交付：

- 启动只加载轻量索引、当前 snapshot、metadata、未闭合 pair 和恢复所需对象；
- GUI 增加 Operation/Recall/Curation 时间线和上下文引用面板；
- CLI 提供 context、recall、consolidate、operations 和 evidence curation；
- 分离 Tool 执行、Artifact 写入、projection、Provider warmup 和 GUI ready 计时；
- 失败路径有用户可读的下一步。

Focused tests：

- 大 Artifact 存在时新建对话不读取正文；
- SSE 断线后面板从事件重建；
- GUI/CLI 与 ContextManifest 显示同一计数和 hash；
- 只读 recall 不阻塞主 Run；
- 启动恢复和 stale operation 可解释。

门槛：用户能看到当前使用了什么、什么已完成、什么还在运行、什么需要召回以及证据整理结果。

### R7：评测、性能调优和可选检索适配器

**优先级：P1-P2。前置：R0-R6。**

交付：

- 将真实失败轨迹脱敏后加入评测和 trajectory-prefix 回归；
- 对 inline/receipt/recall/forget 策略做组件 ablation；
- 量化重复读取、上下文 rot、首证据时间、召回延迟、Provider token、verified success 和成本；
- 仅在确定性索引不足且 A/B 有收益时实现向量检索适配器；
- 保留 deterministic fallback 和可审计召回原因。

Focused tests：

- retriever 失效回退；
- embedding/source hash/version 绑定；
- precision/recall、verified success 和成本对比；
- recall 错误不越过 trust/verifier；
- 完整 replay 在不同 retriever 下仍能重建原始事实。

门槛：任何“更智能的召回”必须以 verified task outcome 或稳定性改善为依据，而不是以相似度或 demo 观感为依据。

### R8：多 Agent 预留接口，不启用

**优先级：P2。前置：R0-R7。**

只预留：

- `OperationRef.ownerWorkItemId`、`parentOperationId`、structured handoff refs；
- shared Artifact/Evidence refs 和预算字段；
- child Scope、取消、ACK、winner settle 和 generation fencing 接缝。

明确不做：

- 不注册多 Agent provider；
- 不默认 parallel；
- 不创建第二个 transcript、ControlStore、Evidence Graph 或 GUI 状态库；
- 不允许 Agent 通过 context_memory 绕过父 Run 权限。

Focused tests 只验证 schema 不会破坏单 Agent，并验证 unsupported capability 返回明确错误。只有未来评测证明存在信息增量，才另立启用计划。

## 18. 文件级实施地图

### 18.1 Domain、ControlStore 和事件

```text
packages/materials/src/domain/types.ts
  OperationRef、ContextRef、ModelReceipt、RecallRecord、ContextCurationOperation

packages/materials/src/domain/utils.ts
  canonical JSON、hash、稳定排序、URI/ID 校验

packages/materials/src/control/
  operation/recall/curation event、generation fencing、idempotency、replay

packages/materials/src/orchestration/run-coordinator.ts
  safe-point receipt/status drain、recall/curation action 和恢复
```

### 18.2 Storage、Knowledge 和 Context

```text
packages/materials/src/effects/artifact-store.ts
  Artifact index、范围读取、hash/sensitivity/generation 校验

packages/materials/src/storage/spill-store.ts
  三态结果、ModelReceipt、threshold、失败回退

packages/materials/src/knowledge/projection.ts
  Operation/Job/receipt/curation URI、L0/L1/L2 和 deterministic search

packages/materials/src/knowledge/consolidation.ts
  source-linked summary、Evidence projection 和幂等整理

packages/materials/src/context/compiler.ts
  receipt/placeholder/ref/status 投影、ContextManifest 扩展

packages/materials/src/context/durable-compaction.ts
  curation/compaction 提交、回滚和 orphan recovery

packages/materials/src/context/maintenance-coordinator.ts
  pressure、nextAction、coalescing 和安全点调度
```

### 18.3 Tool、Skill、MCP、Job 和运行时

```text
packages/materials/src/tools/runtime.ts
  bounded recall、scope/generation/sensitivity、RecallRecord

packages/materials/src/tools/catalog.ts
  receipt policy、Tool schema hash、Skill/MCP metadata

packages/materials/src/runtime/coding-resources.ts
  builtin Tool、evidence/context_memory proxy、bounded result

packages/materials/src/runtime/coding-lane.ts
  status suffix、safe-point drain、single-agent operation ownership

packages/materials/src/runtime/coding-turn-projection.ts
  operation/receipt/status 与 transcript 关联

packages/materials/src/runtime/request-epoch.ts
  actual payload、policy/ref hash 和敏感字段脱敏

packages/materials/src/observability/pi-events.ts
  operation、recall、receipt、context pressure 和启动耗时
```

### 18.4 GUI、CLI 和文档

```text
apps/gui/src/debug-data.ts
  Operation/Receipt/Recall/Curation/Status 投影

apps/gui/src/tool-presentation.ts
  有界 ModelReceipt、用途、状态、refs、hash 和恢复入口

apps/gui/src/server.ts
  context/recall/consolidate/operations API 和 SSE

apps/cli/src/
  context、recall、consolidate、operations、evidence curation

docs/UNIFIED_AGENT_DEVELOPMENT_PLAN_ZH.md
  同步 S4-S6 的引用化边界和本计划关系

docs/tool-contract.md
docs/gui.md
docs/recovery.md
docs/eval-protocol.md
README.md
  只记录已交付行为，Proposal 与 current capability 分开
```

新增公共类型、工具 schema 或 TSDoc 后必须生成 API index，不手工编辑 `docs/generated/`。

## 19. 测试与验证矩阵

### 19.1 单元/契约测试

- Operation、Receipt、Ref、RecallRecord、Curation schema 的 canonical hash 和版本；
- stable URI、规范化、scope、generation、sensitivity、stale 和 hash；
- T0-T3/J0-J1 分流、preview、truncation 和 error receipt；
- receipt 不超过字符/token/字段限制；
- ContextStatusReceipt 计数、coalescing、sequence 和重建；
- ContextCompiler placeholder、Tool pair、P0/P1/L3A/L3B 保留；
- L0/L1/L2 投影、range、cursor、取消和超时；
- RecallRecord 与真实返回内容 hash 一致；
- consolidate source closure、冲突、负面结果、gap 和幂等；
- forget/restore 事务、失败回滚和 orphan recovery；
- Skill activation、MCP schema hash、Job lifecycle 和观察队列；
- deterministic retriever 过滤、排序和 fallback；
- prompt injection 数据边界和敏感 Artifact 脱敏。

### 19.2 Provider-free 场景

```text
small tool result remains inline
large grep result becomes receipt + artifact ref
spill write failure keeps canonical result and returns controlled error
multiple jobs complete with coalesced status suffix
job heartbeat does not grow transcript without bound
generation reset makes old receipt/job stale
recall denied by scope/sensitivity/generation
artifact hash mismatch preserves old context view
recall range and timeout are bounded
context pressure replaces only completed tool results
unfinished tool pair cannot be forgotten
consolidate crashes before summary
consolidate crashes after summary before commit
forget succeeds and restore returns bounded preview
summary loses no negative result or rejected hypothesis
startup skips large Artifact content
SSE disconnect rebuilds the same status projection
deterministic search returns refs and no raw unbounded payload
vector retriever unavailable falls back to exact search
single-agent path rejects unsupported multi-agent operation
```

### 19.3 集成和 GUI 测试

- Chat、CTF、Fixture、Competition 使用相同 Tool/Operation/Receipt/Artifact/Evidence 路径；
- Tool 卡片显示用途、输入、状态、receipt、完整 Artifact、hash 和已召回范围；
- 多个 Tool/Job 运行时状态面板与事件时间线一致；
- Evidence 整理结果可从 summary 跳到每个 source；
- placeholder 可 restore，恢复后仍标明原 URI、generation 和 hash；
- Context panel 显示 inline/preview/placeholder、refs、pressure、last consolidate 和 next action；
- 新建对话不会等待所有旧 Artifact 内容加载；
- Provider 断线、SSE 断线、进程重启后可以恢复状态；
- GUI 不显示 secret、API key、未授权 Artifact 原文或宿主内部路径。

### 19.4 用户真实问题的独立测试

用户后续应使用真实问题验证模型是否：

- 看到 receipt 后会在需要时主动 recall，而不是反复调用同一 Tool；
- 能理解 status suffix 并继续处理尚未完成的 Job；
- 能使用同一 URI 在压缩后找回旧结果；
- 能区分 summary、untrusted observation 和 verified evidence；
- 能在 76K 附近继续推进而不陷入重复读取；
- 能从 Evidence 视图理解已经整理了什么；
- 能在启动后更快进入新对话。

这些真实问题不由 focused tests 替代，也不应为了让 demo 通过而把失败隐藏在摘要里。

## 20. 指标和验收标准

每个阶段都要同时报告收益和退化，至少包括：

```text
verified success / evidence-backed success
Tool calls per successful task
duplicate tool action ratio
duplicate recall ratio
time to first evidence
recall success / denied / stale / hash mismatch rate
receipt build and recall p50/p95/p99
Artifact persist p50/p95/p99
Provider input tokens and output tokens
inline / preview / placeholder ratio
context compile latency
context pressure and curation count
summary source coverage and unsupported claim count
consolidate success / rollback / orphan recovery rate
startup to new-chat-ready latency
startup bytes read and files opened
Provider cacheRead/cacheWrite when reported
replay parity
FAIL_TO_PASS / PASS_TO_PASS / flaky rate
cost and safety regressions
```

### 20.1 MVP 验收

R0-R3 完成后才可称为“持久化引用 MVP”，必须满足：

1. 大 Tool 结果有 durable Artifact、短 receipt、稳定 URI 和 hash；
2. 模型可以显式 bounded recall，并得到 read marker；
3. 结果、状态和 refs 在重启后可从事件和 Artifact 重建；
4. generation/scope/sensitivity 不能被 recall 绕过；
5. ContextCompiler 不会重复注入已外置的大结果；
6. Tool pair、当前任务和 unknown Effect 不被错误整理；
7. 同等真实任务的 verified success、证据覆盖和 replay parity 不低于 baseline；
8. 任何回执或状态更新都存在可测量的字符/字节/token 上限。

### 20.2 完整阶段验收

R0-R7 完成后，系统应达到：

- Tool、Skill、MCP、Job、Evidence 和 Context 都使用同一个引用和审计模型；
- 用户能看到运行状态、结果摘要、来源、hash、trust、已整理内容和恢复入口；
- 原始内容不会因压缩或 forget 丢失；
- 启动路径不读取无关大正文；
- 召回、整理、恢复和失败都可重放、可恢复、可解释；
- 向量检索若存在，仍只是可审计的可选召回器；
- 单 Agent 是唯一启用路径，多 Agent 只有预留 schema。

## 21. 风险、取舍和回滚

### 21.1 主要风险

| 风险 | 表现 | 控制措施 |
| --- | --- | --- |
| 模型不主动 recall | 收到 URI 后继续猜测或重复 Tool | receipt 提供 next action；测试 activation/following rate；必要时只对关键类型自动 L1 召回 |
| 摘要丢细节 | 后续结论遗漏行号或负面结果 | source closure、关键值、负面结果、restore 和保留集回归 |
| 召回增加延迟 | Tool 本身变快但任务变慢 | 小结果 inline；记录 recall p95；按任务做 A/B |
| URI 不可信 | 旧 Run 或越权数据被读取 | scope/generation/sensitivity/hash fencing |
| Tool pair 断裂 | Provider 报协议错误 | pair-aware pruning/curation，未完成 pair 硬保留 |
| 状态污染上下文 | 每个 heartbeat 都追加消息 | event append + Provider coalescing + 安全点更新 |
| 双重事实源 | index/GUI/RAG 自己维护状态 | 全部从 ControlStore/Artifact/Evidence 投影重建 |
| 向量误召回 | 相似文本被当作正确事实 | deterministic filter、trust 分离、source/hash、verifier |
| 启动索引仍很慢 | metadata 过多或同步扫描正文 | lazy index、后台 rebuild、启动读取预算和分段耗时 |
| forget 过早 | 当前推理缺少刚读内容 | 前置检查、summary 事务、restore、旧视图回滚 |

### 21.2 回滚层级

按以下顺序回滚，尽量不影响事实和审计：

1. 关闭自动 placeholder/forget，只保留 receipt 和 Artifact；
2. 关闭自动 recall，只允许显式 recall；
3. 恢复 ContextCompiler 的完整 Tool presentation，但保留 durable Artifact、hash 和 RecallRecord；
4. 关闭向量适配器，切换 deterministic retriever；
5. 关闭 GUI 增强投影，不关闭 ControlStore、ArtifactStore 和 Evidence 事件；
6. 如果新 projection 损坏，按 ContextManifest/事件重建旧 Provider view；
7. 不物理删除原始 Artifact，不重写原始 Pi Session，不用 destructive reset 掩盖数据问题。

## 22. 每阶段交付流程和治理门禁

每个 R 阶段都按同一流程：

1. 先搜索现有 API、Artifact、Knowledge、Evidence 和 Context 原语，确认不重复实现；
2. 先写 domain contract、失败路径和 focused tests；
3. 只使用一个 ControlStore、一个 ArtifactStore、一个 Evidence Graph 和一个 Agent loop；
4. 完成 provider-free replay/scenario；
5. 更新 TSDoc、API mapping、组件文档和用户文档；
6. 如果改动公共源码或 TSDoc，执行 `npm run api:index`、`npm run api:index:check:all` 和 `npm run api:duplicates:all`；
7. 如果改动治理文档、计划或 README，按项目规则更新 `project-status.json` 并执行 `npm run reports:project`、`npm run check:project-reports`；
8. 执行 `npm run build`、focused tests、`npm run test:ci-gates`，阶段合并前再执行完整 `npm test`/`npm run verify`；
9. 在真实 Provider 上分别测 Token、cacheRead、延迟、召回率、成功率和成本，不能用 provider-free 结果代替；
10. 每阶段保留明确 commit、manifest/policy hash、验证日志和 rollback pointer。

## 23. Definition of Done

本计划的实现完成条件是：

1. 完整 Tool/Skill/MCP/Job/Evidence 内容默认持久化且可通过规范 URI 有界读取。
2. Provider 只收到必要的固定规范、当前任务、合法 Tool pair、短 receipt、状态尾部和选定的 L0/L1/L2 投影。
3. 每个 receipt 都能关联 Operation、Artifact、hash、generation、scope、trust 和下一步。
4. 事件每次持久化，模型状态按 coalescing 和安全点投影，不因 heartbeat 无界增长。
5. ContextCompiler、Knowledge Projection、ArtifactStore、Evidence Graph、ControlStore 和 GUI 不出现第二套事实源。
6. 主动 forget 只移除下一轮 Provider view；summary、source closure、原文 URI 和 restore 永久可追溯。
7. 崩溃发生在 recall、consolidate、forget、restore、Job 或 Provider 生命周期的任一点，都能恢复到旧视图或明确的失败/人工处理状态。
8. 启动加载不读取无关大正文，启动性能可以按阶段和字节数解释。
9. 真实评测能证明重复 Tool、上下文压力、证据不可见、状态不可见和启动延迟的变化；没有收益的自动 RAG 策略不启用。
10. deterministic retriever 是完整可用的默认路径；向量检索若存在也只能是可回退、可审计、可关闭的适配器。
11. 单 Agent 是唯一启用运行路径，多 Agent 仅保留 schema 和统一 Work Graph 接缝。
12. API index、component docs、change contracts、project reports、replay、focused tests 和完整质量门禁均通过。

最终目标不是让 Agent 看到更少，而是让它在需要时看到正确、可验证、可恢复的内容；让上下文保持短而有用，让原始证据保持完整，让用户知道系统正在做什么以及下一步为什么这样做。
