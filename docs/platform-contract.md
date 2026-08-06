# Competition platform contract

ProofBlade 的正式比赛模式是无人值守运行。Host 通过 `CompetitionPlatformPort` 获取比赛状态、题目和附件，并在独立验证后提交候选答案；模型、Skill、MCP 和目标进程都不能读取平台凭据或直接调用提交接口。

## 领域边界

平台层维护以下外部事实：

- `ContestSnapshot`：比赛状态、服务端时间、起止时间和当前得分。
- `PlatformChallenge`：题目修订版本、分类、分值、状态和附件元数据。
- `PlatformAttachmentRef`：附件名称、大小、媒体类型和内容哈希，不包含带认证信息的 URL。
- `PlatformSubmissionReceipt`：提交哈希、平台引用、状态、冷却时间和得分。

题目求解仍由每题的 CTF Control Store 管理。后续 Portfolio Scheduler 只保存平台对象的稳定 ID、revision 和调度状态，不复制认证会话。

## 提交协议

候选答案必须先进入敏感 Artifact，再由 Verifier 和 Submission Guard 产生 Host 命令。模型只能提出候选，不能直接持有 `CompetitionPlatformPort`。

```text
candidate proposed
-> evidence policy satisfied
-> submission effect proposed/started
-> platform submit
-> receipt persisted
-> submission effect finished
-> challenge/scoreboard reconciliation
```

本地 `attemptKey` 用于关联 Effect 和平台历史，不能假设平台会把它当作服务端幂等键。进程可能在平台已处理提交、客户端收到响应之前崩溃；恢复时必须先执行 `reconcileSubmission()`：

- `CONFIRMED`：采用平台回执，不重复提交。
- `ABSENT`：平台确认没有该次提交后，策略层才可创建新的 attempt。
- `UNKNOWN`：保持未知并重新同步题目/提交历史；不能把未知解释成失败后直接重试。

`WRONG`、`DUPLICATE`、`COOLDOWN` 和 `REJECTED` 都是平台业务结果，不应伪装成传输异常。认证失败、限流、平台不可用和协议错误使用结构化 `CompetitionPlatformError`。

## 无人值守策略

正式比赛 Profile 不允许 `ask_human`、`NEED_HUMAN` 或无限暂停。遇到无法继续的单题状态时，策略层应按顺序执行：重试可恢复错误、切换能力或模型、否决当前路线、降低题目优先级，最后把该题标记为 `BLOCKED` 并继续其他题目。

Assist 模式仅用于开发和回放，不进入比赛部署配置。

## 平台模拟器

`CompetitionPlatformSimulator` 是确定性的测试 adapter。它隐藏标准答案，提供哈希附件，并模拟：

- 正确、错误和重复提交；
- 服务端冷却时间；
- 平台提交已落地但响应丢失；
- attempt key 冲突；
- 比赛起止时间和得分变化。

后续 Contest Evaluation 使用该模拟器验证从题目同步到 accepted 的整场闭环。真实平台 adapter 必须用同一组 contract tests，并增加认证刷新、分页、限流、附件下载中断和平台协议差异测试。
