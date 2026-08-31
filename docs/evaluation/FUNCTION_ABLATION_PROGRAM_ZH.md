# ProofBlade 功能消融与闭环评测计划

状态：执行中。本文是现有 Harness 功能的评测登记册和运行顺序，不以单次成功率代替结论。原始事实、每次真实运行、首错和修复结果追加到 `ABLATION_CLOSURE_LEDGER_ZH.md`。

## 1. 评测边界

Harness 提供眼睛、纸笔、记忆和手：目标相关的只读观察、可回放 Artifact/Evidence、出处明确的检索与压缩，以及经 scope/effect/verifier 约束的行动能力。它不应将模型的调查顺序变成默认硬限制。

以下不作为能力消融开关，始终保持启用：工作区与网络 scope、凭据隔离、generation fence、effect journal、用户取消、总成本/工具/提交额度、deadline、独立 verifier、Completion gate 和候选泄漏检查。任何拒绝都必须向模型返回“原因 / 未执行的动作 / 下一步或所需授权”。

## 2. 通用实验协议

1. 一次正式策略实验只改变一个 `HarnessPolicy` 因子；模型、Provider、thinking、语料哈希、尝试数、预算、Verifier、权限和安全边界固定。
2. 每个 case 至少记录首个工具、首个有效观察、首个失败、首个候选、首个验证、每轮 Provider 请求、工具调用、重复签名、Evidence 增长、成本和延迟。正式效应结论需要分层 holdout 和重复尝试，单题只可作机制 smoke。
3. 所有非成功必须按最早可证伪边分类：模型推理、Harness 策略、工具/schema、工具环境、Provider、Verifier、预算、语料或操作错误。外层 HTTP 200、effect exit code=0 或工具调用次数都不等于获得事实。
4. 修复后必须增加最小回归，再以新不可变快照重跑。成功案例也要比较为何更少无效调用、更快抵达 verifier、或以更低成本维持 replay parity；失败案例必须说明正确路径在何处不可达。
5. 停止条件：只有 verified completion、Evidence/replay guard、无泄漏和安全边界均满足才能算成功。`EXHAUSTED`、Provider 错误、工具错误和“模型自称完成”必须单独报告。

## 3. 功能清单与消融队列

| 编号 | 功能 / 实现面 | 任务分层 | 基线与唯一变量 | 主要行为指标 | 失败解释与修复门槛 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | 目标与二进制基础观察：`read/glob/grep`、`proofblade.binary.identify/sections/symbols/strings/inspect_elf` | reverse、pwn | 基线为直接结构化观察；变量为工具投影/输出可读性 | 首个目标事实时间、错误路径、重复读取、候选来源 | 先确认输出和 schema 是否到达模型；修复可读性/截断或真实工具故障 | 已有控制题；需扩大 holdout |
| F02 | 深度逆向眼睛：IDALIB MCP、Rizin、本地受限静态分析、`binary_disassemble` 一等手柄 | native reverse | 先做能力可用性实验，不与认知策略混合；后续比较同一可用后端的提示/投影 | 成功 code observation、反编译/反汇编错误率、从代码到 verifier 的路径 | 工具 `isError`、依赖缺失或 schema 错误优先归为环境/工具；Provider 错误必须与模型/预算失败分离；必须修好或切换可验证后端 | 045 证明一等手柄被 Terra 调用并返回代码事实；044/046 含 Provider 错误，端到端 verifier 路径待稳定窗口复测 |
| F03 | MCP 一等工具 surface、schema 与错误投影 | reverse、mobile、web | 直接 schema 对照；变量为一等工具 vs 代理投影，仅在工具都可用时 | 首次正确参数率、MCP 发现回合、payload 可读性、错误后回退采纳 | schema/提示不一致先修 Harness；远端 error 必须原样有界传达 | 031--040 已闭环部分路径 |
| F04 | Artifact / Evidence 图、检索、树和 curation | 证据冲突、跨轮任务 | `manual` 对 `advice`；固定其它 policy | 引用 Evidence 的候选比例、错误 artifact/evidence 混用、验证时延、无效整理回合 | verifier-ready candidate 被整理阻塞则修复交接；不要恢复 curation 硬门禁 | 027--029 已有控制回归；需 holdout |
| F05 | recall、context receipt、压缩与恢复 | 长上下文、跨轮恢复 | `manual/fixed_recent/off` 对一个候选策略 | 召回命中后采纳、事实保持率、重读率、上下文 token、resume parity | 先对比来源丢失、召回不可见和模型未采纳；修复引用或索引，而非强制路径 | 待建立长上下文语料 |
| F06 | 价值排序与行动建议 | 高分支探索 | `off` 对 `heuristic`（之后才是 verified_uplift） | 首个有效动作、有效调用比、候选到验证时延、尾部成本 | 若忽略确定性捷径，调整排序；只建议、不拒绝合法 in-scope 动作 | 待执行 |
| F07 | 首步、phase route、action bundle | 逆向、web、pwn | 默认 `soft_advice` 对 `off`；`hard_gate` 仅明确反事实对照 | 首步命中、路线偏离原因、回退次数、真实成功 | 首步建议错而阻塞即为 Harness 首错；默认不得用硬门禁修饰结果 | 部分机制测试；待分层正式实验 |
| F08 | duplicate failure、no-progress 与 circuit breaker | 不稳定工具、长任务 | `record/advice/adaptive` 对 `off` | 重复签名、恢复后有效动作、提前终止的候选损失、p95 成本 | 区分瞬时 Provider/环境错误与模型重复；先修工具反馈，硬 stop 仅消融 | 待执行 |
| F09 | `verify_claim`、hidden scorer、Completion handoff | 全部可复现题 | 不是策略开关；故障注入/回归 | 候选到 verifier 时延、独立复现次数、错误候选拒绝、重复验证 | 任何正确候选被 handoff/预算阻断先修控制平面 | 027--029 已修复；继续回归 |
| F10 | Pwn 持久 session、后台 shell、reproduce | pwn | session 可用与无 session 的明确降级，不把能力缺失当策略效应 | IO 同步、超时、会话复用、reproduce 成功 | broker/container 缺失必须清楚说明并给 bash fallback；不能假装有 tube | 待有可复现 pwn 语料 |
| F11 | Web session、origin scope、browser/web reproduce | web | interactive session 对 bounded curl fallback；verifier 固定 | cookie/CSRF 持续性、scope 拒绝、reproduce 成功 | target/broker 缺失归环境；请求越界归 scope，均带恢复建议 | 待有 web 语料 |
| F12 | approval、effect journal、恢复与可操作拒绝 | platform / side effect | 故障注入而非能力增益对照 | no-effect proof、批准后重试、恢复一致性、敏感信息泄漏 | 任何 bare denial 是 UX/控制平面 defect；保留 fail-closed | 拒绝反馈已补回归；待端到端 |
| F13 | Provider transport、预算和重试 | 全部真实 Provider 任务 | 固定任务下模拟 502/usage 缺失与正常对照 | 请求数、预算预留、错误后的 verifier 可达性、费用归因 | Provider 失败不得被错误标为模型失败或错误预算耗尽 | 044 发现单 Agent Loop 将连接错误误记为 `budget_exhausted`；045--046 真实 Responses 错误均正确为 `provider_error`；预算拒绝已有可操作反馈回归 |

## 4. 近期运行顺序

1. **047，F02 稳定窗口复测**：在同一 AIHub Responses profile 连续健康检查通过后，固定 046 的预算和条件重跑独立轨迹。验收是无 Provider 污染的 `binary_disassemble -> 后续模型响应 -> 候选或 verify_claim`；连接错误仍只记 F13，不能写入 F02 分母。不得把两个 curation 轨迹作效果比较。
2. **048，F04 机制 smoke**：在至少一个有证据冲突的 fixture 上 `manual` 对 `advice`，记录 curation 是否改变 verifier-ready path；未达可用工具基线的 reverse 题不混入该比较。
3. **049--052，F07/F08**：按 reverse、web、pwn 分层，先 `soft_advice` 对 `off`，最后才以单独标记的 `hard_*` 做反事实；硬模式的更高成功率也必须报告被拒绝的合法路线与损失。
4. **053--056，F05/F06**：使用长上下文、恢复和高分支语料，先检查事实保持和投影采纳，再比较成本/成功。
5. 达到每层足够 holdout 和 3--5 attempts 后再报告 Pass@k、Pass^k、分层置信区间与成本；此前只报告机制证据和修复状态。

## 5. 每次运行的记录模板

```text
实验 ID / Git revision / snapshot fingerprint:
问题与唯一变量:
固定条件：模型、Provider、thinking、语料 hash、预算、Verifier、安全边界:
能力预检：工具、schema、环境、Provider:
结果：verified/evidence-backed/replay parity/泄漏/越权/成本/延迟:
行为链：首个工具 -> 首个观察 -> 首错 -> 首候选 -> 首验证:
首错归因与证据位置:
成功比较或失败反事实:
修复假设 / 最小回归 / 复测 ID / 接受或拒绝标准:
```
