# ProofBlade 消融实验总计划与闭环报告

状态：进行中（2026-09-01）

本文是 ProofBlade 消融工作的统一入口。它回答四个问题：当前有哪些功能、每个功能怎样做单因素消融、失败怎样定位和修复、成功样本为什么成功。本文不把一次成功率当成结论，也不把 Provider、Harness、工具、环境和 Verifier 的故障混在一起。

相关设计：

- `docs/CHAPTER7_AGENT_EVALUATION_ABLATION_DEVELOPMENT_PLAN_ZH.md`（本地研究输入）
- `docs/ABLATION_EVALUATION_DEVELOPMENT_PLAN_ZH.md`（本地研究输入）
- `docs/INFORMATION_THEORETIC_CONTEXT_RAG_RESEARCH_ZH.md`（本地研究输入）
- `docs/PERSISTENT_CONTEXT_RAG_DEVELOPMENT_PLAN_ZH.md`（本地研究输入）
- [评测协议](../eval-protocol.md)
- [功能消融计划](./FUNCTION_ABLATION_PROGRAM_ZH.md)
- [消融闭环台账](./ABLATION_CLOSURE_LEDGER_ZH.md)

## 1. 总原则

ProofBlade 的评估对象是：

```text
具体 Provider/model + 固定 Harness + 固定安全边界 + 一个 Harness 因素
```

每个正式实验必须固定以下内容：语料及 hash、Fixture 初态、Verifier、权限和网络 scope、模型身份、思考等级、采样参数、最大轮数、成本上限、deadline、运行顺序和随机种子。每个 Variant 只改变一个主要因素；组合 Variant 必须标记为 `composite`，只能作探索性结果。

Harness 的职责是给 Agent 提供：

- 眼睛：目标相关的 read、grep、binary、Web、Pwn、MCP 和 Capability 观察；
- 纸笔：Artifact、Observation、Evidence、Hypothesis、事件和可重放记录；
- 记忆：Receipt、`pb://` 引用、Recall、Context Broker、Checkpoint 和恢复；
- 手：经过 scope、Lease、Effect Journal、审批、预算和 Verifier 的动作。

首步建议、阶段提示、证据整理、信息价值和停止提示是认知辅助，不应把合理的调查路径变成锁链。硬门和硬停只作为明确的反事实 Variant。安全边界仍固定存在。

## 2. 固定安全边界

以下项目不进入普通能力消融。它们每次都必须为 `enforced`：

| 边界 | 必须保持的行为 | 失败时的报告要求 |
| --- | --- | --- |
| workspace/network scope | 路径、主机、端口和目标范围校验 | 记录越界输入、未执行动作和可用 scope |
| secret isolation | Key、Authorization、答案和敏感 Artifact 不进入模型无权视图 | 记录泄漏检查和 no-effect proof |
| generation fence | 旧代次不能写入当前 Run | 记录 generation、拒绝边和重放结果 |
| Effect/Lease/Idempotency | 副作用两阶段日志、所有权和重复调用一致 | 记录 PROPOSED/STARTED/FINISHED 与释放状态 |
| budget/deadline/cancel | 请求前预算、在途取消、工具/进程/费用硬上限 | 区分未发请求、在途中止和远端未知状态 |
| approval | 高风险副作用 pending/denied/granted/expired | 必须写明未执行动作、保留状态和下一步授权 |
| independent verifier | 只有 Verifier 能接受 Completion | 记录候选、Evidence、复现和拒绝原因 |
| candidate leak check | 期望答案不能进入事件、普通 Artifact 或报告 | 结果必须是零泄漏；非零即废弃批次 |
| replay parity | JSONL 回放投影与持久投影一致 | `projectionHash` 不一致即控制平面失败 |

固定边界的 fault-injection 单独归入 C 类，不与模型成功率合并。

## 3. 功能总目录

### 3.1 可消融的认知辅助功能（F 类）

| 编号 | 功能 | 当前实现入口 | 对照/实验水平 | 适用语料 | 机制指标 | 目标指标 | 首错与修复方向 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | 基础观察与目标读取 | `capabilities/binary.ts`、`read/glob/grep` | direct observation / advice / off | reverse、forensics、短任务 | 首个目标事实、工具错误、读取次数 | verified success、首证据时间 | 先查结果是否到达模型；丢失则修 Receipt/截断 |
| F02 | Binary/Reverse 眼睛 | `capabilities/objdump.ts`、`reverse.ts`、`binary_disassemble` | IDALIB、objdump、Rizin；generic proxy 对 direct handle | native reverse、长调查 | 代码观察数、地址采纳、MCP 到反汇编时延 | candidate/verifier 到达率 | 先查后端依赖、schema 和 Provider；不得用 RECON 配额压制真实分析 |
| F03 | Capability Router、Skill、MCP 导航 | `tools/runtime.ts`、`skills/registry.ts`、`mcp/registry.ts` | metadata 常驻、按需正文、list/describe/call、一等工具 | 工具密集、多后端 | 发现回合、Schema 采纳、错误重试 | 有效动作比、成功率、成本 | 若提示声称不存在的工具，修发布合同；拒绝要给 `Reason/Next` |
| F04 | Evidence/Artifact 图与整理 | `knowledge/evidence-graph.ts`、`evidence-curation-gate.ts` | manual / advice / draft | 证据冲突、复现型任务 | backlog、去重、引用完整率、整理调用数 | evidence-backed success、verifier 延迟 | 候选已就绪却被整理拖住时，整理必须变为可选，不得挡 verifier |
| F05 | Context Selection、Receipt、Recall | `context/compiler.ts`、`model-receipt.ts`、Knowledge Projection | fixed_recent / receipt / deterministic broker；manual / advice / automatic Recall | long_context、recovery_required | context tokens、Recall 命中/采纳、重复读取 | 成功率、成本、恢复成功 | 路径可见但不召回则改善摘要/查询；错召回则加强 generation/source filter |
| F06 | Prefix Cache 与上下文压缩 | `context/compiler.ts`、maintenance、checkpoint、Telemetry | cache retention、compression off / bounded / query-aware | long_context、跨轮任务 | prefix stability、cacheRead、压缩率、事实保持 | 成本、p95、成功率、replay parity | 先区分客户端 prefix 漂移与 Provider 未复用缓存；摘要丢关键字段则固定 source/command/evidence ids |
| F07 | Information Value / VOI | `evaluation/information-value.ts` | off / heuristic / verified_uplift / PMI / EIG / VOI | 选择空间大、探索任务 | 估计分、动作选择、信息增益、调用成本 | 有效动作比、成功率、成本 | 估计器忽略确定性捷径时，提高 verifier-ready candidate 优先级 |
| F08 | 重复失败与无进展检测 | `runtime/tool-repeat-breaker.ts`、`competition/experiment-gate.ts` | record / advice / hard_stop；adaptive breaker | 工具失败、Provider 瞬态错误、长任务 | 重复签名、阻断次数、无进展轮 | 尾部成本、成功率、恢复率 | 区分瞬态 Provider 错误、不同输入和真实重复；拒绝给换假设/记录证据建议 |
| F09 | Phase Route、Action Bundle、Stop Suggestion | `ablation-policy.ts`、`single-agent-loop.ts`、`run-coordinator.ts` | off / soft_advice / hard_gate；stop off / verifier_driven | 多阶段、候选交接 | 首错 phase、回退数、候选到 verifier 时延 | 成功率、p95、尾部请求 | 已有候选时允许跳过准备阶段；停止只能建议，Completion gate 不变 |
| F10 | Web Session/Browser Session | `web/http-session.ts`、`web/browser-session.ts`、`web-coding-tools.ts` | session tools 对 bounded curl/fallback | stateful Web、CSRF、登录链 | cookie/CSRF 持续、state hash、请求数 | reproduction success、重试成本 | 先查 broker health、scope、lease；不能把 cookie 或远端未知状态归因模型 |
| F11 | Pwn Session/Tube | `pwn/pwn-tools.ts`、`pwn-session.ts`、session broker | pwn_open/send/recv 对 background shell | interactive Pwn、二进制 payload | 同步成功、timeout、进程回收、marker 命中 | clean reproduction success、p95 | 先查 prompt anchor、进程组和 broker；EOF/timeout 不是 shell 成功 |
| F12 | 拒绝反馈与恢复导航 | `coding-resources.ts`、`pwn-coding-tools.ts`、MCP registry、approval | bare error（历史反例）对 `Reason/not executed/Next` | 所有工具与故障注入 | 反馈完整率、替代工具采纳、重复拒绝数 | 恢复后成功率、额外成本 | 缺原因、未执行事实、保留状态或下一步就开修复 PR；不放宽边界 |
| F13 | Provider/模型请求与调度辅助 | `provider-scheduler.ts`、`provider-budget.ts`、`provider-transport.ts`、GUI Profile | Terra/其他模型；max/medium；cache retention | 所有真实实验 | queue、request、retry、usage、cost、deadline | 可用 Provider 流量、成功率、成本 | 先确认 HTTP status、模型身份和 usage；Provider error 不归因 Harness |

### 3.2 控制平面与基础设施回归（C 类）

| 编号 | 功能域 | 主要实现 | 固定验证 |
| --- | --- | --- | --- |
| C0 | 原子、分子与依赖漏斗 | `packages/atoms`、`packages/molecules` | 独立构建、project reference、API index |
| C1 | JSONL Control Store/Reducer | `storage/jsonl-store.ts`、`control/reducer.ts` | 单写者序列、崩溃恢复、projection hash |
| C2 | Effect Journal | `effects/*`、`tools/runtime.ts` | 两阶段效果、重放、幂等和 no-effect proof |
| C3 | Scope/Lease/Generation | `runtime/scope.ts`、`lease-manager.ts` | child-first/LIFO、所有权竞争、过期回收 |
| C4 | 预算、deadline、取消与 Provider Scheduler | `provider-budget.ts`、`request-epoch.ts`、`provider-scheduler.ts` | 未发请求、在途取消、排队清理、资源释放 |
| C5 | Artifact/Evidence Curation 状态机 | `evidence-curation-gate.ts`、ArtifactStore | clear/checkpoint/required、去重、可信 promotion |
| C6 | Background Job 与 Observation Queue | `jobs/*`、`observation-queue.ts` | UTF-8 cursor、完成/错误/心跳、幂等 acknowledge |
| C7 | Verifier/Completion | `verification/*`、`claim-verification.ts` | executor 不得自证、候选防泄漏、独立复现 |
| C8 | Approval 与平台副作用 | `approval-policy.ts`、competition API | pending/denied/granted/expired、真实副作用前停止 |
| C9 | Fixture/Sandbox/Environment | `competition/sandbox.ts`、`environment-janitor.ts` | reset、teardown、未知状态不创建替代实例 |
| C10 | Provider Profile/GUI/CLI | `apps/gui`、`apps/cli` | 配置快照、Key 存在性、同一 Run/Control Store |
| C11 | Session/MCP/Skill 生命周期 | `session-registry.ts`、MCP stdio、Skill Registry | 启动、失败、重启、释放和 schema 快照 |
| C12 | Telemetry、Report、Anonymized Replay | `observability/*`、`evaluation/*` | 分类完整、稳定 report hash、匿名化不泄漏 |

C 类只回答“系统是否正确和可恢复”，不能被写成“模型能力提升”。

## 4. 标准实验流程

每个 F 批次按以下顺序执行，任何一步失败都先修复或标记批次无效：

1. **机制 smoke**：无 Provider 或注入式 Lane，确认 Variant 真的改变了预期的 policy/context/tool surface。
2. **连通性预检**：确认 concrete model、`/models` 或等价探针、Key 存在、价格有效、Responses/Completions 端点正确。
3. **最小 live smoke**：同一 Case、每 Variant 一次、低成本和低轮数，只判断 Provider 流、工具结果、Verifier 交接是否可达。
4. **交错配对**：至少 20 个不泄漏 Case，每 Variant 3--5 次；同一 Case 的 Variant 交错，记录 seed 和 pairing。
5. **轨迹分析**：按事件顺序找首个错误边，不从最终失败倒推原因。保存首个工具、首个目标事实、首个 Artifact/Evidence、首个候选、首次 `verify_claim` 和首次拒绝。
6. **闭环修复**：最小代码或提示修复、最小回归 Fixture/单测、同条件复测。修复后仍失败时，更新首错类别，不抹掉旧批次。
7. **确认集**：只有无 Provider 污染、无预算/期限污染、护栏全通过且样本量足够，才计算正式的 Pass@k、Pass^k 和配对差异。

### 4.1 必填指标

**结果指标**：`verified_success`、`evidence_backed_success`、Pass@k、Pass^k、Best@k、failure_rate、flaky_rate、candidate_leak、forbidden_action_rate。

**过程指标**：首个有效动作/证据/候选时间、Provider 请求数、轮数、Tool 调用数、有效动作比、重复调用、重复阻断、Recall 命中/采纳、Artifact 读取、压缩次数、恢复读取、Provider queue/execute/retry 时间。

**护栏指标**：replay parity、generation、scope、no-effect proof、未回收 Job、未确认 ingress、Verifier 代次、成本 cap、p95 deadline、Key/答案泄漏。

机制指标改善但目标指标不改善时，结论只能是“机制生效，未证明收益”。

### 4.2 失败归因规则

| 首错类别 | 判定证据 | 允许的结论 | 下一步 |
| --- | --- | --- | --- |
| `model_reasoning` | 正确工具和信息可达，模型解释/变换错误 | 模型在该轨迹的推理失败 | 改任务提示或模型对照，不改安全边界 |
| `harness_policy` | 合法动作被 policy 阻断，或提示/工具合同矛盾 | Harness 造成可达性损失 | 降为 advice、修工具 surface、加回归 |
| `tool_schema` | 参数/Schema 不合约，结果未执行 | 工具接缝失败 | 修 Schema/反馈，保留原始错误 |
| `provider` | HTTP/stream/模型身份/usage 失败 | Provider 通道失败 | 重试通道或换 Provider；从策略因果分母排除 |
| `environment` | broker、Docker、进程、网络、文件系统故障 | 环境失败 | 修 runtime/回收/fixture，不改模型结论 |
| `verifier` | 候选到达但 verifier 独立拒绝 | 候选或证据不满足任务 | 分析候选推导和证据闭包 |
| `budget` | 请求前预算拒绝、deadline 或硬上限 | 预算/期限不足 | 对齐预留与实际上限，调整实验预算 |
| `dataset` | 答案泄漏、hash 变化、任务不清或标签错误 | 语料无效 | 重建 corpus，不计算策略差异 |

拒绝反馈的最低格式：

```text
Reason: 为什么触发边界
The requested action was not executed: 哪个动作没有执行
Preserved: 已保留的 Artifact/Evidence/Run 状态
Next: 可执行的替代工具、参数、授权或复测动作
```

已经发出的 Provider 请求不能声称“未执行”；必须记录在途状态和远端状态是否未知。

## 5. 已有实验与可用范围

| 批次 | 当前事实 | 结论级别 | 原因与修复/下一步 |
| --- | --- | --- | --- |
| `EVAL-CONTINUE-20260901` | provider-free baseline-v4：18/18 Fixture、19/19 runtime scenario、37/37 gate、replay parity 全部通过、candidate leak=0 | 控制平面基线 | 证明持久化、Verifier、事件和恢复可复现；不证明模型或认知策略收益 |
| `AB-TERRA-MAX-RESPONSES-027` | baseline/candidate 均 0；模型已得到候选并调用 `verify_claim`，后续被整理/交接循环拖住 | 无效因果批次 | 修复 deferred proposal 必须终止当前 turn，supporting evidence 不再阻塞候选验证 |
| `AB-TERRA-MAX-RESPONSES-028` | 两 Variant 各 1/2；真实流量和 hidden scorer 可达；失败轨迹含 AIHub 502 后被过度成本预留拖住 | 诊断批次 | 修复 Provider completion 上限与预算预留对齐；不能写成 curation 收益 |
| `AB-TERRA-MAX-RESPONSES-029` | 两 Variant 各 2/2；四例 evidence-backed、replay parity、零泄漏；candidate 少一次请求但成本略高 | 控制题探索证据 | 证明预算对齐和验证交接修复有效；两题不足以归因 firstAction 或其他策略 |
| `AB-TERRA-IDALIB-MAGIC-021` | reverse 初检/工具发现耗尽 RECON，实际代码分析不可达；另一路有 Provider 503 | 无效因果批次 | reverse 使用专属静态分析合同；Provider 失败排除 |
| `AB-TERRA-IDALIB-MAGIC-031` | Provider 和 MCP initialize 正常，但提示声称一等工具而实际只暴露 `mcp_call`，模型循环发现代理 | Harness 诊断批次 | 发布前验证真实 schema；修复后的 032+ 仍需按首错复核 |
| `AB-TERRA-IDALIB-MAGIC-034..040` | 已覆盖 Qt/PySide 拒绝、Evidence advice、地址候选和 fallback 机制；部分 ledger 仍为失败 | 机制/通道证据 | `Reason/Next` 反馈和直接反汇编路径可达；失败若无 Provider 后续不能用于策略胜负 |
| `AB-TERRA-OBJDUMP-MAGIC-041..047` | 一等 `binary_disassemble` 能产生真实 objdump 观察；部分轨迹在 Provider 错误或预算/期限处停止 | 机制证据与诊断 | 先修 Provider、deadline 和公平预算；后续才评估 curation/stop 的因果 |
| `AB-TERRA-CURATION-048/049` | 旧记录被 Provider 流错误污染，不能作 curation 因果结论 | 无效批次 | 新建 verifier-ready 语料，确保模型到达 `verify_claim` 后再比较 manual/advice |
| `AB-TERRA-RECALL-019/020` | 旧门控过严或单次尝试，不能作为 Recall 结论 | 无效/探索批次 | 使用同一模型和语料，仅切换 Recall；至少 3 attempts |
| `AB-TERRA-RECALL-022` | 6 个 pairing 全失败；首轮 Provider 请求返回 200，但 Windows bash 在 deadline 后未释放并发/清理，后续请求等待槽位 | 无效诊断批次 | 归因 environment/harness deadline allocation；不能写成 Recall 失败。修复在 PR #109 |
| `F12 refusal feedback` | approval、MCP、IDALIB、bash、Provider budget、Pwn 等拒绝已覆盖 `Reason/not executed/Next`；真实 Terra 曾采纳 `binary_disassemble` | 真实可消费性证据 | 反馈改善模型恢复路径，不等于最终成功率提升；独立实现见 PR #107 |

### 5.1 已成功样本为什么好、坏样本为什么坏

**好样本：029。** 成功轨迹通常是 `read -> bash -> verify_claim -> hidden reproduction`，首个目标事实在第一轮形成，候选进入独立 verifier，随后结束 Run。它好在：Provider 请求上限与预算预留一致、候选交接不要求额外整理、证据来源闭包完整、没有重复读取或拒绝循环。candidate 少一次请求只能作为机制观察，因为样本只有两题。

**坏样本：027。** 模型已经找到候选，但 `deferClaimAcceptance + continuousRecovery` 让本应交给 verifier 的候选继续留在当前 Lane；模型随后把 Artifact ID 当 Evidence ID，重复调用宽泛的 evidence schema。首错在交接策略和 schema 摩擦，不在候选推导。修复是“候选就绪即终止当前 turn 并验证”，并把整理降为可选。

**坏样本：RECALL-022。** Provider 第一轮返回 200，之后 Windows 下的 `bash` 解码命令被外层期限中止；未释放的并发槽位让后续请求继续等待，六个配对都无法比较。首错在评测器 deadline/取消清理，而不是 Recall。该批次必须保留为诊断证据，不能把 0/6 写成自动召回无效。

**好但不可外推样本：IDALIB/OBJDUMP。** Terra 在收到 Qt/PySide 缺失的明确拒绝后采纳 `Next`，调用受 scope 限制的 `binary_disassemble` 并获得真实代码观察。这证明反馈和 fallback 可消费；如果后续 Provider error、预算或样本不足，则只能说“恢复路径可达”，不能说“逆向成功率提升”。

### 5.2 Recall 通道复测：023 与 024

#### `AB-TERRA-RECALL-023`：低成本 smoke（可用通道，不能作因果结论）

- 固定条件：AIHub `openai-responses`、`gpt-5.6-terra`、`thinking=max`、同一 `terra-ablation-017` 语料、同一 Verifier 和安全边界；只切换 `recall=manual` / `recall=automatic`；每 Variant 1 次、2 turns、总 deadline 240 秒。
- 预检：concrete model、Provider match、credential、pricing 和 `/models` 均通过（`200`）；估计最多 4 个 Provider 请求。
- 结果：baseline `1/1`、5 requests、59,164 tokens、`$0.045852`、first Evidence `7,238ms`、89,047ms；automatic `1/1`、3 requests、35,193 tokens、`$0.035193`、first Evidence `8,132ms`、27,979ms。两条均 `evidence-backed=true`、`replayParity=true`、`candidateLeak=false`，有效动作比均为 `1.0`。
- 解释：automatic 少 2 次请求、约 `$0.010659` 和 61 秒，但单题单次差异可能来自模型轨迹/Provider 时延；没有看到足够的跨轮 Recall 命中与采纳证据。因此只能证明通道、Verifier 交接和遥测可用，不能宣布自动 Recall 更好。

#### `AB-TERRA-RECALL-024`：三次配对复测（探索性，受 Provider 波动污染）

- 固定条件：与 023 相同，`attempts=3`、`maxTurns=2`、总 deadline 900 秒；实验 fingerprint 为 `cf7b5fd23fac66fc12816cdd2bcac5a9926400d72147efa5f85d8d5dd8433d48`。
- 完整结果：baseline `3/3`，11 requests，127,874 tokens，`$0.114562`，平均 first Evidence `6,922ms`；automatic `2/3`，9 requests，92,556 tokens，`$0.089484`，平均 first Evidence `7,896ms`。所有成功样本均 evidence-backed、replay parity、零泄漏；automatic 的失败样本为 `provider_error`，不是 budget、tool schema、Harness policy 或 Verifier failure。
- 首错证据：`ABLATION-AB-TERRA-RECALL-024-candidate-terra-case-1-a1` 在第一轮 `provider_request_started` 后收到 AIHub `502`，随后出现 3 次 Provider retry 和 `provider_recovery_required`，`toolCallCount=0`，最终 `run_failed(failureCategory=provider_error)`。正确调查路径尚未被模型看到，因此该样本不能计入 Recall 的能力失败。
- 可比较分母：排除这 1 个 Provider 污染样本后，baseline `3/3`、automatic `2/2`；两组成功样本的有效动作比、事实证据覆盖和重放一致性均相同。automatic 少 2 个请求、低约 `$0.025078` 总成本，但 first Evidence 平均慢约 `973ms`，且样本仍只有一个 misc Case。
- 结论：024 证明评测器能记录并隔离 Provider 首错，也提供了自动 Recall 可能减少请求的探索信号；它没有证明 Recall 提升成功率。正式确认需要至少 20 个不泄漏 Case、覆盖 long_context/recovery_required，并将 Provider error 单独分层。
- 修复状态：上次 `RECALL-022` 的 deadline/并发槽位问题已由 PR #109 的 Lane abort 观察修复；024 没有重现 deadline starvation。下一轮若仍出现 502，应先做 Provider 稳定性分层或换同一 Provider 的稳定窗口，不修改 Recall 归因。

### 5.3 Evidence Curation 通道复测：050 与 051

#### `AB-TERRA-CURATION-050`：低成本 smoke

- 固定条件：AIHub `openai-responses`、`gpt-5.6-terra`、`thinking=max`、同一 `terra-ablation-017` 语料、同一 Verifier 和安全边界；仅切换 `evidenceCuration=manual` / `advice`；每 Variant 1 次、2 turns、总 deadline 240 秒。
- 预检：concrete model、Provider match、credential、pricing 和 `/models=200` 均通过。
- 结果：manual `1/1`、4 requests、46,487 tokens、`$0.026519`、first Evidence `13,135ms`、62,234ms；advice `1/1`、6 requests、72,437 tokens、`$0.032501`、first Evidence `7,688ms`、60,585ms。两条均 evidence-backed、replay parity、零泄漏、effective action ratio=1。
- 行为解释：两组都能在第一轮完成 `read -> bash -> verify_claim` 并由 hidden scorer 复现。advice 没有阻塞候选，但本次多 2 个 Provider 请求、成本高 `$0.005982`；first Evidence 更快约 5.4 秒。单题单次不足以判断整理建议是否真正减少整理成本，且 advice 的额外请求可能只是模型采样差异。
- 结论级别：通道 smoke 通过；不作 curation 因果结论。下一步需要 3--5 attempts 和多类证据冲突任务。

#### `AB-TERRA-CURATION-051`：三次配对复测

- 固定条件：与 050 相同，`attempts=3`、`maxTurns=2`、总 deadline 900 秒；实验 fingerprint 为 `704fb9977c42135e8d28b8a923e254b54c0215868bd504bda6762650b8518f54`。
- 结果：manual `3/3`，11 requests、129,849 tokens、`$0.076601`，平均 first Evidence `10,749ms`（p95 `14,801ms`）；advice `3/3`，11 requests、128,503 tokens、`$0.075255`，平均 first Evidence `7,801ms`（p95 `8,345ms`）。两组每个成功样本均 evidence-backed、replay parity、candidate leak=0、fact-evidence coverage=1。
- 事件级行为：manual 的三条工具序列分别为 `glob -> read -> bash -> verify_claim`、`read -> bash -> verify_claim`、`read -> bash -> verify_claim`；advice 分别为 `read -> bash -> verify_claim`、`read -> bash -> verify_claim`、`bash -> read -> bash -> verify_claim`。六条轨迹均在第一轮到达 `verify_claim`，没有因 curation backlog 被阻断；advice 没有产生额外 `evidence` 整理调用。
- 成功样本为什么好：成功轨迹都把候选交接放在整理之前，模型使用当前 Artifact 输出直接构造 verifier 命令；Verifier 产生独立 reproduction，Evidence 来源闭包和 replay parity 完整。advice 主要改变上下文可见的整理提示，没有把合法探索变成硬门。
- 差异与限制：advice 相比 manual 少 1,346 tokens、低 `$0.001346`，平均 first Evidence 快约 2,947ms，p95 快约 6,456ms，但总 Provider 请求数相同，且只有一个 misc Case。这个过程差异可能由 `glob` 是否被调用、Provider 时延和采样轨迹造成，不能归因于 curation 本身。
- 结论：051 证明 Evidence curation advice 在当前可直接验证任务上不会阻塞 `verify_claim`，并出现小幅过程收益信号；没有证明成功率或证据质量提升。正式确认必须使用至少 20 个 Case，覆盖 `evidence_conflict`、`long_context` 和 `recovery_required`，同时记录 curation backlog、annotation、promotion 和冲突保留数量。
- 修复判断：本批没有发现需要修改的 curation 阻塞；保留现有 advisory gate。若后续任务出现整理后才允许验证的路径，应先修为“候选就绪优先”，并为该根因创建独立 PR。

## 6. 修复闭环与独立 PR 规则

每个问题必须有自己的闭环记录：

```text
实验 ID
 -> 首错事件和证据
 -> 归因类别
 -> 最小修复假设
 -> 单元/集成/机制回归
 -> 同语料同模型复测
 -> 接受或拒绝标准
 -> 独立 PR
```

当前已完成的独立 PR：

- [PR #107](https://github.com/Fruit-Guardians/ProofBlade/pull/107)：拒绝的 Pwn/重复实验动作返回原因、未执行事实和恢复路径；33 个相关测试通过。
- [PR #109](https://github.com/Fruit-Guardians/ProofBlade/pull/109)：评测 Lane 即使忽略 abort 也不会拖住后续配对；评测器 21 个测试通过。该 PR 以消融实现分支为基线，但不是追加到 #106 的提交。

后续规则：一个独立功能或一个独立根因对应一个新分支和一个新 PR；实验结果文档也不得混入无关代码修复。PR 合并前必须列出测试命令、首错证据和复测 ID。

## 7. 后续执行队列

| 阶段 | 实验 | 前置条件 | 通过标准 |
| --- | --- | --- | --- |
| P0 | C0-C12 控制平面回归 | 每次代码改动后执行 | 无 Provider 污染、projection hash、generation、no-effect、replay 全通过 |
| P1 | F12 拒绝反馈故障注入 | approval、MCP、Provider budget、Pwn 各一条 | 每条反馈可消费，模型或注入 Lane 能选择明确 Next，不能只返回拒绝 |
| P2 | F02/F03 reverse fallback | 20+ non-leaking reverse cases、Terra Responses/max | IDALIB 失败时 fallback 可达；Provider/环境失败分母剔除 |
| P3 | F04 curation | verifier-ready 语料、manual/advice、3 attempts | 比较整理调用、候选到 verifier 时延和 evidence coverage；整理不阻塞合法探索 |
| P4 | F05 Recall/context | long_context、recovery_required、receipt 对照 | Recall 命中和采纳可观测；关键事实、来源闭包、replay 不下降 |
| P5 | F06 compression/cache | 长上下文、稳定 prefix、Provider cache telemetry | context/cost 改善且关键事实保持；区分 Provider cache 未命中 |
| P6 | F01/F07/F08/F09 | 分层 Web/Pwn/reverse，soft/off 优先 | 有效动作比、尾部成本、候选到 verifier；不因 hard gate 损失可达路径 |
| P7 | F10/F11 | Web/Pwn broker health 和进程回收先通过 | session 相比 fallback 的状态保持与 clean reproduction 可解释 |
| P8 | 确认集 | 每因素 >=20 cases、3--5 attempts | 配对差异稳定、护栏无回归、才允许给出采用建议 |

## 8. 单实验报告模板

复制以下结构到 `docs/evaluation` 或本地忽略目录；答案、Key、完整 Prompt 和敏感请求体只保留在本地受控 Run，不进入报告：

```markdown
### EXP-ID：名称（状态）

- 因素：
- 问题/假设：
- Git revision / PR：
- Provider / model / thinking / sampling：
- corpus hash / Fixture Catalog hash：
- budget：attempts、maxTurns、maxCostUsd、deadlineMs
- baseline / treatment：
- 固定安全边界：

#### 结果

- verified_success、evidence_backed_success、Pass@k、Pass^k：
- Provider requests、tokens、cost、p95、first Evidence：
- effective actions、重复/阻断、Recall/Receipt/curation：
- replay parity、candidate leak、forbidden action、generation：

#### 行为对比

- 成功样本首个工具、首个事实、候选和 verifier 时间：
- 失败样本第一条可证伪边：
- 好样本为什么减少无效路径：
- 坏样本为什么没有到达正确路径：

#### 归因与修复

- failure category：
- 证据：
- 最小修复：
- 回归命令和结果：
- 同条件复测 ID：
- 接受/拒绝标准：
- 是否允许进入确认集：
```

## 9. 当前判断

目前可以确认：

1. Control Store、Artifact/Evidence、Verifier、Replay、恢复和拒绝反馈机制有可重复的源级或机制级证据。
2. 真实 Terra 已经能够消费部分明确的拒绝反馈并切换到可用 fallback，这验证了“原因 + 未执行 + 下一步”设计。
3. `AB-TERRA-MAX-RESPONSES-029` 证明预算上限与验证交接修复能消除一类伪失败，但不足以证明任一认知策略的因果收益。
4. Recall、Evidence Curation、Compression、Information Value、Stop Suggestion 等仍缺少无 Provider 污染、足够样本、同因素配对的最终结论。
5. 下一轮必须先使用 PR #109 的 deadline 修复做通道 smoke，再开展 Recall 或 curation；任何全失败批次都必须先分析首错，不能只报告成功率。

因此，本项目当前结论不是“某个功能已经提高成功率”，而是“评测和修复闭环已具备，部分功能机制已证实可达，认知策略的真实收益仍待按本计划完成配对确认”。
