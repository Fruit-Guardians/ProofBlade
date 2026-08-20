# Control Store and Reducer

```json component-metadata
{
  "id": "materials-control",
  "name": "Control Store and Reducer",
  "version": "0.3.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T16:31:33.000Z",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-08-09T16:31:33.000Z",
    "lastSecurityAuditAt": "2026-08-09T16:31:33.000Z",
    "sourceHash": "867c38c5f8b13beb5755b3ce4ae0877d4b1c84a9ad6fa51c4ac19d0c6def3fb1",
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

## 开发规则与验证

事件必须可重放、序号连续、Schema 可迁移。状态变化只能通过事件进入 Reducer；Artifact 语义更新使用 `artifact_annotated`，不得改写历史原文或在 Reducer 中修改事件对象。Reasoning Graph 写入使用 node upsert、不可变 edge add 和 tree upsert；必须拒绝未知引用、重复边、环、断开的树和跨 generation 关系。新增事件要覆盖并发、重放哈希和旧数据读取。

- `PAUSED` 状态下的 `finish`、`fail`、`exhaust` 必须在 ControlStore 单写者临界区内统一拒绝，Reducer 重放执行相同策略；只有显式 `resume` 可以解除暂停。
- 需要共同成立的一组领域命令必须通过 `dispatchBatch` 在同一单写者临界区内预验证和投影；任一命令失败时不得追加部分事件或保存部分投影。
- 依赖最新 RunSnapshot 的幂等写入必须通过 `dispatchTransaction` 完成；同步 prepare 中的读取、判重、ID 生成和命令构造与批量提交共享同一按 Run 串行的临界区，禁止在回调中重入 ControlStore。
- 新 `job_queued` 命令在领域层强制携带 `backendId` 与 `backendVersion`；`job_queued_legacy` 只用于读取/迁移没有 Backend 绑定的历史事件，最终仍投影为 `job_queued`。
- Evidence ID、Artifact ID、Effect ID 与 Completion ID 都是不可覆盖的；Evidence 必须绑定当前 run/generation 的既有 Artifact，并校验所有 `dependsOn/supports/refutes` 引用。`reproduction`、`negative`、`confidence: 1`、Completion 终态和成功 finish 只能经私有 Verifier capability 提交，伪造 `lane: "verifier"` 没有权限效果。
- Completion 只能从 `PROPOSED` 原子转换一次；接受时 Evidence 必须逐条支持该 Completion，并以不同 Effect、session、attempt 与 transcript 满足 reproduction 数量。Verifier Effect 必须从纯 `PROPOSED` 初态启动，终态携带与 Task/Run/Generation/Completion/Candidate/Artifact 精确绑定的结构化 verdict；仅有 `exitCode: 0` 不能表示验证通过。成功 finish 必须显式指定 ACCEPTED Completion，最终 candidate hash、Artifact 和完整 Evidence 集合均从该 Completion 派生并写入 `finalResult`。
- `append()` 仅允许 Provider/Tool/Turn/usage telemetry；领域事件必须走命令校验，避免绕过引用和终态不变量。
- Run 目录采用 create-exclusive 锚点；重复 `runId` 不得重写 `task.json` 或截断 `events.jsonl`。Reducer 只允许 seq=1 的唯一 `run_started`，authority hash 一经锚定不可替换；公开 JSONL reader 的 append/projection write 原语还必须提交创建者 secret。`fixture_reset` 只能由 Fixture capability 单独提交，Sandbox 在实际 reset 前必须调用 `assertResetAllowed` preflight；终态、错误 authority 及 verification/report 阶段不得先改变外部 fixture 再被 ControlStore 拒绝。submission 配额按整个 Run 计数，不能用 generation bump 清零。

```powershell
npm run test:materials
```
