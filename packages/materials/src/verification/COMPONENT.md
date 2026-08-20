# Independent Verifier

```json component-metadata
{
  "id": "materials-verification",
  "name": "Independent Verifier",
  "version": "0.4.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T22:20:18.1243188+08:00",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-07T22:20:18.1243188+08:00",
    "lastSecurityAuditAt": "2026-08-07T22:20:18.1243188+08:00",
    "sourceHash": "2f9990a5bf7d09f8ff1c8b851c1f0e9f467bd2ef0e17d522d6a28035bf9cf7a7",
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
- `pwn_reproduce` 只能是 harness 内部的受信 Verifier operation，不是模型可直接选择成功规则的普通 Tool。模型不得提供或覆盖 target command、remote endpoint、flag path、flag rule/regex、shell marker 或 confidence；这些必须来自已绑定当前 run/generation 的 Task Contract 或 Verifier 私有策略，并经 Effect Journal 和不可变 Artifact 留下完整执行来源。
- 当前仓库中尚不存在 `runtime/pwn-coding-tools.ts` 和 `verification/pwn-reproducer.ts`，因此 `pwn_reproduce` 能力保持未接入；不得将未追踪的 `capabilities/pwn.ts` 或模型执行输出提升为受信 reproduction Evidence。

## 开发规则与验证

验证失败保持显式、可重放且不泄漏 scorer 细节。修改接受条件时同步 Task Contract、评测协议和 Auto/Assist 测试。

Coding 复现命令不得包含候选明文，任务绑定命令的 stdout 必须有一行与最终候选完全相等；宽松子串扫描或模型自选命令只能作为观察，不能单独形成 reproduction Evidence。每个 verifier Effect 产出结构化 verdict，绑定 Task hash、Generation、Completion、Candidate Artifact、session、attempt 与 transcript Artifact；ControlStore 会再次核验 verdict 方向和语义绑定。`verify_claim` 必须校验传入的支撑 Evidence ID，并将其挂到执行记录、Evidence、Fact 和结果 Artifact 上；最终投影按 `completionId + candidateHash` 从 durable state 重建每一条独立复现，不得依赖进程内数组或 `assistantText.includes()`。

成功复现还必须生成以 accepted Completion 为根的结果树，并通过 `reproduces/supports/depends_on/derived_from` 边连接上游 Evidence 与复现 Artifact，供主 Agent 和 GUI 回溯完整依据。

历史事件流可以确定性补齐注册时的 run/generation/origin 以继续回放，但缺少新 provenance/verdict 的 reproduction 不会被升级为可信结论；旧式未绑定成功状态会投影为 `NEED_HUMAN / verification_missing`。

Competition 的 solved 投影只接受 `purpose: submission` 的当前 generation Completion，并逐条回查其 Evidence、`fixture_score` Effect 及 accepted verdict 的 completion/candidate/artifact 绑定；平台接受后还必须经 `verifier.finish(completionId)` 写入 `SUCCEEDED + finalResult`。任意 ACCEPTED Completion 与任意 scorer Effect 的宽松组合不能表示平台已接受，Single-agent/GUI 的终态消费也只能读取 canonical `finalResult`。

```powershell
npm run eval
```
