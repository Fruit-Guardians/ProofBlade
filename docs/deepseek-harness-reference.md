# DeepSeek Harness 参考借鉴与 ProofBlade 落地指南

> 文档版本：1.0.0
> 编写日期：2026-08-14
> 参考项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
> 参考提交：`47f943859bef60e4160492346772ded9b24f765a`
> ProofBlade 基线：`0010f14`
> 文档性质：架构调研、差距分析和实施建议，不代表已完成实现

## 1. 结论摘要

DeepSeek Harness 最值得 ProofBlade 借鉴的不是 Cordis 插件框架本身，而是它围绕 Agent 运行时建立的一组工程约束：

1. **模型看到的内容必须能够从持久化事件中重建**。系统提示、工具 Schema、上下文变化和模型选择都不应只存在于进程内。
2. **扩展必须通过稳定接缝接入**。一个能力由定义、提供者和消费者三部分组成，运行循环不直接依赖某个实现。
3. **注册行为必须可逆**。工具、Provider、事件监听器和后台任务都属于作用域，卸载时必须准确撤销。
4. **压缩是一项可恢复的事务**。开始、摘要和结束分别记录，崩溃后可以识别未完成压缩，而不是把半成品当成有效上下文。
5. **工具结果分为规范值、模型展示和完整制品**。大输出进入独立存储，模型只读取有限预览和稳定引用。
6. **子 Agent 是有能力声明和持久会话的执行单元**。不支持的深度、工具过滤或结构化输出必须明确失败。
7. **遥测是可替换能力，不是主循环里的硬编码副作用**。采集、脱敏、导出和断点续传彼此分离。

ProofBlade 已经具备正确基础：四层依赖结构、Pi Session 与 CTF Control Store 双持久化域、Context Compiler、稳定工具代理、Effect Journal、Evidence Forest、后台 Job 和 Provider 注册表。当前最应补齐的是以下四项：

- 持久化的请求纪元 `RequestEpoch`，使一次真实模型请求能够完整审计和重建；
- 统一的 `Definition -> Provider -> Consumer/Resolver` 能力接缝；
- 可逆的 Run/Lane Scope，治理注册、监听器、子进程和临时资源；
- 对压缩、证据整理和沙箱生命周期统一使用开始/完成括号及孤儿恢复。

因此，建议**吸收约束和协议，不整体迁移框架，不扩大首轮工具面，也不合并现有两个持久化域**。

## 2. 调研范围

本次重点阅读 DeepSeek Harness 的以下设计：

- 总体架构与插件树；
- Session 事件日志与请求重建；
- Tool 契约与工具执行管线；
- Compaction 生命周期；
- Spill Store 大结果外置；
- Scope 与可逆注册；
- Subagent Provider；
- Workflow Engine；
- Session Telemetry；
- Profile、Bundle 和配置 Patch。

对照的 ProofBlade 资料与实现边界包括：

- `pi-ctf-agent-harness-design.md`；
- `docs/architecture.md`；
- `docs/task-contract.md`；
- `docs/tool-contract.md`；
- `docs/extensions.md`；
- Context、Control、Knowledge、Runtime、Capabilities、Storage 和 Pi Adapter 组件。

## 3. DeepSeek Harness 的核心方法

### 3.1 插件树不是目录树，而是生命周期树

DeepSeek Harness 使用 Cordis 把系统组织为插件树。插件可以：

- 提供服务；
- 声明类型化事件；
- 注册工具或 Provider；
- 创建子作用域；
- 在卸载时撤销注册和释放资源。

关键点不是“所有代码都做成插件”，而是每项扩展都有明确的所有者和生命周期。注册工具、启动子进程或监听事件不再是永久全局副作用。

对 ProofBlade 的直接启发是：现有 Registry 应继续保留，但注册结果应返回统一的 `Disposable`，并由 Run Scope、Lane Scope 或 Job Scope 持有。这样配置热更新、MCP 断线重连、模型切换和测试隔离才不会留下陈旧状态。

### 3.2 Session 是模型交互的事实来源

DeepSeek Harness 把 Session 设计成仅追加的类型化事件日志。典型事件包含：

- `turn/start`、`step/start`；
- `user/message`；
- `request/header`、`request/context`；
- `llm/stream`、原始响应分块；
- `assistant/message`；
- `tool/call`、`tool/result`；
- `step/end`、`turn/end`。

消息历史不是主要事实，消息只是由事件日志投影得到的模型视图。这带来三个能力：

1. 可以解释模型在某一步究竟看到了什么；
2. 可以在压缩或分支后重新投影上下文；
3. 可以把 Provider 问题、缓存问题和 Agent 推理问题分开定位。

其中 `request/header` 尤其重要。它保存一次请求的模型配置、Adapter 默认值、渲染后的系统提示和实际工具 Schema。`request/context` 保存 Provider、模型和上下文窗口等变化。二者共同形成请求纪元，使重放不依赖当前配置文件。

### 3.3 模型可见内容与日志必须等价

DeepSeek Harness 的重要不变量可以概括为：

> 任何进入模型上下文的内容，都必须在持久化日志中有可重建来源。

这并不等于把密钥、隐私或完整大文件写入 Session。正确做法是：

- 对稳定系统提示记录内容或不可歧义的内容寻址引用；
- 对工具目录记录规范 Schema 和顺序；
- 对文件及大结果记录 Artifact/Spill 引用；
- 对敏感配置记录经过允许的配置快照和哈希；
- 对动态上下文记录来源事件、投影操作和摘要关系。

ProofBlade 已经记录 ContextManifest 和运行遥测，但仍应增加一个明确的请求纪元事件，避免“知道构建过哪些层，却无法证明最终请求内容”的问题。

### 3.4 能力接缝由三种角色组成

DeepSeek Harness 对可替换能力采用三角色结构：

1. **Service Definition**：定义稳定接口、类型和生命周期；
2. **Service Provider**：提供一个具体后端；
3. **Consumer**：只依赖定义，通过注册表或解析器选择 Provider。

这个结构与 ProofBlade 的递进式分层高度一致：

- 原子层定义最小协议；
- 分子层完成通用解析、排序、校验和恢复；
- 材料层提供 CTF、MCP、Skill 或本地实现；
- CLI/GUI 只消费公共能力。

ProofBlade 已在 Capability Backend Resolver 中采用类似模式。下一步应把它变成全项目一致的扩展规范，而不是只服务于 Capability Router。

### 3.5 Tool 同时拥有三种输出

DeepSeek Harness 的工具定义不只包含模型可见的 `name`、`description` 和参数 Schema，还包含：

- 必需的规范输出 Schema；
- `execute`；
- 超时和并发安全属性；
- 调用与结果展示函数；
- 结果最终化和持久化策略。

工具结果被拆成：

1. **Canonical value**：程序和重放使用的规范 JSON；
2. **Model presentation**：给模型的有限、稳定文本；
3. **Durable content**：完整制品或证据内容。

ProofBlade 已有 Artifact、Evidence 和 RTK 重写，因此无需重做工具系统。需要补充的是统一输出契约，确保 `Artifact/Evidence -> 模型摘要 -> GUI 展示` 不再由每个工具自由拼装。

### 3.6 Compaction 是可检测失败的事务

DeepSeek Harness 为压缩记录三个持久事件：

```text
compaction/start
compaction/summary
compaction/end
```

压缩锁覆盖整个过程。如果进程在 `start` 后崩溃，重放时会发现没有匹配的 `end`，从而把它认定为孤儿操作。摘要还记录：

- 主题与摘要正文；
- 被遮蔽的事件范围和序号；
- Token 数；
- Provider、模型和 Usage；
- 原始输出或流调用标识。

ProofBlade 已经实现 notice、snip、prune、compact 和 force 等维护级别，也有 checkpoint。可借鉴之处是统一生命周期和崩溃语义，而不是替换现有压缩算法。

### 3.7 Spill Store 将大结果与对话分离

DeepSeek Harness 的 Spill Store 接收完整文本并返回：

- 不透明定位符；
- 取回提示；
- 字节数和必要元数据。

工具管线只把 head/tail 预览及引用放入模型上下文。保存失败时，工具调用仍保留成功语义，只退回受控的内联结果。其本地后端还约束了目录权限、文件权限、独占创建和符号链接风险。

ProofBlade 的 Artifact Store 已承担类似职责，但 Artifact 更偏向业务制品。建议保留 Artifact，并在其上建立轻量 `SpillStore` 接缝：Spill 是工具大输出的传输策略，Artifact 是可复核的长期产物，两者可以使用同一存储后端，但不应混淆语义。

### 3.8 Subagent 通过能力声明避免隐式降级

DeepSeek Harness 支持多个具名 Subagent Provider。Provider 会声明是否支持：

- 结构化输出；
- 深度限制；
- Tool Filter；
- Persona。

消费者在启动前检查能力，不支持时明确失败。子 Agent 有独立、可持续的 Session；父 Agent 负责授权和中断，销毁顺序采用 child-first。

这与 ProofBlade 计划中的 Planner/Executor 很接近。值得吸收的是“能力声明、独立会话、结构化交接、父级授权和可中断”，不建议立刻扩展成任意 Agent 群体。

### 3.9 Workflow 将编排与主循环分离

DeepSeek Harness 的 Workflow Engine 支持 phase、log、agent、parallel 和 pipeline 等结构，并记录工作流生命周期事件。观察型监听器失败不会破坏主流程，内部传输也不会全部污染父 Session。

ProofBlade 可以在 Phase Gate、Planner/Executor 和 Background Job 稳定后再吸收此机制。工作流应首先用于确定性 CTF 阶段编排，不应用来给模型制造另一套自由脚本语言。

### 3.10 Telemetry 是可替换的旁路能力

DeepSeek Harness 把遥测拆为采集协调器和后端，支持：

- 分层脱敏；
- 游标和交接；
- 以 `session.id + event.seq` 去重；
- 尽力而为，不阻断运行主线。

ProofBlade 已有 RunTelemetry 和 GUI 调试视图，应进一步把导出后端抽象出来，并规定永不导出 API Key、完整敏感文件和未脱敏 Tool 参数。

## 4. 与 ProofBlade 的对应关系

| DeepSeek Harness 概念 | ProofBlade 当前对应 | 当前判断 | 建议 |
| --- | --- | --- | --- |
| Plugin tree | 四层包结构、Registry、Runtime composition | 部分具备 | 不引入 Cordis；补统一 Scope 和 Disposable |
| Session append-only events | Pi Session JSONL | 已具备基础 | 增加 RequestEpoch 与原始响应引用 |
| Durable business state | CTF Control Store | ProofBlade 更强 | 继续与 Pi Session 分离 |
| `request/header` | ContextManifest、Provider snapshot、RunTelemetry | 信息分散 | 合并为可重建请求纪元 |
| Capability seam | Tool/Skill/MCP/Capability registries | 各自实现 | 统一 Definition/Provider/Consumer 规范 |
| Tool canonical output | Tool contract、Artifact、Evidence、RTK | 大体具备 | 明确三种输出及快照测试 |
| Compaction lifecycle | Context maintenance、checkpoint | 算法具备 | 补事务括号与孤儿恢复 |
| Spill Store | Artifact Store | 后端可复用 | 增加大结果策略和不透明引用 |
| Scope | Run/Lane/Job 生命周期 | 缺少统一抽象 | 增加 RunScope/LaneScope/JobScope |
| Subagent Provider | Planner/Executor 规划 | 尚未完整实现 | 先做双模型、独立 Session、结构化交接 |
| Workflow Engine | Phase、Job、Planner handoff | 分散 | 等 Phase Gate 稳定后再抽象 |
| Session Telemetry | RunTelemetry、GUI trace | 已有入口 | 增加后端、游标、脱敏契约 |
| Profiles/Bundles/Patches | Provider 配置、用户目录配置 | 部分具备 | 增加可打印的最终配置投影 |

## 5. 建议落地的统一不变量

### 5.1 请求可重建不变量

每次调用模型前，必须产生一个持久化请求纪元。它至少应证明：

- 使用哪个 Provider、Base URL 类型、模型和 Adapter；
- 使用哪一版系统提示；
- 暴露了哪些工具、顺序和 Schema；
- 使用哪些 Skill/MCP 能力目录版本；
- Context Compiler 选择了哪些层和维护动作；
- 稳定前缀哈希是否与上一请求一致；
- 请求与响应如何关联到 Run、Turn、Step 和 Lane。

密钥、Authorization Header 和敏感原始参数不得进入该事件。

### 5.2 状态权威不变量

- Pi Session 仍然负责“模型见过什么、模型说过什么”；
- CTF Control Store 仍然负责“任务做到哪一步、哪些证据有效、效果是否完成”；
- RequestEpoch 属于 Pi Session；
- Effect、Artifact、Evidence 和 Phase 状态属于 Control Store；
- 两个域使用 `runId/turnId/stepId/effectId` 关联，不复制对方的权威状态。

### 5.3 能力替换不变量

每个可替换能力都必须拥有：

- 稳定定义；
- 版本化 Provider；
- 明确解析顺序；
- availability 检查；
- 能力声明；
- 注册和卸载动作；
- 无匹配、版本漂移和不支持特性时的明确错误；
- 不依赖 GUI、CLI 或具体 CTF 业务的底层接口。

### 5.4 工具可重放不变量

一次工具调用必须能够区分：

- 原始模型参数；
- 规范化参数；
- 实际执行 Provider；
- 规范输出；
- 给模型的结果文本；
- 完整 Artifact/Spill 引用；
- Evidence 提取结果；
- 副作用状态和恢复策略。

### 5.5 生命周期配对不变量

以下操作必须使用 start/end 或 proposed/started/finished 配对：

- Compaction；
- Evidence curation；
- Sandbox lifecycle；
- Background Job；
- MCP session；
- Subagent run；
- Workflow run；
- 有副作用的 Capability invocation。

重放时发现未配对开始事件，必须进入对应恢复器，不能静默视为完成。

## 6. P0：优先实施项目

### 6.1 RequestEpoch：记录实际模型请求

建议在原子层定义最小数据结构，在 Pi Session 层定义事件和投影，在 Runtime 层负责组装：

```ts
export interface RequestEpoch {
  requestId: string;
  runId: string;
  turnId: string;
  stepId: string;
  lane: "planner" | "executor" | "curator" | "summary";
  providerId: string;
  providerProtocol: string;
  model: string;
  adapterVersion: string;
  contextWindow?: number;
  systemPromptHash: string;
  toolCatalogHash: string;
  toolNames: readonly string[];
  capabilityCatalogHash: string;
  contextManifestHash: string;
  stablePrefixHash: string;
  requestBodyHash: string;
  parentEpochId?: string;
  createdAt: string;
}
```

推荐事件顺序：

```text
request/header
request/context
model_request
model_response_started
model_response_chunk_ref
model_response_finished | model_response_failed | model_response_cancelled
```

`request/header` 仅在配置、提示或工具契约变化时保存完整快照；没有变化的请求引用上一个 Epoch，减少日志体积。`requestBodyHash` 应根据真正发送给 Provider 的规范请求计算，而不是根据编译前对象计算。

验收要求：

- 相同稳定前缀连续请求的 `stablePrefixHash` 相同；
- 更换模型只改变应变化字段；
- Tool Schema 顺序变化会改变 `toolCatalogHash`；
- 从事件日志恢复出的请求投影与原请求规范 JSON 完全相同；
- 日志中搜索不到测试 API Key。

### 6.2 统一能力接缝

建议用最小协议统一 Tool backend、Provider、Spill、Telemetry、Sandbox 和 Subagent：

```ts
export interface CapabilityDefinition<TRequest, TResult> {
  readonly id: string;
  readonly contractVersion: string;
  validateRequest(value: unknown): TRequest;
  validateResult(value: unknown): TResult;
}

export interface CapabilityProvider<TRequest, TResult> {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly priority: number;
  capabilities(): Readonly<Record<string, boolean>>;
  isAvailable(context: ResolveContext): Promise<boolean>;
  execute(request: TRequest, context: ExecutionContext): Promise<TResult>;
}

export interface CapabilityRegistration extends Disposable {
  readonly definitionId: string;
  readonly providerId: string;
}

export interface Disposable {
  dispose(): void | Promise<void>;
}
```

统一并不意味着所有能力共用一个巨型注册表。每个组件可以有独立 Registry，但解析、版本漂移、availability、priority 和 dispose 语义应一致。

验收要求：

- 指定 Provider 时 fail-closed；
- 自动选择时跳过 unavailable Provider；
- 相同 priority 使用稳定、可测试的排序；
- 运行开始后 Provider version 漂移会被发现；
- dispose 后新解析不再返回该 Provider；
- 原子层测试无需安装材料层或 GUI。

### 6.3 生成式 Tool Contract Catalog

当前固定工具面有利于缓存，应进一步把以下内容汇总成规范目录：

- 工具名称和固定顺序；
- 模型可见描述；
- 输入 JSON Schema；
- 规范输出 Schema；
- side-effect/read-only 属性；
- timeout/concurrency 属性；
- contract version；
- model presentation version；
- artifact/evidence policy。

目录应由代码生成或由同一规范路径产生，禁止 GUI、Runtime 和测试分别手写一份。CI 对规范 JSON 做快照；描述、顺序或 Schema 变化必须显式更新快照和组件版本。

### 6.4 统一操作括号与孤儿扫描

建议抽象一个通用的操作相关标识，而不是抽象一个通用业务状态机：

```ts
export interface OperationRef {
  operationId: string;
  operationType: string;
  runId: string;
  startedSeq: number;
  finishedSeq?: number;
}
```

各组件仍定义自己的事件和恢复规则。Control Store 启动时扫描：

- 未结束 Compaction：丢弃未完成摘要，保留原始事件；
- 未结束 Curation：不提升草稿 Evidence；
- STARTED Effect：按 Effect Policy 查询、补偿或重试；
- 未结束 Sandbox：终止残留进程并记录清理结果；
- 未结束 Subagent：标记 interrupted，允许显式恢复。

## 7. P1：第二阶段实施项目

### 7.1 SpillStore 接缝

建议接口：

```ts
export interface SpillRequest {
  sessionId: string;
  sourceCallId: string;
  suggestedName?: string;
  mediaType: string;
  content: string | Uint8Array;
}

export interface SpillReference {
  locator: string;
  retrievalHint: string;
  byteLength: number;
  contentHash: string;
}

export interface SpillStore {
  save(request: SpillRequest): Promise<SpillReference>;
  read(locator: string): Promise<Uint8Array>;
}
```

策略建议：

- 结果小于阈值：直接输出规范结果；
- 超过阈值：保存完整结果，模型获得 head/tail、大小、哈希和取回工具提示；
- 保存失败：保留工具成功状态，返回截断内容并记录 `spill_failed`；
- Evidence 引用 Spill 时，以 content hash 去重；
- GUI 展示友好名称、类型、来源工具和摘要，不把哈希当成人类主标题。

### 7.2 RunScope、LaneScope 与 JobScope

建议作用域层级：

```text
ApplicationScope
  ProviderScope
  ProjectScope
    RunScope
      PlannerLaneScope
      ExecutorLaneScope
      CuratorLaneScope
      BackgroundJobScope
```

作用域负责持有：

- Registry registration；
- Event subscription；
- AbortController；
- MCP transport；
- 子进程和沙箱；
- 临时 Spill；
- 定时器和 idle compression 任务。

销毁顺序采用从子到父。每个 dispose 必须幂等，单个清理失败不能阻止其他资源释放，但最终应汇总清理错误。

### 7.3 Telemetry Backend 与脱敏流水线

建议区分：

- `TelemetryCapture`：从 Session/Control 订阅事件；
- `TelemetryRedactor`：按字段和内容规则脱敏；
- `TelemetryBackend`：写本地文件、GUI 流或远端系统；
- `TelemetryCursorStore`：记录已导出序号；
- `TelemetryHandoff`：Provider 切换或进程恢复时交接游标。

强制脱敏字段包括：Authorization、API Key、Cookie、MCP 环境变量、工具参数中的 secret，以及用户配置目录中的敏感内容。

### 7.4 双模型 Subagent 契约

先只实现 Planner 和 Executor 两个角色：

- 各自拥有独立 Session 和稳定前缀；
- Harness 用任务元数据确定是否启用 Planner；
- Planner 只输出版本化结构化计划；
- Executor 只接收计划、必要事实和证据树摘要；
- plan-only 和等待确认场景 fail-closed；
- 普通自动执行场景可根据配置在 Planner 故障后回落；
- 父 Run 可暂停、取消和恢复两个 Lane；
- Provider 必须声明结构化输出、Tool Filter 和深度能力。

不要让 Planner 与 Executor 共享不断变化的消息历史，否则既破坏缓存，也难以判断错误来自计划还是执行。

## 8. P2：成熟后再实施的项目

### 8.1 轻量 Profile、Bundle 和 Patch

可以借鉴 DeepSeek Harness 的配置合成思想，但不引入复杂插件 DSL：

```text
内建默认值
  -> 具名 Profile
  -> Project 配置
  -> User 配置
  -> Conversation Override
  -> CLI 临时参数
```

必须提供 `proofblade config resolve` 或等效 API，打印最终配置及每个字段的来源，同时自动隐藏密钥。对缓存敏感的配置应额外生成 `cacheRelevantHash`。

### 8.2 Workflow Engine

仅在 Phase Gate、Background Job、Planner/Executor 和恢复机制稳定后引入。第一版只支持：

- 顺序 phase；
- 显式 parallel；
- 条件 guard；
- agent step；
- capability step；
- artifact/evidence checkpoint。

工作流定义应是可验证的结构化数据，不执行任意 JavaScript。父 Session 只记录生命周期和结构化结果，内部通信进入子 Session 或 Job 日志。

## 9. 缓存与上下文管理的具体启发

DeepSeek Harness 的请求重建机制能解决 ProofBlade 当前缓存指标“固定但无法解释”的问题。缓存优化应遵循以下顺序：

1. 固定系统提示正文、段落顺序和换行；
2. 固定工具名称、描述、Schema 和排列顺序；
3. Skill/MCP 首轮只展示稳定目录和固定代理；
4. 环境信息使用稳定摘要，不加入无意义时间戳；
5. Planner、Executor、Curator、Summary 使用独立 Lane；
6. 动态对话和 Evidence Forest 摘要放在稳定前缀之后；
7. 先确定性 snip/prune，再在原会话插入压缩请求；
8. 记录 Provider 返回的 cache read/write token，不用本地估算冒充真实命中；
9. 同时记录 `stablePrefixHash`，区分“前缀相同但 Provider 未缓存”和“本地前缀已经漂移”；
10. 对每次前缀变化生成可读 diff，指出是提示、工具、能力目录还是 Provider 配置发生变化。

建议 GUI 对缓存展示四个并列指标：

| 指标 | 含义 |
| --- | --- |
| Stable prefix tokens | 本地编译器判断可稳定复用的 Token |
| Prefix hash retained | 本次与上次稳定前缀哈希是否相同 |
| Provider cache read | Provider 明确报告的缓存读取 Token |
| Provider cache write | Provider 明确报告的缓存写入 Token |

如果 Provider 不返回缓存字段，界面必须显示“Provider 未报告”，不能显示 0% 或沿用上一次固定值。

## 10. 证据森林与 Session Projection 的结合

DeepSeek Harness 主要解决“模型上下文如何重建”，ProofBlade 的优势则是 Evidence Forest。两者可以这样组合：

```text
Tool canonical result
  -> Artifact/Spill
  -> Fact candidate
  -> Curator validation
  -> Evidence node
  -> Evidence tree summary
  -> Context projection
  -> RequestEpoch
```

每个投影到模型的 Evidence 节点应记录：

- `evidenceId`；
- 人类可读标题和标签；
- 来源 Artifact/Spill/Tool Call；
- 支撑、反驳或依赖的边；
- 置信度和验证状态；
- 被哪个 Evidence Tree 采用；
- 投影摘要版本和内容哈希。

RequestEpoch 记录本轮使用的 Evidence Forest projection hash。这样回答错误时，可以判断是没有收集证据、Curator 错误提升、树关系错误、投影遗漏，还是模型无视了已提供证据。

## 11. 不建议照搬的部分

### 11.1 不整体引入 Cordis

ProofBlade 已有清晰的四层依赖和注册表。整体引入 Cordis 会增加运行时依赖、概念数量和迁移风险。应只实现 ProofBlade 需要的 Scope、Disposable 和能力接缝。

### 11.2 不把所有组件拆成独立 npm 包

包数量不是模块化质量。只有当组件具备独立依赖边界、公共契约、独立测试和真实复用价值时才拆包。否则保留在现有 atoms/molecules/materials 包内更容易维护。

### 11.3 不合并 Pi Session 与 CTF Control Store

DeepSeek Harness 的 Session 很强，但 ProofBlade 需要独立的任务事实、证据、效果和完成状态。把业务状态塞回模型 Session 会重新制造“对话看起来完成，但任务没有证据完成”的问题。

### 11.4 不在首轮暴露完整 MCP 和 Skill Schema

DeepSeek Harness 的扩展能力不等于增加初始工具面。ProofBlade 现有固定 `load_skill`、`mcp_call` 和 Capability proxy 更适合缓存稳定与权限控制，应继续保留。

### 11.5 不立即建设任意多 Agent 系统

多 Agent 会增加 Token、并发、证据冲突和取消恢复复杂度。先完成 Planner/Executor 双模型并用 Eval 证明收益，再考虑 Curator 或专用逆向分析 Agent。

### 11.6 不把遥测变成运行前提

遥测后端不可用时，主任务仍应运行。只有本地权威日志持久化失败才应阻断需要审计的操作。

## 12. 与现有开发计划的关系

| ProofBlade 计划 | 可吸收的 DeepSeek Harness 机制 | 调整建议 |
| --- | --- | --- |
| PLAN-100 二进制制品与逆向 | Spill、Tool canonical output | 把大反编译输出外置，保留稳定预览和 Artifact 引用 |
| PLAN-110 Phase Gate 与 Guard | Workflow lifecycle、typed events | 先做确定性 Guard，再抽象轻量 Workflow |
| PLAN-120 Budget 与 Provider Scheduler | RequestEpoch、profile resolution | 记录真实模型配置、预算和缓存相关哈希 |
| PLAN-130 Sandbox 生命周期 | Scope、reversible effects、orphan recovery | 用 JobScope/SandboxScope 管理进程和清理 |
| PLAN-200 Protocol Replay/Shadow Eval | append-only Session、request reconstruction | 用 RequestEpoch 形成可重放输入和影子评测基线 |
| PLAN-210 Planner/Executor | Subagent Provider、capability flags | 独立 Session、结构化交接、父级取消和明确降级策略 |

推荐实施顺序：

```text
RequestEpoch
  -> Tool Contract Catalog
  -> Scope/Disposable
  -> Compaction/Operation orphan recovery
  -> SpillStore
  -> Telemetry backend/redaction
  -> Planner/Executor
  -> Lightweight Workflow
```

## 13. 建议的测试矩阵

### 13.1 请求重建

- 同一 Session 连续三次请求，稳定前缀哈希保持一致；
- 切换模型后，只改变模型和相关配置字段；
- 修改工具描述后，Catalog hash 和请求 hash 变化；
- 从事件日志恢复请求，规范 JSON 与原请求逐字节一致；
- 压缩后恢复请求，摘要及 source seq 关系一致。

### 13.2 扩展与作用域

- Provider 注册、解析、卸载后结果符合预期；
- 相同优先级解析顺序稳定；
- unavailable Provider 被自动选择模式跳过；
- 指定不可用 Provider 时明确失败；
- Scope 重复 dispose 不报错且无资源泄漏；
- 父 Scope 释放时先释放所有子 Scope。

### 13.3 工具与 Spill

- 小结果不产生 Spill；
- 大结果生成完整内容、head/tail 和稳定引用；
- Spill 保存失败不会把工具成功误判为工具失败；
- locator 无法路径穿越或访问其他 Session；
- Artifact/Evidence 能追溯到原始 Tool Call；
- GUI 使用标题和标签展示，不用哈希作为唯一名称。

### 13.4 崩溃恢复

- 在 compaction start 后终止，恢复时保留原上下文；
- 在 Effect STARTED 后终止，按策略查询或重试；
- 在 Evidence curation 中途终止，不提升草稿 Evidence；
- 在 MCP 调用中断后终止 transport，Job 状态可恢复；
- 在 Subagent 输出前终止，父 Run 能显示 interrupted 并继续。

### 13.5 安全与隐私

- RequestEpoch、Telemetry、Artifact 元数据中不存在 API Key；
- MCP 环境变量默认脱敏；
- Spill 目录不能通过符号链接逃逸；
- 跨 Project/Session locator 访问失败；
- GUI 导出的调试包经过同一脱敏器。

## 14. 组件文档更新要求

实施本指南时，应按实际修改同步更新组件文档，不应把本文件当作完成状态：

- RequestEpoch：更新 Pi Session、Context、Provider/Adapter、Runtime 组件；
- 统一能力接缝：更新 Atoms、Molecules、Capabilities 及对应 Registry 组件；
- Tool Catalog：更新 Tools、Runtime、GUI 调试契约；
- Scope：更新 Runtime、MCP、Background Job、Sandbox；
- SpillStore：更新 Storage、Artifacts、Tools、Knowledge；
- Subagent：更新 Planner、Runtime、Context、Control；
- Telemetry：更新 Runtime、GUI、配置和隐私说明。

每次相关组件源码变化，继续遵守仓库现有规则：提高组件版本，更新日期，增加一次 Bug/Security 审计计数，刷新 `sourceHash`，并通过组件文档检查。

## 15. 完成判定

只有满足下列条件，才可认为 DeepSeek Harness 的关键经验已经被 ProofBlade 吸收：

- 任意一次模型请求都能由持久化事件重建并解释；
- 稳定前缀漂移能够定位到具体字段；
- Tool Schema 与规范输出由单一契约路径生成；
- Provider、MCP、Tool 和后台资源都能随 Scope 准确卸载；
- 压缩及长操作崩溃后不会产生伪完成状态；
- 大工具输出不会直接挤占上下文，完整内容仍可取回；
- Planner/Executor 使用独立 Session 和结构化交接；
- GUI 能展示请求、工具、证据、结果和恢复过程的完整关联；
- 全部新机制有确定性测试、重放测试和故障注入测试。

## 16. 参考资料

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md)
- [Session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md)
- [Tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/tools.md)
- [Compaction subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/compaction.md)
- [Spill subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/spill.md)
- [Scope subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/scope.md)
- [Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/subagent.md)
- [Workflow subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/workflow.md)
- [Session telemetry](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-telemetry.md)
