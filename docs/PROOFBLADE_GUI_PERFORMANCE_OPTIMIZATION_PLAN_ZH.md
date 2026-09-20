# ProofBlade 对话创建、工具执行与控制链路性能优化计划

更新时间：2026-09-19（评审修订 2）

> **修订说明（评审修订 2）**
>
> 1. **§7.2 恢复中心论断为已确认事实**。「几毫秒的命令被外围链路放大到秒级」经使用者在真实环境实测确认，不再是待验证推断；§2.6 的热路径分析与 T1/T2 优先级因此成立，不因基线未填而重排。基线的用途改为「量化放大倍数、定位主要成本来源、作为改进对比基准」。
> 2. **§7.2.1 记录 PR 2 已交付的局部基线**，并明确它不能替代真实 Run 基线（无 ControlStore，落盘与 `fsync` 是被计数而非被执行）。
> 3. **U1 迁移方案定为选项 B（先可选、后转必填）**，见 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md` v1.1.0。

> **修订说明（评审修订 1）**
>
> 本版依据一次逐条代码核对修订，共 8 处变更：
>
> 1. **删除原 §2.2 及相关条目**。原论断「普通对话会创建自有物理工作目录、需要删除重复 workspace 生命周期」经核对不成立：`createConversation()` 走 `codingConversationTask()`，其 `allowed_workspace` 即用户选择的真实目录，执行期由 `taskExecutionWorkspace()` 直接返回该目录。`.proofblade-workspaces/` 只服务附件验证任务，是正确设计而非性能债。同步删除原表项 E、原 §5.3 的删除清单、原 §7.1 与 §8.2 的对应断言。
> 2. **删除原表项 B（读取兼容层）**。它与表项 A（启动 fail-fast）在同一部署内互斥，且本机 GUI 没有滚动升级场景；保留它会长期掩盖构建错配，与 §11 完成定义第一条直接冲突。
> 3. **§7.2 拆分为基线段与目标段**。原文在全文无任何实测数据的情况下给出硬性毫秒目标，无法判断其是否合理；改为「先由 T0 填基线，再据基线定目标」。
> 4. **§3.4 / §5.3.1 的 revision 策略修正**。配置类文件由用户或外部工具编辑，`mtimeMs + size` 在 Windows 上不可靠且「写操作主动失效」无法覆盖；改为内容哈希。
> 5. **§4 增加「测试文件」与「回滚粒度」两列**，补齐仓库对改动源文件的测试矩阵要求。
> 6. **§10 每个 PR 增加测试入口**。
> 7. **提出 U1（调用级 `description`）**。它是破坏性工具契约变更，不是性能优化，已拆出为 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md` 单独评审。
> 8. **标题与范围对齐**。原文标题只提「对话创建与工具执行」，实际覆盖构建链路、控制链路与 GUI 读取拆分。

## 1. 背景与目标

当前体验问题不只发生在创建对话。普通对话被接入了接近完整安全任务的初始化、持久化和读取链路；而一次本应在几毫秒完成的 `read`、`glob`、`grep` 或短 `bash`，也可能在命令结束后同步经过 Artifact、Observation、Evidence、Experiment、telemetry、文件锁、`fsync` 和投影处理。底层命令很快，但 ProofBlade 的外围控制链路可能把总耗时放大到数秒，极端情况下达到几十秒，直接降低 AI 做题速度。

用户创建一个普通对话时，只需要建立最小 Run、保存工作目录和首轮会话入口；现在却会同步加载 Skills、MCP、Tool Catalog，生成完整运行版本快照，并写入带投影封印的控制状态。进入对话后，后台轮询还会读取会话、事件和 telemetry。工具执行时又重复承担安全任务级别的持久化成本。

本次优化目标如下：

1. 修复 `this.services.control.loadProjectionHint is not a function`，杜绝源码与运行时构建产物不一致。
2. 普通对话的工作目录与会话生命周期**以既有上游 Pi 路径为唯一实现**（`NodeExecutionEnv` / `JsonlSessionRepo`），不再新增第二套 workspace manager，也不改变当前「附件验证任务才 staging」的行为。
3. 将普通工具调用的 ProofBlade 同步附加开销压到毫秒级，不允许一个几毫秒的命令被外围计算和落盘拖到秒级。
4. 将“创建对话”缩减为最小持久化操作，把工具、技能、MCP 和 Provider 初始化延迟到用户真正发送第一条指令时。
5. 删除无意义的重复扫描、序列化、回读和哈希，仅保留权限边界、完整性校验、重放与 verifier 所需哈希。
6. 将对话创建、工具包装开销和普通指令的性能变成可测量、可回归的工程指标；**所有目标值先有基线，后有阈值**。
7. 参考 DeepSeek Harness 已验证的工具、Session、Spill 和 Telemetry 契约，吸收其热路径约束，不照搬 Cordis 插件树。

## 2. 已确认现状

### 2.1 `loadProjectionHint` 报错属于构建产物错配

源码已经在 `packages/materials/src/control/control-store.ts` 实现 `ControlStore.loadProjectionHint()`，GUI 的 `apps/gui/src/debug-data.ts` 也已调用该方法。但是 `@proofblade/materials` 的包入口指向 `packages/materials/dist/index.js`，当前 `dist` 仍是旧构建，运行时检查得到：

```text
resolved package: file:///D:/AI/project/ProofBlade/packages/materials/dist/index.js
prototype method: undefined
```

因此这不是投影数据损坏，也不是调用参数错误，而是 GUI 用新源码启动、依赖包却从旧 `dist` 加载。`npm run gui` 目前只执行 GUI 的 `tsx src/server.ts`，不会先保证依赖工作区已构建。

### 2.2 普通对话的工作目录与会话路径（已核实：当前行为正确，无需改动）

**本节结论是「无需优化」，保留它是为了阻止后续把这里误判成性能债。**

普通对话创建走 `apps/gui/src/debug-data.ts` 的 `createConversation()`：

```text
createConversation()                                   // debug-data.ts:464
  -> control.createRun(runId, codingConversationTask(...))   // :468
```

而 `codingConversationTask()`（`debug-data.ts:820`）产出的契约已经是真实工作目录：

```ts
target: root,                              // :828
scope: { allowed_workspace: root, ... }    // :841
inputs: []                                 // :830
```

执行期 cwd 由 `packages/materials/src/orchestration/single-agent-loop.ts:590` 的 `taskExecutionWorkspace()` 解析：`allowed_workspace` 非空且该目录存在时**直接返回该目录**，仅在不可用时才回退 fixture 路径。普通对话的 `allowed_workspace` 就是用户在 GUI 里选的目录，因此执行 cwd 即真实目录。

`stageTaskWorkspace()` 的唯一调用点是 `debug-data.ts:410` 的 `startTask()`，对应「带 `verificationCommand` 的附件验证任务」，**普通对话不经过该路径**，因此不会创建 `.proofblade-workspaces/<runId>`。

`apps/gui/src/task-workspace.ts:38` 把 staging 放在 `dirname(runsRoot)` 而非 Run 目录内部，其注释已说明原因：`JsonlControlStore` 会把任何已存在的 Run 目录当作既有 Run。**这是必要设计，不是重复的 workspace 生命周期。**

需要保留的行为（不得以「统一表面结构」为理由移除）：

- 普通对话：直接使用用户选择的真实工作目录和上游 Pi 会话接口。
- 附件验证任务：保留 staging，因为它提供不可变附件、`sha256` 绑定、路径边界、符号链接拒绝和 verifier 复现基础。

**待办仅剩回归测试**：锁住「普通对话不使用 staging」这一既有事实，防止后续重构无意识改变它。见 §8.2。

### 2.3 创建对话同步执行了过多准备工作

当前调用链为：

```text
POST /api/conversations
  -> capabilityCatalog()
  -> requireDirectory()
  -> DebugDataService.createConversation()
  -> ControlStore.createRun()
  -> createRunVersionSnapshot()
  -> load Skills / MCP / Tool Catalog
  -> 计算各 catalog hash 与总 version hash
  -> 创建 task.json、events.jsonl、projection.json
  -> 保存 gui-workspace.json
```

其中 `createRunVersionSnapshot()` 每次创建 Run 都重新读取并组合运行环境目录。完整版本快照对可重复安全任务有价值，但普通空对话在尚未发出任何指令时并不需要完成这些计算。

### 2.4 普通指令前仍存在重复初始化和投影计算

创建 Coding Lane 时还会再次完成以下操作：

- 枚举 Pi session 后再决定 `open` 或 `create`。
- 加载 Skills、MCP、Tool Catalog。
- 计算 skill、MCP、tool catalog hash。
- 计算 system prompt hash 和 Provider tool schema hash。
- 读取 ControlStore snapshot 与 observation queue。
- 对 queue 执行 canonical JSON 序列化并计算 hash。
- 构建完整动态 ContextManifest 并计算 manifest hash。

这些操作并非都应该发生在每个普通回合，更不应该在状态未变化时重复执行。

### 2.5 GUI 轮询读取范围过大

前端轮询会同时刷新 Run 列表和当前 Run 详情。详情读取包含：

- snapshot；
- event stream；
- telemetry；
- Pi session entries、branch 和 stats；
- conversation、tool call、observation queue 等派生视图。

虽然已有 single-flight 和 LRU，但只要事件或 session 版本变化，详情仍可能重建。聊天页并不需要调试器的完整 session 数据，应该按视图拆分读取。

### 2.6 工具热路径存在同步持久化放大

当前一次成功的普通 `read` 可能执行：

```text
Pi read
  -> 拼接完整可见文本
  -> 再计算 visible content hash
  -> ArtifactStore.putText()
     -> 写 Artifact 文件并计算 Artifact hash
     -> ControlStore.dispatch(artifact, persistProjection=false)
        -> 获取跨进程文件锁
        -> lock owner 写入 + fsync
        -> events.jsonl append + fsync
  -> observeCodingArtifact()
     -> 再读取刚写入的 Artifact 文件
     -> ControlStore.dispatchTransaction(annotation + observation + evidence)
        -> 再次获取文件锁并 fsync
        -> 再次 append + fsync
  -> artifactReceipt() 可能再次读取 snapshot
  -> tool_execution_end subscriber 再次读取 snapshot
  -> telemetry 进入 write-behind 队列
```

一次成功的普通 `bash` 除上述步骤外，还会同步执行 `ExperimentGate.record()`。该调用当前使用默认 `persistProjection=true`，因此还可能增加：

```text
ExperimentGate.record()
  -> canonicalJson(input)
  -> inputHash + repeatKey hash
  -> ControlStore.dispatchTransaction(experiment)
     -> 再次获取文件锁并 fsync
     -> events.jsonl append + fsync
     -> 序列化完整 RunSnapshot
     -> 计算 projection hash 和 event-prefix hash
     -> projection 临时文件写入 + fsync + rename
```

Windows 下每次跨进程文件锁的建立本身也会写 owner 文件并 `fsync`。杀毒软件、索引服务、长 Run 的大投影和磁盘写入抖动会进一步放大延迟。因此问题不能只通过“换一个更快的 SHA-256 实现”解决；真正需要减少的是同步事务数、完整对象序列化、重复文件读取、投影重写和 `fsync` 次数。

已有的 `ControlEventBatcher` 已经证明 telemetry 可以 write-behind，但它仍在 `tool_execution_end` 中为了补 Artifact/Evidence 信息同步读取 snapshot。Artifact、Observation 和 Experiment 也尚未共用同一个工具结果提交事务。

### 2.7 DeepSeek Harness 实装对照

本机实际安装的 DeepSeek Harness 组件版本为 `0.1.5-rc.2`，包括 `dsh-tools`、`dsh-agent-loop`、`dsh-session-persistence-jsonl`、`dsh-spill` 和 `dsh-session-telemetry`。仓库现有调研文档基于更早的 `0.1.5-rc.1`，本计划以当前安装包的 README、类型声明和编译产物再次核对热路径机制。

DSH 与本次优化直接相关的行为如下：

| DSH 机制 | 当前实装行为 | 对 ProofBlade 的启发 |
|---|---|---|
| Tool output contract | `execute()` 返回规范 JSON；纯 `render()` 生成模型内容；`presentationMeta()` 生成 GUI 元数据 | 执行值、模型文本和 GUI 展示不能继续混在一个自由拼装对象中 |
| `finalizeContent` | 同步、纯、只做最后模型内容转换 | 最终化阶段不得做磁盘 I/O、ControlStore 写入或网络调用 |
| `tools/result` | 仅观测冻结后的最终结果 | 监听器失败不得改变工具成功语义，也不得阻塞下一步模型调用 |
| Agent loop commit | 并行工具完成后按模型源顺序追加 `tool/call` / `tool/result` | 执行可以并行，提交顺序保持确定性，不需要每个完成事件立即重写业务投影 |
| Session live persistence | live event 进入有界 buffer，定时批量写；`flush()` / `close()` 是明确 durability barrier | 普通 Tool Result 先进入 Session 内存事实源，后台批量持久化；边界处再等待 |
| Spill Store | 大文本独立保存，模型只看到有界 head/tail、locator 和 retrieval hint | 大输出传输策略与长期 Evidence/Artifact 语义分开 |
| Spill failure | 记录警告并保留原始内联结果，不把成功工具变成失败 | 展示/存储旁路故障不能推翻底层命令成功状态 |
| Spill policy | 只处理最终、已接受的纯文本；模型副本和完整值分离 | 不要为了存储策略反复改写或重新哈希规范结果 |
| Telemetry | 可替换旁路能力，按 session/event cursor 去重，尽力而为 | telemetry 不参与 Tool Result 的同步正确性路径 |
| Concurrency | 只有显式 `isConcurrencySafe()` 返回 true 才允许重叠 | read/glob/grep 可显式并行，workspace 写和状态操作保持 barrier |

尤其值得采用的是 DSH 的 Session 持久化模式：`session.append()` 首先形成模型交互的类型化事实，持久化插件接收 live event 后进入 bounded buffer，通过定时器批量 drain；显式 `append()`、`flush()` 和 `close()` 才承担明确的 durability 语义。ProofBlade 不应直接复制其包或 Cordis 生命周期，但应采用同样的“内存提交与磁盘 barrier 分离”原则。

也要注意边界差异：DSH 的 Tool canonical value 是执行局部值，持久 `tool/result` 主要保存模型内容、错误和 presentation metadata；ProofBlade 还拥有 verifier、Effect、Artifact 和 Evidence 权威状态。因此普通结果可以沿用 DSH 式轻路径，重要安全结果仍必须进入 Control Store，但应一次批量提交，而不是多次派生写入。

## 3. 设计原则

### 3.1 普通对话走轻量路径

普通对话不是安全任务模板，也不是独立评测。创建阶段只做以下工作：

1. 校验 `runId`、标题和工作目录。
2. 创建最小 `TaskContract`。
3. 原子写入 Run 起始记录。
4. 保存对话首选项。
5. 返回 `201`，让 GUI 立即进入对话。

模型、Skills、MCP、Tool Catalog、Provider transport、工具预检和动态上下文均延迟到第一条用户消息。

### 3.2 使用上游会话和工作目录接口

普通对话不再扩展另一套 workspace manager。以 Pi 的接口为唯一实现：

```ts
const env = new NodeExecutionEnv({ cwd: workspacePath });
const repo = new JsonlSessionRepo({
  fs: env,
  sessionsRoot: join(runDir, "pi-sessions"),
});
```

ProofBlade 只负责提供经过校验的 `workspacePath`、稳定 `sessionId` 和 Run 元数据，不复制工作区、不生成中间 challenge 文件，也不维护第二套 cwd 编码规则。

### 3.3 正确性哈希与性能哈希分离

不能笼统删除所有哈希。应按用途分类：

| 类别 | 示例 | 处理策略 |
|---|---|---|
| 权限与真实性 | authority hash、projection HMAC | 必须保留 |
| 持久数据完整性 | task hash、artifact hash、event-prefix seal | 必须保留 |
| verifier 绑定 | command、target、verification rule hash | 必须保留 |
| 幂等键 | Effect、请求和提交键 | 保留，但对同一输入复用结果 |
| 配置版本 | skill/MCP/tool catalog hash | 按文件版本缓存，不按对话重算 |
| 展示与诊断 | GUI 投影、queue、prompt 展示 hash | 只在输入 revision 变化时计算 |
| 重复派生 | 同一回合多次 canonicalize 同一对象 | 合并为一次或直接使用版本号 |

### 3.4 用 revision 驱动缓存失效

对于本地文件和 append-only Run，优先使用已有的结构化版本。**但 revision 的构成必须按「谁写这个文件」区分**：

| 数据 | revision 构成 | 理由 |
|---|---|---|
| Run | `lastSeq + generation` | 结构化，权威，无歧义 |
| Session | session 文件集合的版本摘要 | 同上 |
| ProofBlade 自己写的产出 | `mtimeMs + size` | 同进程写入可主动失效 |
| **用户/外部工具编辑的配置** | **内容哈希**（`mtimeMs + size` 仅作快速预筛） | 见下 |

**为什么配置类不能只用 `mtimeMs + size`**：`proofblade.config.json`、`.mcp.json`、`tool-catalog.json`、`SKILL.md` 由用户或外部编辑器写入，不是 ProofBlade 自己写的。因此：

1. Windows/NTFS 的 mtime 更新存在延迟，同秒内的多次写入可能不刷新 mtime；
2. 「写操作主动失效」在这些文件上**不适用**——写入方不是本进程，无法挂失效钩子。

这两点叠加会静默漏掉配置变更，比性能回退严重得多。**这类文件体积小（KB 级），内容哈希成本可以忽略；真正的开销在目录重扫和大对象序列化，不在配置文件的哈希。**因此这里不是性能与正确性的权衡点。

哈希只在跨信任边界或需要内容完整性证明时使用，不把哈希当作所有缓存的默认版本号。

### 3.5 工具完成先返回，控制记录按价值分级

工具结果分为两类：

1. **普通结果**：成功的小型 `read/glob/grep`、无候选值的短 `bash`、完整内容已直接返回模型。它们不应在返回模型前同步创建 Observation、Evidence 和 Experiment，也不应同步重写 projection。必要的审计元数据进入内存队列，在回合边界批量落盘。
2. **重要结果**：截断输出、失败/超时、候选值、显式 `evidence_record`、verifier 输入、外部副作用和最终结果。它们需要持久化，但必须在一次批量 ControlStore 事务中完成，最多一次跨进程锁和一次 event-log `fsync`；projection 仍延迟到回合边界。

模型可见 Tool Result 是首要热路径。观察性数据、GUI 展示字段和统计不得阻塞它。安全边界使用结构化批量提交保持，而不是通过每个派生对象各做一次独立同步写入保持。

### 3.6 采用 DSH 三层 Tool Result，不混合职责

统一工具输出契约：

```ts
interface ToolResultEnvelope<TCanonical> {
  canonical: TCanonical;
  model: ContentBlock[];
  presentation?: JsonValue;
  durable?: {
    spill?: SpillReference;
    artifactId?: string;
    evidenceId?: string;
  };
  isError: boolean;
}
```

- `canonical`：执行局部的规范值，供程序、策略和组合工具使用；不默认完整写入 Control Store。
- `model`：稳定、有界、能直接进入下一次模型请求的内容。
- `presentation`：纯函数产生的 GUI 元数据，重放时可以复用，不触发额外读取。
- `durable`：只有确实发生 Spill、Artifact 或 Evidence 提升时才存在的引用。

该契约吸收 DSH 的 Tool 定义方式，但不引入其 Cordis 注册树。ProofBlade 现有工具仍由当前 Registry 和 Pi Agent 驱动，只统一结果边界与持久化策略。

### 3.7 调用级 `description` 参数与错误反馈（**已拆出，不在本计划实施范围**）

> **评审修订说明**：本项是**破坏性工具契约变更**（给 `bash` / `shell_background` 增加必填参数），不是性能优化。它会改变模型可见的调用面与参数校验的失败语义，需要独立的迁移与重放兼容方案。**已拆出为 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md` 单独评审与排期。**
>
> 本计划不再包含原始表项 U1、原 §8.7 第 9–10 条契约测试，以及 §7 中与 `toolArgValidationErrors` / `toolArgRepairHintRate` 相关的观测项。§3.7 以下文字仅为**原始设计草案**，保留供拆分文档引用，**不构成本计划的实施内容**。幂等性说明见拆分文档 §3.1：`description` 不参与 command hash 与 Effect 幂等键，因此历史 Effect 不受影响。

DSH 的 `bash`/`pwsh` 除工具定义说明外，还要求每次调用提供短的调用级 `description`，用于 UI 标题和执行摘要。ProofBlade 只给现有的 `bash`、`shell_background` 增加这个参数，不新增工具，也不增加描述代理层。

| 工具 | 参数 | 约束 | 用途 |
|---|---|---|---|
| `bash` | `description: string` | 必填，1-160 字符，建议主动语态 5-10 词 | UI 标题、Artifact 摘要、错误上下文 |
| `shell_background` | `description: string` | 必填，1-160 字符，建议主动语态 5-10 词 | Job 列表、轮询提示、日志标题 |

`read`、`glob`、`grep`、`edit`、`write`、`shell_job` 不机械增加字段；现有路径、操作和查询参数已经足够生成稳定展示。只有无法从已有参数可靠派生标题时，才单独评估同类参数。

调用级参数错误必须返回可修复反馈，而不是裸的 `schema mismatch`：

```json
{
  "isError": true,
  "details": {
    "schemaVersion": 1,
    "tool": "bash",
    "code": "BAD_TOOL_ARGS",
    "phase": "validate",
    "retryable": true,
    "receivedFields": ["command"],
    "missingFields": ["description"],
    "allowedFields": ["command", "description", "timeout"],
    "nextAction": "补充主动语态的 5-10 词描述后重试；不要重复发送相同参数。",
    "example": { "command": "npm test", "description": "Run the focused unit tests" }
  }
}
```

规则：参数错误阶段不启动命令、不写 Artifact、不写 Experiment；字段集合稳定排序；`nextAction` 必须可执行；错误消息需要脱敏和长度上限；旧 Session 缺失 description 时 GUI 回退到命令首行。description 只影响展示，不参与 command hash、Effect 幂等键、repeat key 或 Provider cache prefix。

## 4. 更改计划表

> **评审修订说明**：
> - 原表项 **B（读取兼容层）已删除**。它与表项 A（启动 fail-fast）在同一部署内互斥，且本机为单机本地 GUI、没有滚动升级场景；保留它会长期掩盖构建错配，与 §11 完成定义第一条直接冲突。理由详见 §5.1。
> - 原表项 **E（复用 Pi 工作目录）已删除**：该行为**经核对已经成立**，不存在需要删除的重复 workspace 生命周期。取而代之的是回归测试项 **E'**。证据见 §2.2。
> - 原表项 **U1（调用级 `description`）已拆出**为独立文档 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`，因为它是破坏性工具契约变更，不属于性能优化。
> - 行序按实施依赖重排：P0 组内先建立可观测性（T0），再走轻路径（T1/T3），再合并批量提交（T2/D0/D1）。
> - 「测试文件」与「回滚粒度」见 §4.1；仓库要求每个改动源文件被 `.github/test-matrix.json` 规则覆盖（`scripts/check-changed-tests.mjs`）。

| 阶段 | 优先级 | 更改项 | 主要文件 | 预期收益 | 验收条件 |
|---|---:|---|---|---|---|
| A | P0 | 修复 GUI 与 workspace package 的构建一致性 | `package.json`、`apps/gui/package.json`、启动测试 | 消除 `loadProjectionHint` 运行时报错 | 启动前验证该方法存在；GUI HTTP 200；源码变化后不会加载旧 `dist` |
| T0 | P0 | 增加工具分阶段计时，不经 ControlStore 持久化计时本身 | `coding-resources.ts`、Pi observability、benchmark | 精确区分命令耗时和框架开销 | 输出 execute/rewrite/artifact/control/observe/experiment/subscriber/total 时间 |
| T1 | P0 | 普通结果的派生观察延后到回合边界（最多一次同步提交） | `coding-resources.ts`、`tools/runtime.ts`、`knowledge/observer.ts` | 毫秒命令不再等待第二多轮锁和 fsync；收益约 12ms/次 | 小型成功 read/glob/grep/bash 的同步 ControlStore commit <= 1（实测现状为 2）；见 §5.6.3 与拆分文档 |
| T2 | ~~P0~~ **已关闭** | ~~将 Artifact、annotation、Observation、Evidence、Experiment 合并为单次 ToolResultCommit~~ **经代码核实不可行**：`dispatchTransaction` 的 `prepare(before)` 用批次前快照校验整批，故不能在同一批次内注解或引用本批次刚注册的 artifact。改由 T1 的延后路径达成同等目标 | — | 与 T1 相同（工具返回前 1 个提交），且不需要改事务模型 | 见 `docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md` §2.5 / §2.6 |
| T3 | P0 | ExperimentGate 只对声明需要的安全实验启用，普通 coding chat 使用内存去重 | `experiment-gate.ts`、`coding-lane.ts` | 删除每次普通 bash 的投影重写 | 普通对话 bash 不产生同步 experiment projection |
| T4 | P1 | 去除工具结果重复 hash、Artifact 回读和 telemetry snapshot | `coding-resources.ts`、`runtime.ts`、`pi-events.ts` | 降低 CPU、磁盘和 subscriber barrier | 同一输出只计算一次内容 hash；observer 直接接收已知内容；telemetry 不读 snapshot |
| D0 | P0 | 引入 DSH 风格 ToolResultEnvelope | tool contract、`coding-resources.ts`、GUI presenter | 规范值、模型文本、GUI 元数据和长期引用解耦 | `finalizeContent`/render 为同步纯函数，禁止 I/O |
| D1 | P0 | Session live event 有界批量持久化 | Pi Session adapter、session repo、lane barrier | Tool Result 先提交内存事实源，不逐项等待磁盘 | 普通结果 append 不阻塞；turn/close/checkpoint 显式 flush |
| D2 | P1 | 建立轻量 SpillStore seam | Artifact/Spill storage、output rewrite | 大输出不再强制升级成业务 Artifact/Evidence | spill 失败保留工具成功和有界内联结果 |
| D3 | P1 | Tool observers 与 telemetry 改为 observation-only | Pi hooks、telemetry backend | 监听器不再改变结果或阻塞主线 | observer 抛错只记诊断；不改变 `isError` 和模型内容 |
| C | P0 | 普通对话创建改为最小事务 | `apps/gui/src/server.ts`、`debug-data.ts`、ControlStore 创建接口 | 创建按钮快速返回 | 创建阶段不加载 Skills/MCP/Tool Catalog，不建立 Provider transport |
| D | P1 | Run 版本快照改为启动级缓存并延迟绑定 | `runtime/version.ts`、`app/demo.ts`、`control-store.ts` | 消除每个 Run 的目录重扫与重复哈希 | 相同配置连续创建 100 个 Run 只构建一次版本快照 |
| E' | P1 | **回归测试**：锁住「普通对话不使用 staging」（无源码改动） | 仅测试文件 | 防止后续重构无意改变既有正确行为 | 普通对话不创建 `.proofblade-workspaces/<runId>`；附件任务仍创建 |
| F | P1 | Catalog 和 prompt 派生值缓存 | Skills/MCP/Tool Catalog registry、`coding-lane.ts` | 加快首轮与后续指令 | 文件 revision 不变时不重新读内容、不重新计算 catalog hash |
| G | ~~P1~~ **已关闭** | ~~Context 热路径去重~~ **实测无剩余空间**：observation queue 在空 Run 为 0 项、哈希 0.0016ms，`ObservationQueueCache` 已按 `lastSeq/generation/projectionHash` 命中（500 次请求仅 1 次重投影），快照本身也已缓存。剩余可省为亚毫秒级 | — | 无（已达标） | 见 `docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md` §6.1 |
| H | P2 | GUI 详情接口按视图拆分 | `server.ts`、`debug-data.ts`、`api.ts`、`App.tsx` | 聊天页不读取调试器全量数据；**实测 `events` 占每次轮询载荷的 69%（100,160 / 144,901 字节）** | 聊天轮询不传完整事件流；时间线与调试器改为按需/增量拉取。**实施需客户端协同，且 UI 行为无法仅凭单元测试证明，须浏览器验证** |
| I | P2 | 轮询改为增量和可见状态驱动 | `App.tsx`、`polling.ts` | **可见状态半边已存在**（`App.tsx:153` 已有 `visibilityState` 早退），本轮抽为 `isPollingAllowed()` 并加门禁 | 非活动页停止详情轮询 = **已达成**；`lastSeq` 增量 = **服务端已支持但客户端未采用**，需浏览器验证 |
| J | P2 | 加入基准和预算门禁 | `packages/materials/tests/hot-path-budget.test.ts`、`.github/change-contracts.json` | 防止性能回退；**已实施**（PR #236） | **门禁只断言计数，不断言耗时**（耗时门禁在共享 runner 上测的是机器）；4 条 `[contract:...]` 场景已登记进 change-contracts，改动相关源文件时必须保留 |

### 4.1 测试文件与回滚粒度（补充）

上表为**待评审的目标形态**；本表补齐仓库对改动源文件的测试矩阵要求与单项回滚边界。**每个 PR 必须同时提供对应测试，否则 `check:changed-tests` 会在改动源文件时报告 `no test-matrix rule covers this source file`。**

| 阶段 | 测试文件 | 回滚粒度 |
|---|---|---|
| A | `apps/gui/tests/` 启动形状测试 | 恢复原 `gui` 脚本 |
| T0 | `packages/materials/tests/` 计时单元 + benchmark script | 移除计时钩子 |
| T1 | `packages/materials/tests/` commit 计数测试 | 恢复同步提交 |
| T2 | `packages/materials/tests/` 事务合并测试 | 恢复多次 `dispatchTransaction` |
| T3 | `packages/materials/tests/` 门控范围测试 | 恢复全量 durable gate |
| D0 | `packages/materials/tests/` 纯函数注入测试（render/presentation/finalize 注入 I/O 即失败） | 回退结果包络到旧对象形态 |
| D1 | `packages/materials/tests/` flush barrier 测试 | 回滚 routine write-behind，保留 D0 |
| C | `apps/gui/tests/` 创建链路测试 | 恢复完整创建事务 |
| T4 | `packages/materials/tests/` hash 次数测试 | 恢复回读路径 |
| D | `packages/materials/tests/` 缓存命中测试 | 单模块退回逐 Run 构建 |
| F | `packages/materials/tests/` 失效测试 | 单模块退回逐次计算 |
| G | `packages/materials/tests/` 复用测试 | 单模块退回逐次构建 |
| D2 | `packages/materials/tests/` 失败语义测试 | 禁用 Spill policy，不影响 Artifact Store |
| D3 | `packages/materials/tests/` observer 抛错测试 | 恢复原 observer，但仍禁止改变结果 |
| E' | `apps/gui/tests/` 或 `packages/materials/tests/` | 纯测试，无需回滚 |
| H | `apps/gui/tests/` 接口契约测试 | 回滚为原 RunDetail 接口 |
| I | `apps/gui/tests/` 轮询行为测试 | 恢复全量轮询 |
| J | `packages/materials/tests/`、benchmark script | 移出门禁，保留报告 |

## 5. 分阶段实施细节

### 5.1 P0：先恢复可用性

#### 5.1.1 修复构建入口

为 GUI 增加明确的依赖构建入口，避免开发命令直接消费旧 `dist`。建议提供两个命令：

```json
{
  "gui": "npm run build:gui-deps && npm run dev --workspace=@proofblade/gui --",
  "gui:fast": "npm run dev --workspace=@proofblade/gui --"
}
```

其中 `build:gui-deps` 只构建 `atoms`、`molecules` 和 `materials`。`gui:fast` 只用于已经由 watcher 或完整 build 保证产物一致的开发场景。

同时增加启动断言：

```ts
if (typeof services.control.loadProjectionHint !== "function") {
  throw new Error("@proofblade/materials runtime is stale; rebuild GUI dependencies");
}
```

开发期与 CI 一律 fail-fast，**不提供运行时降级**，理由见 §5.1.2。

#### 5.1.2 为什么不提供读取兼容层（原表项 B 已删除）

原计划曾提出「方法缺失时退回 `snapshot()`」的兼容层。**评审后删除**，三条理由：

1. **与 fail-fast 互斥**。同一部署内不可能既在启动时抛错、又在方法缺失时降级。原表项 A 与 B 同时列为 P0，实施者无法判断应该走哪条；原 §10 又把两者打包进同一个 PR，矛盾被固化。
2. **没有对应场景**。这是单机本地 GUI（`npm run gui -- --port 4173`），不存在「跨版本滚动升级期间新旧共存」的部署形态。兼容层要解决的窗口在这里不存在。
3. **收益为负**。兼容层会长期掩盖构建错配——而构建错配正是本计划 §2.1 要修的 P0 缺陷。保留它等于一边修问题、一边留一个让问题静默复发的开关，与 §11 完成定义第一条「运行时不再出现源码/`dist` API 错配」直接冲突。

因此本计划只做一件事：**修正构建入口，并让错配在启动时立即失败且给出可操作的诊断。**诊断信息必须包含期望的方法名、解析到的包路径与实际类型，便于一次定位。

若将来真的引入多版本部署，应作为独立设计议题重新评审，而不是在性能计划里预埋。

### 5.2 P0：创建对话最小化

#### 5.2.1 从创建事务移除完整版本快照

为 `ControlStore.createRun()` 增加显式创建策略，例如：

```ts
type CreateRunOptions = {
  versionSnapshot?: "eager" | "deferred";
};
```

普通对话使用 `deferred`；Fixture、Competition、Evaluation 和 verifier-backed task 继续使用 `eager`。第一次创建 Coding Lane 时再生成并以单独事件绑定版本快照。

如果暂时不调整事件协议，则先把 `createRunVersionSnapshot()` 提升为 `createServices()` 生命周期内的 single-flight 缓存。这样风险较小，也能消除大部分重复工作。

#### 5.2.2 创建 API 不重复读取能力目录

`POST /api/conversations` 当前为了生成默认首选项调用 `capabilityCatalog()`。能力目录已在进程内缓存，但 Provider Native 部分仍会重建。创建接口应直接使用启动时缓存的默认首选项，或只保存用户提交的差异字段；完整能力归一化放到读取设置或首次发送消息时进行。

#### 5.2.3 保持写入原子性

当前 Run 创建和 `gui-workspace.json` 保存是两个事务。优化后仍需处理“Run 已创建但 GUI 设置保存失败”的状态。建议：

1. 先校验全部输入。
2. 创建最小 Run。
3. 保存对话首选项。
4. 保存失败时返回带 `runId` 的可恢复错误，由重试执行幂等补写，而不是重新创建 Run。

### 5.3 P1：官方工作目录和会话路径（**仅补回归测试**）

**经核对，本节原先要求「删除」的四项行为在普通对话路径上均不存在**（证据见 §2.2）。因此本节不产生源码改动，只产生一条回归测试。

普通对话的既有标准路径已经是目标形态：

```text
用户选择目录
  -> requireDirectory()
  -> codingConversationTask(): target = root, allowed_workspace = root, inputs = []
  -> taskExecutionWorkspace(): allowed_workspace 非空且存在 -> 直接返回该目录
  -> NodeExecutionEnv(cwd)
  -> JsonlSessionRepo.list({ cwd })
  -> open(existing) 或 create({ id, cwd })
```

原「需要删除或禁止的行为」清单逐条核对结果：

| 原条目 | 核对结果 |
|---|---|
| 为普通对话复制整个项目目录 | **不存在**。`createConversation()` 不调用 `stageTaskWorkspace()` |
| 为普通对话生成 `challenge.md` | **不存在**。`challenge.md` 只由 `startTask()` 的附件任务路径写出 |
| 为普通对话逐文件计算输入哈希 | **不存在**。普通对话 `inputs: []`，循环体不执行 |
| 同时维护 Run 工作区和 Pi 工作区两套 cwd | **不存在**。执行 cwd 由 `taskExecutionWorkspace()` 单一来源决定 |

**必须保留、不得以「统一表面结构」为理由移除的行为**（这些是正确设计，不是性能债）：

- 附件验证任务的 staging、大小限制、路径边界、符号链接拒绝和内容哈希。
- `apps/gui/src/task-workspace.ts:38` 把 staging 放在 `dirname(runsRoot)` 而非 Run 目录内部——`JsonlControlStore` 会把任何已存在的 Run 目录当作既有 Run，因此这个位置是必要的。
- Docker/远程执行环境的 host/container 路径映射。
- verifier 对不可变附件和命令的绑定。

**本节唯一动作（表项 E'）**：增加一条回归测试，断言普通对话创建后不存在 `.proofblade-workspaces/<runId>`，同时断言附件验证任务仍然创建它。目的是防止后续重构无意改变这个已经正确的行为。

### 5.4 P1：哈希和目录扫描优化

#### 5.4.1 `RunVersionSnapshot` 缓存

在服务启动时建立：

```ts
interface VersionSnapshotCache {
  revision: string;
  promise: Promise<RunVersionSnapshot>;
}
```

revision 由以下文件的**内容哈希**组成（`mtimeMs + size` 仅作快速预筛，命中差异才计算哈希）：

- `proofblade.config.json`
- `.mcp.json`
- `tool-catalog.json`
- Skills 根目录中相关 `SKILL.md`

**为什么这里必须是内容哈希而不是 `mtimeMs + size`**：这些文件由用户或外部编辑器写入，不是 ProofBlade 自己写的。两个后果：

1. Windows/NTFS 的 mtime 更新存在延迟，同秒内多次写入可能不刷新 mtime；
2. 「写操作主动失效」在这些文件上**不适用**——写入方不是本进程，挂不上失效钩子。

这两点叠加会**静默漏掉配置变更**（例如用户改了 `.mcp.json` 却仍复用旧 catalog），后果比性能回退严重得多。这类文件是 KB 级，内容哈希成本可忽略；真正的开销在**目录重扫与大对象序列化**，不在配置文件的哈希。此处不构成性能与正确性的权衡。

只有 revision 改变才读取内容并重新计算 catalog/content hash。

#### 5.4.2 Coding Lane 初始化缓存

将 install-root 级别资源改为共享不可变快照：

- `ProofBladeSkillRegistry`
- MCP definitions 和 schema cache 元数据
- `ProofBladeToolCatalogRegistry`
- stable system prompt 基础部分
- Provider tool definitions

有连接状态的 MCP client 不能盲目全局共享；应拆成“可缓存 definitions”和“按 Lane/服务生命周期持有 connections”。

#### 5.4.3 Context 计算去重

目前 queue items 会先 canonicalize 再 hash，随后 ContextCompiler 又会把相同数据纳入 manifest hash。可将 observation queue 投影直接返回稳定 revision：

```ts
type ObservationQueueProjection = {
  items: ObservationQueueItem[];
  revision: string; // last relevant seq + generation
};
```

缓存键改为：

```text
lastSeq / generation / queueRevision / guidanceRevision / capabilityRevision
```

只有跨进程校验时才需要重新计算内容哈希。

### 5.5 P2：GUI 读取拆分

建议把当前 RunDetail 拆成：

1. `GET /api/runs/:id/summary`：snapshot 摘要、状态、最后序号、聊天所需消息尾部。
2. `GET /api/runs/:id/events?afterSeq=`：时间线增量。
3. `GET /api/runs/:id/sessions`：仅调试器打开时加载。
4. `GET /api/runs/:id/telemetry`：仅指标面板可见时加载。
5. `GET /api/runs/:id/artifacts`：仅产物页加载。

后台轮询只请求 summary；SSE 已经活跃时优先消费流事件，并在回合完成后做一次一致性刷新。

### 5.6 P0：工具执行热路径重构

#### 5.6.1 先增加不干扰热路径的分段计时

为每次工具调用记录以下单调时钟区间：

```text
scheduled -> execution_start
execution_start -> command_complete
command_complete -> rewrite_complete
rewrite_complete -> artifact_staged
artifact_staged -> control_commit_complete
control_commit_complete -> tool_result_emitted
tool_result_emitted -> subscribers_complete
```

计时结果只能写入进程内环形缓冲区或现有 telemetry batcher，禁止为了测量工具延迟再增加一次同步 ControlStore 写入。开发接口按需读取最近样本，benchmark 直接消费内存计数器。

#### 5.6.2 引入 `ToolResultCommit`（**已关闭：经核实不可行**）

> **评审修订 3（代码核实）**：本节假设可以把 artifact 注册与派生观察放进同一批次。核实结果是不能：`ControlStore.dispatchTransaction` 先执行 `prepare(before)` 并用**批次之前的快照**校验整批命令，因此
>
> - 对本批次刚注册的 artifact 发 `artifact_annotation` 会被拒绝；
> - 引用本批次刚创建的 observation 的 `evidence` 会被 `validateEvidence` 拒绝（它对 artifact 查 `snapshot.artifacts`，而非同批次引用表）。
>
> 即 **artifact 注册必须先于派生观察提交**，这是被强制的顺序不变量。突破它需要改事务模型（按批内顺序增量校验），属于语义变更而非性能优化。
>
> **等价目标改由表项 T1 的延后路径达成**：artifact 同步提交，派生观察在回合边界批量落盘。两者都能把工具返回前压到 1 个提交，但 T1 不需要改事务模型。详见 `docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md` §2.5 / §2.6。
>
> 下文保留原始设计，仅作历史记录，不构成本计划的实施内容。

新增一个工具结果批量提交结构：

```ts
interface ToolResultCommit {
  artifact?: StagedArtifact;
  annotation?: ArtifactSemanticMetadata;
  observation?: Observation;
  evidence?: Evidence;
  experiment?: ExperimentRecord;
  telemetry?: ToolTelemetry;
  durability: "write_behind" | "event_log" | "verifier";
}
```

实施步骤：

1. 工具输出在内存中完成截断、脱敏和一次内容 hash。
2. `ArtifactStore.stageText()` 只写 Artifact 内容，不立即注册控制事件。
3. Observer 直接接收已经在内存中的 bounded output，不再 `readText()` 回读刚写文件。
4. 一次 `dispatchTransaction()` 同时注册 Artifact、annotation、Observation、Evidence 和 Experiment。
5. 事务统一使用 `persistProjection:false`；回合结束、lane close、checkpoint 或 verifier barrier 再 `flushProjection()`。
6. `tool_result_recorded` 直接使用 ToolResultCommit 中的 Artifact hash/Evidence 状态，不再调用 `snapshot()` 查回。

#### 5.6.3 普通结果最多一次同步提交

> **评审修订 3（实测修正）**：本节原写「零同步提交」。真实 Run 基线（PR #230）与成本分解（`docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md`）表明该目标在当前架构下**不可达**：一次 `read` 有 2 个逻辑提交（artifact 注册、派生观察），每次约 12ms；artifact 是后续 Evidence/verifier 的引用对象，不能在模型继续前不落盘。
>
> 因此目标修正为**「普通结果最多一次同步提交」**，理论收益从 25ms 降到约 13ms。完整分解与队列设计见拆分文档，本节只保留结论。

满足以下全部条件时进入快速路径：

- 工具无外部副作用或副作用仅限当前 workspace；
- 执行成功；
- 输出未截断且已完整返回模型；
- 不包含候选值、失败签名或 verifier 标记；
- 不是显式 Evidence/Checkpoint/Submission 操作；
- 输出大小不超过配置阈值。

快速路径行为：

- Tool Result 立即返回模型。
- **artifact 注册保持同步**（提交 1）：它是后续 Evidence 与 verifier 的引用对象，延后会让引用悬空。
- 派生的 annotation / observation / evidence（提交 2）进入 bounded write-behind 队列，**不再同步**。
- 不同步记录 Experiment（已由表项 T3 达成）。
- 队列在 turn end、agent end、显式 checkpoint、lane close、pause、verifier handoff 和进程关闭时 flush。
- 队列满时**降级为同步提交**，不得丢弃：Observation/Evidence 不是遥测，队列必须 fail-closed，不能复用 fail-soft 的 `ControlEventBatcher`（其注释明确 `Control-plane commands never use this class`）。

Pi session 本身仍保存模型看到的 Tool Result，因此普通结果不会因为控制投影延迟而从对话历史消失。只有需要被最终结论引用的材料才在使用前提升为正式 Evidence。

**模型可见行为变更**：派生观察延后后，`observationNotice` 不再能同步给出 observation/evidence ID，只能保留 `progressKey`（或标记为 pending）。这是本项唯一的模型可见变更，必须独立评审。

**实施顺序**：建议排到表项 **D1（Session live buffer）之后**，复用 D1 建立的有界缓冲与 flush 屏障定义，而不是先造一套再改。

#### 5.6.4 重要结果只允许一次同步事务

候选值、错误、超时、截断输出、外部副作用和 verifier 输入进入重要路径。该路径要求：

- 内容 hash 只计算一次并贯穿 Artifact、Observation 和 telemetry。
- 预先分配 Artifact/Observation/Evidence/Experiment ID。
- 同一批 commands 由 ControlStore 一次验证和 reduce。
- event log 一次 append、一次 `fsync`。
- 不在工具返回前写 projection。
- verifier 所需的 durability barrier 可以等待 event log，但不等待 GUI projection。

#### 5.6.5 限制 ExperimentGate 的适用范围

普通 Coding 对话的每次 `bash` 不需要持久化 no-repeat experiment。调整为：

- Competition、Evaluation、显式安全任务策略：使用 durable ExperimentGate，并并入 ToolResultCommit。
- 普通 Coding chat：使用 lane 内存中的 bounded repeat map。
- 显式 ablation：按实验配置决定 durable 或 memory-only。
- verifier replay：保持独立可信 Effect/Experiment 记录。

#### 5.6.6 减少锁和 `fsync`

工具热路径的硬性规则：

| 路径 | 跨进程锁 | event-log fsync | projection fsync | Artifact 回读 |
|---|---:|---:|---:|---:|
| 普通成功结果 | 0 | 0 | 0 | 0 |
| 重要工具结果 | <= 1 | <= 1 | 0 | 0 |
| verifier/外部副作用 barrier | <= 1 | <= 1 | 按明确 barrier 决定 | 0 |
| turn-end 批量 flush | <= 1 | <= 1 | <= 1 | 0 |

不能通过把 `fsync` 全部删除来换速度。真正的优化是把多次独立 durability barrier 合并到语义明确的边界。

### 5.7 参考 DeepSeek Harness 调整后的目标管线

结合 DSH 当前实装，ProofBlade 的目标管线调整为：

```text
Tool execute
  -> validate canonical value
  -> pure render(model content)
  -> pure presentationMeta(GUI metadata)
  -> classify durability
       routine:
         -> append tool/result to Pi Session live buffer
         -> emit model result immediately
         -> observation-only telemetry
       oversized:
         -> SpillStore.saveText best-effort
         -> model gets bounded head/tail + opaque locator
         -> append tool/result to Pi Session live buffer
       material/security:
         -> stage durable bytes once
         -> one ToolResultCommit to Control Store
         -> append tool/result with durable refs
  -> turn/checkpoint/close barrier flushes Session + Control batches
```

#### 5.7.1 Session 是“模型见过什么”的事实源

沿用现有双域边界：

- Pi Session 记录 `tool/call`、模型可见 `tool/result`、顺序和错误状态。
- Control Store 记录任务阶段、Effect、正式 Artifact、Evidence、Experiment 和 verifier 状态。
- 两者通过 `runId/turnId/toolCallId/artifactId/evidenceId` 关联。
- 普通 Tool Result 不因为 Control Store 尚未 flush 而阻塞模型。
- 一旦 Tool Result 将被正式 Evidence、Completion 或 verifier 引用，必须先完成对应 Control Store barrier。

这与 DSH 的 Session 事件事实源一致，也保持 ProofBlade “Pi Session 与 Control Store 不合并”的既有架构决定。

#### 5.7.2 模型提交与磁盘持久化分离

参考 DSH JSONL persistence 的 live buffer：

- 每个 Lane 维护有界 Tool/Telemetry commit queue。
- queue 项是已冻结的结构化值，不保留可变大对象引用。
- 达到条数、字节或时间阈值时批量 drain。
- drain 失败时保留队列并退避重试，普通工具调用不改为失败。
- `turn_end`、`agent_end`、checkpoint、pause、lane close 和 verifier handoff 强制 flush。
- 关闭时先停止新调用，再 drain，最后释放 Session/Control 资源。

写后即崩溃的窗口由 Pi Session 和 Control Store 的不同语义处理：模型已看到的普通结果以 Session 为准；尚未提升的自动 Observation 可以丢失并在重放时重新派生；正式 Evidence、外部副作用和 verifier 结果必须在返回成功前完成 durability barrier。

#### 5.7.3 Spill 与 Artifact 分工

采用 DSH 的职责划分：

| 类型 | 用途 | 是否自动成为 Evidence 来源 | 失败语义 |
|---|---|---:|---|
| Inline model content | 小型完整结果 | 否 | 直接返回 |
| Spill | 大型工具输出的传输与取回 | 否 | 保留有界内联结果，工具仍成功 |
| Artifact | 需要长期复核的业务材料 | 可以被显式提升 | 注册失败时重要结果失败 |
| Evidence | 支持/反驳结论的正式记录 | 已是权威记录 | 必须通过 Control Store barrier |

`read` 不应形成 `read -> spill -> read` 循环。普通完整文件读取直接进入模型；只有超大输出且模型无法完整消费时才提供 Spill locator。Spill locator 必须是不透明值，取回动作遵循 workspace 和会话边界。

#### 5.7.4 Observer 只观察，不修改结果

参考 DSH `tools/result` 事件：

- 工具最终结果在通知 observer 前冻结。
- telemetry、GUI presenter、自动标签和统计只能读取。
- observer 抛错进入诊断日志，不能把成功调用改成失败。
- observer 不允许同步调用 `snapshot()`、重写 projection 或读取 Artifact 全文。
- 需要改变安全判定的逻辑必须位于 pre/guard/post policy，而不是结果 observer。

#### 5.7.5 明确不照搬的 DSH 部分

1. 不引入 Cordis 插件树重写现有组合层。
2. 不把 ProofBlade 整体做成 DSH 插件。
3. 不合并 Pi Session 和 Control Store。
4. 不把 Capability 目录展开成大量模型可见工具。
5. 不因为 DSH 使用 buffered persistence 就把 verifier/外部副作用也改成无 barrier。
6. 不把 DSH RC 版本的内部 ABI 作为 ProofBlade 公共接口。
7. 不为 description 单独新增工具；它只是现有命令工具的调用参数。

## 6. 不应删除的安全与一致性机制

性能优化不得破坏以下边界：

1. Run ID 的 create-exclusive 目录锚点。
2. `taskHash` 对持久 TaskContract 的绑定。
3. authority hash 与 projection HMAC。
4. event-prefix seal 与投影内容完整性。
5. Artifact 内容 hash。
6. verifier command、target、verification policy 的绑定。
7. Effect 幂等键和跨重试一致性。
8. 附件验证任务的不可变副本和路径边界。

优化重点是减少同一数据的重复计算、把不需要的工作移出热路径，而不是降低可信边界。

## 7. 验收指标

### 7.1 功能指标

- `loadProjectionHint` 在运行时存在；若缺失，GUI 在启动时**立即失败并输出可操作诊断**（不降级，见 §5.1.2）。
- 普通对话创建后立即可选中并发送消息。
- 重启 GUI 后可继续原有 Pi session。
- 普通对话不新增 `.proofblade-workspaces/<runId>`；附件验证任务仍创建（**回归断言，非新增行为**，见 §5.3）。
- Fixture、Competition、Evaluation 和 verifier-backed task 行为不变。
- 历史 sealed、unsealed、stale 和损坏投影仍按既有规则读取或回放。

### 7.2 性能指标

> **评审修订说明**：本节原文在全文**没有任何实测数据**的前提下直接给出毫秒阈值。在基线未知时无法判断阈值是否合理——真实 p50 可能是 80 ms（则 100 ms 目标毫无意义），也可能是 8 秒（则 100 ms 目标不现实）。因此本节拆为**基线段**与**目标段**：先由 T0 填基线，再据基线定阈值。
>
> **关于中心论断「几毫秒的命令被外围链路放大到秒级」**：该现象已由**使用者在真实环境实测确认**，不是机制推演。因此 §2.6 的热路径分析与 T1/T2 的优先级**成立**，不需要因基线未填而重新排序。基线的用途是量化放大倍数、定位主要成本来源，并作为改进后的对比基准——而非判断问题是否存在。
>
> 注意 PR 2 交付的 provider-free 基线**不能**替代真实 Run 基线：它没有 ControlStore，Artifact 落盘、文件锁、`fsync` 与 projection 重写是被计数而非被执行。真实 Run 基线仍须补齐。

#### 7.2.1 基线段（T0 产出，必须先填）

测试条件：本机 release-like 构建，至少 100 个历史 Run，一个 10,000 条事件的长对话。

**已完成的局部基线（PR 2，provider-free）**：命令执行本身为亚毫秒到毫秒级，`scheduled → executionStart` 框架调度开销可忽略。

**已完成的真实 Run 基线（`npm run baseline:tools:real`）**：在隔离临时项目中驱动真实 ControlStore，8 次/用例：

| 用例 | 每次调用 durable 事件 | projection 重写 | Artifact 回读 | command p50 | framework p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| read-1B | 4 | 0 | 0 | 25.1ms | 26.5ms | 34.7ms |
| read-32KiB | 4 | 0 | 0 | 43.0ms | 44.9ms | 49.5ms |
| bash-noop（`echo baseline`） | 5 | 0 | 0 | 532ms | 536ms | 2.9s |

三条可直接使用的结论：

1. **控制链路每次调用是固定成本，约 25ms**，与载荷大小几乎无关。`read-1B` 与 `read-32KiB` 事件数完全相同（各 4 条），但延迟只从 25ms 增长到 43ms——增量来自 32KiB 的归档 I/O，**固定部分才是链路本身**。
2. **`projection 重写 = 0`**：这直接验证了表项 T3（`ExperimentGate` 延后投影）在真实 Run 上生效。全量投影重写已不在工具热路径上。
3. **`bash` 的 p95（2.9s）与 p50（532ms）严重脱节**，而 `framework − command` 仅约 4ms。也就是说这条尾巴来自命令执行/进程启动与磁盘抖动，**不是** ProofBlade 附加开销。§2.6 提到的「杀毒软件、索引服务、磁盘写入抖动」在这里得到量化。

**基线尚缺的部分**：真实 Run 基线原本只用了一个 Run、一个短会话。**长 Run 部分已由 `npm run baseline:tools:longrun` 补齐**（本机实测，每点 5 次取样）：

| events | events.jsonl | projection.json | read p50 | snapshot() p50 | replay() |
|---:|---:|---:|---:|---:|---:|
| 10 | 28 KB | 4.6 KB | 28.7ms | 0.2ms | 11.0ms |
| 1,000 | 644 KB | 12.6 KB | 35.2ms | 0.3ms | 578.6ms |
| 5,000 | 3.1 MB | 20.7 KB | 34.4ms | 0.2ms | **4.0s** |
| 10,000 | 6.2 MB | 28.7 KB | **36.7ms** | 0.2ms | **9.3s** |

**两个结论，缺一不可：**

1. **工具热路径不随 Run 历史退化。** `read` 在 10 条事件与 10,000 条事件下都是约 29–37ms，`snapshot()` 恒为 0.2–0.3ms。原因是 `#withWrite` 在提交后用 `committed.reduce(reduce, before)` 刷新快照缓存，所以每次读取都命中增量折叠而不是重放。**这否定了「长 Run 让每次工具调用变慢」这一猜测。**
2. **但重放路径随历史线性增长，10,000 事件约 9.3 秒。** `replay()` 按设计折叠整条事件流，慢是应该的；问题是它位于**读取回退路径**上：`control-store.ts:743` 在 `loadProjection` 无法返回有效投影时回退到 `eventStore.replay()`。也就是说 **projection 缺失或被判定无效时，一次读取会付出全量重放**——这正是使用者报告的「秒级」量级。

**这条把 §2.6 的「秒级放大」定位到了一个具体机制**：不是每次工具调用都慢，而是**重放回退在长 Run 上慢**。因此：

- T3（延后投影重写）的价值得到解释：长 Run 上 `saveProjection` 内部要 `events()` 取全量事件，投影重写本身是 O(历史)；
- **建议新增一项 P0：长 Run 的重放回退必须有界或可避免**（例如投影封印失效时增量修复而非全量重放）。本计划原本没有这一项，是本次实测暴露的。

**回退代价的端到端实测**（10,000 事件，走真实 GUI 读取路径 `DebugDataService.getRun`，冷缓存 = 重启后的 GUI）：

| 条件 | projection.json | getRun |
|---|---:|---:|
| 冷缓存，投影存在 | 4.6 KB | **211.6ms** |
| 冷缓存，投影**被删除** | absent | **2095.8ms** |

投影文件只有 **4.6 KB**，但它的存在与否让一次读取相差 **10 倍（0.21s → 2.1s）**。

这里有一个**必须点明的反直觉后果**：T1/T2/T3 一路把 `persistProjection: false` 铺到热路径上，换来了快速调用；代价是 **`projection.json` 会长时间停留在陈旧状态**。于是"投影缺失或陈旧"不再是罕见故障，而是**正常运行下会出现的状态**——一旦缓存冷掉，就要付出全量重放。

也就是说：**投影延迟写入的收益与重放回退的风险是同一枚硬币的两面。** 新 P0 应当同时考虑"在明确屏障处补齐投影"，而不是只优化回退本身。

| 待测指标 | 基线值 | 状态 |
|---|---:|---|
| 普通对话创建 API p50 / p95 | — | **待测** |
| 底层命令 <= 10 ms 时，普通工具总耗时 p50 / p95 | read ≈ 29–37ms（不随历史变化） | **已测** |
| 普通工具 ProofBlade 附加耗时 p50 / p95 / p99 | read ≈ 25ms 固定；bash ≈ 4ms | **已测局部** |
| 长 Run 单次工具调用 | 10,000 事件下仍 ≈ 37ms | **已测** |
| 长 Run 重放回退 | 10,000 事件 ≈ 9.3s | **已测（新发现）** |
| 重要工具结果单次提交 p95 | — | **待测** |
| 普通 Tool Result 从 command complete 到 model-visible p95 | — | **待测** |
| 首次点击发送到 Provider 请求发出 p50 / p95 | — | **待测** |

**只有本表填完后，7.2.2 的阈值才可评审。**在基线缺失时签署阈值，等于把无法验证的数字写进验收条件。（7.2.2 的不变量类指标是计数而非耗时，因此不受此限制。）

#### 7.2.2 不变量类指标（无需基线，可立即作为门禁）

以下指标是**计数**而非耗时，与机器负载无关，因此不依赖基线，可直接作为 CI 断言：

| 指标 | 目标 |
|---|---:|
| 单个普通工具同步 ControlStore commit（已实测 2 → 目标 1） | `<= 1` |
| 单个重要工具同步 ControlStore commit / event fsync / projection rewrite | `<=1 / <=1 / 0` |
| 单个普通工具 projection rewrite（真实 Run 已实测 0） | 0 |
| observer 同步磁盘/网络操作 | 0 次 |
| Spill 失败导致成功 Tool 变为失败 | 0 次 |
| 创建阶段 Skills/MCP/Tool Catalog 内容扫描 | 0 次 |
| 相同配置下 100 个 Run 的版本快照构建 | 1 次 |
| 未变化 Run 的列表轮询完整事件回放 | 0 次 |
| 聊天 Tab 后台轮询 session branch/stats 重建 | 0 次 |
| 同一输入版本的 ContextCompiler 重建 | 0 次 |
| Session live persistence 批量大小 | 受条数和字节双上限约束 |

#### 7.2.3 目标段（基线填完后评审）

阈值相对**本机 §7.2.1 基线**定义，且必须同时记录绝对毫秒值与相对降幅，便于换机复现：

- 普通对话创建 API：p50 与 p95 均需达到设定阈值，并以基线为参照。
- 普通工具附加耗时：以「附加耗时 / 底层命令耗时」的比值作为主指标，避免不同命令混淆。
- 首次点击发送到 Provider 请求发出：**相对基线降低至少 50%**。

### 7.3 观测指标

增加仅开发/测试使用的计数器：

- `runVersionSnapshotBuilds`
- `skillCatalogLoads`
- `mcpCatalogLoads`
- `toolCatalogLoads`
- `projectionHashComputations`
- `contextBuilds`
- `sessionBranchLoads`
- `conversationCreateDurationMs`
- `firstProviderDispatchDurationMs`
- `toolCommandDurationMs`
- `toolFrameworkOverheadMs`
- `toolResultCommitDurationMs`
- `toolSynchronousControlCommits`
- `toolEventLogFsyncs`
- `toolProjectionWrites`
- `toolArtifactReadbacks`
- `sessionLiveQueueDepth`
- `sessionLiveBatchSize`
- `sessionFlushDurationMs`
- `spillAttempts`
- `spillFailures`
- `observerFailures`

> `toolArgValidationErrors` 与 `toolArgRepairHintRate` 随 U1 一并拆出到 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`。

CI 应断言次数上限，不只断言最终耗时，避免机器负载掩盖算法回退。

## 8. 测试计划

### 8.1 构建一致性

1. 清理 `packages/materials/dist` 后运行标准 GUI 启动命令。
2. 修改 Materials 公共接口并启动 GUI。
3. 断言 GUI 解析到的 `ControlStore.prototype.loadProjectionHint` 为函数。
4. 请求 `/api/bootstrap` 和 `/api/runs`，确认 HTTP 200。

### 8.2 创建对话

1. 创建普通对话，断言只出现最小 Run 文件和 Pi session 所需目录。
2. **回归断言（对应表项 E'）**：普通对话创建后不存在 `.proofblade-workspaces/<runId>`；同时创建一次附件验证任务，断言它**仍然**创建该目录。两条断言必须同时存在，否则无法区分「行为正确」与「功能被误删」。
3. 注入 catalog loader 计数器，断言创建阶段为 0。
4. 连续创建 100 个对话，记录 p50/p95（填入 §7.2.1 基线）。
5. 模拟 `gui-workspace.json` 写入失败，验证可恢复重试。

### 8.3 首轮与续轮

1. 首轮按需加载资源并发出 Provider 请求。
2. 第二轮配置不变时复用资源和派生 hash。
3. 修改 `.mcp.json`、Skill 或 tool catalog 后只失效对应缓存。
4. 重启后 `JsonlSessionRepo.open()` 能续接同一 session。

### 8.4 投影和历史读取

覆盖以下矩阵：

- sealed current projection；
- sealed projection + event tail；
- legacy unsealed projection；
- tampered projection body；
- tampered task；
- 缺失 projection；
- 运行时不含 `loadProjectionHint` 的兼容对象。

### 8.5 GUI 轮询

1. 聊天 Tab 仅请求 summary。
2. 调试器首次打开时才读取 sessions。
3. 页面不可见时停止后台详情刷新。
4. SSE 执行中不产生并发全量详情请求。
5. 快速切换 Run 时旧请求不得覆盖新选择。

### 8.6 工具热路径基准

建立不会调用真实 Provider 的 deterministic benchmark，覆盖：

1. `read`：1 B、4 KiB、64 KiB 和 1 MiB 文件。
2. `glob/grep`：空结果、10 条结果和上限结果。
3. `bash`：零输出、短输出、64 KiB 输出、失败和超时。
4. 连续 1,000 次小型工具调用，检查 p50/p95/p99 和内存上限。
5. 100 个并行只读调用，检查 scheduler 与 subscriber barrier。
6. 10,000 条历史事件的长 Run，确保单次普通工具不随历史长度线性变慢。
7. 开启 Windows Defender/索引服务的本机补充测试，定位真实 `fsync` 抖动；CI 只使用次数门禁和宽松耗时门禁。

每个样本必须同时报告：

```text
command_ms
framework_ms
total_ms
control_commits
event_fsyncs
projection_writes
hash_bytes
snapshot_reads
artifact_reads
```

测试失败时应直接指出是哪一个阶段超出预算，不能只输出一个总耗时。

### 8.7 DeepSeek Harness 不变量对照测试

增加以下契约测试：

1. canonical value、model content 和 presentation metadata 分别快照，任一层变化都可定位。
2. render、presentation 和 finalizeContent 测试中注入文件/网络访问即失败，保证其为纯函数。
3. 普通工具结束后模型立即收到结果，Session persistence 人为延迟不增加 tool latency。
4. turn-end/close 前注入 buffered persistence 失败，确认 flush 明确报错且队列未丢失。
5. Spill backend 失败时工具保持成功，并返回受控内联结果。
6. observer 抛错时 `isError`、model content 和 canonical value 不变。
7. 并行工具按完成顺序执行、按模型源顺序提交 `tool/result`。
8. 正式 Evidence 引用之前强制 Control Store barrier，普通自动 Observation 不要求同步 barrier。

> 原第 9、10 条（`bash` 缺失 `description` 的 `BAD_TOOL_ARGS` 反馈、以及 `description` 不影响 command hash）随 U1 一并拆出到 `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`。

## 9. 风险与回滚边界

| 风险 | 控制方式 | 回滚粒度 |
|---|---|---|
| 延迟版本快照导致早期事件缺少版本信息 | 先实现服务级缓存，再单独迁移事件协议 | 仅回滚 deferred snapshot |
| Registry 共享导致连接或关闭生命周期混乱 | definitions 与 live connections 分离 | 回滚 MCP 共享，保留静态 catalog 缓存 |
| revision 缓存漏掉低精度 mtime 变化 | revision 同时包含 size；写操作主动失效 | 单模块退回内容 hash |
| 详情接口拆分导致 UI 状态短暂不一致 | 响应携带 `lastSeq`，前端拒绝旧版本 | 回滚为原 RunDetail 接口 |
| 构建前置增加开发启动时间 | 提供 watcher/`gui:fast`，标准命令保证一致性 | 只回滚命令，不回滚 API 检查 |
| Session write-behind 扩大崩溃窗口 | 普通结果由 Pi Session live log 承担；turn/close/checkpoint 强制 flush；重要结果仍同步 barrier | 回滚 routine write-behind，保留 ToolResultEnvelope |
| Spill 与 Artifact 语义混淆 | Spill 默认不能作为 Evidence；显式 promote 后才注册 Artifact/Evidence | 禁用 Spill policy，不影响 Artifact Store |
| observer 失败被静默吞掉 | 旁路诊断计数和 bounded error log，发布门禁检查失败率 | 恢复原 observer，但仍禁止改变结果 |

## 10. 推荐落地顺序

每个 PR 必须自带对应测试（见 §4.1），否则 `check:changed-tests` 会在改动源文件时失败。PR 边界按「可独立回滚的最小单元」划分。

1. **PR 1：构建一致性（表项 A）**  
   修复 `loadProjectionHint` 报错：`build:gui-deps` + `gui:fast` + 启动断言，**不提供运行时降级**（§5.1.2），不改数据协议。  
   *测试入口*：`apps/gui/tests/` 启动形状测试——断言解析到的 `ControlStore.prototype.loadProjectionHint` 为函数，且 `/api/bootstrap`、`/api/runs` 返回 200。

2. **PR 2：工具热路径计时与基线（表项 T0）**  
   先证明时间消耗在命令、Artifact、ControlStore、Observer、Experiment 还是 subscriber barrier，并建立次数门禁。**本 PR 的产出直接填入 §7.2.1；在它合并前，§7.2.3 的目标段不得评审。**  
   *测试入口*：`packages/materials/tests/` 计时单元 + benchmark script；确认计时本身不写 ControlStore。

3. **PR 3：普通对话轻量创建（表项 C）**  
   创建接口不加载 Skills/MCP/Tool Catalog、不建立 Provider transport；补写入失败恢复。  
   *测试入口*：`apps/gui/tests/` 创建链路测试 + §8.2 第 3–5 条。

4. **PR 4：普通对话 staging 回归断言（表项 E'）**  
   纯测试，无源码改动。锁住 §2.2 的既有正确行为。可与 PR 3 合并。  
   *测试入口*：§8.2 第 2 条双向断言。

5. **PR 5：ToolResultEnvelope 与纯展示层（表项 D0）**  
   分离 canonical/model/presentation/durable，保证 finalize 和 observer 不做阻塞 I/O。  
   *测试入口*：§8.7 第 1–2 条（注入 I/O 即失败）。

6. **PR 6：Session live buffer 与普通工具最多一次同步写（表项 D1 + T1 + T3）**  
   让成功的小型 read/glob/grep/bash 先返回模型，在 turn/close/checkpoint 做明确 flush；ExperimentGate 限定适用范围。  
   *测试入口*：§8.7 第 3–4 条 + commit 计数测试。

7. **PR 7：ToolResultCommit 批量持久化（表项 T2）**  
   合并 Artifact、Observation、Evidence、Experiment 和 telemetry，重要结果最多一次同步提交。  
   *测试入口*：事务合并测试 + §8.7 第 8 条。

8. **PR 8：去重复 hash 与 Artifact 回读（表项 T4 + D3）**  
   *测试入口*：hash 次数测试 + §8.7 第 6 条。

9. **PR 9：SpillStore 与大输出策略（表项 D2）**  
   分离大输出传输和长期 Artifact/Evidence，存储失败不推翻工具成功语义。  
   *测试入口*：§8.7 第 5 条。

10. **PR 10：缓存 RunVersionSnapshot 和静态 catalogs（表项 D + F）**  
    保持 eager snapshot 语义，消除每个 Run 重复扫描；revision 按 §5.4.1 使用内容哈希。  
    *测试入口*：缓存命中测试 + §8.3 第 3 条（改 `.mcp.json` 只失效对应缓存）。

11. **PR 11：Coding Lane 上下文热路径去重（表项 G）**  
    使用 revision 缓存 context、queue 和 prompt 派生值。  
    *测试入口*：复用测试 + §8.3 第 2 条。

12. **PR 12：GUI 详情接口拆分与增量轮询（表项 H + I）**  
    聊天、调试器、telemetry 和 artifact 分开加载。  
    *测试入口*：§8.5 第 1–5 条。

13. **PR 13：基准与预算门禁（表项 J）**  
    把 PR 2 的基准固化为 CI 门禁。  
    *测试入口*：CI 次数断言 + 报告输出。

14. **（条件触发）评估是否需要 deferred version snapshot**  
    只有前述优化仍不能达到 §7.2.3 目标时才调整事件协议。不默认实施。

## 11. 完成定义

本计划完成不是以“减少了若干 hash 调用”为标准，而是同时满足：

- 运行时不再出现源码/`dist` API 错配；错配在启动时立即失败，**不依赖运行时降级掩盖**。
- 普通对话创建不执行安全任务级初始化。
- 几毫秒的普通工具不再被 ProofBlade 附加链路放大到秒级。
- 普通工具返回前没有同步 ControlStore commit、`fsync` 或 projection rewrite。
- 重要工具结果的派生记录在一个批量事务中完成。
- Tool canonical value、模型内容、GUI metadata 和 durable refs 已明确解耦。
- Session live buffer 在 turn/close/checkpoint 具备可测试的 flush barrier。
- Spill/Telemetry/observer 故障不再改变普通工具的成功语义。
- 普通对话的工作目录与 session 生命周期由既有上游 Pi 路径负责，且**该行为已有回归测试锁定**（表项 E'）。
- 保留所有跨信任边界的完整性与 verifier 哈希。
- GUI 聊天视图不再周期性加载调试器全量数据。
- §7.2.1 基线已实测填入，§7.2.3 目标已据基线评审通过。
- 基准测试证明创建和首轮指令延迟达到目标，并能在 CI 中防回退。
- 每个改动源文件都有 §4.1 对应的测试文件。

## 12. DeepSeek Harness 参考依据

本计划参考以下本地材料与实装：

- `docs/deepseek-harness-reference.md`：Tool 三层输出、Session 事实源、SpillStore、旁路 Telemetry、双持久化域边界。
- `docs/deepseek-harness-plugin-feasibility.md`：采用 A+B、不采用 Cordis 深度插件化，以及固定工具面约束。
- `docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`：U1 拆分出的调用级 `description` 契约变更（不在本计划范围）。
- 本机 `C:/Users/19678/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` `0.1.5-rc.2`：规范输出、纯 render、finalize、observer-only result event 和并发声明。
- 本机 `dsh-agent-loop` `0.1.5-rc.2`：工具执行与按模型顺序提交 `tool/call` / `tool/result`。
- 本机 `dsh-session-persistence-jsonl` `0.1.5-rc.2`：bounded live buffer、批量 drain、显式 flush/close barrier。
- 本机 `dsh-spill` / `dsh-spill-policy` `0.1.5-rc.2`：大输出外置、受控预览、opaque locator 和 fail-soft 语义。
- 本机 `dsh-session-telemetry` `0.1.5-rc.2`：Telemetry 作为可替换旁路能力。

参考结论是吸收协议与不变量，不复制 DSH 的包边界或插件树。ProofBlade 的 verifier、Effect、Artifact、Evidence 和 Control Store 权威性继续保留。

## 13. 现状认定的核对方式

本文 §2 的「已确认现状」不是推演，均可按下列路径复核。评审修订 1 修正的正是其中一条未核对的论断。

| 论断 | 核对方式 |
|---|---|
| §2.1 构建产物错配 | 比对 `packages/materials/dist/index.js` 与 `src/control/control-store.ts` 的 mtime；在前者中搜索 `loadProjectionHint`（应无匹配），在后者中应命中 `control-store.ts:323` |
| §2.2 普通对话工作目录 | 读 `debug-data.ts:464` `createConversation()` → `:820` `codingConversationTask()`（`target`/`allowed_workspace` = root、`inputs: []`）；读 `single-agent-loop.ts:590` `taskExecutionWorkspace()`；确认 `stageTaskWorkspace()` 唯一调用点是 `debug-data.ts:410` `startTask()` |
| §2.5 GUI 轮询范围 | 读 `App.tsx` 轮询入口与 `debug-data.ts` 的 RunDetail 组装 |
| §2.6 工具热路径 | 读 `coding-resources.ts` 工具包装与 `ExperimentGate.record()` 的 `persistProjection` 实参 |

**流程要求**：后续任何新增的「现状」论断，都必须给出一条可在 5 分钟内执行的核对命令。§2.2 的教训是——一条未经核对的现状判断，会让整个条目连带其验收条件、测试计划和 PR 一起变成无效工作。

