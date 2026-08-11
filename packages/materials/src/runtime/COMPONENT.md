# Pi and Provider Runtime

```json component-metadata
{
  "id": "materials-runtime",
  "name": "Pi and Provider Runtime",
  "version": "0.10.11",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-11T02:30:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 9,
    "securityAuditCount": 9,
    "lastBugAuditAt": "2026-08-11T02:30:00.000Z",
    "lastSecurityAuditAt": "2026-08-11T02:30:00.000Z",
    "sourceHash": "69bb1d659d31385e219b57be80cee3ae6ca7720c8b664b6d53a097b3b4bf6c02",
    "result": "passed"
  }
}
```

## 职责

适配 Pi AgentHarness、Provider Profile、OpenAI-compatible/Responses/Anthropic Messages 传输、Coding/Solver lane、系统提示和实际 Tool 装配。

## 入口与边界

- `coding-lane.ts` 驱动普通对话并在动态尾部注入隐藏 Forest 摘要；`solver-lane.ts` 驱动证据型任务。
- `pi-adapter.ts` 管理 Session；`lmstudio-provider.ts` 解析配置模型；`provider-transport.ts` 处理代理传输。
- `provider-native.ts` 只声明协议可能提供的原生服务工具及其语义归属，不把未进入 Effect/Artifact/Evidence 链的 Provider 内置能力冒充成可调用 Capability。
- `solver-tools.ts` 与 `coding-resources.ts` 装配最小 Tool/Skill/MCP 面；`evidence` 是证据图固定代理，`verify_claim` 是 Coding 结论复现门。
- Coding Provider 始终看到固定 `evidence`、`load_skill` 和 `mcp_call`；启用的 Skill/MCP 只改变运行时允许集合与短摘要，不展开动态 Tool Schema。
- 无进展守卫分别累计纯只读观察和显式 `durableProgress=false` 观察；普通 Bash/process 和未解析策略只清除 read-window，只有显式持久进展或 workspace/network/platform 副作用可清除 declared-no-progress-window。
- Coding `bash` 通过 `OutputRewritePort` 包装；RTK 探测和执行复用同一个 Pi `ExecutionEnv`，并在 Session details 中记录 provider/version/hash/字节数/Artifact。
- Coding `read` 与 `bash` 都为文本结果注册语义化中间 Artifact，并在模型可见结果中返回稳定 `A-*` 锚点；`evidence record` 使用该锚点一次完成命名、提升、Evidence 与可选 Fact。
- Coding `read/bash` 接入 Evidence Curation Gate：4 个未审阅产物触发检查点，8 个触发硬门；Agent 必须 `record` 有价值发现或 `annotate` 已审阅的普通输出后才能继续侦察。

## 开发规则与验证

模型、URL、思考等级、缓存策略和 Provider 重试预算只能来自配置。OpenAI-compatible 429/408/409/5xx 由 Pi 的可中止退避处理；`maxRetries` 控制重试次数，`maxRetryDelayMs` 限制中转站 `Retry-After`，暂停时 AbortSignal 会打断等待。保持 System/Tool 前缀稳定，Provider 切换不进入底层组件。Pi 升级必须更新锁定快照与适配测试。

Provider Native 发现只依据明确选择的 wire protocol，不发送会产生费用或远端副作用的探针。`openai-responses`/`anthropic-messages` 的服务器搜索、代码执行等能力在没有能记录策略、输入、输出、Artifact 与 Evidence 的适配器前只能标记为 protocol candidate；与 `read`、`bash`、`edit`、`write` 重合的 workspace 语义必须由 ProofBlade 受控工具接管，不能作为第二套模型可见工具注册。

Coding Lane 的 context hook 按模型窗口扣除输出预算、System/Tool 固定开销和 Provider 安全余量，再构造单调 Provider 视图并记录 compaction 请求；真正的 `harness.compact()` 必须等当前 Agent 回合结束、Harness 恢复 idle 后执行。`length` 响应使用机械检查点压缩后自动续跑，最多两次，超过上限必须显式报错而非返回空答案。内部恢复提示保留在 Pi 调试轨迹中，但不冒充 GUI 用户消息。错误或人工暂停的回合不启动普通摘要请求。

重复 Tool 失败断路器通过 Pi `terminate` 停止单一工具批次；无进展断路器在单回合滚动窗口内比较 Tool Contract 明确声明为只读且无副作用的工具参数和稳定 Artifact 内容哈希，第三次取回同一观察时停止。待处理终止携带窗口来源，同批 process 成功可取消 read-window 终止，但不能取消 declared-no-progress-window 终止；后续 read-window 终止也不得覆盖或降级已有的 declared-no-progress 终止。混合批次不满足 Pi 的全结果终止条件时，Runtime 必须在下一次 Provider 请求前停止；同批出现符合该窗口进展语义的观察则取消顺序相关的无进展停止。只有 Harness 最终以空文本 `toolUse/error` 确认终止后，恢复提示才能投影到 `AgentOutcome` 和持久化的 `assistant_message`；正常完成的回合不得标记为断路器终止，模型已经生成的非空文本优先保留。

Evidence 变更操作返回 `durableProgress` 和基于 Artifact 内容哈希的稳定 `progressKey`；幂等复用、相同内容的新 Artifact 以及无关措辞变化不得被当作持久进展。显式 `durableProgress=false` 的 Evidence 观察在普通进程型 `bash` 之间继续累计，只由 `durableProgress=true` 或真实 workspace/network/platform 副作用清除，避免模型用重复读取穿插 Evidence 整理来重置收敛窗口。`no_progress` 终止记录其来源窗口：重复纯只读观察触发的 read-window 允许同批次成功的普通 process 取消，声明无进展触发的 declared-no-progress-window 仍拒绝 process；两者都接受显式 `durableProgress=true` 和真实 workspace/network/platform 副作用。未解析策略在 read-window 中也按潜在进展处理。单轮连续 12 次不同 Tool 失败且没有持久进展时触发 `tool_failure_storm`，避免通过变换错误参数绕过完全相同失败断路器。Windows Host 提示必须要求使用 `python`/`py` 并把中间文件保存在工作区相对目录。

`evidence` 的 Artifact、Evidence、Graph、Tree 和 Forest 操作共用一个缓存稳定 Tool。Provider 可见 Schema 必须使用根级 `type: object` 和直接字符串枚举，以兼容严格的 OpenAI-compatible Function Calling 校验；每个 operation 的必需字段和互斥字段继续由确定性运行时分支校验。`curation_status` 返回准确的待整理 Artifact ID；`record` 只接受复数 `artifactIds`，`annotate` 只接受单数 `artifactId`。`inspect_forest` 用于方向回顾并返回有界的近期 orphan 名称与摘要，`inspect_tree` 用于局部溯源，`record/link/create_tree/update_tree` 由 Evidence Curator 整理知识。Forest 摘要在每个外部用户回合开始时刷新，作为隐藏动态消息插在本轮用户输入前，不进入 System/Tool 稳定前缀或会话持久历史。`load_skill` 和 `mcp_call` 每次执行都要校验当前对话的 enabled set。

Coding `mcp_call describe` 使用 MCP Registry 的统一服务器描述，除外层 Tool Schema 外也返回配置允许的嵌套 Tool 策略摘要。

CTF flag、挑战答案或恢复密钥等确定性结论必须由不含候选明文的命令从工作区输入复现。最终回答和复现候选不一致时，Runtime 把本轮投影为 `unverified`，不把字符串扫描结果当作确认。

输出改写不得改变 `bash` 的名称、描述、Schema 或 Tool 顺序。Solver Lane 的业务工具继续使用 Effect Journal/Capability Router，不叠加第二条 RTK 裁剪链。

```powershell
npm run test:materials
```
