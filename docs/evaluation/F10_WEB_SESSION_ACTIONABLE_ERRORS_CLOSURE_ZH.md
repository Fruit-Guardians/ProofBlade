# F10 Web Session 可恢复反馈闭环

状态：已实现，待真实 Web 确认集

## 问题

模型调用 `web_open/web_request/web_replay/web_close` 时，未知 session、URL scope、generation drift、origin、HTTP method、request body 和 broker 故障可能只返回裸错误。模型无法判断动作是否执行、session 是否仍可用，容易重复同一请求或错误地重建状态。

## 修复

- WebToolHandler 的模型入口统一返回 `Reason`、`The requested action was not executed` 和 `Next`。
- 保留原始诊断词（例如 `Unknown web session`、`outside the task scope`、`generation drift`），并根据错误类型给出 `web_list`、新建 session、修正 scope/method/body 或检查 broker 的恢复路径。
- 已发出的 HTTP 请求错误不会被伪装成未执行；请求前的 scope、session、generation 和参数拒绝明确标注未执行。
- HTTP/Browser 的硬 scope、cookie/CSRF、Artifact、generation fence 和 Verifier 行为没有放宽。

## 验证

```powershell
npm run build --workspace=@proofblade/materials
node --import tsx --test packages/materials/tests/web-tools.test.ts packages/materials/tests/web-session.test.ts
```

新增回归覆盖未知 session 和 host/port/scheme 越界反馈；原有 Web session、cookie/CSRF、replay、generation、Browser scope、Artifact/Evidence 和 clean reproduction 测试保持通过。

## 归因与后续实验

裸错误属于 `tool_schema/harness_feedback`，不是模型推理失败。修复后的成功标准是：模型能依据 `Next` 选择 `web_list`、`web_open` 或修正请求，且不重复同一越界动作；真实确认集固定 Terra/Provider、Web 语料和安全边界，比较 session 工具与 bounded curl 的恢复率、重复请求、state hash、首证据时间、成本和 replay parity。

本 PR 同时包含实现、回归测试和本闭环文档；不单独提交文档变更。
