# F09 停止建议功能与消融闭环

状态：已实现，待真实模型确认集

## 问题

`HarnessPolicy.stopSuggestion` 已经存在于消融配置和策略控制器，但 Coding Lane 没有在可信 `verify_claim` 成功后发出 `stopSuggested` 决策。因此该配置只改变 fingerprint，不能改变模型可见行为，也无法评估“完成验证后减少尾部探索”的假设。

## 修复

- 在 `attachCodingTurnGuards` 的成功 Tool Result 路径识别 `verify_claim.details.verified === true`。
- 根据 `stopSuggestion=soft_advice` 或 `verifier_driven` 写入 `AblationDecisionEvent`，包含 experiment、variant、case、turn、completionId hash 输入和 reason code。
- 返回有界的模型可见建议：保存当前 Artifact/Evidence，让外层独立 Verifier 完成，不继续无效探索。
- 建议是非阻断的；只有原本的 deferred claim 交接才保留 `terminate=true`。不会绕过 Verifier，也不会阻止合法的下一步动作。
- `stopSuggestion=off` 继续保持原行为，但仍可记录 `none:allow` 事件用于对照。

## 路线与动作包接入

同一审计还发现 `phaseRoute` 和 `actionBundle` 虽已进入 `HarnessPolicy`，Tool Hook 却没有传入 `phaseRouteViolation` 或 `actionBundleViolation`，使这些消融因子此前只有配置差异而没有运行行为。

- Coding Lane 在每个 Provider turn 前从 Control Store 刷新当前 `domainPhase` 和已发布的 action bundles。
- Tool Hook 将当前工具与本 phase bundle 和其它 phase bundle 对照：当前 bundle 外的工具产生 `action_bundle`，只属于其它 phase 的工具额外产生 `phase_route`。
- `soft_advice` 记录建议并允许调用；显式 `hard_gate` 返回现有可恢复的拒绝反馈；`off` 保留 allow 记录。
- `verify_claim`、`submit_flag`、`pwn_reproduce` 和 `web_reproduce` 是完成工具，始终豁免路线/动作包阻断，避免策略阻断独立验证。

## 机制验证

命令：

```powershell
npm run build --workspace=@proofblade/materials
node --import tsx --test packages/materials/tests/tool-repeat-breaker.test.ts packages/materials/tests/ablation-policy.test.ts
```

结果：Materials 构建成功；38 个测试通过、0 失败。新增测试验证：可信 `verify_claim` 结果产生 `stop_suggestion:advise`，建议文本进入 Tool Result，deferred 交接仍以 `toolUse` 在当前 Harness 边界终止；当前 phase 外工具在 soft mode 留下 `action_bundle:advise`，hard phase route 会阻断跨 phase 工具，而完成工具仍可调用。原有重复失败、无进展、硬门、软建议和安全边界回归全部保持通过。

## 成功与失败归因

成功样本在可信候选出现后停止继续读取和整理，保留当前 Artifact/Evidence，并让外层 Verifier 接管 Completion。它改善的是交接时机和尾部成本，不是候选本身的真实性。

失败风险是把任意字符串或未验证候选误判为“可停止”，或者把非 deferred 的正常竞争流程误终止。实现只接受 `verified === true`，并把 `terminate` 限定在原有 `deferClaimAcceptance` 语义；测试覆盖了这两个边界。

路线风险是把 action bundle 当成固定工作流，阻断已经有证据支持的替代调查或完成验证。默认仍使用 soft advice；hard mode 只作为明确消融反事实，并且完成工具始终豁免。若真实实验发现 hard mode 降低可达性，应归因 Harness route 而非模型，并保持默认建议模式。

## 后续真实消融

固定 Terra Responses/max、语料、Verifier、成本和安全边界，比较 `stopSuggestion=off`、`soft_advice` 和 `verifier_driven`。每个 Variant 至少 20 个不泄漏 Case、3--5 次尝试，记录候选到 `verify_claim`、尾部 Provider 请求、成本、p95、Evidence 覆盖和 replay parity。若建议未被模型采纳，归因模型行为；若建议早于可信验证出现，归因 Harness 并立即开修复 PR。

## 本 PR 范围

本 PR 同时包含实现、回归测试和本闭环文档。固定安全边界、独立 Verifier、候选防泄漏、generation fence、成本和取消行为没有改变。
