# Pi and Provider Runtime

```json component-metadata
{
  "id": "materials-runtime",
  "name": "Pi and Provider Runtime",
  "version": "0.6.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T02:47:13+08:00"
}
```

## 职责

适配 Pi AgentHarness、Provider Profile、OpenAI-compatible 传输、Coding/Solver lane、系统提示和实际 Tool 装配。

## 入口与边界

- `coding-lane.ts` 驱动普通对话；`solver-lane.ts` 驱动证据型任务。
- `pi-adapter.ts` 管理 Session；`lmstudio-provider.ts` 解析配置模型；`provider-transport.ts` 处理代理传输。
- `solver-tools.ts` 与 `coding-resources.ts` 装配最小 Tool/Skill/MCP 面；`evidence` 是证据图固定代理，`verify_claim` 是 Coding 结论复现门。
- Coding Provider 始终看到固定 `evidence`、`load_skill` 和 `mcp_call`；启用的 Skill/MCP 只改变运行时允许集合与短摘要，不展开动态 Tool Schema。
- Coding `bash` 通过 `OutputRewritePort` 包装；RTK 探测和执行复用同一个 Pi `ExecutionEnv`，并在 Session details 中记录 provider/version/hash/字节数/Artifact。
- Coding `read` 与 `bash` 都为文本结果注册语义化中间 Artifact，并在模型可见结果中返回稳定 `A-*` 锚点；`evidence record` 使用该锚点一次完成命名、提升、Evidence 与可选 Fact。

## 开发规则与验证

模型、URL、思考等级和缓存策略只能来自配置。保持 System/Tool 前缀稳定，Provider 切换不进入底层组件。Pi 升级必须更新锁定快照与适配测试。

`evidence` 的 `search/read/annotate/record` 共用一个缓存稳定 Tool，并使用判别联合 Schema 隔离各操作字段；只允许把有实质价值的发现提升为 Evidence。`load_skill` 和 `mcp_call` 每次执行都要校验当前对话的 enabled set。MCP `list` 不连接 Server，`describe` 才允许懒连接，`call` 必须使用 describe 后可见的 allowlist Tool。

CTF flag、挑战答案或恢复密钥等确定性结论必须由不含候选明文的命令从工作区输入复现。最终回答和复现候选不一致时，Runtime 把本轮投影为 `unverified`，不把字符串扫描结果当作确认。

输出改写不得改变 `bash` 的名称、描述、Schema 或 Tool 顺序。Solver Lane 的业务工具继续使用 Effect Journal/Capability Router，不叠加第二条 RTK 裁剪链。

```powershell
npm run test:materials
```
