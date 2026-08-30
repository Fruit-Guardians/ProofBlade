# PentAGI 对 ProofBlade 的架构借鉴与开发建议

## 1. 文档目的与调研基线

本文分析 [PentAGI](https://github.com/vxcontrol/pentagi) 对 ProofBlade 后续开发的可借鉴之处，并给出可以直接进入工程计划的模块设计、实施顺序和验收标准。

调研基线：

- PentAGI：`ea665308baaff015b226f308438a68d929d0f29b`，2026-08-06。
- ProofBlade：当前工作区架构、Competition Fleet、Control Store、Evidence Graph、Pi Session、Capability/MCP、Background Job、Docker 方案及 GUI。
- 结论针对 ProofBlade 的证据驱动 CTF Agent 定位，不以复制 PentAGI 的 Go/PostgreSQL/微服务栈为目标。

## 2. 核心结论

PentAGI 最值得 ProofBlade 学习的不是“使用更多 Agent”，而是以下五个系统设计：

1. **Flow、Task、Subtask、Action、Artifact、Memory 形成统一工作分解和追踪模型。**
2. **专家 Agent 通过明确的委派契约协作，而不是共享一段无限增长的聊天记录。**
3. **任务、容器、工具调用、长期记忆和报告都带同一组关联 ID，运维与审计可以从任意层回溯。**
4. **LLM 链路与系统链路分开观测：Langfuse 看模型，OpenTelemetry/Grafana 看服务和资源。**
5. **运行时资源必须成为持久、可查询、可取消、可恢复的状态，不能只是进程内队列或 Docker 侧状态。**

ProofBlade 已经在确定性事件、效果日志、独立验证、证据图、上下文恢复和固定 Tool Surface 上强于 PentAGI。因此正确方向是：

> 保留 ProofBlade 的 Control Store 和验证器作为唯一事实来源，把 PentAGI 的任务分解、专家协作、长期经验检索、容器资产视图和运营观测吸收到现有事件模型中。

不建议把 ProofBlade 改造成 PentAGI 式大型微服务，也不建议让多个 Agent 直接并发修改同一个 Run。

## 3. 两个项目的能力映射

| PentAGI 概念 | ProofBlade 当前对应物 | 差距 | 建议 |
| --- | --- | --- | --- |
| Flow | Run / Competition challenge | Run 更偏单题执行，缺少显式的工作分解树 | 在 Run 内增加 Work Graph，不再新建第三套顶层状态 |
| Task / Subtask | TaskContract / Intent / Handoff | Intent 粒度较弱，缺少状态、依赖和负责角色 | 增加持久 WorkItem 与依赖边 |
| Specialist agents | Planner / Solver / Coding Lane | 已有通道，但专家角色不完整 | 先实现有界专家委派，不做自由 Agent 群聊 |
| Toolcall / termlog / searchlog | Pi Tool event / Effect / Artifact | ProofBlade 已有统一审计，但查询入口分散 | 增加统一 Action Projection 与筛选 API |
| Vector memory | Evidence search / history search | 当前主要是 Run 内精确检索 | 增加跨 Run 的成功经验索引，证据仍保留原始引用 |
| Graphiti | Reasoning Forest | ProofBlade 已有显式支持/反驳边 | 先增强跨 Run 引用，不急于引入 Neo4j/Graphiti |
| Kali container record | Docker Runtime 设计 | 容器管理尚未完整落入当前主线 | 引入持久 RuntimeResource 和 ContainerManager |
| Flow queue | FleetScheduler | Fleet 当前状态主要在内存 | 把挑战队列、claim 和 promotion 写入持久事件 |
| Langfuse + OTEL | RunTelemetry / GUI debug | 已有 Run 观测，缺少标准导出和跨 Run 运维视图 | 增加 OTLP 导出，保留本地事件为权威源 |
| Report | Completion / Artifact / Evidence | 有验证结果但缺少面向人的完整报告流水线 | 增加验证绑定的 Report Bundle |
| REST + GraphQL | GUI HTTP/SSE / CLI | 本地使用足够，远程自动化不足 | 先做稳定 REST 和事件流，不必同时引入 GraphQL |

## 4. 建议一：在 Run 内增加持久 Work Graph

### 4.1 为什么值得做

PentAGI 的 Flow -> Task -> Subtask 模型使长任务具备可见的分解、状态和负责人。ProofBlade 当前的 TaskContract 很强，但后续行动主要分散在 Intent、Planner Handoff、消息和 Tool 调用中。模型陷入循环时，操作者很难快速回答：

- 当前具体在做哪一个子目标？
- 哪些子目标已经完成、失败或被证据否定？
- 哪个子目标依赖哪条事实？
- 哪些动作可以并行，哪些必须等待？
- 本轮 guard 触发后应该重新规划哪个节点？

### 4.2 建议的数据结构

在 `packages/materials/src/domain/` 增加通用工作项，不复制一套 PentAGI 数据库模型：

```ts
export type WorkItemStatus =
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "SUPERSEDED";

export interface WorkItem {
  id: string;
  runId: string;
  parentId?: string;
  title: string;
  objective: string;
  role: "planner" | "researcher" | "coder" | "executor" | "verifier";
  status: WorkItemStatus;
  dependsOn: string[];
  evidenceIds: string[];
  artifactIds: string[];
  attempt: number;
  maxAttempts: number;
  budget?: { turns?: number; toolCalls?: number; costUsd?: number; deadlineAt?: number };
  createdSeq: number;
  updatedSeq: number;
}
```

对应事件建议为：

```text
work_item_created
work_item_ready
work_item_claimed
work_item_blocked
work_item_completed
work_item_failed
work_item_cancelled
work_item_superseded
work_dependency_added
work_evidence_attached
```

所有状态由 reducer 投影，不能由某个 Agent 的内存对象直接修改。WorkItem 的完成不等于 Run 完成；Run 仍只能由现有独立验证器判定。

### 4.3 与现有 Handoff 的关系

`HandoffRecord` 应变成 Work Graph 的只读执行快照：

- Planner 根据 Snapshot 和 Evidence Forest 产生或调整 WorkItem。
- Executor 每轮只 claim 一个 READY WorkItem。
- Handoff 包含该 WorkItem、直接依赖、证据摘要、禁止重复动作和剩余预算。
- 新证据导致计划变化时，旧 WorkItem 标为 `SUPERSEDED`，而不是覆盖历史。

### 4.4 验收标准

- 重放事件后 Work Graph hash 完全一致。
- 依赖有环、父节点缺失、终态回退必须被 reducer 拒绝。
- 任一 RUNNING WorkItem 均有 lease、role 和预算。
- GUI 可按状态、角色、父节点展示工作树和阻塞原因。
- guard 触发后能够精确标记当前 WorkItem 为 BLOCKED，并创建替代节点，而不是只发一段 replan prompt。

## 5. 建议二：实现有界专家委派，而不是自由多 Agent

### 5.1 可借鉴部分

PentAGI 的 researcher、coder、installer、pentester、memorist、adviser 等角色能把搜索、编程、环境维护和执行分开。ProofBlade 可以借鉴角色边界，但必须保留以下约束：

- 只有 coordinator 可以改变 Work Graph。
- 专家只返回结构化 `SpecialistResult`，不能直接宣告任务成功。
- 有副作用的 Tool 仍经 Effect Journal、Capability Router 或受控 Coding Runtime。
- 同一资源键上的副作用保持串行。
- 专家输出必须引用 Artifact/Evidence，纯文本结论不能提升为事实。

### 5.2 首批角色

建议只增加三个角色：

| 角色 | 输入 | 可用能力 | 输出 |
| --- | --- | --- | --- |
| Researcher | WorkItem、已有事实、目标元数据 | read、search、browser/MCP、只读 capability | 候选事实、资料 Artifact、下一步建议 |
| Coder | WorkItem、接口约束、已有脚本 | read/edit/write、有限 bash、代码 Skill | Patch Artifact、运行说明、测试结果 |
| Critic | 当前计划、失败窗口、Evidence Forest | evidence/history/inspect，只读 | 反例、缺失证据、替代假设、风险评分 |

Executor 和 Verifier 已经存在，无需重新命名或复制。

### 5.3 委派契约

```ts
export interface SpecialistAssignment {
  assignmentId: string;
  workItemId: string;
  role: "researcher" | "coder" | "critic";
  objective: string;
  allowedToolNames: string[];
  allowedArtifactIds: string[];
  budget: { maxTurns: number; maxToolCalls: number; deadlineAt: number };
  expectedOutputSchema: string;
}

export interface SpecialistResult {
  assignmentId: string;
  status: "COMPLETED" | "BLOCKED" | "FAILED";
  summary: string;
  artifactIds: string[];
  evidenceIds: string[];
  proposedWorkItems: Array<{ title: string; objective: string; role: string }>;
  unresolvedQuestions: string[];
}
```

建议通过固定 `delegate_specialist` Tool 复用当前稳定 Tool Surface，而不是把所有专家工具暴露到顶层。每个委派创建独立 Pi Session 分支，但 Control Store 事件仍写入父 Run，并携带 `workItemId`、`assignmentId` 和 `role`。

### 5.4 并发原则

首版仅允许只读专家并发。Coder/Executor 等会修改工作区的角色必须满足以下之一：

- 独立 worktree/目录，最终由 coordinator 合并；
- 获得 workspace resource lease；
- 针对互不相交的明确文件集合。

每个 Run 默认最多 2 个专家，整个 Fleet 还要受 ProviderScheduler 和容器配额约束。不能把模型并发上限直接等同于 Agent 并发上限。

### 5.5 不建议照搬的部分

- 不让主 Agent 自由反复调用专家直至成功。
- 不把不同角色全部变成长期驻留进程。
- 不让“adviser 建议”覆盖 reducer 状态或验证器结论。
- 不为每种专家创建不同顶层 Tool Schema，避免缓存前缀持续变化。

## 6. 建议三：增加跨 Run 的经验库，但保持证据可追溯

### 6.1 PentAGI 的启发

PentAGI 把 Tool 结果切片后写入 pgvector，并按 flow/task/subtask/tool 元数据检索，还可选用 Graphiti 保存时序关系。这个方向有助于减少重复试错，但直接把所有 Tool 输出向量化会带来噪声、敏感信息传播和陈旧经验误导。

### 6.2 ProofBlade 应采用的三层记忆

```text
Run Memory       当前 Run 的 Control Store + Evidence Graph（权威）
Experience Index 跨 Run 的已验证经验索引（可检索、非权威）
Domain Library   人工维护的 Skill/Guide/Capability 文档（版本化）
```

只有满足以下条件的内容才能进入 Experience Index：

- 对应 WorkItem 已终结；
- 引用至少一个 Artifact 或 Evidence；
- 结果经过 verifier，或明确标记为失败经验；
- 敏感字段已按 Artifact sensitivity 策略处理；
- 记录来源版本、target kind、tool contract hash 和 image digest。

建议条目：

```ts
export interface ExperienceRecord {
  id: string;
  sourceRunId: string;
  sourceWorkItemId: string;
  outcome: "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "REJECTED_APPROACH";
  targetKind: string;
  summary: string;
  techniqueTags: string[];
  toolNames: string[];
  evidenceIds: string[];
  artifactHashes: string[];
  environmentFingerprint: string;
  compatibility: { toolContractHash: string; imageDigest?: string };
  createdAt: string;
}
```

### 6.3 检索策略

首版不必立即部署 pgvector/Neo4j。按以下顺序演进：

1. SQLite FTS5 或现有 JSON 索引：关键词、标签、target kind、tool name 精确过滤。
2. 可选 embedding adapter：只对摘要做向量索引，原始内容仍在 Artifact Store。
3. 在真实评测证明收益后，再考虑图数据库或 Graphiti adapter。

检索必须先过滤兼容性和作用域，再做排序；返回内容必须带 source Run、Evidence 和环境指纹。模型只能把经验作为候选假设，不能直接当成当前题目的 confirmed fact。

### 6.4 评测门槛

- 对六个 Fixture 建立重复解题组，比较首次证据时间、有效 Tool 比例和成本。
- 经验检索不得降低 verifier 成功率。
- 过期环境经验必须被兼容性过滤命中测试覆盖。
- 敏感 Artifact 文本不得进入 embedding 请求或普通日志。

## 7. 建议四：把 Fleet 和容器改造成持久运行控制面

### 7.1 Fleet 持久化

PentAGI 的 Flow Queue RFC 提出的原则很适合 ProofBlade：队列必须持久、可见、可取消、可重排，不能只是内存状态。

当前 `FleetScheduler` 适合单进程比赛运行，但 challenge 状态、优先级和 worker claim 主要驻留在内存。建议增加 Fleet Store：

```text
fleet_created
challenge_queued
challenge_priority_changed
challenge_claimed
challenge_started
challenge_waiting
challenge_terminal
challenge_cancelled
worker_heartbeat
worker_released
```

Promotion 必须通过原子 claim 完成，并带 `workerId`、`leaseId`、`leaseExpiresAt`。重启后只恢复 QUEUED 和 lease 已过期的 RUNNING 项，不重复领取仍有有效 lease 的题目。

### 7.2 容器资产模型

PentAGI 将 container 作为可查询实体暴露给 API/UI。ProofBlade 应在现有容器建议基础上新增 `RuntimeResourceRecord`：

```ts
export interface RuntimeResourceRecord {
  id: string;
  runId: string;
  workItemId?: string;
  kind: "solver" | "gateway" | "network" | "volume";
  externalId: string;
  generation: number;
  state: "CREATING" | "READY" | "RUNNING" | "STOPPING" | "STOPPED" | "ORPHANED" | "FAILED";
  ownerLeaseId: string;
  imageDigest?: string;
  createdAt: number;
  lastHeartbeatAt?: number;
  expiresAt?: number;
}
```

由 host-side `ContainerManager` 负责 doctor、create、reconcile、destroy 和 reap；Docker label 只是交叉校验，Control Store/Fleet Store 才是权威状态。

### 7.3 容量调度

Fleet 的并发配置应从单一数字升级为资源预算：

```json
{
  "fleet": {
    "maxConcurrentChallenges": 8,
    "maxConcurrentContainers": 12,
    "maxConcurrentProviderTurns": 5,
    "profiles": {
      "web": { "weight": 1 },
      "pwn": { "weight": 2 },
      "pwn-kernel": { "weight": 4 }
    }
  }
}
```

Scheduler 只有在 Provider、container 和 profile weight 三个预算均可用时才能 promotion。等待资源的 challenge 保持 `QUEUED`，不要先启动平台环境再长时间占用。

### 7.4 自启动原则

- 常驻的是 ProofBlade manager，不是五个题目容器。
- 题目容器使用 `restart=no`，进程启动时由 manager 对照 lease、generation 和平台状态决定恢复或回收。
- queued challenge 不分配容器。
- manager 进入 degraded 状态时仍允许离线 reverse/crypto，拒绝需要 Docker 的新题。

## 8. 建议五：建立双通道可观测性

### 8.1 保留现有权威链

ProofBlade 的 Control Store、Pi Session、Effect Journal、Artifact/Evidence 比外部 APM 更适合作为审计和恢复来源，不能被 Langfuse 或 OTEL 替代。

### 8.2 新增 OTLP 导出

借鉴 PentAGI 的系统观测栈，为以下对象生成 trace/span：

```text
fleet.run
challenge.solve
work_item.execute
specialist.assignment
provider.request
tool.call
effect.execute
container.create
container.exec
verification.run
report.build
```

统一 attributes：

```text
proofblade.run_id
proofblade.fleet_id
proofblade.challenge_id
proofblade.work_item_id
proofblade.assignment_id
proofblade.tool_name
proofblade.effect_id
proofblade.container_profile
proofblade.generation
proofblade.provider
proofblade.model
```

默认只导出 ID、状态、计数、时长、哈希和错误分类；prompt、Tool arguments、flag、API key、目标响应正文不进入 OTLP。

### 8.3 GUI 运营视图

在现有单 Run 调试之外增加：

- Fleet 看板：queued/running/waiting/solved/failed、分值和并发槽。
- Work Graph：任务树、依赖、角色、证据数、预算和阻塞原因。
- Runtime 资产：容器/网络/镜像 digest、generation、heartbeat 和 orphan 状态。
- Provider 池：排队、并发、429、缓存命中、成本和 p95 延迟。
- Convergence：guard 次数、replan 后成功率、重复工具族和无进展窗口。

## 9. 建议六：生成可验证的报告包

PentAGI 的面向用户报告能力很成熟，而 ProofBlade 的优势是证据和验证结构更严格。建议新增 Report Builder，将两者结合。

报告结构：

1. 任务范围、目标、模式和环境指纹。
2. 最终状态与 verifier 结论。
3. Work Graph 执行摘要。
4. 已确认事实、被拒绝假设和关键证据。
5. Tool/Effect 时间线及关键 Artifact。
6. 复现步骤、限制和未解决问题。
7. 成本、Token、缓存、耗时和容器资源统计。
8. 完整性清单。

首版输出 Markdown + `manifest.json`：

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "snapshotHash": "sha256:...",
  "eventLogHash": "sha256:...",
  "reportHash": "sha256:...",
  "artifacts": [{ "id": "A-1", "sha256": "...", "bytes": 1234 }],
  "evidence": [{ "id": "E-1", "artifactIds": ["A-1"] }],
  "verification": { "status": "SUCCEEDED", "attempts": 1 }
}
```

第二阶段再增加 Ed25519 签名和 `proofblade report verify <bundle>`。签名是完整性证明，不改变 verifier 的业务权威。

## 10. 建议七：补齐面向自动化的控制 API

PentAGI 的 REST/GraphQL/API Token 适合平台集成。ProofBlade 建议先稳定 REST，不同时维护 GraphQL：

```text
POST   /api/v1/fleets
GET    /api/v1/fleets/:id
POST   /api/v1/fleets/:id/challenges/:id/cancel
PATCH  /api/v1/fleets/:id/challenges/:id
GET    /api/v1/runs/:id/work-items
GET    /api/v1/runs/:id/evidence
GET    /api/v1/runs/:id/resources
POST   /api/v1/runs/:id/pause
POST   /api/v1/runs/:id/resume
GET    /api/v1/runs/:id/report
GET    /api/v1/events?after=<cursor>
```

要求：

- Mutation 必须带 idempotency key。
- 每次控制操作写入 actor、reason、request id 和事件序号。
- API Token 只保存 hash，支持 scope、过期和撤销。
- SSE 使用持久 cursor，断线续传不依赖进程内 buffer。
- 完成 webhook 在后续阶段实现 at-least-once、稳定 delivery id、HMAC 签名和持久重试记录。

## 11. 不建议照搬 PentAGI 的部分

### 11.1 不立刻微服务化

ProofBlade 当前单机 JSONL + 原子投影对确定性重放很有价值。为了“像 PentAGI”而同时引入 PostgreSQL、Redis、ClickHouse、Neo4j、MinIO、Loki、Jaeger 会显著扩大部署和故障面。先通过 repository/adapter 接口保留未来替换空间。

### 11.2 不默认保存所有 Tool 输出到向量库

Tool 输出噪声大、可能含凭据和目标敏感数据。只有经过 Evidence/Artifact 筛选和脱敏的摘要才能进入跨 Run 索引。

### 11.3 不用多 Agent 代替验证

多个 Agent 一致不等于事实。完成判定仍由平台或 Independent Verifier 决定。

### 11.4 不给 Agent Docker Socket

PentAGI 提供 Docker worker 方案，但 ProofBlade 应继续由 host runtime 创建题目容器。模型只获得容器内受限执行环境，不获得 Docker daemon 控制权。

### 11.5 不让长期记忆成为隐式提示注入

检索结果必须进入 `<untrusted-experience>` 边界，带来源、时间、环境和验证状态。Planner 可以采用，Executor 不能把它直接提升为 confirmed fact。

## 12. 推荐实施路线

### Phase 0：契约与基线（1 个迭代）

交付：

- WorkItem、SpecialistAssignment、RuntimeResource、ExperienceRecord ADR。
- 当前 Fleet、Container、Evidence、Telemetry 的基线指标。
- 事件兼容策略和 schemaVersion 升级规则。

验收：所有新设计都能映射到现有 Control Store，且不产生第三套任务真相。

### Phase 1：持久 Work Graph（2 个迭代）

交付：

- domain types、commands、reducer、snapshot projection。
- Handoff 与 WorkItem 集成。
- CLI/GUI 工作树视图。
- cycle、lease、replay、terminal-state 测试。

价值：先获得可见、可恢复的任务分解，再谈多 Agent。

### Phase 2：Fleet Store 与 ContainerManager（2-3 个迭代）

交付：

- 持久 challenge queue、原子 claim、worker heartbeat。
- RuntimeResource events、doctor/reconcile/reap。
- 容量预算和 degraded mode。
- `containers doctor|list|reconcile|stop|reap` CLI。

价值：解决比赛长时间运行、进程重启和 Docker 资源泄漏。

### Phase 3：有界专家委派（2 个迭代）

交付：

- 固定 `delegate_specialist` Tool。
- Researcher、Coder、Critic 三角色。
- 独立 Session 分支、assignment budget、结果 schema。
- workspace lease/worktree 隔离。

上线门槛：在固定 Fixture 集上成功率不下降，成本增幅有上限，至少一个类别的首次证据时间明显改善。

### Phase 4：经验索引与报告包（2 个迭代）

交付：

- SQLite FTS 经验索引和兼容性过滤。
- verified success/failure 自动提炼。
- Markdown + manifest 报告和离线 hash verifier。

后续根据评测决定是否增加 embeddings 和 Ed25519。

### Phase 5：OTLP 与远程控制（2 个迭代）

交付：

- OTLP exporter、Fleet/Runtime dashboard。
- 稳定 REST、API Token、持久 SSE cursor。
- 可选完成 webhook。

## 13. 优先级建议

| 优先级 | 项目 | 原因 |
| --- | --- | --- |
| P0 | 持久 Work Graph | 是专家协作、可视化和恢复的共同前提 |
| P0 | Fleet/Container 持久控制面 | 直接影响线上比赛稳定性和资源安全 |
| P1 | Report Bundle | 能把现有 Evidence/Verifier 优势转化为可交付结果 |
| P1 | 有界 Researcher/Critic | 对减少错误路线最有价值，副作用风险较低 |
| P1 | OTLP 导出 | 提升长时间运行的定位效率，不改变权威状态 |
| P2 | 跨 Run Experience Index | 有潜力，但必须先有稳定来源和评测门槛 |
| P2 | Coder 并发委派 | 需要 workspace 隔离和合并语义 |
| P3 | Neo4j/Graphiti | 当前 Evidence Forest 足够，先证明图检索的增量价值 |
| P3 | GraphQL/大型微服务栈 | 当前不是核心瓶颈，维护成本高 |

## 14. 必须增加的测试矩阵

| 领域 | 必测场景 |
| --- | --- |
| Work Graph | 环依赖、重复 claim、lease 过期、父节点取消、旧计划 supersede、确定性重放 |
| Specialist | 超预算、Provider 失败、结果 schema 错误、引用未知 Artifact、并发写冲突 |
| Fleet | 重启恢复、优先级更新、取消 queued/running、worker 崩溃、claim 竞争、容量变化 |
| Container | create 每个故障点、成对回滚、daemon 重启、orphan 回收、generation fencing、磁盘不足 |
| Experience | 来源删除、环境不兼容、敏感数据、重复条目、错误经验降权、无 embedding fallback |
| Observability | exporter 不可用、背压、脱敏、trace 关联、导出失败不影响 Control Store |
| Report | Artifact 篡改、缺失 Evidence、Snapshot hash 不一致、失败 Run、部分报告恢复 |
| API | 幂等重试、Token scope、SSE 断线续传、并发 mutation、webhook 重复投递 |

## 15. 建议的首个开发切片

第一个 PR 不应直接实现多 Agent。建议只完成以下纵向切片：

1. 新增 `WorkItem` 类型和 8 个生命周期事件。
2. Reducer 投影 `snapshot.workItems`，实现依赖校验和 lease fencing。
3. Planner Handoff 绑定一个 READY WorkItem。
4. Competition Loop 在进入一轮时 claim WorkItem，guard 时 BLOCKED，成功时 COMPLETED。
5. CLI 增加 `proofblade work <run-id>`。
6. GUI 在 Run 详情增加无编辑能力的 Work Graph 列表。
7. 添加 replay、crash recovery、guard replan 和 verifier authority contract tests。

这个切片不会改变 Provider Tool Surface，不引入新服务，也不改变最终完成语义，但会为后续专家委派、Fleet 恢复和报告提供统一骨架。

## 16. 最终建议

ProofBlade 应借鉴 PentAGI 的“产品化运行控制面”，而不是复制它的技术栈：

- 用 Work Graph 提升长任务的可解释性和可恢复性；
- 用有界专家委派提升探索质量，但保持单一 coordinator 和验证器权威；
- 用持久 Fleet/Container 状态支撑比赛规模化运行；
- 用 Experience Index 复用已经验证的经验，而不是复用未经筛选的聊天内容；
- 用 OTLP 和 Report Bundle 把现有事件、证据和验证能力转化为可运营、可交付、可审计的系统。

实施顺序必须是“状态模型 -> 恢复与资源 -> 专家协作 -> 经验与报告 -> 标准观测/API”。如果先堆 Agent 数量，ProofBlade 会增加成本和并发故障，却得不到 PentAGI 真正有价值的生命周期可见性。
