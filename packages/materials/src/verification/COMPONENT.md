# Independent Verifier

```json component-metadata
{
  "id": "materials-verification",
  "name": "Independent Verifier",
  "version": "0.4.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "61ba0373c491a9b80ebe57dc517d5ac745d5aef7738293b9539103eb92c1bdc4",
    "result": "passed"
  }
}
```

## 职责

独立复现候选结果，通过隐藏 scorer 和当前 generation Evidence 决定 completion 是否接受。只有 Verifier 可以提交 `SUCCEEDED`。

## 入口与边界

- `verifier.ts` 执行配置次数的隐藏 scorer 复现并产出报告。
- `claim-verification.ts` 为普通 Coding 对话识别高风险确定性结论，从 durable Snapshot/Artifact 重建投影，并把命令执行记录进 Effect Journal。只有 Task Contract 预先绑定且精确匹配的 verifier command 才能走 Verifier-owned Sandbox；该服务会执行 `required_reproductions` 次独立 attempt 后原子接受 Completion。模型自选命令只走普通 Effect 并形成 audited observation。
- Solver/Planner 只能提出 candidate，不能确认成功。
- 生产 `AppServices.verifierJournal` 只暴露由配置 Sandbox 执行的 `execute()`；任意 executor callback 仅存在于未从 package root 导出的 test composition，模型 lane 与普通 Solver lane 均拿不到 Verifier/Fixture capability。
- 候选明文放在敏感 Artifact，事件只保留哈希和引用。
- `pwn_reproduce` 的输入仍只有模型提出的 ordered stages；target command、remote endpoint、flag path、flag rule/regex、shell marker 和 confidence 来自当前 Run 的 Task Contract/Verifier 私有策略。模型侧的 `PwnReproducer` 只产生观察，配置了容器 verifier 时由 `PwnReproductionVerifier` 在 owner=`verifier` 的新 session/process 中重新执行，并通过 `CodingClaimVerifier.executePwnReproductionEffect` 生成受信 Effect、transcript Artifact、Evidence 和 Completion verdict。
- Web clean replay 同样由 verifier capability 写入 replay `web_request` 记录；只有完整复现通过时才写入 `web_exploit_chain=reproduced`，失败重放只保留 `observed` 链与 negative Evidence。普通 lane 不能直接发出 verifier result command。
- 当 Task Contract 的 `verification.web.transport` 冻结为 `browser` 时，`BrowserReproducer` 通过应用注入的 `BrowserVerifierFactory` 获取全新、空 storage 的 BrowserContext；factory 只接收当前 run/generation、target、policy hash、scope 和响应上限，模型不能接触 driver。Replay 支持由 policy allowlist 控制的 navigation/click/fill/submit/wait；driver 未实现某动作时产生 negative verifier Evidence，`evaluate` 永不开放。`browser.max_steps/max_duration_ms/max_response_bytes` 由 verifier 约束，未配置可信 runtime 时保持 fail-closed，并复用同一 Effect/Evidence/Completion 与 domain-record 绑定。带 `BrowserRuntimeBroker` 时，资源记录额外绑定稳定 `verificationKey`；恢复服务只把精确匹配的 context handoff 交给 `BrowserReproducer`，由其复用原 replay Effect/session id，并从 durable interaction count 继续 recipe。顺序多 attempt 恢复会读取已完成 replay Artifact，再接管唯一 STARTED attempt；多个同时 in-flight 或结果不明确时保持 `RECOVERY_REQUIRED`，不新建 context。`playwright-browser-verifier.ts` 提供可选的动态 Playwright adapter：它只使用受限 page/context API，强制空 storage、headless、同源复核和幂等 close；Playwright 包或浏览器二进制缺失时应用组合层不注入 factory。
- Pwn verdict 必须同时满足结构化 stage 状态、shell marker、live flag read、candidate hash 一致性和当前 generation；失败也写入 verifier-owned negative Evidence，不能被当作成功。未配置容器或 immutable Pwn policy 时，工具保持 fail-closed，模型侧结果不会提升为受信 reproduction Evidence。
- Web/Browser/Pwn/Claim 复现开始前先写入由 `runId + generation + verifier kind + policy hash + recipe hash + source ids` 派生的 `VerificationRequest`。Web/Browser/Pwn 随后先写不绑定候选的 `verification_replay` Effect 和 immutable recipe Artifact，再创建 clean session/process；最终 `*_reproduce` Effect 才绑定 Completion、candidate 和 verifier verdict。Claim 也在最终受信命令前固定 request，并把最终 attestation 写入同一结果索引。重启后同一 key 若已绑定终态 Completion，则只重放 durable candidate/Evidence；若仍是 PENDING 或 Completion 仍为 PROPOSED，则拒绝再次打开外部 session/process，等待统一 recovery service reconcile，避免用随机 session 绕过一次性复现实验。恢复入口会把缺少 durable Effect 的请求标为 `RECOVERY_REQUIRED`，该状态只有受控 recovery capability 可写入，完成终态后才推进为 `RECOVERED`。
- Pwn/Web/Browser replay 与 Claim final attestation 统一使用有界 `VerifierOutcomeEnvelope`。信封只包含 request/generation/policy/recipe 绑定、外部状态、attempt 摘要、阶段摘要和 Artifact 索引；原始响应、tube transcript、截图和 body 仍保存在 Artifact。`replay` 信封禁止 candidate、accepted、terminal verdict 和 Evidence ID；Claim 只有在受信 Evidence/Completion 已经准备好后才生成 terminal envelope，`EffectJournal`/投影会再次校验这些绑定，防止观察结果被误当作最终证明。

## 开发规则与验证

验证失败保持显式、可重放且不泄漏 scorer 细节。修改接受条件时同步 Task Contract、评测协议和 Auto/Assist 测试。

Coding 复现命令不得包含候选明文，任务绑定命令的 stdout 必须有一行与最终候选完全相等；宽松子串扫描或模型自选命令只能作为观察，不能单独形成 reproduction Evidence。每个 verifier Effect 产出结构化 verdict，绑定 Task hash、Generation、Completion、Candidate Artifact、session、attempt 与 transcript Artifact；ControlStore 会再次核验 verdict 方向和语义绑定。`verify_claim` 必须校验传入的支撑 Evidence ID，并将其挂到执行记录、Evidence、Fact 和结果 Artifact 上；最终投影按 `completionId + candidateHash` 从 durable state 重建每一条独立复现，不得依赖进程内数组或 `assistantText.includes()`。

成功复现还必须生成以 accepted Completion 为根的结果树，并通过 `reproduces/supports/depends_on/derived_from` 边连接上游 Evidence 与复现 Artifact，供主 Agent 和 GUI 回溯完整依据。

历史事件流可以确定性补齐注册时的 run/generation/origin 以继续回放，但缺少新 provenance/verdict 的 reproduction 不会被升级为可信结论；旧式未绑定成功状态会投影为 `NEED_HUMAN / verification_missing`。

Competition 的 solved 投影只接受 `purpose: submission` 的当前 generation Completion，并逐条回查其 Evidence、`fixture_score` Effect 及 accepted verdict 的 completion/candidate/artifact 绑定；平台接受后还必须经 `verifier.finish(completionId)` 写入 `SUCCEEDED + finalResult`。任意 ACCEPTED Completion 与任意 scorer Effect 的宽松组合不能表示平台已接受，Single-agent/GUI 的终态消费也只能读取 canonical `finalResult`。

Verifier 在 `evidence + completion_verified` 已经持久化、但后续 Fact/投影步骤尚未完成时可以安全重试：对已终态 Completion，服务只从当前 generation 的受信 Evidence、完成的 verifier Effect 和绑定 verdict 重建 `VerificationOutcome`，不会再次访问平台、追加 Evidence 或重复提交。终态 Evidence 缺失、跨代、跨 Run、Artifact 未绑定或 verdict 不一致时仍 fail-closed。

```powershell
npm run eval
```
