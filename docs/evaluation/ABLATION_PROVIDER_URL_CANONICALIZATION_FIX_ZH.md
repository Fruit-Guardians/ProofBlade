# 消融 Provider URL 规范化修复

## 问题

实验快照原样保存 `profile.baseUrl`，而 preflight 比较侧去除尾斜杠。配置为 `https://host/v1/` 时，快照和当前 profile 会产生不同 Provider 匹配结果，导致合法实验无法通过 `provider_match`。

## 修复与归因

首错属于实验 Harness 的 Provider 身份规范化，不是模型策略或网络请求失败。快照、profile fingerprint 和 preflight 现在共用同一个尾斜杠规范化函数；请求探测仍自行拼接规范化 URL。

## 验证

`ablation.test.ts` 新增带尾斜杠 profile 的快照/preflight 回归，确认 `provider_match=true`，且不改变公开 API 或凭据内容。

本文件与代码、测试同属该 bug-fix，不单独提交。
