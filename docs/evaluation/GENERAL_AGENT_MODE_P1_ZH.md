# 通用 Agent 模式 P1 实现记录

本功能对应“移除 CTF 模式并统一为通用 Agent Harness”计划的 P1 第一项：让普通 Coding Assistant 不因领域标签或用户措辞被隐式切换到 CTF 工作流。代码、测试和本文档属于同一个功能 PR。

## 变更范围

- `isChallengeTask()` 只把显式的非 `coding_assistant` 任务模式视为挑战流程；`target_kind=web/reverse/pwn/...` 只是能力与评估标签。
- `PiCodingLane` 不再使用当前用户消息文本调用 `isLikelyCtfPrompt()` 改写本轮运行模式。普通请求里出现 `challenge`、`flag` 或 `reverse` 不会自动增加首步、Phase、Action Bundle 或 CTF fast path 文本。
- 显式 `ctf_solve`、平台提交任务或调用方传入 `challengeProfile` 仍保持原有 verifier、scope、Effect、generation、预算和候选保护。

## 首错归因

此前领域属性和 CTF 认知策略耦合在运行时：普通任务只要带 `target_kind`，或者用户讨论 feature flag/challenge，就可能收到领域工作流提示。首错属于 Harness 认知路由，不是模型推理或安全边界。它会让合法的文件读取、编辑、测试路径被额外流程噪声占用，且使消融实验把隐式模式切换误算成策略效果。

## 设计取舍

安全平面不受影响：路径、网络、凭据、Effect Journal、取消、预算和 Verifier 仍在工具执行层强制检查。CTF 能力也没有删除；用户可以创建显式挑战任务，或由调用方绑定挑战 Profile。普通 Agent 现在按任务目标自主选择能力，领域标签只影响可选能力推荐与评估分层。

## 验收与复测

- `coding-resources.test.ts` 保留显式 CTF 任务为 challenge path，同时断言 `coding_assistant + web` 不再是 challenge task。
- 普通 coding 的提示词路径不再由用户消息二次切换；现有 CTF guidance 测试继续通过。
- `npm run build --workspace=@proofblade/materials`
- `npm run typecheck --workspace=@proofblade/cli`
- `node --import tsx --test packages/materials/tests/coding-resources.test.ts`
- `npm run check:components`

## 当前边界

这项 PR 只移除隐式模式切换，不重命名 `verify_claim`、`submit_flag` 或 CTF 兼容 CLI。后续独立 PR 再处理通用 `verify_result`、统一任务入口、Context Database 与 GUI 状态；每项都会保留 CTF Fixture 作为可选领域能力和回归样本。
