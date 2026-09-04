# Pi and Provider Runtime

```json component-metadata
{
  "id": "materials-runtime",
  "name": "Pi and Provider Runtime",
  "version": "0.10.26",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-02T13:56:20.488+08:00",
  "qualityAudit": {
    "bugAuditCount": 23,
    "securityAuditCount": 23,
    "lastBugAuditAt": "2026-08-29T10:23:08.975Z",
    "lastSecurityAuditAt": "2026-08-29T10:23:08.975Z",
    "sourceHash": "77d35f637162a1751b18e2856972d88e379277e457791fa7d150b2e12c3137ab",
    "result": "passed"
  }
}
```

## 职责

适配 Pi AgentHarness、Provider Profile、OpenAI-compatible/Responses/Anthropic Messages 传输、统一 Coding lane、系统提示和实际 Tool 装配。

## 入口与边界

- `coding-lane.ts` 是唯一生产 Agent lane：交互任务、Fixture 和 Competition 都由它驱动；差异只来自不可变 `TaskContract` 能力和外层是否需要多轮 Coordinator，不再分叉 Tool、上下文、Evidence 或 Completion 系统。确定性 lane 仅由评测和单元测试注入。
- `pi-adapter.ts` 管理 Session；`lmstudio-provider.ts` 解析配置模型；`provider-transport.ts` 处理代理传输。
- `provider-native.ts` 只声明协议可能提供的原生服务工具及其语义归属，不把未进入 Effect/Artifact/Evidence 链的 Provider 内置能力冒充成可调用 Capability；`provider-scheduler.ts` 按 Provider/model 共享并发槽和 FIFO 等待队列。
- `coding-resources.ts` 装配最小 Tool/Skill/Capability/MCP 面；`evidence` 是证据图固定代理，`verify_result` 是通用结果复现门。历史 `verify_claim` 事件只由回放/迁移逻辑读取，不再作为模型工具暴露。
- `CodingClaimVerifier` 是唯一候选验证路径。任务绑定的 reproduction command 对所有模式都走同一 verifier journal；没有绑定命令的普通探索仍可继续，但只能写入明确标记的 observation，不能接受 Completion，最终文本也会统一标记为未验证。`deferClaimAcceptance` 只控制外层编排时机，不改变验证规则。
- `SecurityToolProfile.firstActionPlan` 将首个安全任务动作结构化为建议的 Tool 集和有界调用次数；Preflight 结果与该计划一起写入 Run。Coding lane 在 `tool_call` 结果中给出可操作的 advisory，但不会因为模型选择了其他工具而阻断；首个成功 Observation 仍会记录为已完成，恢复时从当前代 Observation 推导状态。
- `SecurityToolProfile.actionBundles` 将 RECON、TARGET_MODEL、HYPOTHESIS、EXPERIMENT、REPRODUCE 各阶段的工具、能力、前置条件、成功/失败判据和调用上限一次性预计算；Preflight 与 Run replay 携带同一份契约，回合提示只推荐当前 durable phase，不再让模型临场请求或安装缺失工具。阶段路线和动作包默认只产生带原因与下一步的 advisory；只有显式消融 Variant 的 `hard_gate` 才允许认知阻断。
- Durable session broker 在 Coding lane 装配前先做有界 health/capability preflight，并按不可变 TaskContract 的 target/policy 只筛选当前方向需要的 kind；仅当 broker 报告 `READY`、覆盖对应 `pwn-session`/`http-session` kind 且 `stableAcrossRestart=true` 时才注册。配置存在但 token 缺失、服务降级、能力不匹配或探针失败时，对应 kind 保持不可用，不以 Docker/进程内 HTTP 作为隐式替代。没有 health 方法的注入 broker 仅保留给测试/开发适配器，生产 HTTP broker 必须实现该契约。
- Preflight 的本地健康缓存只负责提速，写入通过跨进程文件锁和原子替换保护；真正的发布边界是 `RunToolPreparation` 事件。Coding lane 在创建 Provider 回合前重新读取 ControlStore，必须确认 preparation 的 hash、generation 与当前 Run 一致，否则在任何 Provider 请求前 fail-closed。
- Web `web_request` 会把 baseline/request/observed chain 结构化记录绑定到 HTTP exchange Artifact 与 Observer Evidence；启用 ArtifactStore 的 Pwn tube 会把有界 transcript、binary profile、primitive 和 exploit stage 记录为领域账本。它们仍只用于目标建模和重规划；配置 immutable Pwn policy 时，`pwn_reproduce` 额外经过 verifier-owned clean process、Effect、transcript Artifact 和 accepted/negative Evidence，不能由模型观察直接升级。
- Web verifier 的 transport 可冻结为 HTTP 或 Browser；Browser 模式只在 Coding Lane 收到应用拥有的 `BrowserVerifierFactory` 时暴露同一个 `web_reproduce` 工具，否则不注册该工具。Factory 只产生 verifier-owned 的全新 context，输入绑定 run/generation/target/policy/recipe hash/scope/响应上限；若提供 `BrowserRuntimeBroker`，opaque handle 与稳定 `verificationKey` 会进入 `ExternalResourceRegistry` 并由 CLI/GUI/Competition recovery composition 参与 inspect/adopt/release；配置了 broker 但 factory/凭据不可用时，Browser 题目在 lane 创建前直接 fail-closed，不静默退回本地 Playwright。没有 broker 的 context 仍只在进程内有效，重启后 fail-closed。Broker 接管后，`BrowserReproducer` 复用原 replay Effect、原 session id 和已持久化 interaction count，从中断的 recipe step 继续，不创建第二个 context；顺序多 attempt 恢复会复用已完成 attempt 的 replay Artifact，并只接管唯一的 STARTED attempt；多个同时 in-flight 或结果不明确时仍保持人工恢复，避免猜测前序结果。MCP/browser 工具不属于该边界。每次全新 browser replay 都创建空 storage 的 verifier context，保持单一 Web 解题路径而不把浏览器驱动暴露给模型。当前 policy 已约束步骤数、总时限、响应上限和 click/fill/submit/wait allowlist；`evaluate` 默认禁止。材料层提供 `tryCreatePlaywrightBrowserVerifierFactory` 的可选动态 adapter，CLI/GUI/Competition 负责注入；缺少 Playwright 或浏览器二进制时保持 fail-closed，CI 不需要安装浏览器。真实 host 通过 `scripts/browser-runtime-playwright-host.ts` 自动探测 `launchPersistentContext`：有该能力时使用受控 profile root + 脱敏 host ledger，支持新进程 `inspect/adopt/resolve`；没有该能力时明确降级为 process-local 且 `stableAcrossRestart=false`。
- 发布前 smoke 使用根目录 `npm run browser:smoke:required`，它只启动本地表单靶场并验证真实 BrowserReproducer → Effect → Evidence → Completion 链；Playwright 可以通过 `PROOFBLADE_PLAYWRIGHT_MODULE` 从外置安装加载，不进入 ProofBlade 的硬依赖。
- `bash` 是分析逃生通道而不是第二个控制面：其输出只能进入不受信任的 Artifact/Observation；运行时会拦截常见的脚本/重定向写入 `domain_record` 或 Control Store 的尝试。真正的 Web/Pwn 领域记录必须由结构化 Tool 或受信 verifier 通过 ControlStore 写入，静态 guard 不是 verifier 权限的替代品。
- 安全约束由持久化 `TaskContract` 的权限、范围和验证策略判定，不能依赖 executor prompt 是否包含安全领域关键词；这样安全评估和 evidence-first replan 不会因提示词投影变化而失效。
- 普通 `coding_assistant` 任务不因 `target_kind` 标签或用户消息中的领域词语自动进入专用工作流；安全画像只用于按需推荐能力，不能改变通用 Agent Loop 的基本语义。
- Coding Provider 始终看到固定 `evidence`、`load_skill`、`capability` 和 `mcp_call`；`capability` 通过 search/describe/invoke 渐进暴露逻辑能力，启用的 Skill/MCP 只改变运行时允许集合与短摘要，不展开动态 Tool Schema。
- Coding Lane 把已校验的工作目录作为 Capability 可见根，并复用共享 Control Store、Artifact Store 和 Effect Journal；`.proofblade`、路径越界、硬链接和 Backend 绑定保护与 Fixture Solver 一致。当前 Coding Capability Runtime 不隐式导入未启用 MCP，MCP 仍由会话级 `mcp_call` 集合控制。
- 无进展守卫分别累计纯只读观察和显式 `durableProgress=false` 观察；普通 Bash/process 和未解析策略只清除 read-window，只有显式持久进展或 workspace/network/platform 副作用可清除 declared-no-progress-window。
- Coding `bash` 通过 `OutputRewritePort` 包装；RTK 探测和执行复用同一个 Pi `ExecutionEnv`，并在 Session details 中记录 provider/version/hash/字节数/Artifact。
- Coding `read` 与 `bash` 都为文本结果注册语义化中间 Artifact，并在模型可见结果中返回稳定 `A-*` 锚点；`evidence record` 使用该锚点一次完成命名、提升、Evidence 与可选 Fact。
- Coding `read/bash` 接入 Evidence Curation Gate：4 个未审阅产物触发检查点，8 个触发硬门；Agent 必须 `record` 有价值发现或 `annotate` 已审阅的普通输出后才能继续侦察。
- Coding 回合还对 `bash`/`shell_background` 的进程与网络实验做单回合预算（总调用、长任务、超时和归一化实验族）；触发后先持久化证据，再由 Competition Loop 发起一次替代假设重规划，最多恢复两次，不把题目级停滞误报为 Provider 故障。
- `observation-queue.ts` 是事件流上的唯一观察投影：它从 ingress/Job/Provider/Verifier/Maintenance 事件生成有界脱敏摘要，按 urgent/normal/background 排序并支持 coalescing；`PiCodingLane` 在 context 安全点注入前 8 项，回合结束只确认实际展示项，避免把模型没有看到的观察误标记为已消费。
- `monitor_job` 与 Coding `shell_job monitor` 都使用单调 UTF-8 字节 cursor，并支持 `new_output`、`keyword`、`exit`、`error`、`heartbeat` 和有界 `timeout`；后台 Job 的 `job_finished` 保留原始 Artifact 引用，GUI/重启通过 ControlStore 重建待处理观察，不需要第二套内存状态。

## 开发规则与验证

模型、URL、思考等级、缓存策略、Provider 重试预算和 `maxConcurrentRequests` 只能来自配置。调度器在真实 Provider 请求前取得按 Provider/model 共享的并发槽，默认上限为 1；排队请求可被 AbortSignal 取消且不会占用成本 reservation，槽位按 FIFO 释放。OpenAI-compatible 429/408/409/5xx 由 Pi 的可中止退避处理；`maxRetries` 控制重试次数，`maxRetryDelayMs` 限制中转站 `Retry-After`，暂停时 AbortSignal 会打断等待。保持 System/Tool 前缀稳定，Provider 切换不进入底层组件。顶层 Tool schema 只能由不可变 `TaskContract` 能力声明决定；每轮安全画像、Preflight 和准备后的工作流必须进入最后一条 `proofblade-context` 动态消息，不能拼接用户原文或回写 System/Developer 消息。Pi 升级必须更新锁定快照与适配测试。

Provider Native 发现只依据明确选择的 wire protocol，不发送会产生费用或远端副作用的探针。`openai-responses`/`anthropic-messages` 的服务器搜索、代码执行等能力在没有能记录策略、输入、输出、Artifact 与 Evidence 的适配器前只能标记为 protocol candidate；与 `read`、`bash`、`edit`、`write` 重合的 workspace 语义必须由 ProofBlade 受控工具接管，不能作为第二套模型可见工具注册。

Coding Lane 的 context hook 按模型窗口扣除输出预算、System/Tool 固定开销和 Provider 安全余量，再以较低的主动维护阈值构造单调 Provider 视图；上下文达到软阈值时先 snip/prune，再在当前回合结束后由同一 `harness.compact()` 链完成压缩和 checkpoint。`length` 响应使用机械检查点压缩后自动续跑。重复观察、失败风暴、实验预算、Tool budget 和 claim verification 都进入同一 continuous-recovery 维护链，追加修复提示、集中 Evidence 整理和换策略要求，不强行结束 Agent 回合。Provider idle/error 和人工暂停即使没有模型文本，也必须持久化可见的状态说明；错误或人工暂停的回合不启动普通摘要请求。

重复 Tool 失败断路器通过 Pi `terminate` 停止单一工具批次；无进展断路器在单回合滚动窗口内比较 Tool Contract 明确声明为只读且无副作用的工具参数和稳定 Artifact 内容哈希，第三次取回同一观察时停止。待处理终止携带窗口来源，同批 process 成功可取消 read-window 终止，但不能取消 declared-no-progress-window 终止；后续 read-window 终止也不得覆盖或降级已有的 declared-no-progress 终止。混合批次不满足 Pi 的全结果终止条件时，Runtime 必须在下一次 Provider 请求前停止；同批出现符合该窗口进展语义的观察则取消顺序相关的无进展停止。只有 Harness 最终以空文本 `toolUse/error` 确认终止后，恢复提示才能投影到 `AgentOutcome` 和持久化的 `assistant_message`；正常完成的回合不得标记为断路器终止，模型已经生成的非空文本优先保留。

Evidence 变更操作返回 `durableProgress` 和基于 Artifact 内容哈希的稳定 `progressKey`；幂等复用、相同内容的新 Artifact 以及无关措辞变化不得被当作持久进展。显式 `durableProgress=false` 的 Evidence 观察在普通进程型 `bash` 之间继续累计，只由 `durableProgress=true` 或真实 workspace/network/platform 副作用清除，避免模型用重复读取穿插 Evidence 整理来重置收敛窗口。`no_progress` 终止记录其来源窗口：重复纯只读观察触发的 read-window 允许同批次成功的普通 process 取消，声明无进展触发的 declared-no-progress-window 仍拒绝 process；两者都接受显式 `durableProgress=true` 和真实 workspace/network/platform 副作用。未解析策略在 read-window 中也按潜在进展处理。单轮连续 12 次不同 Tool 失败且没有持久进展时触发 `tool_failure_storm`，避免通过变换错误参数绕过完全相同失败断路器。Windows Host 提示必须要求使用 `python`/`py` 并把中间文件保存在工作区相对目录。

`evidence` 的 Artifact、Evidence、Graph、Tree 和 Forest 操作共用一个缓存稳定 Tool。自动 bash/read observation 只进入检索和上下文索引，不自动清空 curation backlog；显式 `evidence record` 或 verifier Evidence 才算集中整理。Provider 可见 Schema 必须使用根级 `type: object` 和直接字符串枚举，以兼容严格的 OpenAI-compatible Function Calling 校验；每个 operation 的必需字段和互斥字段继续由确定性运行时分支校验。`curation_status` 返回准确的待整理 Artifact ID；`record` 只接受复数 `artifactIds`，`annotate` 只接受单数 `artifactId`。`inspect_forest` 用于方向回顾并返回有界的近期 orphan 名称与摘要，`inspect_tree` 用于局部溯源，`record/link/create_tree/update_tree` 由 Evidence Curator 整理知识。Forest 摘要在每个外部用户回合开始时刷新，作为隐藏动态消息追加到现有 transcript 之后，不进入 System/Tool 稳定前缀或会话持久历史。`load_skill` 和 `mcp_call` 每次执行都要校验当前对话的 enabled set。

Coding `mcp_call describe` 使用 MCP Registry 的统一服务器描述，除外层 Tool Schema 也返回配置允许的嵌套 Tool 策略摘要。

MCP 调用结果必须解包后再交给模型，不得逐层重新序列化。线缆形状是四层嵌套：Tool 自己的 JSON 是 `result.content[].text` 里的字符串，外面套 `{server, tool, result}` 信封，信封又是 `RawEffectResult.stdout` 里的字符串。直接再 `JSON.stringify` 一次会让模型收到没有真实换行的 `\\\"instruction\\\"` 转义串，从而判断输出被截断并重复发起同一次调用；实测一次 idalib `disasm` 因此从 835 字符膨胀到 10778 字符（12.9 倍）。指令清单（`asm.lines`）扁平化为 `addr  instruction` 行并内联 label 与 ref，`decompiled`/`pseudocode`/`code`/`source` 按原文输出，`null` 与空容器字段丢弃。

`external_submit` 只在 `verification.kind = "platform_submission"` 时注册，因为它会花掉一次真实提交，GUI 聊天运行没有可提交的对象。它先走 `runtime.submitCandidate`（格式校验、提交预算、候选哈希去重），再由 `IndependentVerifier` 触发 Journal 的 `fixture_score`，那才是真正到达平台的一步。禁止在 lane 里直接调用平台 API：Journal 的 idempotency key 会把重复提交折叠成回放而非第二次调用，事件日志同时是「错误提交次数」和「API 调用效率」两个计分项的账本。assist 模式下候选只记录为 PROPOSED completion 并立即返回，绝不联系平台，由操作者决定是否放行。

Artifact 锚点只在可见输出确实少于原始输出时追加，并写明被截留的字节数。对完整输出宣告 Artifact 会教会模型「有内容被藏起来了」，使它把回合花在取回已经拿到的文本上；`read` 的归档内容等于其可见内容，因此永不追加锚点，Artifact ID 只留在 `details` 里供 GUI 与 Evidence Graph 使用。`evidence search` 在元数据未命中时检索归档正文（单个 Artifact 上限 512 KB），否则内容查询永远落空而模型只能重跑命令。

安全任务中的确定性结论必须由不含候选明文的命令从工作区输入复现。最终回答和复现结果不一致时，Runtime 把本轮投影为 `unverified`，不把字符串扫描结果当作确认。

输出改写不得改变 `bash` 的名称、描述、Schema 或 Tool 顺序。统一 Coding lane 的业务工具继续使用 Effect Journal/Capability Router，不叠加第二条 RTK 裁剪链。

```powershell
npm run test:materials
```
