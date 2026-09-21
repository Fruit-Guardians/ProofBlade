# ProofBlade GUI

```json component-metadata
{
  "id": "gui",
  "name": "ProofBlade GUI",
  "version": "0.7.24",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-21T13:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 24,
    "securityAuditCount": 24,
    "lastBugAuditAt": "2026-09-21T13:00:00.000Z",
    "lastSecurityAuditAt": "2026-09-21T13:00:00.000Z",
    "sourceHash": "d7f54673b06c79cc3c5912a3f18d64ad826d6b08d5253b620c3b5e369ed54aa5",
    "result": "passed"
  }
}
```

## 职责

提供真实模型对话、工作目录选择、Provider 配置、会话文件夹、对话重命名/删除、能力开关、上下文用量/剩余窗口/主动压缩阈值、Run 观测和 Tool 调试界面。Node server 是 Materials 的应用适配器，浏览器只保存展示状态和临时脚本结果。

## 入口与依赖

- 服务入口：`src/server.ts`；浏览器入口：`src/main.tsx`；主界面：`src/App.tsx`。
- 数据投影：`debug-data.ts`；Tool 可读投影：`tool-presentation.ts`；目录适配：`directory-browser.ts`；本地配置：`provider-settings.ts`、`workspace-settings.ts`。
- 依赖 Materials 公共 API、React 和 Lucide，不创建第三套 durable state。

## 开发规则

- API 响应只暴露 `hasApiKey`，不回传 Key。
- SSE 临时消息在 turn 完成后由 Pi Session 持久数据替换；用户暂停或 Provider idle/error 造成的空 Assistant entry 必须由持久化 assistant_message 的可见恢复文本补回，不能留下无提示的空气泡。
- Runtime 的 `repeated_tool_failure`、`no_progress` 与 `tool_failure_storm` 都属于可恢复的正常终止；SSE 必须发送可见 `done`，历史投影只能用持久化 Pi entry ID 覆盖对应的空 Assistant ToolUse/Error 消息。
- Coding Lane 为上下文恢复生成的内部续跑提示只出现在原始调试轨迹，不投影成用户对话气泡。
- 对话运行时发送按钮切换为暂停按钮；`POST /api/runs/:runId/pause` 必须中止当前 Pi Lane、持久化 `PAUSED` 并经 SSE 回报 `stopping/paused`。下一次发送通过 Control Store 的 `resume` 继续原 Session。
- Fixture 求解必须在 `startSolve` 返回前创建 durable Run；Coding lane 建成后登记到同一运行控制表，确保立即点击暂停时不会出现 `Run not found`，也不会在后台继续调用模型。
- CTF Fixture/旧入口必须通过 `/api/ctf-solve` 把题目描述、附件路径哈希和任务验证命令一次写入 TaskContract；附件先复制到 Run 专属 workspace，随后由 `SingleAgentLoop`/`RunCoordinator` 执行，不能把用户原始目录直接交给 verifier。
- 运行中状态以服务端 `active` 投影为准，页面切换或组件重挂载不得恢复为可发送状态；暂停确认前按钮保持可见并禁用重复暂停。
- 模型标签和右侧配置必须显示当前对话下一轮使用的 Provider/Model/Thinking；最近一条响应的模型仅作为历史元数据，不得覆盖当前选择。
- Provider Profile 必须显示并保存实际 wire protocol；模型发现按 OpenAI Bearer 或 Anthropic `x-api-key`/版本头发送。能力面板按本对话 Profile 显示 Provider Native 状态：协议候选未接入时不可勾选，和受控 workspace 工具语义重合时显示被接管原因，不能把产品内置工具误展示为 ProofBlade 可执行能力。
- Provider Profile 可设置 `maxConcurrentRequests`（1-32，默认 1）；普通对话与 Fixture Solver 共用按 Provider/model 的 FIFO 槽位，排队取消不会发送请求。运行指标展示排队数、取消数、最大队列深度和平均等待。
- 缓存展示同时给出本次离散缓存块和会话累计读取、未命中、请求数、输入侧命中率；`cacheWrite` 不进入缓存命中率分母。
- 上下文面板显示最近一次真实 Provider 请求的已用 tokens、窗口上限、剩余 tokens 和利用率；对话可选择 20%-80% 的主动压缩阈值，该偏好由服务端传入现有 Coding Lane 维护链，不能在 GUI 另建压缩流程。
- “待处理观察”面板直接由 `ControlStore` 事件重建，不维护 GUI 私有队列；显示 Job/Provider/Verifier/Maintenance 的有界脱敏摘要、待消费和 urgent 数量、来源、事件序号、关联 Job/Request/Artifact/ref。Coding Lane 在安全点只注入本次确实展示的前 8 项，消费标记以 `observation_consumed` 事件持久化，重启后可重建且幂等。
- 会话工作目录必须经过服务端绝对路径、存在性和目录类型校验，再传给 `PiCodingLane`。
- 普通 Coding 对话的名称保存在用户本地 workspace metadata；删除必须由服务端校验 Run 类型和活动状态后删除完整持久目录，并同步移除本地对话偏好。Fixture Run 不提供删除入口，避免破坏复盘材料。
- GUI 创建 Coding Lane 时必须传入共享 Artifact Store 与 Effect Journal，让 `capability` 代理复用现有持久化和安全边界；不得在 GUI 层创建旁路执行器或第二套 Capability 状态。
- 新控件必须覆盖运行中、空数据、错误和窄屏状态；Tool 原始 JSON 仍从 durable domain 投影，可读卡片不得替代原始记录。
- 最终结论的 `verified/unverified` 状态来自 durable `assistant_message` 事件；已验证状态必须显示 Evidence 引用，缺少复现时必须给出醒目的未验证提示。
- “证据与结果”顶层展示可折叠的推理森林摘要；每棵树显示名称、结论、用途、状态、节点/关系/共享计数，展开后查看根节点、来源、类型边、AI 解释和关联树。没有推理树但已有 Evidence/Artifact reasoning node 时，必须展示尚未整理的图节点，不能只显示空的 Fact → Evidence → Artifact 兼容视图。共享节点显示被哪些树采用；旧对话保留 Fact → Evidence → Artifact 兼容视图。
- `evidence` Tool 的 Forest/Tree/Link 操作必须显示中文动作名和对象 ID，原始 JSON 继续作为调试层保留。
- 旧 Session 没有验证元数据时，只读投影可根据解题请求与非 ToolUse 最终消息补充 `unverified`；该兼容逻辑不得补造 Evidence 或改写原始消息。
- GUI Shutdown 先拒绝新 Chat/Solve/Conversation，并中止、等待全部活动任务；服务、HTTP Server 和 Vite 的清理必须全部执行，最后统一报告失败。
- Run 切换、定时器、手动操作和对话完成后的列表/详情刷新必须共用组件生命周期内唯一的单飞协调器；后台 tick 忙时立即返回且不得积压等待 Promise，交互刷新忙时只合并一次最新请求，旧 Run 的迟到响应不得覆盖当前详情。后台刷新不得清除可见错误；Run 切换、手动刷新和对话完成等交互刷新成功后必须清除已恢复的请求错误。
- Run 详情缓存必须同时观察 durable `events.jsonl` 的 `mtimeMs`/文件大小和递归排序后的 Pi Session 文件状态；Session 加载期间发生变化时重读一次，仍不稳定则不得缓存。完整详情采用容量 32、单项 8 MiB、总量 64 MiB 的加权 LRU，超限详情只返回不缓存；同一 Run 的并发 miss 必须 single-flight，命中缓存时仍要刷新进程内 `active` 状态，服务关闭时必须与列表缓存一并清空。
- 首屏只等待轻量 bootstrap 与 Provider 设置即可解除全局 loading；Workspace Skill/MCP 能力扫描和 Run 列表必须后台加载，不能阻止用户打开“新建对话”。静态 Skill/MCP 目录在进程内 single-flight 缓存，Provider Native 状态继续按当前配置动态生成。
- Run 列表优先读取并校验 `projection.json`，不为侧栏统计 Tool 次数而回放完整事件流；projection 缺失或损坏（含无封印的历史 Run）时才在持锁回放后回填带封印的 projection，仅落后但已校验的 projection 走尾部折叠，不得因列表刷新而重放或重写 projection。历史 Run 只在首次冷读时回放一次，后续 GUI 启动复用已校验的封印投影；列表 Tool 数是可选投影，缺失时不显示。
- Server 启动必须在首个请求前调用 `DebugDataService.assertRuntimeShape()`，断言 `@proofblade/materials` 运行时暴露 `REQUIRED_CONTROL_METHODS` 的全部成员并打印解析到的包路径。缺失成员属于源码与 `dist` 的构建错配，必须 fail-fast；不得为该断言增加运行时兼容降级，降级会把构建问题重新变成难以定位的投影异常。`npm run gui` 先执行 `build:gui-deps` 保证产物一致，`gui:fast` 只用于已由 watcher 保证一致的场景。
- 普通对话**不得**创建 `.proofblade-workspaces/<runId>`。`createConversation()` 构造的 TaskContract 使用用户选择的真实目录（`target`/`allowed_workspace` = 该目录、`inputs: []`），执行 cwd 由 `taskExecutionWorkspace()` 解析，因此无需 staging；即使填写了 `verificationCommand` 也仍是普通对话。staging 只服务附件验证任务，由 `startTask()` 经 `stageTaskWorkspace()` 创建，用于不可变附件、逐文件 sha256、符号链接拒绝与可重放 cwd。staging 根必须是 `dirname(runsRoot)` 而非 Run 目录内部——`JsonlControlStore` 会把任何已存在的 Run 目录当作既有 Run。该边界由回归测试**双向**锁定（普通对话不创建 + 附件任务仍创建），路径断言必须复用 `taskWorkspaceDir()`/`taskWorkspaceRoot()`，不得另写字面量以免与实现漂移。
- `POST /api/conversations` **不得**加载 workspace 能力目录（`capabilityCatalog()`）。创建只做三件事：校验工作目录、创建最小 Run、保存调用方实际提交的偏好字段。因此 `WorkspaceSettingsStore.saveConversation()` 允许省略 `defaults`；省略时**不落地** `enabledTools`/`enabledSkills`/`enabledMcpServers`，这些列表在读取时由当前默认值解析。理由有两条：创建阶段扫描 Skills/MCP/Tool 目录属于用户尚未要求的开销；而把创建时的快照写进本地配置，会让此后新增的能力对该对话永久不可见。显式选择与已存值仍优先于默认值。
- 后台轮询的可见状态规则必须经 `polling.ts` 的 `isPollingAllowed()` 判定，**不得在定时器回调里重新内联** `visibilityState` 比较：每个 tick 都会取回完整 RunDetail（实测一个 121 事件的 Run 为 145KB，其中 events 占 100KB），隐藏标签页不该调度这份开销。该规则由 `[contract:polling-hidden-document-is-idle]` 与 `gui-polling-idle-discipline` 契约锁定。服务端 `/api/runs/:id/events` 已支持 `afterSeq` 增量读取，但客户端**尚未采用**——采用它需要客户端累积事件并同步改动时间线与调试器，属行为变更，须浏览器验证。

## 验证

```powershell
npm run test --workspace=@proofblade/gui
npm run build --workspace=@proofblade/gui
```
