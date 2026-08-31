# ProofBlade 功能消融总目录与执行计划

状态：进行中。本文是功能清单、消融顺序、行为分析和修复闭环的单一入口。它补充 `FUNCTION_ABLATION_PROGRAM_ZH.md` 的因素矩阵，并把已经实现但不能作为普通认知消融开关的控制平面功能单独列出。

## 1. 评测对象与原则

评测对象是“固定模型/Provider + 固定语料 + 固定 Verifier + 固定安全边界 + 一个 Harness 功能变量”。每次实验只改变一个主因素；模型、思考等级、采样、预算、截止时间、工具 scope、答案防泄漏和 fixture 快照必须保持不变。`hard_gate`、`hard_stop` 只作为明确标记的反事实，不是默认运行方式。

Harness 的职责是给模型提供眼睛（目标相关观察）、纸笔（Artifact/Evidence/事件）、记忆（有出处的检索和恢复）和手（受 scope、journal、审批约束的动作）。首步建议、阶段路线、证据整理和停止提示默认只能建议或记录，不能把合法调查路径变成锁链。硬边界拒绝时必须返回四件事：触发原因、未执行的动作、已保留的状态、下一步或所需授权。

## 2. 当前基线证据

最近一次 provider-free 基线：`EVAL-CONTINUE-20260901`，协议 `baseline-v4`，报告哈希 `283f0bd4e8c16e45dcdd8b06b8f9474e3d0a782e3a0b4cdab86849599694a57`。

| 项目 | 结果 | 解释 |
| --- | ---: | --- |
| Fixture | 18/18 | 六个 Web/Reverse fixture，各 3 次；均到 `SUCCEEDED/report` |
| Runtime scenario | 19/19 | 覆盖 cache、context、convergence、evidence、durability、events、recovery |
| 总门槛 | 37/37 | gate 通过 |
| Provider 请求 / Token / 费用 | 0 / 0 / 0 | 这是控制平面基线，不测模型推理 |
| Evidence / Replay parity | 18/18 / 18/18 | 每个 Fixture 均有证据绑定和重放一致性 |
| 候选泄漏 | 0 | 题目答案未进入事件日志 |
| Fact-Evidence coverage | 1.0 | 已确认事实都有当前证据来源 |

这次运行证明 Harness 的持久化、验证、事件和恢复契约可重复执行；它不能推出任何模型的解题成功率，也不能说明某个建议策略优于另一策略。所有真实 Provider 结果必须再按首错和 Provider telemetry 分层。

## 3. 功能全目录与消融映射

下表覆盖仓库组件、主要实现面、可测变量和验收信号。实现路径是定位入口，不是限制模型只能调用这些路径。

| 功能域 | 当前实现与组件 | 消融批次 | 变量与对照 | 主要指标 | 失败时先查什么 |
| --- | --- | --- | --- | --- | --- |
| 原子与依赖漏斗 | `packages/atoms`、`packages/molecules`、TypeScript project references | C0 | 保持启用；做构建/契约回归 | 独立构建、哈希稳定、依赖方向 | 类型/序列化和依赖边界，不归因模型 |
| JSONL Control Store 与 Reducer | `storage/jsonl-store.ts`、`control/reducer.ts` | C1 | 正常、重启、事件重放 | projection hash、单写者序列、崩溃恢复 | 事件顺序、幂等键、投影替换 |
| Run/Phase/WorkItem | `orchestration/run-coordinator.ts`、domain 状态机 | F09 | 正常完成、暂停、取消、恢复 | phase gap、终态一致性、完成提案时延 | coordinator/recovery，而非提示策略 |
| Effect Journal | `effects`、`tools/runtime.ts` | C2 | pure/idempotent/resumable/manual replay | PROPOSED/STARTED/FINISHED、no-effect proof | replay policy、重复副作用、generation |
| Scope、Lease、Generation | `runtime/scope.ts`、`control/lease-manager.ts`、fixture generation | C3 | 所有权竞争、过期、重启 | child-first/LIFO、fencing、release 幂等 | 资源身份与代次，不把拒绝当模型失败 |
| 总预算、deadline、取消 | `evaluation/provider-budget`、request epoch、abort | F13/C4 | 正常、请求前拒绝、在途超时、Provider error | 请求数、预留/结算、错误分类、未发请求证明 | Provider transport、预算预留、终态分类 |
| 基础观察工具 | `capabilities/binary.ts`、read/glob/grep/inspect | F01 | direct observation 对 no-advice | 首个目标事实、重复读取、有效动作比 | 输出是否到达模型、schema/截断 |
| Capability Router | `capabilities/backend.ts`、`tools/runtime.ts` | F03 | 一等工具对 generic proxy | 首次正确参数、发现回合、backend 选择 | 路由、参数契约、scope/effect |
| Binary/Reverse 眼睛 | `capabilities/objdump.ts`、`reverse.ts`、`binary_disassemble` | F02 | IDALIB、objdump、Rizin；direct handle 对 generic proxy | 代码 observation、候选到 verifier 路径 | 后端依赖、工具选择、Provider，不用配额压制 |
| MCP stdio 与错误投影 | `mcp/registry.ts`、`mcp_call`、IDALIB/JADX | F03/F12 | list/describe/call、依赖拒绝恢复 | schema 到达、错误可读性、替代工具采纳 | `isError`、Qt/PySide、启用集合；拒绝必须含 Reason/Next |
| Skill Registry | `skills/registry.ts`、`load_skill` | F03 | metadata 常驻、正文按需加载 | 发现回合、加载后采纳、token 成本 | enabled set、正文截断、哈希 |
| Evidence Artifact 图 | `knowledge/evidence-graph.ts`、Artifact store | F04 | `manual` 对 `advice` 对 `draft` | Evidence 引用候选比例、错误 ID、验证时延 | 是否已有 verifier-ready candidate、schema 循环 |
| Evidence Curation Gate | `knowledge/evidence-curation-gate.ts` | F04/C5 | notice/checkpoint/advice；不阻塞合法探索 | backlog、整理动作、有效路径是否被延迟 | 若拒绝调查，先修控制平面；不要把整理硬门禁当成功因 |
| Recall 与 Knowledge | `context/compiler.ts`、`knowledge` 查询、`history` | F05 | `manual`、`advice`、`automatic` | Recall 命中/采纳、重复读取、事实保持 | 引用是否可见、索引命中、模型未采纳 |
| 上下文选择与压缩 | `context/compiler.ts`、maintenance、checkpoint | F05 | fixed_recent、receipt、deterministic broker；compression off/summary/query-aware | 上下文 token、关键事实保持、resume parity | 丢失来源、tool pair、prefix 漂移 |
| Cache Prefix 与 Usage | molecules prefix capture、`observability/run-telemetry.ts` | F06 | stable prefix、rewrite、cache retention | prefix stability、cacheRead、成本 | Provider 字段缺失与客户端漂移分开 |
| Information Value | `evaluation/information-value.ts` | F07 | off、heuristic、verified uplift、PMI/EIG/VOI | 信息增益、有效调用比、成本 | 是否忽略确定性捷径、估计器输入 |
| 收敛与重复失败 | `runtime/tool-repeat-breaker.ts` | F08 | record、advice、hard_stop；adaptive breaker | 无进展轮、重复签名、尾部成本、正确候选损失 | 一次性错误是否被误判永久失败 |
| Stop Suggestion | `single-agent-loop.ts`、Completion handoff | F09 | off、soft_advice、verifier_driven | 候选到验证时延、尾部 Provider 请求 | 是否早于独立验证；Verifier 永远固定 |
| Web Session/Browser | `browser/*`、`web-session.ts`、`web-tools.ts` | F10 | session 对 bounded curl/fallback | cookie/CSRF 持续、state hash、reproduce | broker health、scope、lease；不传 cookies |
| Pwn Session | `pwn/*`、`container/*`、tube/session broker | F11 | tube/session 对 background shell | IO 同步、超时、复用、reproduce | host/broker availability、进程组回收 |
| Background Jobs 与观察队列 | `jobs/*`、`orchestration/observation-queue.ts` | C6 | monitor trigger、重启、幂等 acknowledge | job completion 可见性、重复确认、游标 | event ingress、摘要脱敏、Artifact 引用 |
| Planner/Executor Handoff | `orchestration/handoff.ts`、context handoff | F05/F07 | deterministic handoff 对 off；过期重建 | handoff freshness、采纳、重复计划 | knowledge hash、过期计划淘汰 |
| Hidden Verifier 与 Completion | `verification/*`、`verify_claim` | 固定 C7 | 故障注入，不做能力增益消融 | 独立复现、错误候选拒绝、replay parity | verifier authority、candidate hash、证据代次 |
| Approval 与平台副作用 | `control/approval-policy.ts`、competition API | 固定 C8 | pending/denied/granted/expired fault matrix | no-effect proof、重试一致性、敏感信息 | 审批状态、资源键、脱敏；禁止用真实提交做实验 |
| Competition/Fixture Sandbox | `competition/*`、`sandbox/*`、fixture catalog | 固定 C9 | 本地脚本、远端 fault injection | 环境生命周期、teardown、catalog hash | 远端状态 UNKNOWN 时不创建替代实例 |
| Provider Scheduler/Profiles/GUI | `runtime/provider-*`、`apps/gui` | F13/C10 | 并发、缓存保留、profile 选择 | queue latency、请求 fingerprint、成本 | 配置/凭据/endpoint；Key 永不入日志 |
| CLI/GUI/Script Lab | `apps/cli`、`apps/gui` | C11 | 同一 Control Store 的显示/调试路径 | 展示与持久状态一致、Worker 超时 | 投影层，不把 GUI 状态当权威 |
| Observability 与报告 | `observability/*`、`evaluation/*` | 固定 C12 | 原始事件对 telemetry/report/replay | 稳定 report hash、分类完整性、匿名化 | 统计投影，不修改业务终态 |

其中 `F01-F13` 是模型行为或上下文相关的单因素批次；`C0-C12` 是控制平面、工具基础设施或安全不变量回归。C 类功能不应与“模型更聪明”混合解释。

## 4. 实验批次和执行顺序

每个 F 批次先做机制 smoke，再做交错配对，最后才做确认集。每个普通消融至少使用 20 个不泄漏 holdout case、每个 Variant 3--5 次；不足时只能标记 `smoke` 或 `exploration`。

| 批次 | 目标 | 设计 | 当前状态与下一动作 |
| --- | --- | --- | --- |
| 047 | F02/F12/F13：IDALIB 拒绝恢复、一等反汇编、Provider 分类 | Terra Responses/max，`magic`，两条独立轨迹 | 已完成机制证据；advice 采纳 `binary_disassemble`，但 Provider error 阻断候选，不能作 curation 因果结论 |
| 048 | F04：证据整理是否改变 verifier-ready 交接 | 独立 verifier-ready fixture，`manual` 对 `advice`，Provider-free smoke 后再 live | 下一项；先验证整理调用不会阻塞 `verify_claim` |
| 049--052 | F01/F03/F07/F08：观察、工具表面、信息价值、收敛 | Web/Reverse/Pwn 分层，先 soft/off，hard 只作反事实 | 待 048 完成后交错执行 |
| 053--056 | F05/F06：Recall、上下文选择、压缩、缓存 | 长上下文与恢复语料；固定 prefix/Provider telemetry | 待建立长上下文语料 |
| C0--C12 | 基础设施和安全回归 | fault injection、重启、replay、无 Provider 或脚本化 Provider | 每次代码改动都跑，不能用成功率替代不变量 |
| 确认阶段 | 所有 F 因素 | >=20 case、3--5 attempts、分层置信区间 | 未达到样本量前不发布上线结论 |

## 5. 单次实验记录模板

每个实验目录必须同时保存以下内容（答案只进入私有 scorer，不进入报告或日志）：

1. **快照**：Experiment ID、Git revision、Provider/API/model/thinking、模型与 policy fingerprint、corpus/catalog hash、预算、deadline、唯一改变的因素。
2. **行为链**：首个工具、首个目标事实、首个 Artifact/Evidence、首个候选、首个 `verify_claim`；按 phase 记录 Provider 请求、工具调用、重复/拒绝/重试。
3. **结果与护栏**：verified success、evidence-backed、replay parity、candidate leak、cost/token、p95、越权和 no-effect proof。
4. **首错**：使用 `model_reasoning`、`harness_policy`、`tool_schema`、`provider`、`environment`、`verifier`、`budget`、`dataset` 之一；写出第一条可证伪证据，不用最终状态倒推原因。
5. **成功解释**：说明哪条无效路径减少、哪条证据让 Verifier 可复现、为什么不是随机采样或 Provider 差异。
6. **失败解释**：说明正确路径是否可达、在哪一步被阻断、模型是否看到明确反馈、若解除该阻断预期会发生什么。
7. **修复闭环**：最小修复、回归 fixture/测试、同快照复测 ID、接受/拒绝标准；修复后仍失败则更新首错，不掩盖结果。

## 6. “成功/失败”判读规则

- 成功不等于 `status=SUCCEEDED`：必须同时有当前代次 Evidence、独立复现和 replay parity；真实实验还必须确认 Provider telemetry 和无泄漏。
- 失败不等于模型失败。请求未发出时优先检查预算/deadline/权限；已发出但传输失败归 `provider_error`；工具 `isError` 或 schema 不合约归工具层；合法路径被策略拒绝归 Harness；Verifier 拒绝才进入候选/证据分析。
- 相同终态但不同轨迹不能直接比较。若 baseline 是 `budget_exhausted` 而 advice 是 `provider_error`，只能分别记录机制证据，不能称作策略胜负。
- 拒绝反馈必须可消费：`Reason`、明确未执行事实、保留的 Artifact/Evidence/状态、`Next` 和必要授权。缺少其中任一项就创建控制平面修复项。

## 7. 当前结论与未完成项

当前最强结论是：ProofBlade 的本地控制平面已能稳定完成 37/37 基线，F04 provider-free 机制 smoke 的 21 项测试通过，真实 Terra 轨迹也已证明 IDALIB Qt/PySide 拒绝可被模型采纳并切换到 `binary_disassemble`。尚无足够证据说明 `evidenceCuration`、`recall`、`compression` 或任何认知策略的因果收益；047 的 Provider error 和单题样本必须排除在这些结论之外。

下一次提交完成 048 时，必须增加独立的 verifier-ready fixture、记录 `manual/advice` 的候选交接行为，并在发现整理阻塞或 schema 摩擦时先修复，再用同一条件复测。所有功能最终都要回到本目录的批次表和闭环模板，不能只留下一个成功率数字。
