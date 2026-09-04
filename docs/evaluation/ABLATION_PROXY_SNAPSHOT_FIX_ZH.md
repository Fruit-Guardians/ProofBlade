# Ablation Provider Proxy 快照修复

本 PR 修复实验快照无法完整描述 Provider 传输路径的问题。它与 Ablation snapshot/preflight 功能和回归测试属于同一变更，不是独立文档功能。

## 首错

`proxyUrl` 已参与运行时 profile fingerprint，但旧 `AblationModelSnapshot` 没有保存该字段，且 fingerprint 输入也遗漏了它。结果是：添加本机代理后，预检可能发现 fingerprint 漂移，却无法从快照知道漂移来自哪条传输路径；不应将 052 的 Node 直连超时误归因于模型策略。

## 修复

- `AblationModelSnapshot.proxyUrl` 保存规范化后的可选代理 URL。
- profile fingerprint 将 `proxyUrl` 纳入 canonical 输入；直连与代理通道产生不同 fingerprint。
- 密钥仍只保存 `apiKeyEnv` 名称，代理 URL 不包含凭据。

## 验收

同一实验输入在无代理和 `http://127.0.0.1:7897` 下生成不同 fingerprint，代理 URL 会写入 snapshot；既有 snapshot/preflight、ledger list 过滤和篡改检测测试继续通过。

## 实验关联

AB-TERRA-FIRST-ACTION-052 的三次 pairing 在 Node/undici 直连下均为 `provider_error: Request timed out.`；PowerShell 和经 `127.0.0.1:7897` 的 Node transport 对 `/v1/models` 均返回 200/Terra。该失败是 Provider transport 环境污染，不进入 firstAction 策略分母。修复后创建 053 immutable snapshot，固定代理并完成 3/3 对照复测。
