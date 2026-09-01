# 消融实验闭环报告功能

状态：实现并进入持续扩展。本文与 `ablation-report` 代码、单元测试和当前实验记录属于同一个功能变更；它不是独立的文档更新。

## 目标

消融报告不能只打印一个成功率。对每条 Attempt，它必须同时回答：

1. 结果是否是 verified、evidence-backed、无候选泄漏的终态；
2. 第一处可证伪边属于 Provider、预算/控制平面、工具、环境、Verifier 还是模型；
3. 成功轨迹先调用了什么，何时得到首个 Evidence，是否到达 `verify_claim`；
4. 失败或污染是否应进入策略因果分母，以及下一次应该修复什么、如何复测。

Harness 的默认职责仍是提供眼睛、纸笔、记忆和手。`firstAction`、`phaseRoute`、`actionBundle`、recall、curation 等认知辅助是建议，不应把合法的 in-scope 探索变成硬门禁。安全边界、预算、deadline、generation fence、独立 Verifier 和答案防泄漏仍保持硬约束。

## 报告契约

`buildAblationReport` 保留两层事实：

- **原始 Variant 指标**：所有已完成终态的成功、Token、费用、延迟和失败类别，Provider/预算失败不会被隐藏或改写。
- **可比较闭环**：只有终态且没有 `candidate_leak`、`provider_error`、`budget_exhausted`、`effect_outcome_unknown` 的 Attempt 才进入 `comparableRecords`。`incomplete` 记录也会在 `excludedRecords` 中出现。

配对成功率差只在双方都可比较的 pairing 上计算，并额外输出 `excludedPairs`。因此“Provider 502 导致一侧失败”仍出现在原始结果和首错归因中，但不会伪装成策略劣化；“运行中/未知”也不能悄悄成为配对分母。

真实评测的 `variants[].cases[]` 通过 `ablationRecordsFromRealModelSummary` 转换为同一报告记录。转换只保留工具名、时间、计数和分类，不保存 prompt、候选答案、绝对路径或 Provider 响应正文。工具调用按 durable decision 的 `createdAt` 排序，生成首工具和 `verify_claim`/`evidence` 调用计数。

## 现有功能与消融计划

| 功能 | 唯一变量/对照 | 任务分层 | 主要指标 | 首错与修复门槛 |
| --- | --- | --- | --- | --- |
| F01 基础观察 | 结构化观察 vs 输出投影 | Reverse/Pwn | 首事实时间、重复读取、候选来源 | schema/截断先修工具，不归因模型 |
| F02 IDALIB/Rizin/反汇编眼睛 | 后端可用性、直接手柄 vs 代理 | Native reverse | code observation、函数级调用、verifier 路径 | 依赖/工具错误先修或切换可验证后端 |
| F03 MCP surface | 一等 schema vs generic proxy | Reverse/Web/Mobile | 正确参数率、发现回合、错误后回退 | 提示与实际 surface 不一致是 Harness 首错 |
| F04 Evidence 图与整理 | `manual` vs `advice` | evidence conflict/复现 | evidence 覆盖、整理调用、验证时延 | verifier-ready 候选不能被 curation 阻塞 |
| F05 recall/context/compression | `off/manual/fixed_recent/automatic` | long-context/recovery | 事实保持、采纳率、Token、resume parity | 来源丢失修索引/receipt，不强迫路径 |
| F06 信息价值排序 | `off` vs `heuristic` | 高分支探索 | 有效动作比、信息增益、尾部成本 | 确定性候选优先，但仍保持建议模式 |
| F07 首步/阶段/动作包 | `soft_advice` vs `off` | Web/Pwn/Reverse | 首步命中、回退、首证据时间 | 错误建议不能拒绝合法动作 |
| F08 重复/无进展/熔断 | `off` vs `record/advice/adaptive` | 长任务/不稳定工具 | 重复签名、恢复率、p95 成本 | 区分瞬时 Provider/环境错误与模型循环 |
| F09 verify/hidden scorer | 故障注入，不作为普通策略开关 | 可复现题 | 候选到验证、复现次数、错误拒绝 | handoff 阻断先修控制平面 |
| F10 Pwn session/shell/reproduce | session vs 明确降级 | Pwn | IO 同步、复用、复现成功 | 缺少 broker 必须给可操作 bash fallback |
| F11 Web session/replay | session vs bounded fallback | Web | cookie/CSRF、origin、reproduce | scope/环境错误必须带恢复手柄 |
| F12 approval/effect/recovery/refusal | fault injection | side effect | no-effect proof、批准后重试、恢复一致性 | fail-closed 但反馈必须含 Reason/未执行/Next |
| F13 Provider/预算/重试 | 正常 vs 502/usage/deadline 注入 | 全部真实任务 | traffic、预留、成本、错误后可达性 | Provider 错误不能写成模型或策略失败 |

正式结论要求固定模型、Provider、thinking、语料哈希、Verifier、权限和安全边界；每个因素至少 20 个不泄漏 case、每层 3--5 次交错尝试。更小样本只标作 mechanism smoke。

## 已有证据与解释

- Terra `023` recall smoke：两组各 `1/1`，只能证明调用链可运行；automatic 请求更少，但样本不足，不能称为 recall 因果收益。
- Terra `024` recall 配对：baseline `3/3`、automatic `2/3`；唯一失败是 AIHub `502`，首错责任域为 Provider，不能归因 recall。闭环动作是稳定窗口复测并从策略分母排除污染 pairing。
- Terra `050` evidence curation smoke：两组各 `1/1`，advice 没有阻塞 `verify_claim`；这说明交接契约正确，不等于 advice 提升解题率。
- Terra `051` evidence curation 配对：两组各 `3/3`；advice 没有额外 `evidence` 调用，过程指标略好，但只有一个 `misc` case，不能作泛化因果结论。后续应扩展到 `evidence_conflict`、Web/Pwn 和恢复分层。
- F08/F05/F06/F07/F09/F10/Pwn/real evaluator 的 provider-free 回归均通过，证明状态机、边界、重放和归因管道；Provider-free 结果不证明 Terra 的认知策略收益。
- F02/F12/F13 的 047 真实轨迹在 IDALIB `decompile_function` 因 Qt/PySide 依赖拒绝后，Terra 实际采纳 `binary_disassemble`，取得结构化代码观察且没有越权 effect。这证明“原因 / 未执行 / 下一步”反馈可被消费；同批 baseline 因 deadline、advice 因 Provider 错误中断，故不作端到端成功率或 curation 结论。

每次复测都必须追加新的 immutable snapshot，并按“首工具 -> 首观察 -> 首错 -> 首候选 -> 首验证”记录。成功样本要解释调用减少、首 Evidence 提前或 verifier 更快的原因；失败样本要指出正确路径在何处仍不可达，并把修复回归和复测 ID 写回 [`ABLATION_CLOSURE_LEDGER_ZH.md`](./ABLATION_CLOSURE_LEDGER_ZH.md)。

## 验收与下一步

本功能的最小验收包括：

- 报告转换真实 summary 时保留首工具、工具序列、首 Evidence 和 failure category；
- 不完整 Attempt 被计数但不进入原始终态或可比较配对分母；
- Provider/预算/环境污染保留在原始成功率和首错表，并从策略配对分母排除；
- CLI 与 GUI 使用同一个转换函数，输出哈希稳定；
- 单元测试、构建、类型检查和 `check:components`、`check:project-reports`、`check:change-contracts` 全部通过。

本轮审查闭环还补齐了三项恢复契约：

- HTTP 非幂等请求在远端已收到、但 Artifact/Observation/ControlStore 持久化失败时，工具返回 `request_sent_result_unknown`，明确“已发送、结果未知”，并要求先核对状态再重试；不再误导模型认为请求未执行。
- Loop 的 abort、lane close 和 runtime close 都有独立清理超时；Provider 或工具忽略 abort 时，deadline 仍能结束 Run，超时只记录为清理告警。
- 每个 terminal pairing 完成时将不含 prompt、候选答案和响应正文的结果快照原子写入 ledger；进程崩溃后已完成 pairing 的结果仍可审计，resume 只处理 ready/unknown pairing。

相关回归覆盖 `web_request` 已发送但结果未知、stuck lane cleanup、ledger 结果快照和 resumable pairing；本轮未新增真实 Terra 请求，既有 Terra 结果仍按本文件前述样本量与 Provider 污染边界解释。

下一批真实实验优先覆盖 `long_context`、`recovery_required`、`evidence_conflict`，按 Web/Pwn/Reverse 分层，每 Variant 3--5 次；任何新的失败先补“为什么失败/如何修复/复测”再更新成功率结论。
