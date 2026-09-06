# C4 评测 deadline 与取消清理闭环

状态：已实现，已用于后续 Terra smoke

## 问题

真实消融 `AB-TERRA-RECALL-022` 的首轮 Provider 请求曾返回 200，但 Windows 工具调用在 deadline 后没有让外层 `lane.prompt()` 返回；后续 pairing 被占用或等待并发槽位，六条记录都无法比较。该失败属于评测 Harness/环境，不是 Recall 失败。

## 修复

- `SingleAgentLoop` 将 caller-owned `AbortSignal` 与正在等待的 `lane.prompt()` 竞争。
- deadline 触发时仍先调用 `lane.abort()` 进行协作式资源释放；即使 Provider 或工具忽略 abort 且 prompt 永不 settle，外层 Run 也会终止并记录 `budget_exhausted`。
- 晚到的 Provider/tool rejection 由 wrapper 吸收，避免在 Run 已终态后形成未处理 rejection。
- `finally` 阶段对 `lane.close()` 和 tool runtime cleanup 使用独立 2 秒上限；超时被记录为 cleanup timeout，不会重新阻塞 Run，也不会把迟到的 close rejection 变成未处理 rejection。
- 既有公平 deadline 分片保持不变：严格配对运行不会让前一条 stall 消耗整个实验 deadline。

## 验证

```powershell
npm run build --workspace=@proofblade/materials
node --import tsx --test packages/materials/tests/real-model-evaluator.test.ts
```

结果：Materials 构建成功；新增回归使用一个 `close()` 永不 settle 的 Lane，Run 在 5 秒内仍返回 `EXHAUSTED`；原有 deadline abort、严格配对公平 deadline、Provider diagnostics、预算/失败分类和 replay 测试保持通过。

## 真实复测证据

修复后 `AB-TERRA-RECALL-023/024` 和 `AB-TERRA-CURATION-050/051` 均完成 Provider -> Tool -> `verify_claim` 路径，没有重现 `RECALL-022` 的 deadline starvation。Provider 502 仍单独分类为 `provider_error`，不能被错误写作 Harness 或策略失败。

## 后续

每个 live pairing 继续保留 experiment deadline、case deadline、request epoch、queue/retry、Provider/Tool 首错和 run terminal category。任何未完成 pairing 先按 C4 诊断，再进入 Recall/Curation/其他认知策略的因果分母。

本 PR 同时包含实现、回归测试和本闭环文档；不单独提交文档变更。
