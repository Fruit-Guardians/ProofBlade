# Competition Play

```json component-metadata
{
  "id": "materials-competition",
  "name": "Competition Play",
  "version": "0.2.2",
  "createdAt": "2026-08-13T10:00:00+08:00",
  "updatedAt": "2026-08-18T16:00:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 0,
    "securityAuditCount": 0,
    "lastBugAuditAt": null,
    "lastSecurityAuditAt": null,
    "sourceHash": null,
    "result": "pending"
  }
}
```

## 职责

把「限时批量刷题」这件事变成可运行的东西：统一的平台 API 接缝、单题求解回路、并行调度与人机协同控制面。

## 入口与边界

- `api.ts` 是与平台之间**唯一**的接缝。未配置时用 `NotConfiguredCompetitionApi` 显式失败，绝不静默回退到假数据。
- `task.ts` 生成 `verification.kind = "platform_submission"` 的 TaskContract，标志本次由线上平台而非本地 scorer 裁定。`max_tool_calls` 只约束进入 Effect Journal 的调用（capability invoke、artifact read、fixture_score）；coding lane 的 bash/read/edit/write 与一等 MCP 工具不走 Journal，因此不计入。
- `sandbox.ts` 实现 `SandboxPort`：本地解包附件、写 `connection-info.txt`，并把 `fixture_score` effect 接到 `api.submitFlag`。
- `loop.ts` 在 **coding lane** 上驱动单题。不用 solver lane 是因为后者的工具是只读代理，跑不了真实利用、写不了解题脚本、也驱动不了反编译器 MCP。保留有界轮数、deadline、abort 与 assist 模式的「提交前停下」；去掉 phase/planner 编排和 verifier 编排——`submit_flag` 已在同一轮内完成提交并把裁定结果交回模型。
- `fleet.ts` 是有界 worker 池加控制面（优先级、逐题 auto/assist、取消、实时并发）。没有全局暂停：暂停整支队伍在限时赛里等于送分。
- `solver.ts` 把上面几件组装成一次完整运行；动态 flag 题在开环境时直接提交，不花一次模型运行。

Provider 已在单次 Prompt 内执行配置的重试策略；若最终仍返回 `stopReason=error`，竞赛循环必须立即以 `PROVIDER_ERROR` 结束该题并保留 `errorMessage`。Fleet 收到该状态后触发本次运行的 Provider 断路器，不再领取新的 pending 题；修复余额、凭据或上游故障后再次 Start 可继续 pending 队列，已经失败的诊断题不会被静默重试。

DASCTF 的错旗响应采用显式 allowlist：默认仅 `40001`，GUI 后端可由 `competition.json` 的 `wrongFlagCodes` 或 `PROOFBLADE_COMPETITION_WRONG_FLAG_CODES` 覆盖。平台请求串行发送；GET 可对 429/503 做有界重试，非幂等 POST 在平台没有幂等键的前提下禁止自动重试。

DASCTF 比赛规则要求标准 flag 只提交花括号内的内容。适配器会把完整的 `DASCTF{value}` / `flag{value}` 规范化为 `value`；已是裸答案或题目声明的其他特殊格式保持不变，避免过度改写。

## 开发规则与验证

提交路径必须经过 Effect Journal，不允许在 lane 里直接调 `api.submitFlag`。原因是计分：规则把**错误提交次数**和 **API 调用效率**作为并列指标，Journal 的 idempotency key 会把重复提交同一 flag 折叠成回放而不是第二次真实调用，事件日志同时就是这两项的账本。新增提交入口必须证明：同一 flag 重复提交只联系平台一次，且 assist 模式下完全不联系平台。

```powershell
node --import tsx --test packages/materials/tests/competition-*.test.ts
```
