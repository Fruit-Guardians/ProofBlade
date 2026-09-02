# ModelContextFrame P0 实现记录

本功能对应上下文修复计划的 P0：证明 Provider 最终实际收到什么。它与代码、测试和本 PR 属于同一功能变更，不是独立文档 PR。

## 实现

- `buildModelContextFrame()` 解析 Chat Completions 的 `messages`、Responses 的 `input` 和带 `system` 的适配器 payload。
- 每条最终消息记录 role、来源类型、Artifact/Evidence 引用、内容 SHA-256、可见字符数和估算 Token。
- `model_context_frame_recorded` 事件写入最终 adapter payload 的 metadata-only frame。
- `request_epoch_context` 同时保存 `modelContextFrameId` 和 `modelContextFrameHash`，可从事件重建请求与 frame 的关联。
- omitted 项以 `included=false` 保存，后续可以显示预算裁剪原因和回取入口；原始正文不复制到 ControlStore。

## 首错与修复

此前只有 ContextManifest、request body hash 和 dynamic suffix hash，无法判断某个 Tool Result 是否真的进入最终 Provider payload。首错属于 Context Plane 可观测性缺失，不是模型没有使用信息。修复把观测点放到 `before_provider_payload`，即 Provider adapter 转换完成之后，而不是只记录 ContextCompiler 的中间消息。

## 验收

- frame 测试覆盖 Responses/input 和 Chat Completions/messages 两种 payload。
- 测试断言敏感候选正文不出现在 frame JSON 中。
- 测试断言 omitted 项保持 `included=false`，并且 frame hash 可用于稳定关联。
- 现有 materials build/typecheck 和 context/observability 回归必须继续通过。

## 当前边界

Frame 默认是低敏 metadata 视图，暂不把非敏感正文作为持久 Context Artifact；GUI 的模型视图下一步可消费 frame 的来源、大小和 hash，并按本地调试开关读取经过 sensitivity 检查的内容。Frame 只证明“进入请求”，不证明模型理解或后续动作使用了该内容。
