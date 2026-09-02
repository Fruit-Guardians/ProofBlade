# Tool Result Receipt P1 实现记录

本功能对应 Harness 对比计划、OpenViking 风格上下文计划的 P1：模型必须直接看到大结果的状态和回取入口。代码、测试、组件说明和本文档属于同一个功能 PR。

## 首错归因

此前 `read`/`bash` 会将完整输出写入 Artifact，Artifact ID 主要停留在 `details`，而 Provider 通常只把 `content` 作为模型输入。模型因此可能看到被裁剪的正文，却不知道完整结果在哪里、是否已省略、应该如何读取。首错是 Context/Tool Result 展示边界，不是模型没有调用 Recall。

## 修复

- `renderModelReceipt()` 输出稳定的 `[ProofBlade receipt]` envelope，包含 `state`、`visible`、`content_sha256`、Artifact URI、`omitted_chars`、摘要和下一步。
- `createCodingReadTool()` 在读取结果被限制时追加 receipt；完整短结果仍保持原正文，不制造无意义的回取循环。
- `createCodingBashTool()` 在 RTK/归档结果存在省略或错误 Artifact 时追加 receipt，同时保留既有错误和 Artifact anchor。
- Receipt 只读取当前 Run/current generation 的 Artifact，secret/flag candidate 的完整正文仍不进入 receipt。

## 验收与行为分析

测试要求模型可见文本包含 `pb://run/.../artifact/.../content`、`next=recall` 和省略数量，并且不能出现大段原始内容。已有 RTK bash 测试继续验证原始输出落盘和既有 anchor；短结果不追加 receipt，避免模型把已经完整看到的内容重复读取。

成功轨迹的预期改进是：当输出确实被裁剪时，模型可以沿明确的 Artifact/Recall 路径取回 L2，而不是重复执行原命令；若模型仍重复命令，下一首错应归因模型未采纳 receipt 或 Recall 工具 schema，而不是继续增加 CTF 门禁。

## 当前边界与下一步

本 PR 不新增向量索引或跨 Run 记忆，不改变 Artifact/Evidence 权威关系。下一项可独立实现确定性 `find/search` 索引和 RetrievalTrace；它必须与本 Receipt PR 分开评估，分别记录命中、进入 ModelContextFrame、被模型读取和后续动作使用四个状态。
