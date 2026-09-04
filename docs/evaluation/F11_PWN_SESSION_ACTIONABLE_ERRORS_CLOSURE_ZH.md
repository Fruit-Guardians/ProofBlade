# F11 Pwn Session 可恢复反馈闭环

状态：已实现，待真实 Pwn 确认集

## 问题

Pwn 交互的安全边界必须拒绝缺少 endpoint、越界 endpoint、未知/已退出 session、缺少 broker 和无证据 primitive 记录。但裸错误只告诉模型“失败”，没有说明动作是否触发、已有状态是否保留或怎样继续，容易重复同一请求。

## 修复

- `PwnToolHandler` 对模型入口统一返回 `Reason`、`The requested action was not executed` 和 `Next`。
- endpoint 解析/host/port scope、broker unavailable、unknown/exited session、primitive 描述/confidence/supporting ids 和 target-kind 不匹配都给出针对性恢复路径。
- 真实二进制 payload、session lease、进程组回收、generation fence、clean reproduction 和 Verifier authority 保持不变。
- repeat gate 拒绝包含失败次数、repeat key、改变假设/输入、记录 Evidence 或新授权 Run 的建议。

## 验证

```powershell
npm run build --workspace=@proofblade/materials
node --import tsx --test packages/materials/tests/pwn-tools.test.ts packages/materials/tests/pwn-coding-tools.test.ts packages/materials/tests/competition-convergence.test.ts
```

结果：Materials 构建成功；相关回归 33/33 通过。覆盖 Pwn coding tools、base64 二进制字节、session 生命周期、broker/recovery、unknown/exited session、scope、primitive provenance、reproduction barrier 和 repeat gate。

## 首错归因与后续实验

裸 Pwn 拒绝属于 `harness_feedback/tool_schema`，不是模型推理失败。若 endpoint 或 session 状态有效，Pwn 工具仍可继续；若边界拒绝，模型应采纳 `Next` 改用 bounded bash、`pwn_list`、新 session、合法 scope 或补充 Artifact/Evidence。真实确认集固定 Terra/Provider、Pwn 语料和安全边界，比较 Pwn session 与 background shell 的协议同步、timeout、marker 命中、重复调用、clean reproduction 和成本。

本 PR 同时包含实现、回归测试和本闭环文档；不单独提交文档变更。
