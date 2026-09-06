# Competition Play

```json component-metadata
{
  "id": "materials-competition",
  "name": "Competition Play",
  "version": "0.2.4",
  "createdAt": "2026-08-13T10:00:00+08:00",
  "updatedAt": "2026-08-21T00:00:00+08:00",
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
- `api-journal.ts` 是可选的同一接缝记录层：生产 GUI 将列表、详情、启动、远端查询、提交和停止请求及其响应/错误按序写入私有 JSONL；离线 replay 只消费记录并校验参数摘要，不触碰平台。
- `task.ts` 生成 `verification.kind = "platform_submission"` 的 TaskContract，标志本次由线上平台而非本地 scorer 裁定；平台附件和生成的 `connection-info.txt` 以相对路径与 SHA-256 写入 `inputs`，让 prompt、任务哈希和 replay 绑定真实可见输入。`max_tool_calls` 只约束进入 Effect Journal 的调用（capability invoke、artifact read、fixture_score）；coding lane 的 bash/read/edit/write 与一等 MCP 工具不走 Journal，因此不计入。
- `sandbox.ts` 实现 `SandboxPort`：本地解包附件、写 `connection-info.txt`，并把 `fixture_score` effect 接到 `api.submitFlag`。
- `loop.ts` 在统一 **coding lane** 上驱动一个受控安全目标。Fixture 自动执行和平台运行共享同一套 `read`/`bash`/编辑/能力/MCP 工具；平台运行只额外注入外部目标边界和 `external_submit`，保留有界轮数、deadline、abort 与 assist 模式的「提交前停下」。
- `fleet.ts` 是有界 worker 池加控制面（优先级、逐题 auto/assist、取消、实时并发）。没有全局暂停：暂停整支队伍在限时赛里等于送分。
- `environment-janitor.ts` 在 `startEnvironment()` 前占用容量槽，并将 instance/expiry 写入挑战工作区之外的持久账本；绑定 challenge 的 reservation 还会持久化稳定 `idempotencyKey`，启动前进入 `STARTING`，重启时只有远端按同一 key 和 challenge 精确回显才允许 adopt。正常结束和过期 sweep 走同一个 stop 路径；live composition 开启远端精确检查后，只有 ACTIVE 精确匹配才调用 stop，ABSENT 直接关闭本地容量记录，UNKNOWN/mismatch 保留给下一次恢复重试。
- `CompetitionEnvironmentJanitor` 可把平台环境同步到共享 `ExternalResourceRegistry`；`CompetitionEnvironmentResourceAdapter` 只把 janitor 已确认的同 owner/instance/key 记录标为 `MATCH`，恢复时可 adopt，跨 Run 或 instance/key 不匹配时保留 `UNKNOWN`。平台提供 `inspectEnvironment` 时必须再通过集中式 `CompetitionEnvironmentIdentityCapabilities` 检查：只有声明为跨重启稳定且精确匹配的 `instance-id`/`idempotency-key` 才能 adopt 或 release，缺字段是 `UNKNOWN`；没有远程查询默认也保持 `UNKNOWN`，只有显式 `allowLedgerOnlyRecovery` 才允许兼容旧的本地账本模式。通用 HTTP 适配器支持 `Idempotency-Key` header，并允许查询 endpoint 使用 `{challengeId}`、`{instanceId}` 或 `{idempotencyKey}` 路径占位符；DASCTF 明确是 `challenge-only` 且不回显稳定 key，因此只能观察，不能跨重启自动 adopt。
- Coding lane 可接收 `ApprovalPolicy`；当外部提交或平台提供的动态结果需要批准时，只记录 pending approval 并停止在提交前，不触碰平台 API。
- `solver.ts` 把上面几件组装成一次完整运行；平台提供的动态结果可以走无模型的受控提交路径，但仍创建 Run、候选 Artifact、`fixture_score` Effect 和 verifier 终态。生产 GUI 的 live backend 为每个 API/solver pair 共享一份 janitor，避免 Fleet 并发超过平台环境上限。
- `solver.ts` 在平台环境返回后按题目 `target_kind` 预检必需的 session broker，并把同一份只读 `SessionRuntimePreflight` 传入 coding lane；lane 不重复请求 health。无关 kind 不扩大故障域，动态 flag 仍完全跳过 session runtime。
- 通用 `HttpCompetitionApi` 与 DASCTF adapter 的 JSON envelope 通过共享有界流读取器分块消费；超过 `maxResponseBytes`（默认 8 MiB）会取消底层 reader，避免 `response.text()` 在异常大响应上先分配完整正文。

Provider 已在单次 Prompt 内执行配置的重试策略；若最终仍返回 `stopReason=error`，竞赛循环必须立即以 `PROVIDER_ERROR` 结束该题并保留 `errorMessage`。Fleet 收到该状态后触发本次运行的 Provider 断路器，不再领取新的 pending 题；修复余额、凭据或上游故障后再次 Start 可继续 pending 队列，已经失败的诊断题不会被静默重试。

比赛平台的鉴权、限流、服务和环境 provisioning 故障以 `PLATFORM_ERROR` 结束当前题，并触发同一 Fleet 断路器，避免继续消耗所有 pending 题。`startEnvironment()` 抛错时也必须按 challenge id 做一次 best-effort teardown，因为 build POST 可能已经成功而 readiness 轮询随后失败。

可明确归因于单题的 ID、详情 payload 或附件错误使用 `CompetitionChallengeError`，在 Solver 中映射为 `CHALLENGE_ERROR`，只失败当前题而不触发全局熔断；对旧适配器抛出的可识别附件/详情错误，以及响应正文明确写出题目不存在/无效的 GET 详情 400/404/410/422，也会在 Solver 边界归类为单题错误。路由不存在、统一错误页和未指明题目的 404 保持 `PLATFORM_ERROR`，避免鉴权、配置或共享服务故障扩散到所有 pending 题。

DASCTF 的错旗响应采用显式 allowlist：默认仅 `40001`，GUI 后端可由 `competition.json` 的 `wrongFlagCodes` 或 `PROOFBLADE_COMPETITION_WRONG_FLAG_CODES` 覆盖。平台请求串行发送；GET 可对 429/503 做有界重试，非幂等 POST 在平台没有幂等键的前提下禁止自动重试。

DASCTF 比赛规则要求标准 flag 只提交花括号内的内容。适配器会把完整的 `DASCTF{value}` / `flag{value}` 规范化为 `value`；已是裸答案或题目声明的其他特殊格式保持不变，避免过度改写。

## 开发规则与验证

提交路径必须经过 Effect Journal，不允许在 lane 里直接调 `api.submitFlag`。原因是计分：规则把**错误提交次数**和 **API 调用效率**作为并列指标，Journal 的 idempotency key 会把重复提交同一 flag 折叠成回放而不是第二次真实调用，事件日志同时就是这两项的账本。新增提交入口必须证明：同一 flag 重复提交只联系平台一次，且 assist 模式下完全不联系平台。

```powershell
node --import tsx --test packages/materials/tests/competition-*.test.ts
```
