# ProofBlade 工具架构与开发指南

本文件是 ProofBlade 工具系统的开发辅助文档。它说明 Agent 如何看到工具、工具如何选择 MCP 或 CLI 后端、执行结果如何进入审计和证据链，以及新增工具时必须补齐的代码、配置和测试。

本文件的核心约束是：

> Agent 只使用一等工具；MCP、CLI 和内置实现只是工具背后的执行后端。

也就是说，模型不应该负责选择传输协议、拼接复杂 shell 命令或理解 Capability Router 的内部参数。模型看到的是稳定的工具名称、真实的输入 Schema 和明确的输出语义。

## 1. 设计目标

工具系统同时服务于普通 Coding Agent、CTF Solver、CLI、GUI 和后台恢复。设计必须满足以下目标：

1. **一等工具接口**：每个高价值能力使用独立的 Provider-visible Tool，具有稳定名称、描述和对象根 Schema。
2. **后端可替换**：同一逻辑能力可以由内置实现、本地 CLI、MCP 或 Provider-native 实现提供，不改变 Agent 看到的工具名。
3. **可审计**：外部效果有参数哈希、执行策略、版本、结果 Artifact 和终态；敏感原文不进入日志和 Prompt。
4. **可恢复**：中断、超时、进程退出和重启都能得到确定结果。不能安全重放的效果必须进入 `UNKNOWN`，不能静默重试。
5. **上下文稳定**：工具 Schema、顺序和描述尽量稳定；长工具目录和完整 MCP Schema 按需加载。
6. **结果可验证**：大输出、图片、二进制和目标内容先进入 Artifact，再向模型返回有界摘要或引用。
7. **环境可移植**：Windows、Linux、WSL 和不同逆向工具链缺失时，工具仍能给出确定的可用性和失败原因。
8. **比赛合规**：模型请求只使用赛事允许的网关和 API 端点；工具后端不引入未授权模型服务或未审计的远程执行路径。

## 2. 分层总览

```text
CLI / GUI / Competition Driver
              |
              v
        AgentHarness Turn
              |
              v
     First-Class Tool Facade
       (name + Schema + policy)
              |
              v
       Tool Runtime Boundary
   (allowlist + validation + effect)
              |
       +------+-------+----------------+
       |              |                |
       v              v                v
   Built-in        CLI Backend      MCP Backend
   read/edit       local process    stdio server
       |              |                |
       +--------------+----------------+
                      v
                Artifact / Evidence
                Session / Telemetry
                Control Store
```

### 2.1 信息范围边界

ProofBlade 使用四级依赖漏斗：

| 层级 | 包 | 工具相关职责 |
| --- | --- | --- |
| Atoms | `packages/atoms` | ID、哈希、序列化、基础持久化，不知道 CTF、Pi 或 MCP。 |
| Molecules | `packages/molecules` | 通用 Artifact、上下文、事件和工具组合，不知道具体题型。 |
| Materials | `packages/materials` | Agent、Capability、Effect、MCP、CLI、Evidence 和 Provider 语义。 |
| Applications | `apps/cli`、`apps/gui` | 用户意图、运行控制、展示和调试，不实现工具业务规则。 |

工具后端和运行策略属于 `materials`。GUI 不应该直接启动 MCP、CLI 或读写 Effect；CLI 也不应该绕过 `materials` 自己实现一套工具调用协议。

## 3. 一等工具模型

### 3.1 Agent 看到什么

一个一等工具至少包含以下 Provider-visible 信息：

```ts
interface FirstClassToolContract {
  name: string;
  label: string;
  description: string;
  parameters: object;
  executionMode: "sequential" | "parallel";
}
```

`parameters` 必须是对象根 Schema。不要把多个互斥操作塞进一个自由字符串，也不要让模型传入命令行文本来表达结构化参数。

推荐：

```text
binary_disassemble({
  path: "sample.bin",
  address: "0x401000",
  maxInstructions: 80
})
```

不推荐：

```text
capability({
  capabilityId: "proofblade.binary",
  operation: "disassemble",
  input: { ... }
})
```

后者可以作为兼容代理或内部路由接口，但不应是高频能力的主要模型接口。

### 3.2 逻辑工具名与后端工具名

工具名应该表达逻辑能力，不应该绑定实现厂商：

```text
binary_functions
binary_disassemble
binary_xrefs
browser_open
browser_extract
```

不要把逻辑工具命名为：

```text
ghidra_reverse
rizin_disassemble
ida_mcp_call
```

当后端从 Rizin 切换到 Ghidra MCP 时，Agent 不应该需要学习新的工具名或重新理解任务流程。

当前 Coding lane 对直接展开的 MCP 工具使用 `mcp__<server>__<tool>` 命名。这是 MCP 兼容层的合理命名；对于有本地后端和 MCP fallback 的稳定领域能力，推荐进一步增加逻辑 Capability facade，避免把 Server 名称传播到长期 Prompt 和任务记忆中。

### 3.3 工具策略元数据

Solver 的完整工具契约还包含策略字段。新工具应该能够映射到这些字段：

```ts
interface ToolPolicy {
  version: string;
  readOnly: boolean;
  sideEffect: "none" | "workspace" | "process" | "network";
  timeoutMs: number;
  replay: "pure" | "idempotent" | "resumable" | "reconcile" | "manual" | "forbidden-replay";
  executionMode: "sequential" | "parallel";
  resourceKeys: string[];
  sensitivity: "public" | "internal" | "sensitive";
  evidenceKinds: string[];
}
```

策略不是装饰信息。它决定是否需要 Effect Journal、是否允许自动恢复、是否会清除 no-progress 窗口、是否可以并行，以及结果是否能进入 Evidence。

## 4. 当前代码入口

### 4.1 Coding lane

主要入口是：

- `packages/materials/src/runtime/coding-lane.ts`
- `packages/materials/src/runtime/coding-resources.ts`

`createCodingTools()` 注册内建 Coding Tool、固定代理和提交工具。内建工具包括 `read`、`bash`、`edit`、`write`。固定代理包括 `verify_claim`、`evidence`、`load_skill`、`capability`、`mcp_call`、`shell_background` 和 `shell_job`。

`createMcpFirstClassTools()` 会读取启用 MCP Server 的 Tool Schema，并生成带真实输入 Schema 的一等 MCP Tool。Server 在 lane 启动期间进行工具枚举；不可用的 Server 会被跳过，兼容代理可以作为兜底。

`codingActiveToolNames()` 决定当前对话允许哪些工具。工具名称可以进入 Provider，但执行时必须再次检查会话 allowlist，不能只依赖启动时的列表。

### 4.2 Solver lane

主要入口是：

- `packages/materials/src/runtime/solver-lane.ts`
- `packages/materials/src/runtime/solver-tools.ts`
- `packages/materials/src/tools/runtime.ts`

Solver 更强调固定工具表、Capability Catalog、Effect Journal、Artifact/Evidence 和恢复。高价值能力应该通过一等 facade 暴露，但其执行仍统一进入 `ProofBladeToolRuntime.invokeCapability()`。

### 4.3 Capability Runtime

`ProofBladeToolRuntime` 负责：

- 加载 Capability Catalog 和 MCP Manifest。
- 选择可用 Backend。
- 校验 Capability、Operation 和输入参数。
- 计算策略和版本。
- 进入 `ProofBladeCapabilityRouter` 与 `EffectJournal`。
- 生成 Artifact、Observation 和 Evidence。
- 管理后台 Job 和 Run 结束时的清理。

Backend 接口位于 `packages/materials/src/capabilities/backend.ts`。当前 Backend 类型包括 `bundled`、`local-process`、`mcp` 和 `provider-native`。

### 4.4 MCP Registry

MCP 入口是 `packages/materials/src/mcp/registry.ts`。项目级配置位于仓库根目录 `.mcp.json`，不从用户全局目录扫描配置。当前主要运行方式是 `stdio` Server：

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "ghidra-mcp",
      "args": [],
      "cwd": ".",
      "description": "Local Ghidra reverse analysis",
      "includeTools": ["functions", "decompile", "xrefs"],
      "readOnly": true,
      "replay": "pure",
      "requestTimeoutMs": 30000,
      "disabled": false
    }
  }
}
```

敏感值只允许通过环境变量展开。绝对安装路径不提交到配置；使用 `toolchain` Profile 和宿主环境变量，并通过 `proofblade mcp doctor` 检查。

## 5. MCP 与 CLI 的选择

### 5.1 选择 MCP

MCP 适合：

- 需要维持打开工程、绑定目标或会话状态的工具。
- 工具之间存在明确的多步协议。
- 返回值天然是结构化对象、资源、图片或进度流。
- 工具由外部桌面应用或长期运行服务提供。
- 现有 CLI 无法完整表达状态，也不能可靠恢复。

典型例子是本地 IDA、Ghidra、JADX 和浏览器自动化服务。

MCP 的限制：

- Server 启动、握手、Schema 枚举和退出都可能失败。
- Server 版本和宿主安装路径必须进入能力版本信息。
- 外部网络 MCP 会引入比赛审计和白名单风险。
- 未经裁剪的 Tool Schema 会膨胀 Provider 上下文。

比赛环境默认只使用本地、固定、可审计的 `stdio` MCP。不要使用运行时自动下载的 `npx -y` Server、远程 HTTP MCP 或隐式读取用户全局配置的 MCP。

### 5.2 选择 CLI

CLI 适合：

- 输入是文件或明确参数，输出是一次性文本/JSON/二进制。
- 操作可以通过输入哈希、命令版本和参数稳定重放。
- 已有成熟命令，如 `file`、`strings`、`objdump`、`rizin`、`binwalk`。
- 需要精确退出码、超时、工作目录和环境变量控制。
- 不需要保持跨 Tool call 的应用状态。

CLI 不应该直接以任意 shell 字符串暴露给模型。应为命令建立一等 facade，使用结构化参数，再由 Backend 生成 argv 或受控命令。

### 5.3 决策表

| 条件 | 选择 |
| --- | --- |
| 高频、参数复杂、模型需要准确填写 | 一等逻辑 Tool |
| 本地无状态文件分析 | 一等 Tool + CLI Backend |
| 有打开工程和多步绑定状态 | 一等 Tool + 本地 stdio MCP |
| 远程服务或未审计网络调用 | 默认拒绝，除非有明确授权 |
| 工具数量很多、单次任务只需少数 | 任务前筛选后生成一等 Tool |
| 需要后台运行数分钟 | 一等 `start`/`poll`/`stop` Tool + Durable Job |
| 同一逻辑能力有多种实现 | 一个逻辑 Tool + Backend Resolver |

## 6. 推荐的一等工具执行链

```text
Provider tool call
  -> schema validation
  -> session allowlist check
  -> effect policy resolution
  -> backend resolution
  -> effect proposed
  -> effect started
  -> CLI or MCP execution
  -> timeout / abort handling
  -> output normalization and redaction
  -> Artifact registration
  -> bounded untrusted observation
  -> effect finished
  -> tool result returned to Pi Session
```

任何一步失败都要产生结构化错误。不要把执行异常拼成看似成功的普通文本。

### 6.1 参数阶段

参数校验至少包括：

- 对象根 Schema 和未知字段拒绝。
- 路径必须是允许的相对路径或已登记 Artifact。
- 地址、长度、偏移和数量有上限。
- 命令参数不能由模型直接注入任意 shell 语法。
- Server、Tool、Capability 和 Backend 必须属于当前 Run allowlist。
- 敏感字段在持久化前转为哈希或脱敏值。

### 6.2 Effect 阶段

对目标、进程、网络、持久写入和 MCP 调用，先判断是否需要 Effect Journal。默认不确定时选择更严格的 `manual` 或 `forbidden-replay`。

Effect 需要记录：

- Run ID、Fixture generation 和 Effect ID。
- 逻辑 operation、规范化参数哈希和 Backend ID/version。
- cwd、超时、replay policy 和 side-effect policy。
- 开始、结束、取消、超时或未知状态。
- 输出字节、Artifact 哈希、退出码和错误签名。

### 6.3 输出阶段

模型只接收有界结果：

- 文本：head/tail 摘要和截断信息。
- 图片：图片本体或缩小后的受控版本，不重复注入不变大图。
- 二进制：类型、大小、哈希、解析摘要和 Artifact ID。
- MCP 结构化结果：去除多层 JSON envelope，保留原始字段语义。
- 目标返回：使用 `<untrusted-observation>` 边界，不能当作系统指令。

大输出完整保存在 ArtifactStore。不要把“存在 Artifact”写进每一条未实际截留的结果；虚假的 Artifact 锚点会诱导模型重复读取。

## 7. CLI Backend 开发规范

### 7.1 Backend 的职责

CLI Backend 应实现 `CapabilityBackend`，而不是散落在 Agent Prompt 或 GUI 中。Backend 负责：

1. 声明自己处理的 Capability/Operation。
2. 报告 ID、类型、优先级、版本和可用性。
3. 校验输入和资源边界。
4. 构造受控 cwd、环境和参数。
5. 返回 replay policy、超时和输出敏感级别。
6. 将 stdout/stderr 归一化为 `RawEffectResult`。

### 7.2 可用性检查

可用性检查必须是只读的，不要在 `status()` 中启动真正分析。检查内容可以包括：

- 可执行文件是否存在。
- 版本命令是否成功。
- 必要的安装目录或数据文件是否存在。
- 当前平台是否支持该命令。

公开错误原因必须脱敏宿主绝对路径。可用性变化应改变 Backend version 或 status，而不是让一次调用在深层才报模糊错误。

### 7.3 命令构造

优先使用 argv/参数数组；如果底层只能接收 shell 命令，必须统一处理：

- Windows 和 POSIX shell 差异。
- 路径空格、引号和 Unicode。
- 超时和 AbortSignal。
- 禁止把候选 flag、API Key 或 Secret 写进命令字符串。
- 绝对路径不进入 Model、Artifact、日志或公开错误。

超过单次运行上限的命令使用 Durable Background Job，而不是让同步 Tool 长时间占用 Agent turn。

## 8. MCP Backend 开发规范

### 8.1 配置边界

MCP Server 配置只放在 `.mcp.json`。Server 必须显式声明：

- `command`、`args` 和可选 `cwd`。
- `description`。
- `includeTools` allowlist。
- `readOnly`、`replay` 和请求超时。
- 必要时的 `toolchain` Profile。

不要扫描全局配置，不要把 Token 写入配置，不要自动接受 Server 自己返回的任意 Tool。

### 8.2 生命周期

推荐生命周期：

```text
list config
  -> doctor / availability
  -> describe selected server
  -> create connection
  -> call allowlisted tool
  -> normalize result
  -> close at Run teardown
```

Server 枚举失败必须变成确定的 unavailable 状态。调用过程中进程退出时，当前 Effect 进入明确失败或 `UNKNOWN`；不能因为连接重建而重复执行可能有副作用的操作。

### 8.3 MCP 结果处理

MCP 结果常见形状是：

```text
tool result
  -> result.content[].text
  -> RawEffectResult.stdout
  -> outer adapter envelope
```

模型最终只能看到一次解包后的语义结果。禁止对已经是 JSON 字符串的结果再次 `JSON.stringify`。反汇编、伪代码、函数和 XRef 应归一化为短文本或稳定对象，避免四层转义和无界增长。

## 9. 组合 Backend 与 fallback

当同一逻辑能力有多种实现时，使用 `CapabilityBackendResolver`：

```text
binary_disassemble
  -> local Rizin (priority 10)
  -> local bundled parser (priority 20)
  -> Ghidra MCP (priority 30)
```

Resolver 必须按固定优先级和 ID 排序，返回候选列表、选中 Backend、版本和不可用原因。Run 中一旦 Effect 已经开始，不得在中途静默换 Backend；下一次调用可以根据明确策略重新选择。

持久化的 Effect 和 Job 必须绑定 Backend ID/version。重启时发现版本改变，应拒绝自动重放或重新建立明确的新 Effect，而不是把两个实现混成一个结果。

## 10. 错误、取消和恢复

推荐错误形状：

```json
{
  "ok": false,
  "error": {
    "code": "TOOL_TIMEOUT",
    "message": "operation timed out",
    "retryable": true,
    "phase": "execute",
    "signature": "sha256...",
    "partialArtifactRef": {
      "id": "A-123",
      "sha256": "..."
    },
    "nextHint": "Read the partial artifact before retrying."
  }
}
```

常见阶段：`validate`、`allowlist`、`lease`、`preflight`、`execute`、`normalize`、`redact`、`artifact`、`evidence`、`finish`。

取消要求：

- AbortSignal 传入 CLI、MCP 和所有等待阶段。
- `stop` 只取消自己的 Job，不影响其他 Run。
- 取消后的晚到结果不能把 `CANCELLED` 改成成功。
- 未知外部状态进入 `UNKNOWN`，等待显式查询或人工处理。
- Run teardown 关闭 MCP 连接、后台进程和监听器。

不要把“重试整个 Agent turn”当作 Provider 请求重试。它可能重复用户消息、污染 Session，甚至重复非幂等工具副作用。可重试边界必须位于明确的 Provider/Backend 层。

## 11. 上下文和工具目录管理

### 11.1 常驻上下文

L0 常驻内容只保留：

- 工具名称、短描述和必要使用规则。
- 当前 Run 的工具 allowlist 摘要。
- 目录哈希和版本信息。

完整 Schema、MCP Tool 列表、Skill 正文和长 Tool 输出按需进入上下文。工具 Schema 的顺序必须稳定，避免破坏 Provider cache prefix。

### 11.2 工具数量

一等工具不代表所有工具都在每个 Run 中可见。创建 lane 前按任务类型筛选：

```text
web challenge -> browser_* + read/write + web_request
reverse       -> binary_* + read/write + local process tools
pwn           -> process_* + shell_background + binary_*
```

保留一个稳定的兼容代理用于诊断或低频能力，但不要让 Agent 为了调用高频能力而先学习通用代理的二级协议。

### 11.3 输出预算

每个 Tool 都必须定义：

- 最大响应字符数。
- Artifact 截留策略。
- 图片大小和重复读取策略。
- 二进制摘要上限。
- 失败时的 partial artifact 行为。

工具输出不能靠上下文压缩“自然变短”。压缩前必须已经保存完整 Artifact，并保留稳定引用。

## 12. 安全与比赛配置

赛事环境下，模型请求和工具网络请求必须分开建模：

1. Provider 请求只使用平台授权网关和白名单 URL。
2. 不使用未授权大模型服务、远程 Agent 或隐式代理。
3. 本地 CLI 和本地 stdio MCP 不应在启动时下载新依赖。
4. 挑战目标的网络交互必须由题目允许的工具完成，并单独记录目标、时间和结果。
5. Tool、Artifact、Effect 和日志不得泄漏 API Key、参赛账号、候选 flag 或宿主绝对路径。
6. 每个参赛队只运行一个 Agent；不要通过共享文件、外部聊天或未审计服务形成 Agent 间通信。
7. 比赛结束后停止 Agent 获取 flag 的能力和平台提交入口。

配置检查至少包括：

```text
provider base URL      exact authorized gateway URL
api key                environment or platform-provided secret
model                  platform-authorized model
tool allowlist         task-scoped first-class tools
mcp servers            local, explicit, pinned, audited only
network policy         challenge traffic and provider traffic separated
```

## 13. 新增一等工具流程

### Step 1: 定义逻辑能力

先回答：

- Agent 要完成什么动作？
- 输入字段有哪些，哪些必填？
- 输出是文本、对象、图片、二进制还是 Job ID？
- 是否读取目标、改写工作区、启动进程或访问网络？
- 失败后能否安全重试？
- 是否需要跨调用保持状态？

如果不能给出稳定答案，先不要把工具暴露给模型。

### Step 2: 定义一等 Schema

在 `materials` 中定义 Provider-visible Tool。Schema 使用 TypeBox 或与当前 AgentHarness 兼容的对象 Schema，拒绝未知字段，限制字符串、数组、长度和数值范围。

### Step 3: 实现 Backend

- 内置纯逻辑：放入 Materials 的领域实现。
- 本地命令：实现 `CapabilityBackend`，通过受控执行器调用 CLI。
- 本地状态服务：实现 MCP Registry 配置和 MCP Capability Adapter。
- 多后端：为每个 Backend 写 availability、version、priority 和 fallback 测试。

### Step 4: 接入 Runtime

所有外部效果经过 Runtime/Router/Journal。登记参数哈希、replay policy、Backend version、Artifact 和恢复行为。

### Step 5: 绑定一等工具 facade

Facade 只负责：

- 校验输入。
- 检查 allowlist。
- 调用 Runtime。
- 把内部结果转换成 Agent 可读的有界结果。

Facade 不应该直接依赖 GUI、CLI 命令行解析或某个 Provider。

### Step 6: 编写测试

至少添加：

- Schema、工具名和工具顺序契约。
- 正常调用和结构化输出。
- 未知字段、越界参数和路径逃逸。
- 工具不可用、超时、取消和进程退出。
- Effect 状态、Artifact 哈希和敏感值脱敏。
- Backend version 变化和 fallback 选择。
- 进程重启后的恢复或 `UNKNOWN`。
- 一等工具实际调用，而不只是 helper 单测。

### Step 7: 更新文档和报告

同步更新：

- `docs/tool-contract.md` 的工具契约。
- `docs/extensions.md` 的 MCP/Capability 配置。
- 组件说明和变更契约。
- Provider 工具 Contract Hash。
- 项目报告和测试路径。

## 14. 测试命令

开发期间按风险从小到大执行：

```powershell
# 类型和构建
npm run build

# 当前包的定向测试
node --import tsx --test packages/materials/tests/<new-tool>.test.ts

# 组件、变更契约、项目报告和 CI 门禁
npm run check:components
npm run check:change-contracts
npm run check:project-reports
npm run test:ci-gates

# Materials 全量
npm run test:materials

# Solver/Runtime evaluation
npm run eval -- --enforce-gate
```

如果工具涉及真实模型、真实 MCP、平台提交或外部目标，再增加隔离的集成测试。集成测试必须使用 fixture、临时 Run 和独立 ArtifactStore，不能污染开发者当前 Run。

## 15. 调试路径

工具调试时按以下关系追踪，不要只看控制台文本：

```text
Run
  -> Pi Session
      -> assistant toolCall
          -> toolResult
          -> Control telemetry
          -> Effect
              -> Artifact
                  -> Observation / Evidence
```

使用稳定的 `toolCallId` 关联 Provider-visible 调用、Tool Result 和 Control telemetry。原始 Tool 参数来自 Pi Session；Control Store 只保留必要的参数哈希和执行策略。完整输出从 ArtifactStore 读取。

排查顺序：

1. Tool 是否进入当前 Run allowlist？
2. Provider 看到的名称和 Schema 是否正确？
3. Effect policy 是否把读操作误判成副作用，或反之？
4. Backend 是否 available，版本是否改变？
5. Effect 是否进入 `PROPOSED -> STARTED -> FINISHED`？
6. 输出是否成功归一化、脱敏并写入 Artifact？
7. Tool Result 是否发生 JSON 多层嵌套、截断或虚假 Artifact 提示？
8. 取消、重启或 Run teardown 后是否仍有子进程和连接？

## 16. 维护原则

- 优先修复 Provider-visible 的行为和上下文成本，再优化内部抽象。
- 一个逻辑能力只保留一个稳定的一等工具名。
- 后端切换不应该改变 Agent 的调用协议。
- 不可审计、不可恢复或无法限制输出的工具，不应直接开放给 Agent。
- 任何新 MCP Tool 都必须有 `includeTools`、policy、timeout 和版本策略。
- 任何新 CLI 都必须有可用性检查、参数边界、超时和输出 Artifact 策略。
- 测试必须覆盖真实 Tool facade；只测试 helper 不能证明 Agent 能正确使用工具。
- 失败必须显式、结构化、可定位；禁止返回“看起来成功”的错误文本。

## 17. 相关文档和代码

- 架构总览：`docs/architecture.md`
- 工具契约：`docs/tool-contract.md`
- MCP、Capability 和 Skill 接入：`docs/extensions.md`
- 恢复语义：`docs/recovery.md`、`docs/recovery.en.md`
- Coding Tool 注册：`packages/materials/src/runtime/coding-resources.ts`
- Coding lane：`packages/materials/src/runtime/coding-lane.ts`
- Solver Tool 注册：`packages/materials/src/runtime/solver-tools.ts`
- Runtime 边界：`packages/materials/src/tools/runtime.ts`
- Backend Resolver：`packages/materials/src/capabilities/backend.ts`
- MCP Registry：`packages/materials/src/mcp/registry.ts`
- Effect Journal：`packages/materials/src/effects/effect-journal.ts`
