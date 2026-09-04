# 上下文边界与缓存稳定性修复

## 修复范围

- `contextText()` 的默认 Provider system prompt 上限固定为 10,000 token；显式更大预算也不会绕过该硬上限。
- dynamic suffix hash 现在只对最终裁剪后、实际放入 `proofblade-context` 的文本计算。
- Reasoning Forest 的树名、摘要、标签、引用 ID 和整体模型可见文本都有界；无关事件推进 `lastSeq` 不会改变 forest hash 或可见文本。Envelope 同时提供 `visible-hash`，它严格对应裁剪后的模型可见正文。

## 首错归因

这些问题属于 Context Plane 的最终组装和缓存身份不一致：中间编译结果、可见投影和遥测 hash 可能代表不同内容。它们不是模型策略失败，也不是 Provider 网络失败。

## 验证

- ContextCompiler 回归验证默认 `contextText()` 不超过 10,000 token。
- Provider smoke 通过实际 AgentHarness HTTP 请求，验证序列化后的 system message 不超过 10,000 token，并验证 dynamic suffix hash 等于发送文本的 SHA-256。
- Reasoning Forest 回归验证无关 `lastSeq` 不改变 hash/文本，超大名称、摘要、标签和引用仍不超过 2,048 token。
- Forest 回归验证 `visible-hash == sha256(clipped body)`，并保持相同输入的可见文本稳定。

实现、测试和本说明属于同一上下文 bug-fix PR。
