# ProofBlade 对话式 Agent 与动态调试 GUI

## 启动

GUI 是 `apps/gui` 应用层，不保存独立 Run 业务状态。它默认读取项目根目录的 `proofblade.config.json` 作为基础配置，并从用户目录 `.proofblade/gui-provider.json` 加载多个 GUI Provider Profile，从 `.proofblade/gui-workspace.json` 加载文件夹和会话偏好。

```powershell
npm ci
npm run gui -- --port 4173
npm run gui -- --config proofblade.config.json --port 4173
```

服务默认只监听 `127.0.0.1`。可用参数：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--port` | `4173` | HTTP 端口 |
| `--host` | `127.0.0.1` | 监听地址 |
| `--config` | `proofblade.config.json` | ProofBlade 配置文件 |
| `--project-root` | 仓库根目录 | 运行数据与配置根目录 |

对应环境变量为 `PORT`、`HOST`、`PROOFBLADE_CONFIG` 和 `PROOFBLADE_ROOT`。服务只把 Provider 名称、模型配置值、Base URL、思考等级和 `hasApiKey` 作为界面数据；环境变量或用户配置中的 Key 内容不会进入 API 响应。

## Provider 设置

工作区右上角齿轮打开“中转站与模型”。它支持多个 OpenAI-compatible Profile，每个 Profile 独立配置名称、Provider 标识、Base URL、API Key、可选 HTTP(S) 代理 URL、`/models` 模型发现、模型选择和 Pi 思考等级。模型发现与 Pi Provider 请求使用同一代理；本地模型 Profile 留空代理即可直连。保存时不改写 `proofblade.config.json`，后续新 turn 会立即读取所选 Profile。

Windows 默认路径为：

```text
%USERPROFILE%\.proofblade\gui-provider.json
```

Key 只在模型发现请求和 Provider 调用时作为 Bearer 凭据使用。`GET /api/provider` 只返回各 Profile 的 `hasApiKey` 布尔值；设置弹窗的密码输入框不会回填已保存内容。清除 Key 使用独立复选框。输入框下方可为当前对话选择 Profile、该 Profile 的模型和思考等级。

## 对话工作区与能力

侧栏支持“全部对话”“未分类”和自定义文件夹筛选。新建对话时可以选择文件夹，并通过绝对路径输入或服务端目录浏览器选择工作目录；也可以填写可选的任务验证命令，该命令会绑定到不可变 `TaskContract`，与 CTF/Fixture 使用同一受信复现链。既有对话也可从输入框下方切换目录。服务端校验路径为已存在的目录，再将其作为下一轮 `PiCodingLane.projectRoot`。工作目录、文件夹与会话级偏好写入：

```text
%USERPROFILE%\.proofblade\gui-workspace.json
```

“Tool、Skill、MCP”弹窗展示项目当前发现到的全部能力。内建 Coding Tool 可以逐项启停；`load_skill` 和 `mcp_call` 作为固定代理始终进入 Coding Provider Tool 列表，启用集合只决定代理执行时可访问哪些 Skill 或 MCP Server。`mcp_call(operation=list)` 只列出已启用 Server 且不连接进程，`describe` 才延迟发现完整 Tool Schema，`call` 再按 allowlist 执行。这些选择按 Run ID 持久化，不影响其他对话。

## 上下文与 Token

每个 Pi Session 汇总 Provider 响应中的输入、输出、推理、缓存读取和缓存写入 Token。输入框下方和右侧指标使用同一份 Provider usage；上下文面板另外显示发往 Provider 的可见消息数量、Tool 数量、系统提示字符、消息字符、Tool Schema 字符和粗略可见 Token 估算。

Provider 输入 Token 与可见估算不是同一指标。中转站或模型模板可能加入服务端固定上下文，因此很短的用户消息也可能由上游报告数千输入 Token。缓存统计只读取 Provider 返回字段；字段缺失时显示 `0`，不从输入量推测缓存命中。

Provider 请求事件还记录 `cacheRetention`（`short`、`long` 或 `none`），用于区分“请求了缓存”与“上游实际返回缓存 Token”。GUI 可以在每个 Provider Profile 中单独保存该值；无 GUI 时再由 `modelProfiles.executor.cacheRetention` 提供默认值，不会把具体模型或密钥写进源码。对话消息旁显示单轮缓存读取和命中率，指标面板显示累计提示词量与累计 token。

右侧“缓存前缀”显示另一组独立诊断。运行时在 Pi 完成请求重写后的 `before_provider_payload` 捕获 System/Developer 指令和有序 Tool Schema，只持久化规范哈希、数量和 Token 估算，不记录正文。相同 Provider 和模型的相邻请求参与比较；稳定率低于 100% 时，事件数据会把原因归类为 `system`、`tools` 或 `rewrite`。

这两个指标回答不同问题：

| 指标 | 数据来源 | 回答的问题 |
| --- | --- | --- |
| 缓存前缀稳定率 | 客户端最终请求体的哈希比较 | ProofBlade 是否改变了可缓存的 System/Tool 前缀？ |
| 缓存命中率 | Provider 响应中的 `cacheRead` | 中转站或模型实际复用了多少提示 Token？ |

前缀稳定率为 100% 但缓存读取不增长时，应检查 Provider 的缓存粒度、TTL、模型支持和中转站透传；缓存前缀发生变化时，应先消除对应的 System、Tool Schema 或请求重写漂移。维护阈值依次为 55% notice、60% snip、75% prune、80% compact 和 90% force compact。每次 snip/prune 后会重新计量，仍达到 compact 阈值才调度摘要压缩。

## 真实模型对话

“新建对话”创建 Coding Agent 会话，不选择或初始化 Fixture；普通 Chat、CTF Chat 和 Fixture 都调用同一个 Coding Lane。对话 composer 调用：

```text
Browser -> POST /api/runs/:id/chat
        -> validate conversation workspacePath
        -> PiCodingLane.create(projectRoot = workspacePath, task-bound verifier policy)
        -> PiCodingLane.prompt(user text)
        -> configured Provider / real model
        -> read / bash / edit / write (按需)
        -> Pi Session + Control Store
```

侧栏“Fixture 测试”是独立入口，但交互 Chat、CTF Chat 和 Fixture 自动执行共用同一个 `PiCodingLane`、`CodingClaimVerifier`、上下文维护和恢复路径。自动执行只由 `SingleAgentCtfLoop` 在外层编排多轮；它不拥有第二套 Tool、Completion 或验证判定逻辑。Fixture 额外构建靶场、显示阶段条并提供 Evidence、Artifact、Checkpoint 和恢复核对。

响应使用 `text/event-stream`。服务端把 AgentHarness 事件规范化为：

| 事件 | 内容 |
| --- | --- |
| `started` | Run 已进入当前对话 turn |
| `text_delta` | assistant 文本增量 |
| `thinking_delta` | 模型思考增量 |
| `tool_start` | Tool ID、名称和原始参数 |
| `tool_end` | Tool 结果与错误状态 |
| `done` | 最终文本、stop reason 和 usage |
| `error` | Provider、Harness 或 Tool 错误 |

浏览器只把这些事件作为当前 turn 的临时画面。请求完成后重新读取 Pi Session，以 durable entries 替换临时消息。每个 assistant message 下方的 Tool 卡片直接显示实际指令/参数、Tool Result 文本、状态、耗时和关联引用；“完整数据”再打开原始调试侧栏。普通会话可持续多轮；Fixture 终态 Run 保持只读。

普通对话还提供三种 durable 投影：

- “执行轨迹”按时间合并用户消息、AI 思考/回答、Tool 调用/返回和 Control Event，原始对象保留在每条记录内。
- “证据与结果”汇总所有 Tool 输入/返回、Run 的结构化 Evidence 和 Artifact 索引。
- “产物”读取 Snapshot 已登记的 Artifact 内容；没有产物时显示明确空状态。

## 调试路径

Tool 调试器按以下信息层级选择数据：

```text
Run
  -> Pi Session
      -> assistant message / turn
          -> one toolCall
              -> toolResult
              -> Control telemetry
              -> Artifact / Evidence / Effect links
```

Pi Session 通过 Pi 0.83.0 的 `JsonlSessionRepo` 和 `NodeExecutionEnv` 读取。GUI 不手工拆 JSONL 行。Tool 关联使用稳定的 `toolCallId`：

1. 在 assistant message 的 `content` 中定位 `type: "toolCall"`。
2. 在 Session entries 中查找相同 ID 的 `role: "toolResult"`。
3. 在 Control events 中查找相同 ID 的 `tool_call_recorded` 和 `tool_result_recorded`。
4. 从参数和结果递归收集已经存在于 Run Snapshot 的 Artifact、Evidence 和 Effect ID。
5. 根据 Evidence source 和 Effect artifact 引用补全关联记录。

Control telemetry 刻意不保存原始 Arguments；原始参数来自 Pi Session，Control Store 只提供参数哈希、执行策略、等待/执行时间、输出字节和错误签名。两个 durable domain 在 GUI 中关联，但各自的职责没有变化。

## Tool 调试对象

Script Lab 和“完整对象”视图使用以下结构：

```ts
interface ToolCallDebug {
  id: string;
  name: string;
  timestamp: string;
  status: "success" | "error" | "pending";
  assistantEntryId: string;
  assistantOrdinal: number;
  callIndex: number;
  arguments: unknown;
  call: unknown;
  result?: unknown;
  completedAt?: string;
  presentation: {
    summary: string;
    inputLabel: string;
    input: string;
    outputLabel: string;
    output: string;
  };
  assistantEntry: unknown;
  resultEntry?: unknown;
  telemetry: {
    call?: HarnessEvent;
    result?: HarnessEvent;
  };
  links: {
    artifacts: ArtifactRef[];
    evidence: Evidence[];
    effects: Effect[];
  };
}
```

`pending` 表示 Session 已记录调用但尚未出现对应 Tool Result。界面会保留该调用，运行中刷新后自动显示后续结果。

## Script Lab

脚本在浏览器临时 Web Worker 中运行，`input` 为当前选择的完整 `ToolCallDebug`。示例：

```js
return {
  tool: input.name,
  args: input.arguments,
  result: input.result?.details,
  evidenceIds: input.links.evidence.map(item => item.id)
};
```

每次点击“运行”都会创建新的 Worker。结果或错误返回后 Worker 立即销毁；超过 1500 ms 会被终止。输入和结果使用结构化克隆传递，返回值还会经过 JSON 序列化规范化。脚本源码不进入 Node 服务端、Control Store、Pi Session 或配置文件。

输出视图：

| 视图 | 用途 |
| --- | --- |
| JSON | 可展开的键值树 |
| 表格 | 把对象和数组扁平化为路径、类型、值 |
| 文本 | 查看字符串或格式化 JSON 文本 |

## 本地 API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Fixture、模型摘要、刷新间隔 |
| `GET` | `/api/provider` | 当前 GUI Provider 覆盖与 `hasApiKey` |
| `POST` | `/api/provider/models` | 使用表单 Base URL 和本地 Key 读取模型列表 |
| `PUT` | `/api/provider` | 新建或更新用户目录中的 Provider Profile |
| `PUT` | `/api/provider/active` | 切换默认 Provider Profile |
| `DELETE` | `/api/provider/:id` | 删除指定 Provider Profile |
| `GET` | `/api/workspace` | 文件夹、会话偏好与 Tool/Skill/MCP 目录 |
| `GET` | `/api/directories?path=...` | 校验绝对路径并列出父目录、磁盘根与子目录 |
| `POST` | `/api/folders` | 创建对话文件夹 |
| `PUT` | `/api/folders/:id` | 修改对话文件夹名称 |
| `DELETE` | `/api/folders/:id` | 删除文件夹并把其中对话移到未分类 |
| `GET` | `/api/conversations/:id/preferences` | 读取会话级工作目录、Profile、模型、文件夹与能力选择 |
| `PUT` | `/api/conversations/:id/preferences` | 校验并更新会话级工作目录、Profile、模型、文件夹与能力选择 |
| `GET` | `/api/runs` | Run 摘要列表 |
| `GET` | `/api/runs/:id` | Snapshot、Events、Telemetry、Pi Sessions 与 Tool 投影 |
| `GET` | `/api/runs/:id/artifacts/:artifactId` | 校验引用后读取 Artifact 文本 |
| `POST` | `/api/conversations` | 校验工作目录和可选验证命令，并创建不绑定 Fixture 的 Coding Agent 会话 |
| `POST` | `/api/fixture-conversations` | 创建绑定 Fixture 的交互调试会话 |
| `POST` | `/api/runs/:id/chat` | 通过 SSE 执行一个真实模型 turn |
| `POST` | `/api/solve` | 使用生产 `SingleAgentCtfLoop` 创建并执行 Run |
| `POST` | `/api/runs/:id/reconcile` | 使用 `RunRecoveryService` 核对恢复 |
| `POST` | `/api/runs/:id/checkpoint` | 使用 `CheckpointService` 创建机械检查点 |

Run ID 只接受字母、数字、点、下划线和连字符，Artifact 必须先存在于对应 Run Snapshot。API 请求体上限为 1 MB。

## 验证

```powershell
npm run typecheck --workspace=@proofblade/gui
npm run test --workspace=@proofblade/gui
npm run build:web --workspace=@proofblade/gui
npm test
```

GUI 单元测试覆盖目录存在性/类型校验、会话工作目录持久化、Tool 指令与结果可读投影、Tool/Result/Telemetry/Artifact/Evidence 关联、pending 调用、Run ID 边界、Provider 本地持久化、Key 响应脱敏和带 Bearer 凭据的模型发现。浏览器回归应至少覆盖 1440px 桌面与 390px 移动视口、目录选择、Tool 卡片、执行轨迹、证据与结果、Provider 设置、真实对话、Script Lab、抽屉交互、控制台错误和页面溢出。
