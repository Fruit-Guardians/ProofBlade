# ProofBlade 扩展开发指南

本文规定 ProofBlade 的扩展边界、工具开发方法，以及 MCP 和 Skill 的接入契约。目标是让每个新增功能处于正确的信息层级，并且保持可重放、可审计、可裁剪的上下文。

## 1. 当前实现状态

| 机制 | 状态 | 当前入口 |
| --- | --- | --- |
| 原子与分子扩展 | 已实现 | `packages/atoms`、`packages/molecules` |
| ProofBlade Tool 契约 | 已实现 | `packages/materials/src/tools/contracts.ts` |
| Pi Solver Tool 适配 | 已实现 | `packages/materials/src/runtime/solver-tools.ts` |
| Capability 目录与路由 | 已实现 | `packages/materials/src/capabilities` |
| Effect Journal、Artifact、Evidence | 已实现 | `packages/materials/src/effects`、`packages/materials/src/knowledge` |
| 后台任务 | 已实现 | `packages/materials/src/jobs/background-runner.ts` |
| 项目级 MCP | 已实现 | `.mcp.json`、`mcp.<name>` Capability、官方 MCP 2.0 stdio Client |
| 项目级 Skill | 已实现 | `skills/<name>/SKILL.md`、`load_skill`、Pi `harness.skill()` |
| Tool 输出改写 | 已实现 | `OutputRewritePort`、`tools.outputRewrite`、Coding `bash` RTK adapter |

状态表是行为事实来源。README 只提供入口，不用模糊措辞把预留接口写成已交付功能。

## 2. 先判断信息位，再选择目录

新增功能先回答四个问题：

1. 它知道 ProofBlade、CTF、Run 或用户目标吗？
2. 它只是获取信息，还是会处理、传递或改变信息？
3. 删除所有上层包后，它还能独立运行吗？
4. 它产生的结果是否要进入 Effect、Artifact、Observation 或 Evidence？

判断结果如下：

| 信息范围 | 职责 | 所属层 | 允许依赖 |
| --- | --- | --- | --- |
| 不知道外部世界 | 类型、哈希、规范化、最小存储接口 | `packages/atoms` | Node 标准库和原子内部 |
| 知道原子，不知道业务 | 通用获取、处理、传递和组合 | `packages/molecules` | `atoms` |
| 知道 ProofBlade 运行语义 | 能力目录、效果、证据、上下文、任务流程 | `packages/materials` | `atoms`、`molecules`、Pi |
| 知道用户命令和交付形式 | 参数解析、命令输出、应用装配 | `apps/cli` | 所有下层包 |

依赖箭头固定为：

```text
apps/cli -> packages/materials -> packages/molecules -> packages/atoms
```

出现以下任一情况就说明层级放错：

- `atoms` import 了 Pi、ProofBlade 或 CTF 类型。
- `molecules` 读取 `proofblade.config.json` 或认识 Run Phase。
- `materials` 为了复用一个纯函数而让下层反向 import。
- CLI 命令承担业务状态变更，而没有调用材料层服务。

每层的最低验收是独立构建。原子和分子还必须通过：

```powershell
npm run test:atoms
npm run test:molecules
```

## 3. 选择哪一种扩展机制

### 3.1 原子

适合稳定、最小、无业务语义的类型或值操作。例如规范 JSON、摘要、标识符和追加存储协议。原子不感知模型、Prompt、目标、Run 和证据。

### 3.2 分子

适合由多个原子组成的通用行为。例如有界文本窗口、事件投影器、分层上下文组合和通用 Tool 执行接口。分子可以定义可扩展接口，但不选择具体 Provider 或任务策略。

### 3.3 内建 Tool

适合模型需要直接使用、且 ProofBlade 必须控制其输入输出的稳定操作。内建 Tool 的 Schema 会进入 Solver 工具面，因此数量和描述要保持克制。

### 3.4 Capability

适合同一稳定代理工具背后的可发现操作。新增文件读取器、分析器或平台适配时，优先增加 Capability Manifest，而不是为每个操作增加一个顶层 Solver Tool。这样可以让主上下文只保留 `list_capabilities` 和 `invoke_capability` 的固定 Schema。

### 3.5 MCP

适合由独立进程维护、具备自身生命周期和工具目录的服务。ProofBlade 只常驻服务器名称与一句描述；完整 Tool Schema 在模型明确查询服务器时加载。调用结果仍要进入 Effect Journal 和 Artifact，目标输出仍被标记为不可信观察。

当 MCP Tool 本身还是一个分发器（例如 `agent_call_tool({ name, args })`）时，必须配置 `nestedToolPolicy`。ProofBlade 会在创建 Effect 前解析内层工具名，未知工具默认拒绝，并把内层的副作用、重放、敏感级别和资源键写入审计参数。Solver 与 Coding 的 `describe` 都会给出获准内层工具的策略摘要；`redactArguments` 指定的内层字段即使只有一个字符也只保存哈希，返回结果中的原值也会被清除。内层 sensitivity 为 `secret` 时，结果 Artifact 同样标为 `secret`。`describe` 始终使用 `manual` 重放策略，不继承 Server 的调用策略。

```json
{
  "nestedToolPolicy": {
    "dispatcherTool": "agent_call_tool",
    "toolField": "name",
    "argumentsField": "args",
    "tools": {
      "page_info": {
        "readOnly": true,
        "sideEffect": "none",
        "replay": "manual",
        "sensitivity": "target"
      },
      "page_eval": {
        "readOnly": false,
        "sideEffect": "network",
        "replay": "forbidden-replay",
        "sensitivity": "target",
        "redactArguments": ["expression"]
      }
    }
  }
}
```

这是执行边界，不是解题编排器：模型仍通过 `agent_tools` 动态发现工具，并可自由决定调用顺序、组合方式和分析路线。仓库根目录的 `.mcp.example.json` 给出了 `frx-director-mcp 0.3.4 -> Firefox-Reverse` 的可审查示例；复制为 `.mcp.json` 前需修改安装路径和 `PROOFBLADE_FRX_WORKSPACE_ROOT`。

### 3.6 Skill

适合工作方法、领域规则、操作步骤和配套脚本。主上下文只常驻 `name` 与 `description`；模型或宿主明确选择 Skill 后，才加载完整 `SKILL.md`。Skill 不承担 Effect、权限或审计职责。

### 3.7 Pi Package / Extension

Pi CLI 的 Package 自动发现和 ExtensionAPI 不会自动出现在嵌入式 AgentHarness 中。ProofBlade 采用嵌入式运行方式，因此引入 Pi Package 时必须显式选择：

- 把纯逻辑适配为材料层 Capability。
- 把独立服务作为 MCP sidecar。
- 把方法说明和资源整理为 Skill。
- 确实需要宿主进程扩展时，在材料层建立显式适配器并锁定版本。

Package 和 Extension 属于宿主进程可信代码，接入前要审查来源、安装脚本、依赖树、网络行为和升级差异。

### 3.8 Output Rewrite Adapter

适合压缩已有 Tool 的动态输出，但不增加新的 Provider Tool。通用 prepare/finalize 契约放在 Molecules，具体 Provider、版本门槛、Shell、Artifact 和失败策略放在 Materials。当前 RTK adapter 只包装 Coding `bash`，保持名称、描述和 Schema 哈希不变。

新增改写器时必须满足：原始命令与改写命令只记录哈希；真实执行与探测使用同一 Shell；Tool 返回前先注册可恢复 Artifact；trace 区分完整原文与有界可见输出；同一 Run 只启用一条改写链；用 A/B Fixture 检查字节/Token 降幅、关键行、退出码、Artifact 校验和回放一致性。

## 4. 编写内建 Tool

### 4.1 契约递进

Tool 类型按层递进扩展：

```text
atoms.ToolAtom
  -> molecules.AgentTool
    -> molecules.ToolDefinition
      -> materials.ProofBladeToolContract
        -> Pi AgentHarnessTool
```

`ProofBladeToolContract` 在通用 ToolDefinition 上增加以下字段：

| 字段 | 含义 |
| --- | --- |
| `version` | 行为或 Schema 变化时递增的版本 |
| `readOnly` | 是否只读 |
| `sideEffect` | `none/workspace/process/network/platform` |
| `timeoutMs` | 单次执行的确定超时上限 |
| `replay` | `pure/idempotent/resumable/reconcile/manual/forbidden-replay` |
| `outputPolicy` | `inline/summary/artifact` |
| `resourceKeys` | 资源租约键或参数化键模板 |
| `sensitivity` | `public/target/secret` 输出与遥测敏感级别 |
| `evidenceKinds` | 可能产生的证据种类 |
| `executionMode` | Pi 调度方式：`sequential/parallel` |

### 4.2 最小模板

在 `packages/materials/src/runtime/solver-tools.ts` 中定义 TypeBox 参数和契约，再通过现有 `adapt()` 适配给 Pi：

```ts
const querySchema = Type.Object({
  query: Type.String({ minLength: 1 }),
});

const queryContract: ProofBladeToolContract<
  typeof querySchema,
  Static<typeof querySchema>,
  unknown,
  SolverToolContext
> = {
  name: "query_example",
  version: "1.0.0",
  description: "Query one bounded, auditable source.",
  parameters: querySchema,
  readOnly: true,
  sideEffect: "none",
  timeoutMs: 30_000,
  replay: "pure",
  outputPolicy: "summary",
  resourceKeys: ["example:{query}"],
  sensitivity: "target",
  evidenceKinds: ["observation"],
  executionMode: "sequential",
  async execute(input, context, signal) {
    return await context.runtime.queryExample(input.query, signal);
  },
};
```

不要把业务实现写在 `execute` 内。`execute` 只做参数到材料层 Runtime 的适配；状态变更、效果记录和证据生成由 Runtime、Router、Journal 与 Observer 分工完成。

### 4.3 Tool 开发步骤

1. 在材料层 Runtime 增加一个明确的业务方法。
2. 用 TypeBox 定义封闭参数对象，默认 `additionalProperties: false`。
3. 填全效果、重放、输出和证据元数据。
4. 将契约加入 `createSolverTools()`，保持稳定排序。
5. 为参数拒绝、取消、输出截断和重放增加测试。
6. 更新 `docs/tool-contract.md` 中的工具数量和职责。
7. 检查 `solverToolContractHash()` 变化是否符合预期。

只有模型需要频繁直接使用、Schema 必须长期稳定的操作才新增顶层 Tool。其余操作优先走 Capability。

## 5. 编写 Capability

### 5.1 Manifest 模板

```ts
const manifest = withCapabilityHash({
  id: "proofblade.example",
  version: "1.0.0",
  description: "Bounded example capability.",
  trust: "bundled",
  operations: [
    {
      name: "read",
      description: "Read one bounded value.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      readOnly: true,
      sideEffect: "none",
      replay: "pure",
      outputPolicy: "summary",
      executionMode: "sequential",
    },
  ],
});
```

Capability ID 使用带命名空间的稳定小写名称。Operation 只表达一个动作。Manifest 和 Operation 会排序后计算规范哈希，因此描述、Schema 或策略变化都会产生可检测的目录变化。

### 5.2 调用路径

```text
list_capabilities
  -> CapabilityRegistry

invoke_capability
  -> CapabilityRegistry.find
  -> 参数与作用域校验
  -> EffectJournal
  -> Sandbox / Adapter
  -> ArtifactStore
  -> Observation / Evidence
```

Capability 返回的目标内容使用 `<untrusted-observation>` 包裹，不能被解释为系统指令。大输出保存在 Artifact 中，只把有界摘要和引用放进当前上下文。

### 5.3 重放策略

| 策略 | 使用条件 |
| --- | --- |
| `pure` | 同输入无外部变化，重复执行等价 |
| `idempotent` | 重复执行不会产生额外效果 |
| `resumable` | 有可验证的续跑位置 |
| `reconcile` | 中断后先查询外部状态再决定 |
| `manual` | 需要显式人工或策略判断 |
| `forbidden-replay` | 重复执行可能造成不可接受的二次效果 |

不确定时选择更严格的策略，并为恢复路径写测试。

## 6. MCP 接入契约

项目级 MCP 实现在 `packages/materials/src/mcp/registry.ts`。ProofBlade 参考 `tmp/pi-mcp-adapter` 的延迟发现和生命周期做法，嵌入层直接使用官方 MCP 2.0 Client/Core，不加载 Pi CLI ExtensionAPI。

### 6.1 配置位置

项目级配置固定为仓库根目录 `.mcp.json`。它不写入 `proofblade.config.json`，因此 Provider 和模型配置保持独立。首版只接入 stdio Server：

```json
{
  "mcpServers": {
    "example": {
      "command": "COMMAND",
      "args": ["ARG"],
      "cwd": ".",
      "env": {
        "TOKEN": "${TOKEN}"
      },
      "description": "One-line server description",
      "requestTimeoutMs": 30000,
      "includeTools": ["read_item"],
      "readOnly": true,
      "replay": "manual",
      "disabled": false
    }
  }
}
```

敏感值只从环境变量展开，不写入事件、Artifact、日志或 Prompt。`cwd` 相对项目根目录解析。Server 必须显式配置，不扫描用户主目录的全局 MCP 设置。

### 6.1.1 深度逆向 Capability 映射

`proofblade.binary.functions`、`disassemble` 和 `xrefs` 可以通过 `.mcp.json` 映射到 Ghidra、Rizin 或其他兼容 MCP Server。映射只描述传输边界，模型仍通过同一个 `invoke_capability` 自由选择调用顺序；本地 `rz/rizin` Backend 可用时优先使用本地实现，未安装或不可用时才选择 MCP 映射。

```json
{
  "binaryReverse": {
    "functions": {
      "server": "ghidra",
      "tool": "reverse",
      "arguments": { "path": "$path", "limit": "$maxResults" },
      "output": "functions"
    },
    "disassemble": {
      "server": "ghidra",
      "tool": "reverse",
      "arguments": { "path": "$path", "address": "$address", "limit": "$maxInstructions" },
      "output": "disassemble"
    },
    "xrefs": {
      "server": "ghidra",
      "tool": "reverse",
      "arguments": { "path": "$path", "address": "$address", "direction": "$direction" },
      "output": "xrefs"
    }
  }
}
```

`arguments` 的 `$path`、`$address`、`$maxResults`、`$maxInstructions` 和 `$direction` 会从逻辑 Capability 输入取值，其他值按字面量传递。若 Server 使用统一 dispatcher，可添加 `nestedTool: { "name": "functions", "toolField": "name", "argumentsField": "args" }`；它必须与该 Server 的 `nestedToolPolicy` 完全一致。为了防止把任意 MCP 动作伪装成只读逆向，映射对应的 MCP Server 或内层 Tool 必须显式声明 `readOnly: true` 且 `replay: "pure"`，输出也必须符合规范化的函数、指令或 XRef 数组。

### 6.2 延迟发现

MCP 不把全部服务器 Tool Schema 注入 L0 常驻上下文。固定交互流程为：

1. 列出服务器名称、描述、启用状态和目录哈希，不启动进程。
2. 明确选择一个 Server 后再建立连接并请求 Tool 列表。
3. 只返回该 Server 的有界、排序后 Schema。
4. 调用时再次检查 allowlist、参数、超时和 Run 生命周期。
5. Run 结束时关闭由本次运行启动的连接和子进程。

外层 Solver 工具保持固定，优先复用 `list_capabilities` 和 `invoke_capability`。每个 MCP Server 映射为 `mcp.<server-name>` Capability，避免服务器增减导致核心 Tool Schema 波动。

普通 Coding Agent 使用单一固定 `mcp_call`：`operation=list` 读取已启用 Server 的一行目录，`operation=describe` 延迟加载所选 Server 的完整 Tool Schema，`operation=call` 调用已发现且允许的 Tool。`load_skill` 与 `mcp_call` 即使当前启用集合为空也保持相同名称、顺序和 Schema；执行时再次检查会话 allowlist。Coding 对话没有 CTF Fixture，因此结果进入 Pi Session 与 Tool telemetry，不创建虚假的 Observation/Evidence；Solver 路径继续经过 Effect Journal 和 Artifact/Evidence。

当前 CLI 入口：

```powershell
proofblade mcp list
proofblade mcp describe RUN-ID example
proofblade mcp call RUN-ID example read_item '{"id":"ITEM"}'
```

`mcp list` 只解析配置。`describe` 和 `call` 必须关联一个已有 Run，因此连接、结果和失败都会进入该 Run 的 Effect/Artifact 记录。

### 6.3 效果与证据

MCP 调用必须经过：

```text
invoke_capability
  -> MCP Capability Adapter
  -> EffectJournal
  -> MCP Client / stdio Server
  -> ArtifactStore
  -> bounded untrusted observation
```

默认 MCP 调用使用保守的 `process` 效果和 `manual` 重放策略。只有配置和 Server 注解都证明只读、幂等时，适配器才降低限制。Server 返回的图片、二进制或超长文本先落 Artifact，再向模型返回摘要、哈希和 Artifact ID。

### 6.4 MCP 验收

- [x] 缺少 `.mcp.json` 时启动行为与当前版本一致。
- [x] `list_capabilities` 不启动 Server。
- [x] 首次 describe/call 才启动对应 Server。
- [x] 未列入 `includeTools` 的 Tool 不可见且不可调用。
- [x] 已知环境变量值和敏感参数值不出现在 Effect、Artifact 和上下文中。
- [x] 调用失败和进程退出形成确定的 Effect 终态。
- [x] 中断后的 MCP Effect 进入 `UNKNOWN`，默认不自动重放。
- [x] 合成 stdio Server 的发现、调用、脱敏、证据和清理测试通过。

## 7. Skill 接入契约

ProofBlade 复用 Pi AgentHarness 的 Skill 解析和校验规则，并在 Windows 适配层统一路径表示。Registry 实现在 `packages/materials/src/skills/registry.ts`。

### 7.1 目录与格式

```text
skills/
  evidence-triage/
    SKILL.md
    scripts/
    references/
    assets/
```

`SKILL.md` 最小示例：

```markdown
---
name: evidence-triage
description: Prioritize observations and request the smallest missing evidence.
---

# Evidence triage

1. Read the active handoff and evidence ids.
2. Retrieve only artifacts required by the next action.
3. Record a falsifiable hypothesis before requesting another effect.
```

校验规则：

- `name` 只使用小写字母、数字和连字符，最长 64 个字符。
- `name` 与父目录名称一致。
- `description` 必填，最长 1024 个字符，准确描述触发条件。
- 可使用 `disable-model-invocation` 阻止模型主动选择。
- 引用文件必须位于该 Skill 目录内，禁止路径越界。
- Skill 正文和引用资源不得包含 Provider 或具体模型 ID。

### 7.2 上下文加载

Skill 分两级进入上下文：

```text
常驻 L0：name + description + catalog hash
按需加载：SKILL.md 正文 + 必需引用的有界窗口
```

加载正文时记录 Skill 名称、内容哈希和加载时间，但不把 Skill 当作目标证据。正文超过预算时先加载目录和摘要，再通过引用读取工具获取局部内容。Skill 更新后目录哈希变化，旧检查点仍保留原哈希以支持审计。

当前入口：

```powershell
proofblade skills list
proofblade skills show evidence-triage 4000
proofblade skill RUN-ID evidence-triage "Focus on the current handoff"
```

Solver 的 L0 只包含可由模型选择的 Skill 元数据、内容哈希和目录哈希。`load_skill` 返回最多 12000 字符的有界正文；CLI `skill` 通过 Pi AgentHarness 原生 `skill()` 启动一个显式 Skill Turn。

### 7.3 Skill 与 Tool 的边界

- Skill 说明“应该怎样思考和操作”。
- Tool 执行“具体动作”。
- Skill 可以建议调用 Tool，但不能自行写 Run 状态。
- Skill 中的脚本通过 Capability 或受控进程适配器执行，不能绕过 Effect Journal。
- 从目标文件或远端内容生成的 Skill 视为不可信输入，不进入宿主指令层。

### 7.4 Skill 验收

- 没有 `skills/` 目录时行为与当前版本一致。
- 无效 frontmatter、重名和目录名不匹配会给出确定诊断。
- 默认上下文只出现元数据，不出现 Skill 正文。
- 明确加载后才出现正文，并受字符/Token 预算限制。
- 同一内容得到稳定目录哈希。
- Skill 引用不能越出自身目录。
- 加载 Skill 不会创建 Observation 或 Evidence。
- 示例 Skill 能在本地模型会话中按需加载并完成一次工具选择。

## 8. 上下文约束

任何扩展都必须说明它向哪一层上下文提供信息：

| 层级 | 内容 | 扩展约束 |
| --- | --- | --- |
| L0 | 身份、硬规则、Tool/Skill/MCP 摘要 | 稳定、短小、带目录哈希 |
| L1 | 当前任务与完成条件 | 扩展不得改写 |
| L2 | 已确认事实与反证 | 只能由证据链更新 |
| L3 | 当前假设、意图和 handoff | 使用稳定 ID，不复制长文本 |
| L4 | 最近观察和工具结果 | 有界窗口，不可信内容需包裹 |
| L5 | Artifact 和历史索引 | 默认只放引用、哈希和摘要 |

MCP 的完整 Tool Schema、Skill 正文、长 Tool 输出都不是 L0 常驻内容。达到 55/60/75/80/90% 预算阈值时，它们与其他上下文采用相同的 notice、snip、prune、compact、force-compact 分级维护、Artifact 外置和检查点规则。

## 9. 扩展完成定义

每个扩展提交前逐项检查：

- 信息层级和依赖方向正确。
- 类型通过递进扩展增加信息，没有修改下层业务无关契约。
- 参数 Schema 封闭，错误输入有确定错误。
- 效果、重放、输出和证据策略填写完整。
- 大输出进入 Artifact，模型只接收有界内容。
- 不可信输入没有进入系统指令或控制字段。
- 密钥和环境变量经过脱敏，不进入持久化数据。
- 取消、超时、崩溃恢复和重复调用有测试。
- Tool/Capability/Skill/MCP 目录哈希变化有快照验证。
- 下层包可独立构建和测试。
- `npm test` 和 `npm run eval` 通过。
- README、对应契约文档和 CLI 帮助同步更新。
- 新增恢复行为时同步 `docs/recovery.md` 的故障窗口和收敛不变量。

完整回归命令：

```powershell
npm run typecheck
npm test
npm run eval
```

需要本地模型的集成测试继续从 `proofblade.config.json` 读取 Provider、Endpoint 和 `model: "auto"`，不在源码、Skill、MCP 配置示例或测试中固定具体模型。
