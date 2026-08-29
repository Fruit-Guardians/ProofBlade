# Control Store and Reducer

```json component-metadata
{
  "id": "materials-control",
  "name": "Control Store and Reducer",
  "version": "0.3.5",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 5,
    "securityAuditCount": 5,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "1537621b06d101e36a1de3f92447524bc593c49559b2fb1db843d4b56540183a",
    "result": "passed"
  }
}
```

## 职责

维护 Run 的只追加事件、单写者序列、投影、阶段机和租约。Reducer 是 RunSnapshot 的唯一派生入口，也是业务完成状态的权威控制平面。

## 入口与边界

- `control-store.ts` 负责受校验的领域命令、telemetry-only raw append、snapshot 与 replay；`ControlStore.create()` 通过 ECMAScript 私有工厂拆分普通 Control、Verifier 结果、Verifier Effect 与 Fixture 生命周期 capability。每个 Run 在 `run_started` 时锚定创建者的 authority hash；JSONL/Projection 写入必须证明相同 secret。默认 secret 为进程内随机值；需要可信跨进程恢复时，harness 必须通过 `authoritySecret`（CLI/GUI 对应 `PROOFBLADE_CONTROL_AUTHORITY`）显式注入同一个至少 32 字符的 credential，错误或缺失 credential 只能读取、不能写既有 Run。结果端口在运行时拒绝 Effect 命令，Effect 端口也不能写 Evidence/Completion，二者都不得进入模型 lane。
- `reducer.ts` 应用事件；`phase-machine.ts` 校验阶段转换；`lease-manager.ts` 处理所有权。
- 不直接执行外部 Effect，不保存 Provider 消息正文。
- `app-server.ts` 是对 GUI/外部控制面的稳定边界，只提供 Run 读取、事件游标分页/订阅和审批查询/批准；不得把 ControlStore 的任意写原语直接暴露出去。
- `security/approval-policy.ts` 负责受保护副作用的持久化审批，资源明文只在进程内使用，账本保存摘要哈希并默认 fail-closed。

## 开发规则与验证

事件必须可重放、序号连续、Schema 可迁移。状态变化只能通过事件进入 Reducer；Artifact 语义更新使用 `artifact_annotated`，不得改写历史原文或在 Reducer 中修改事件对象。Reasoning Graph 写入使用 node upsert、不可变 edge add 和 tree upsert；必须拒绝未知引用、重复边、环、断开的树和跨 generation 关系。新增事件要覆盖并发、重放哈希和旧数据读取。

- `PAUSED` 状态下的 `finish`、`fail`、`exhaust` 必须在 ControlStore 单写者临界区内统一拒绝，Reducer 重放执行相同策略；只有显式 `resume` 可以解除暂停。
- 需要共同成立的一组领域命令必须通过 `dispatchBatch` 在同一单写者临界区内预验证和投影；任一命令失败时不得追加部分事件或保存部分投影。
- Verifier 结果端口允许精确重试已持久化的 Evidence/终态 Completion，但只做严格内容匹配后的 no-op；同一 ID 的内容、方向、引用或 Evidence 集合发生变化会拒绝，不能借幂等语义覆盖旧结论。
- 依赖最新 RunSnapshot 的幂等写入必须通过 `dispatchTransaction` 完成；同步 prepare 中的读取、判重、ID 生成和命令构造与批量提交共享同一按 Run 串行的临界区，禁止在回调中重入 ControlStore。
- 新 `job_queued` 命令在领域层强制携带 `backendId` 与 `backendVersion`；`job_queued_legacy` 只用于读取/迁移没有 Backend 绑定的历史事件，最终仍投影为 `job_queued`。
- Evidence ID、Artifact ID、Effect ID 与 Completion ID 都是不可覆盖的；Evidence 必须绑定当前 run/generation 的既有 Artifact，并校验所有 `dependsOn/supports/refutes` 引用。`reproduction`、`negative`、`confidence: 1`、Completion 终态和成功 finish 只能经私有 Verifier capability 提交，伪造 `lane: "verifier"` 没有权限效果。
- Verification request 的 `RECOVERY_REQUIRED/RECOVERED` 标记只能经 recovery-only capability 写入；它们是事件流中的审计状态，不授予模型或 GUI 任何完成权限，且恢复标记不能跨 generation 延续。
- `evaluatePhaseGate(snapshot, phase)` 是可重放的阶段门禁纯函数；它只依据当前 generation 的 Observation/Evidence/Hypothesis/Experiment、Verifier verdict 和 Executor WorkItem 判断缺口，并把旧 generation 标为 `stale`。`SUBMIT` 的成功 finish 必须再次通过该门禁，GUI/Context 只读展示其缺口与 `phaseBudget` 的剩余额度，不能把展示值写回 Run。
- Completion 只能从 `PROPOSED` 原子转换一次；接受时 Evidence 必须逐条支持该 Completion，并以不同 Effect、session、attempt 与 transcript 满足 reproduction 数量。Verifier Effect 必须从纯 `PROPOSED` 初态启动，终态携带与 Task/Run/Generation/Completion/Candidate/Artifact 精确绑定的结构化 verdict；仅有 `exitCode: 0` 不能表示验证通过。成功 finish 必须显式指定 ACCEPTED Completion，最终 candidate hash、Artifact 和完整 Evidence 集合均从该 Completion 派生并写入 `finalResult`。
- `append()` 仅允许 Provider/Tool/Turn/usage telemetry；领域事件必须走命令校验，避免绕过引用和终态不变量。
- 多命令领域批次写入使用同步临时文件加原子替换，而不是直接追加半个 JSONL 批次；常见单事件写入保持同步追加吞吐。进程在提交后、Projection 写入前退出时，事件流仍可完整重放。`ControlStore.reconcileProjection()` 以事件流为事实来源修复过期或损坏的 Projection，且对 `LEGACY-UNTRUSTED` Run 保持只读。
- Control Store 的完整读-校验-事件-Projection 事务还必须持有 Run 目录下的跨进程文件锁；锁使用 create-exclusive token、owner PID 和 stale reclaim，活跃 owner 不得被抢占。单个进程内的 `KeyedOperationQueue` 只负责降噪，不能替代跨进程协调。所有基于最新快照构造序号的写入必须在锁内重新读取事件流，避免两个进程生成相同 `seq` 或用旧 Projection 覆盖新状态。
- Web/Pwn 领域记录通过 `domain_record_added` 进入同一 Control Store；记录只保存有界结构化元数据和 Artifact/Evidence/Effect 引用，必须匹配当前 generation 与任务方向，不能用模型权限写入 Web `reproduced` 结论。
- 观察队列不写入第二个状态文件：`acknowledgeObservations()` 在同一 Run 写锁内把实际消费的源事件转换为 `observation_consumed`，先 reduce 再保存 Projection，使 `lastSeq` 与事件流保持一致；重复确认只产生一次标记。
- Broker-owned session 的 Control Store owner 使用可选 `bindingState` fence：`session_opened` 只能由 binding authority 写入 `FINALIZING`，external ledger marker 成功后再由同一 Run 锁内的 `session_binding_completed` 转为 `BOUND`；旧记录默认无 fence。关闭或恢复不能跳过该事件，也不能凭 marker 单独伪造 BOUND。
- Run 目录采用 create-exclusive 锚点；重复 `runId` 不得重写 `task.json` 或截断 `events.jsonl`。Reducer 只允许 seq=1 的唯一 `run_started`，authority hash 一经锚定不可替换；公开 JSONL reader 的 append/projection write 原语还必须提交创建者 secret。`fixture_reset` 只能由 Fixture capability 单独提交，Sandbox 在实际 reset 前必须调用 `assertResetAllowed` preflight；终态、错误 authority 及 verification/report 阶段不得先改变外部 fixture 再被 ControlStore 拒绝。submission 配额按整个 Run 计数，不能用 generation bump 清零。

```powershell
npm run test:materials
```
