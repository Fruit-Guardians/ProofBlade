# AB-TERRA-FIRST-ACTION-053：首步建议复测

本记录与 `AblationPolicyController` 的默认认知策略修复属于同一功能 PR。它不是独立的文档 PR。

## 实验快照

- 模型：AIHub `gpt-5.6-terra`，`openai-responses`，`thinkingLevel=max`
- 代理：`http://127.0.0.1:7897`；Provider `/v1/models` probe=200，包含 Terra
- 语料：`terra-ablation-017`，1 个 `misc` verifier-ready case，hash `74ecb65eb6508b5bb150ec3a326574d376d3bfacf1185f20965ca28e48f5ac74`
- 预算：每 Variant 3 attempts，`maxTurns=2`，总上限 `$6`，deadline `900000ms`
- 唯一变量：baseline 使用默认 `firstAction=soft_advice`；candidate 使用 `firstAction=off`
- 实验快照：`AB-TERRA-FIRST-ACTION-053`，fingerprint `211698437303af4c87f5bfada27e297d13ba75cbbd74941bf25666dae5d13a38`

## 结果

| Variant | verified | Evidence-backed | replay parity | 泄漏 | Provider 请求 | Token | 成本 USD | 平均首 Evidence ms | 平均耗时 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline `soft_advice` | 3/3 | 3/3 | 3/3 | 0 | 13 | 100880 | 0.085520 | 24730.7 | 91409.7 |
| candidate `off` | 3/3 | 3/3 | 3/3 | 0 | 12 | 91484 | 0.078684 | 5719.7 | 96226.7 |

配对成功率差为 `0`；candidate 少 1 次 Provider 请求、少 9396 Token、成本低 `$0.006836`，但平均耗时高 `4817ms`，p95 高 `38541ms`。两边均为完整终态，没有 Provider/预算/工具污染，报告 gate 只因该 corpus 只有 1 个 case 而未达到正式评测的 20-case 门槛。

## 行为链与解释

六条轨迹都在第一轮完成候选验证，首工具为 `read`（baseline 第 3 次从 `bash` 开始），随后是 `bash -> verify_claim`；独立 verifier 对每个候选完成两次 reproduction。两 Variant 的 `effectiveActionRatio=1`、`factEvidenceCoverage=1`，说明成功不是模型自述，而是当前代 Evidence、独立复现和 replay parity 共同成立。

`off` 的首 Evidence 明显更早，主要因为该简单 misc 任务不触发任何首步偏离：模型可以直接读取/解码输入并验证，关闭建议没有损失。`soft_advice` 的额外 Provider 请求和更晚平均首 Evidence 来自一次轨迹多次 `verify_claim` 交互；这更像采样路径差异，而不是建议本身导致的必然开销。反过来，`off` 的 p95 更高，说明关闭认知提示并没有稳定改善 wall-clock。

## 首错与修复

052 在没有代理的 Node/undici 直连下 3 个已执行 pairing 都是 `provider_error: Request timed out.`；PowerShell 直连偶尔可返回 200，经本机代理稳定返回 200。首错属于 Provider transport，已在 #92 增加 proxyUrl 快照字段和 fingerprint 输入，旧失败不进入策略分母。

本次 053 没有失败 Attempt，也没有需要修改模型路线的首错。代码侧修复的是默认语义：旧 `DEFAULT_HARNESS_POLICY` 把 `firstAction/phaseRoute/actionBundle` 设为 hard gate，把 cognitive scaffolding 当成锁链；现在默认改为 `soft_advice/soft_advice/soft_advice`，`duplicateFailure=advice`、`circuitBreaker=adaptive`，hard 模式只作为显式消融 Variant。安全平面、Effect Journal、scope、generation、预算和 verifier 不变。

## 结论边界与下一步

053 只能支持“在一个简单 misc case 上，soft advice 与 off 都可完成；off 在过程指标上偶然更省，但没有稳定时延优势”。它不能证明首步策略的泛化收益，也不能用于选择默认策略的最终发布结论。正式结论需要 Web/Pwn/Reverse 分层、至少 20 个不泄漏 case、每 Variant 3--5 次，并记录 firstAction violation、advice 是否被采纳、首工具和首 Evidence。

下一批优先执行 F07 的 phaseRoute/actionBundle soft-vs-off smoke；若出现合法动作被拒绝，首错直接归因 Harness 并补最小回归，不通过提高 hard gate 强度掩盖模型行为。
