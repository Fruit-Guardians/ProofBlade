# Run Recovery

```json component-metadata
{
  "id": "materials-recovery",
  "name": "Run Recovery",
  "version": "0.1.1",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T17:39:20+08:00",
  "qualityAudit": {
    "bugAuditCount": 1,
    "securityAuditCount": 1,
    "lastBugAuditAt": "2026-08-07T17:39:20+08:00",
    "lastSecurityAuditAt": "2026-08-07T17:39:20+08:00",
    "sourceHash": "ee7b9cfae03fdbd52ffdcea2de358827736a8db7ebbf35835e9111548c483d73",
    "result": "passed"
  }
}
```

## 职责

在进程重启或中断后协调租约回收、Fixture generation 核对、Job reconciliation、普通 Effect 恢复和上下文溢出收敛；验证请求由 `VerificationRecoveryService` 单独检查，禁止通用 Sandbox 猜测性重放。

## 入口与边界

- `run-recovery.ts` 按环境、控制状态、Job、Effect 的固定顺序恢复。
- 恢复只解释 durable facts，不依赖内存中的旧对象。
- UNKNOWN 是禁止重放 Effect 的显式终态，不用猜测成功。
- verifier-owned `PROPOSED/STARTED/UNKNOWN` Effect 不由通用恢复器重跑；`VerificationRecoveryService.inspect()` 返回稳定请求的终态、待恢复和歧义状态。无 Completion/Effect 的请求在恢复入口会通过 recovery-only capability 持久化标成 `RECOVERY_REQUIRED`，重复 reconcile 是幂等的，普通/模型 lane 不能伪造该标记。Web/Browser/Pwn 现在先写一个不携带候选的 verifier-owned `verification_replay` Effect，再打开 clean session/process；其 recipe 以独立 recovery Artifact 保存，结果 Artifact 只表示外部 replay 观察，不是可信 verdict。Verifier attestation 的输入仍先登记为独立 verifier-owned recovery Artifact，`PROPOSED` 请求可在不触碰外部资源时复用原输入；`reconcile()` 还可接管唯一的 verifier 结果 Artifact，或调用显式 `VerificationRecoveryAdapter`：`PROPOSED` 适配器可以复用原 Effect 请求，`STARTED` 适配器只能查询并在确认结果后完成 Effect，无法确认时保持恢复需求。适配器由 `VerificationRecoveryAdapterRegistry` 按 verifier kind 唯一注册，并可在 fixture/generation 确认后由工厂构造，避免恢复入口持有过期外部句柄。当前默认 Claim 适配器只允许纯本地命令和 `fixture_score` 的 `PROPOSED` 重用；平台或已启动 Pwn 不会猜测重放，保持 `UNKNOWN`。Completion 终态落盘后才允许将恢复标记推进到 `RECOVERED`。
- 外部 session/container/platform environment 由 `ExternalResourceRegistry` 维护独立的有界账本，记录 immutable `runId + generation + kind + effect/request/policy/recipe` 绑定。每条记录同时持有不包含 opaque handle 的稳定 `bindingTxnId`，用于把“外部启动”和“Control Store owner”关联到同一个可重放事务。所有资源遵循 `PROPOSED → STARTED → CONFIRMED/UNKNOWN → RELEASED`；已知 opaque handle 的 session 使用 `registerStarted()` 在单次 ledger 锁内完成登记与启动标记，避免“外部动作已开始但账本仍是 proposal”的窗口。`classifyExternalBinding()` 只做纯判定：精确 OPEN owner 可 `ADOPT/RECONCILE`，缺 owner 或已关闭 owner 只能 `RELEASE`，任何身份不一致都进入 `MANUAL/UNKNOWN`。重启时先 `inspect`，只有 backend 返回精确 `MATCH` 且提供当前进程可调用 binding 才允许 `adopt`，旧 generation 只有确认归属后才 `release`，平台查询或释放失败保持 `UNKNOWN` 并可重试。`RunRecoveryService` 在本地 session orphan cleanup 前先对“精确 OPEN owner + STARTED/UNKNOWN resource + marker 缺失”执行 metadata-only marker repair，再提取 Pwn/HTTP/Browser handoff；这只修复可由两个 ledger 的 immutable identity 证明的关系，不触碰外部 backend，也不把 repair 当作 adoption。若发现 `session:<id>` 没有对应 Control Store session，则只尝试精确 release，失败保持 UNKNOWN，绝不 adopt 到新 lane。`SessionRegistry`、`HttpSessionBackend` 和 `BrowserContextBackend.adoptExisting()` 复用原 session id，唯一 `PiCodingLane` 接管后才开放工具。Pwn binding 必须携带理解 opaque handle 的 session runtime，HTTP binding 必须携带 broker-owned `fetchImpl`；HTTP session 还可以注入幂等的 `externalRelease` 端口，在 Control Store owner 写入失败或 session 关闭时释放精确 broker handle，失败则保留 `UNKNOWN` 交给 registry 重试。Browser binding 必须携带 broker-owned context。Browser verifier 会把稳定 `verificationKey` 写入资源绑定；恢复时同一 in-flight replay Effect 只允许从已完成的 interaction 索引继续 recipe，不创建第二个 context。Browser broker 的 inspect/adopt/release 调用有默认 15 秒且可配置的超时，超时只产生 `UNKNOWN`，不会放宽归属检查。Pwn/Web/Browser SessionRegistry、Docker label adapter、BrowserRuntimeBroker、SessionRuntimeBroker adapter 与 CompetitionEnvironmentJanitor 已支持可选接入；默认账本位于 `.proofblade/external-resources.json`，不污染 `runs/` Run 命名空间。没有 broker 或没有可用 binding 的进程内 Docker/HTTP/Playwright 资源不会被伪造为可接管资源。

`session-runtime-wire.ts` 同时提供 Pwn/HTTP 的版本化 create/open、health、lifecycle/action wire（含有界 lease heartbeat）、远程 HTTP fetch/Pwn runtime proxy；敏感请求头和响应头（包括 `set-cookie`）在跨进程边界脱敏，请求/响应体有硬上限，响应按流读取并在超限时取消底层 reader，客户端断开会传播 AbortSignal。`DurableSessionRuntimeService` 将 create reservation、幂等 key、跨进程锁、精确 immutable binding、STARTING 崩溃恢复、可续期租约和 release 状态持久化到独立账本；heartbeat 与每次远程 Pwn/HTTP 动作都必须先通过精确绑定和未过期租约，过期动作 fail-closed，而 release 仍可查询并回收精确句柄。实际 socket/process 必须由注入的 `SessionRuntimeHost` 提供，服务不会猜测、伪造或替换会话。`stableAcrossRestart=true` 只有在 host 同时提供 `inspectByIdempotency()` 时才会被接受，否则 health 强制降级，避免把无法证明的 host 当成可恢复运行时。`BindingTransactionCoordinator` 进一步把 session 的 external STARTED、Control Store owner 和最终 `BOUND` marker 串成可重放的 PREPARE/CONTROL_COMMITTED/BOUND intent；恢复只修复可证明的 metadata，真正的 inspect/adopt/release 仍由 broker 完成。`scripts/session-runtime-service.ts` 提供带 Bearer 鉴权的部署入口，health 在 host 没有稳定恢复能力时明确返回 `DEGRADED/stableAcrossRestart=false`。Coding lane 在创建任何 Provider 回合前执行一次 broker health/capability preflight；只有 `READY`、声明目标 kind 且 `stableAcrossRestart=true` 的 broker 才进入活动组合。已配置但降级、能力不匹配、鉴权/网络失败的 broker 会按 kind fail-closed，不能静默退回本地 Docker 或进程内 HTTP。

Runtime host 语义补充：若 host 未提供专用 heartbeat，服务会先用同一 immutable binding 调用精确 `inspect`，只有返回当前 opaque handle 的 `PRESENT` 才能续租；health 也会核对声明的每个 session kind 是否具备完整 action 实现，缺失时返回 `DEGRADED`，而不是把仅能创建/查询的 host 暴露给 Coding lane。

部署自检补充：`preflightConfiguredRuntimes()` 只读取 Browser、HTTP-session、Pwn-session 的 health/capability，不创建外部资源；未配置的 broker 明确返回 `NOT_CONFIGURED`，已配置但缺凭据、不可达、非 `READY` 或不具备 `stableAcrossRestart` 的 broker 返回 `UNAVAILABLE`。CLI 的 `runtime selfcheck` 将该结果以脱敏 JSON 输出，并以退出码 2 阻断不完整部署，避免启动后才由模型回合暴露 runtime 降级。Competition solver 会按题目方向选择必需 kind，并将一次性的 `SessionRuntimePreflight` 传给 lane，避免重复 health 请求；Session Runtime 服务默认允许以 `degraded` 状态启动用于诊断，但生产入口应使用 `--require-ready` 或 `PROOFBLADE_SESSION_RUNTIME_REQUIRE_READY=1`，在绑定端口前拒绝非 `READY` host。

恢复顺序补充（2026-08-27）：`RunRecoveryService` 先处理无 Control Store owner 的精确 release，再执行外部资源 inspect/adopt，最后才由 `BindingTransactionCoordinator` 补写缺失的 Control Store 绑定。`STARTED/UNKNOWN` 即使与 OPEN owner 的 immutable identity 相符，也只能进入 `MANUAL/UNKNOWN`；只有 backend 已确认资源，或已经存在精确 control-session marker，才允许事务进入 `BOUND`。

绑定事务补充：backend 精确 `inspect → adopt` 成功后，协调器会持久化 `EXTERNAL_CONFIRMED` 中间态，再推进 `CONTROL_COMMITTED → BOUND`。该 marker 用来区分“外部句柄已经确认但 Control Store marker 尚未写完”和“外部句柄仍未知”，恢复不能跳过这一区分。

参考 HTTP Host：`session-runtime-http-host.ts` 提供 `DurableHttpSessionRuntimeHost`，将 Cookie/CSRF 状态以 AES-GCM 加密保存于 Host 私有账本，支持幂等 create、精确 scope、跨进程 inspect/adopt、bounded response stream 和幂等 release。缺少状态密钥时只返回 `DEGRADED/stableAcrossRestart=false`；它只声明 `http-session` 能力，不伪造 Pwn supervisor。Pwn 的 `DurablePwnSessionSupervisor` 则把实际本地子进程、部署固定容器内的 `docker exec` 或显式 allowlist 的远程 raw TCP socket 交给独立 detached worker，监督器账本只保存 opaque handle、worker 端口、幂等请求和 transcript-state 路径，RPC token 通过 0600 私有文件传递且 release 后清理；服务重启通过同一 externalId inspect/adopt，缺失 worker 返回 `UNKNOWN`，绝不重新执行 command；worker 自身若带有既存 transcript-state 会拒绝重复拉起 child/transport。Host-local command 默认拒绝，Docker container/command 由部署固定并校验 allowlist，远程 endpoint 还必须匹配部署 host/port scope，远程请求中的 command 不会被 worker 执行，避免模型输入变成宿主机任意执行或 SSRF。部署入口为 `scripts/session-runtime-http-host.ts`、`scripts/session-runtime-pwn-host.ts` 与 `scripts/pwn-supervisor-host.ts`；若一个服务端点同时承载两类会话，应使用 `scripts/session-runtime-combined-host.ts`，它按不可变 `request.kind` 分派生命周期和 action，并且只有 HTTP/Pwn 两个底层 host 都稳定时才报告整体 `READY`。Pwn/HTTP 仍按各自 capability 做 fail-closed 预检。

## 开发规则与验证

新增中断点必须证明重复执行收敛、旧 generation 隔离且投影哈希一致。恢复顺序变化需要同步恢复文档。

```powershell
node --import tsx --test packages/materials/tests/*recovery*.test.ts
```
