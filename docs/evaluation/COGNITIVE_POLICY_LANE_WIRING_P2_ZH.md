# Cognitive Policy Lane Wiring P2 实现记录

本 PR 只负责把可消融的认知策略接入 Coding Lane。它不改变安全平面，也不重新聚合 CLI、GUI、Receipt、ledger 或上下文数据库功能。

## 首错

策略定义虽然已经能区分 `allow`、`advise`、`block`、`terminate`，但 Coding Lane 之前只直接执行内置重复/无进展/首步守卫，实验 Variant 的策略快照没有进入真实 Tool Call 边界。因此消融报告无法证明某次拒绝来自哪个策略，`soft_advice/off` 也不能真正放宽认知控制。

## 修复

- `AblationPolicyBinding` 将 experiment、variant、case、attempt、turn 和策略控制器绑定到一个 lane。
- `tool_call` 和 `tool_result` 边界都记录脱敏的 `AblationDecisionEvent`，包含策略名、模式、原因码、输入 hash 和后续 Evidence/结果关联。
- `hard_gate/hard_stop` 只在显式实验 Variant 中阻断，并返回 Reason、未执行事实和 Next；`soft_advice/advice/off` 保留模型工具可达性，追加建议或审计记录。
- 认知策略可以放宽重复失败/失败风暴，但 workspace、network、secret、Effect、lease、generation、取消、预算和 Verifier 检查仍由固定安全平面执行。
- 首步计划从硬限制变为建议计数；显式 hard Variant 仍可用于反事实实验，不改变默认 Agent 的自由探索。

## 验收

- 默认策略的首步违规返回 `advise`，显式 `firstAction=hard_gate` 返回 `block`。
- `firstAction=off`、`soft_advice` 和安全违规组合均有确定性测试。
- 真实 Harness 测试验证 soft first-action advice 会记录决策但不阻断工具。
- materials build、CLI typecheck、ablation-policy 与 tool-repeat-breaker 回归通过。

## 失败/成功解释

若 hard Variant 成功率较高，只能说明该反事实路线在特定任务上减少了无效工具调用，不能说明 hard gate 适合默认使用；还必须统计被拒绝的合法路线。若 soft/off 失败，先查看 Provider、工具 schema、环境和 Verifier 事件，再判断模型是否采纳建议，不能把认知策略失效修成更严的锁链。

## 与 Terra 053 的关系

`AB-TERRA-FIRST-ACTION-053` 在固定代理的 Terra Responses/max 通道上，默认 soft advice 与 `off` 都完成 3/3 verified；off 在一个 misc case 上少 1 次 Provider 请求、少 9396 Token、成本低 `$0.006836`，但 p95 更高。该样本只证明策略可达和过程差异，不能作为泛化收益或默认策略发布结论。
