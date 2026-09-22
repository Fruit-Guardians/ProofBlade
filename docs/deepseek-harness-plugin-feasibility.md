# ProofBlade 作为 DeepSeek Harness 插件的可行性评估

> 文档版本：1.0.0
> 编写日期：2026-08-14
> 文档性质：**可行性评估与方法比较，不代表已排期，也不代表任何方案已被采纳**
> ProofBlade 基线：`5060321`
> 实测环境：`@deepseek-ai/dsh` `0.1.5-rc.1`，`DSH_HOME=C:\Users\19678\.dsh`，profile `web`

本文回答一个问题：**ProofBlade 适合做成 DeepSeek Harness（下称 DSH）插件吗？**

本文是 `deepseek-harness-reference.md` 与 `cordis-paper-reference.md` 的补充，不是替代。那两份文档讨论的是「向 DSH 借鉴什么机制」；本文讨论的是「以什么形态接入 DSH」。**三份文档的结论必须一致**，冲突时以本文第 6 节列出的非目标为准。

---

## 1. 结论

**「做成 DSH 插件」这句话在本项目语境下至少对应三种不同形态，代价相差一个数量级。其中只有两种值得做，第三种与既有决策冲突。**

| 方案 | 形态 | 需要发布 npm 包 | 需要修改 ProofBlade 内核 | 建议 |
| --- | --- | --- | --- | --- |
| **A. Agent Preset** | `<DSH_HOME>/.agent-presets/<id>/` 下的 YAML 组合 | 否 | 否 | **建议采纳** |
| **B. MCP Server** | 把证据/验证链暴露为 MCP server，DSH 作为 client 连接 | 否（可本地私有） | 仅新增一层薄适配 | **建议采纳（真正有价值的一步）** |
| **C. Cordis 插件包** | 注册进 DSH `ctx.tools` / `ctx.systemPrompt` 的插件包 | 是 | 是，且是重写级 | **不建议** |

一句话概括推荐：

> **做 A + B，不做 C。**把 ProofBlade 定位为 DSH 的「证据与完成判定权威后端」，而不是 DSH 插件树里的一个节点。

理由集中在第 4 节。核心事实是：ProofBlade 与 DSH 是**同一层**的系统（都自带 agent loop、会话持久化、工具契约、GUI），把同层系统嵌入对方的插件树，等价于放弃其中一方的编排主权。

---

## 2. 三种形态到底是什么

混淆主要来自 DSH 的三层配置模型。实测后确认（依据 `@deepseek-ai/dsh` README 与 `~/.dsh/profiles/web/` 实际内容）：

### 2.1 Profile：宿主组合层

`~/.dsh/profiles/web/package.json` 中的 `dsh.profile.bundles` 列出有序 bundle（当前为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`），`cordis.patch.yml` 是用户自己的 patch 层。**这一层本身就是一个 YAML 节点图，不写代码即可改。**

实测该文件当前形态（本机）：

```yaml
- insert:
    - id: mcp-ida
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ida
        transport: stdio
        command: 'D:\AI\MCP\ida-pro-mcp\.venv\Scripts\idalib-mcp.exe'
        args: ['--stdio']
        toolCallTimeoutMs: 600000

    - id: mcp-jadx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jadx
        transport: stdio
        command: 'D:\AI\MCP\jadx-mcp-server\.venv\Scripts\python.exe'
        args: ['D:\AI\MCP\jadx-mcp-server\jadx_mcp_server.py']
        cwd: 'D:\AI\MCP\jadx-mcp-server'
        toolCallTimeoutMs: 300000
```

**结论：本机 DSH 已经在用 MCP 接入外部能力，且协议路径已经完全打通。**方案 B 不是新建基础设施，而是往这条既有链路里加一个 server。

### 2.2 Agent Preset：会话能力层

`<DSH_HOME>/.agent-presets/<id>/agent.cordis.yml` + `preset.yml`（含 `name`/`description`/`order`）。DSH 自带 `standard`、`ptc`、`cordis`、`minimal` 四个 preset。**preset 只组合已安装插件，不提供新插件，因此同样不需要 npm 包。**

preset 决定一个会话拿到哪些 tool、prompt section 和 skill。实测 `dsh-agent-presets` 的配置契约：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `default` | 必填 | 默认 preset id |
| `roots` | `[]` | 扫描目录，按优先级顺序，每项含 `path` 与 `trust` |
| `includeUserRoot` | `true` | 追加 `<dshHome>/.agent-presets` 作为 `user` root |

创作方式是 **copy-only**：新建 preset 是复制已有 preset 的整个目录，不接收调用方提供的组合文本。这一设计意味着**不能凭空生成一个 preset，必须从既有 preset 复制后编辑**。

### 2.3 Cordis 插件包：真正的代码扩展

只有当需要**新增 tool、新增注册表或新增 prompt section** 时才需要写。形态为：

```js
export const name = "tool-todo";
export const inject = ["tools", "sessionProjections"];
export const Config = z.object({ allowParallelInProgress: z.boolean().required() });

export function apply(ctx, config) {
  ctx.sessionProjections.register({ /* ... */ });
  ctx.tools.register(defineTool({ /* name, description, parameters, output, execute */ }));
}
```

（摘自 `@deepseek-ai/dsh-tool-todo` `lib/index.js`，为最小真实样例。）

安装路径为 `dsh plugin --profile web <pnpm args>`，即在 profile 目录内转发给 pnpm；`dsh.profile.bundles` 中命名的 bundle 先解析 dsh 安装，再从 profile 自己的 `node_modules` 解析。

**方案 C 的成本来源就在这里**：它要求 ProofBlade 的能力被重新表达为 DSH 的注册表契约，并且随 DSH 的 `0.1.5-rc` ABI 演化而维护。

---

## 3. 已经存在的五个接缝（实测）

评估可行性时最重要的发现是：**双方的重叠面比预期小，而可对接的接缝比预期多。**

### 3.1 Skill 格式完全兼容 —— 零成本

| 维度 | ProofBlade | DSH | 结论 |
| --- | --- | --- | --- |
| 目录形态 | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` | 一致 |
| 必填 frontmatter | `name`、`description` | `name`、`description` | 一致 |
| 发现深度 | 根下第一层 | **不递归发现嵌套 `**/SKILL.md`** | 一致 |

ProofBlade 当前有 `skills/ctf-reverse/SKILL.md` 与 `skills/evidence-triage/SKILL.md`，深度与 frontmatter 均满足 DSH 的发现规则，**可直接被 DSH 读取**。

`dsh-skill-filesystem` 的 root 优先级（实测自其 README）：

| 优先级 | 类型 | 路径 |
| --- | --- | --- |
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| — | `user` | `<dshHome>/skills` |

因此可用 preset 内的一行配置直接指向仓库，**避免复制出两份真相**：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - 'D:\AI\project\ProofBlade\skills'
```

`custom` 排在 project 根之后、user 根之前，恰好避免被 `~/.dsh/skills` 中的同名 skill 覆盖。

### 3.2 MCP 链路已双向可用

- **DSH 侧**：`@deepseek-ai/dsh-mcp-client` 支持 `transport`、`command`、`args`、`cwd`、`serverName`、`toolCallTimeoutMs` 等；模型看到的工具名为 `mcp__<serverName>__<tool>`。本机已配置两个 server（见 2.1）。
- **ProofBlade 侧**：当前是**纯 MCP client，没有自己的 MCP server**。`packages/materials/src/mcp/registry.ts` 中全部是 `connection.client.listTools()` / `describeServer()` 一类的消费侧调用。

所以方案 B 是**新增能力，不是重构**。

### 3.3 ProofBlade 有可用的程序化 API

`packages/materials/src/index.ts`（164 行）导出了真实库 API，覆盖方案 B 需要的能力：

| 导出路径 | 对方案 B 的意义 |
| --- | --- |
| `control/control-store.js` | 只追加事件、投影、Run/Phase 状态 |
| `verification/verifier.js`、`claim-verification.js` | 独立验证与完成判定 |
| `effects/effect-journal.js`、`artifact-store.js` | 效果日志与制品 |
| `knowledge/evidence-graph.js`、`projection.js`、`consolidation.js` | 证据森林与投影 |
| `context/compiler.js`、`checkpoint.js` | 上下文编译与检查点 |

即：**这些能力可以被进程内直接调用，不需要绕 CLI 子进程。**

### 3.4 MCP server 依赖已在位

`packages/materials/package.json` 的 `devDependencies` 已包含 `"@modelcontextprotocol/server": "2.0.0"`，与运行时的 `@modelcontextprotocol/client`、`@modelcontextprotocol/core` 同为 `2.0.0`。方案 B 的脚手架成本因此接近于零。

### 3.5 模型层不构成障碍

DSH 提供 `@deepseek-ai/dsh-llm-pi-ai`，直接支持 pi-ai catalogs 与 OpenAI-compatible 网关；ProofBlade 固定 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 为 `0.83.0`。**两边在 LLM 抽象上同源，不存在「模型层不兼容」这一反对理由。**注意：这同时意味着 §5.2 的版本漂移风险是真实存在的。

---

## 4. 三种方案的成本收益

### 4.1 方案 A：Agent Preset

**收益**：让 DSH 会话直接获得 ProofBlade 的领域工作方法（`ctf-reverse`、`evidence-triage`），无需任何代码改动。

**成本**：一个 YAML 文件 + 一次目录复制。极低。

**边界**：preset 只能组合已安装插件。它**不能让 DSH 调用 ProofBlade 的 Control Store 或验证器** —— 那需要方案 B。

**建议**：采纳，作为 B 的前置或并行项。这是投入产出比最高的一步。

### 4.2 方案 B：MCP Server

**收益**：让 DSH 在需要时调用 ProofBlade 的证据与完成判定能力，**同时双方各自保留持久化权威**：

```text
DSH 负责：会话、编排、日常执行
   ↓ mcp__proofblade__*
ProofBlade 负责：Run/Phase 事实、Effect Journal、Artifact、Evidence、完成判定
```

这与 `deepseek-harness-reference.md` §5.2「状态权威不变量」完全一致 —— 两个持久化域不合并，通过 id 关联。

**成本**：需要新增一个 MCP server 入口（复用 3.3 的库 API，复用 3.4 的依赖），以及一组工具契约、资源键、敏感度与重放策略声明。

**关键设计约束（必须遵守）**：ProofBlade 的既有决策是「固定工具面以保持缓存稳定」（`deepseek-harness-reference.md` §11.4：不在首轮暴露完整 MCP 和 Skill Schema）。**对外暴露时同样不能把 Capability 目录展开成 N 个 MCP 工具** —— 否则会在 DSH 侧复现它在自己内部刻意避免的前缀漂移问题。应暴露一个固定、克制、与 ProofBlade 内部稳定代理同构的工具集。

**安全约束**：区分只读查询与有副作用操作。只读（`show`、`timeline`、`cost`、`ledger`、`knowledge inspect`）可默认可调用；有副作用（`checkpoint`、`compact`、`task run`、`verify` 触发）必须走 DSH 的审批与沙箱策略，并明确声明 `readOnly` / `sideEffect` / `replay` / `sensitivity`，与 ProofBlade 现有 `.mcp.json` 的服务声明风格保持一致（参考该文件对 `idalib-mcp` 的 `readOnly: true`、`sideEffect: "process"`、`replay: "manual"`、`sensitivity: "target"` 声明）。

### 4.3 方案 C：Cordis 插件包

**不建议，理由有四条，且前三条来自本项目自己的既有结论：**

1. **与 `deepseek-harness-reference.md` §11.1 冲突**：「不整体引入 Cordis」。方案 C 恰恰是把 ProofBlade 的核心能力搬进 Cordis 生命周期模型。
2. **与 §11.3 冲突**：「不合并 Pi Session 与 CTF Control Store」。插件化的终点通常是把业务状态并入宿主 Session —— 正是该节明确反对的做法。
3. **与 §11.2 冲突**：「不把所有组件拆成独立 npm 包」。方案 C 要求把能力切成可被 DSH 加载的包边界。
4. **层错位**：ProofBlade 自带 agent loop（`packages/materials/src/orchestration/single-agent-loop.ts`）、GUI（`apps/gui`，React + Vite + 自有 server）、工作流与恢复链。它是与 DSH **同层**的产品。同层系统互相插件化，收益是「少一个进程」，代价是放弃自己的编排主权 —— 这笔交易不划算。

**唯一可能合理的 C 变体**：一个**只暴露验证链的薄插件**（不搬 loop，不搬 store，只注册几个 read-only tool）。但这与方案 B 提供的能力重叠，而 B 的成本更低、耦合更松、不依赖 RC 期 ABI。**除非 B 被证明无法满足需求，否则不建议走 C。**

---

## 5. 风险

### 5.1 版本脆弱性（主要风险，仅影响方案 C）

DSH 当前为 `0.1.5-rc.1`。插件契约中的 `inject` 数组、`ctx.sessionProjections`、preset 的 `realm`/`isolate` 语义均处于 RC 阶段。ProofBlade 的 `npm run verify` 门禁包含 37 项评测（六靶场各三次 + 19 个 provider-free 运行时场景），若底层 ABI 高频变动，维护成本会侵蚀全部收益。

**缓解**：A + B 方案下，双方之间只隔一个 YAML 文件和一份 MCP schema，DSH 升级时的改动量是常数级的。这正是选择 A+B 的工程理由。

### 5.2 依赖版本漂移（影响 A 与 B）

两边都依赖 `@earendil-works/pi-*`。ProofBlade 固定 `0.83.0` 并要求 Node `>=22.19.0`。若 DSH 侧 pin 的 pi 版本与之不同，需要确认是否会形成两份 pi 运行时，以及是否存在全局状态冲突。

**缓解**：接入前实测一次；必要时把 pi 版本对齐作为前置条件。

### 5.3 工具面膨胀（仅影响方案 B）

见 4.2 的「关键设计约束」。这是最容易被忽视、且会直接损害 DSH 侧缓存收益的风险。

### 5.4 目录与配置重叠（仅影响方案 A）

本机 `~/.dsh/skills` 已有 `android-traffic-capture`、`app-analysis-report`、`app-crypto-boundary-hunt`、`frida-runtime-hooking` 四个 skill，与 ProofBlade 的两个 skill **无同名冲突**。但若后续把 `skills/` 直接接入 `customSkillDirs`，需注意优先级顺序（§3.1），并避免同一 skill 在两处维护导致正文漂移。

### 5.5 双写与一致性（仅影响方案 B）

若 DSH 侧与 ProofBlade 侧都能修改 Run 状态，会产生两个真相。**缓解**：明确写操作只能单向进入 ProofBlade（DSH 调用，ProofBlade 落盘并返回权威结果），DSH 侧不缓存可变的 Run 状态。

---

## 6. 明确非目标

本节与 `deepseek-harness-reference.md` §11 保持一致，供后续评审对照：

1. 不把 ProofBlade 整体迁移进 DSH 插件树。
2. 不合并 Pi Session 与 CTF Control Store。
3. 不为接入 DSH 而在 ProofBlade 内引入 Cordis 依赖。
4. 不把 Capability 目录展开成 DSH 侧的 N 个工具。
5. 不因为接入 DSH 而改变 ProofBlade 现有的固定工具面与缓存稳定性设计。
6. 不在验证链之外暴露有副作用的写操作。

---

## 7. 若决定推进：最小路径

（本节仅为路径说明，**不含排期承诺**。）

```text
步骤 1（方案 A，零代码）
  从 DSH 已有 preset 复制一份，重命名 id
  -> 在 preset 的 skill-filesystem 行配置 customSkillDirs 指向 ProofBlade skills/
  -> 验证：DSH 会话能看到 ctf-reverse 与 evidence-triage，且正文按需加载

步骤 2（方案 B 的只读子集）
  新增 MCP server 入口，先只暴露只读查询
  -> 复用 packages/materials 的 control-store / evidence-graph 读路径
  -> 在 ~/.dsh/profiles/web/cordis.patch.yml 增加一行 dsh-mcp-client
  -> 验证：mcp__proofblade__* 可见；只读工具返回与 CLI 同源结果

步骤 3（方案 B 的写子集，需审批门禁）
  仅在有明确需求时暴露 checkpoint / verify 一类有副作用操作
  -> 必须声明 sideEffect / replay / sensitivity，并接入 DSH 审批策略
```

**验收标准**：

- DSH 侧调用 ProofBlade 后，ProofBlade 的 Run 事件、Effect、Artifact、Evidence 记录完整，且与 CLI 路径产出同构；
- DSH 侧不出现可变的 Run 状态副本（满足 §5.5）；
- 暴露的 MCP 工具数量固定，不随 Capability 目录变化；
- DSH 升级后，需要改动的文件数不超过 2（一个 patch 条目 + 一份 schema）。

---

## 8. 参考

- `docs/deepseek-harness-reference.md` —— DSH 架构调研、差距映射与落地优先级（**结论需与本文一致**）
- `docs/cordis-paper-reference.md` —— Cordis 时空可组合性与落地分析
- `docs/extensions.md` —— ProofBlade 自身的扩展机制与分层判断
- `docs/architecture.md` —— 依赖方向与运行时组件
DSH 侧契约均实测自本机已安装的 `0.1.5-rc.1` 包内 README 与编译产物，路径基准为：

```text
<dsh-install>/node_modules/@deepseek-ai/
```

- `dsh/README.md` —— entry modes、profiles、bundles、`dsh plugin` 转发语义
- `dsh-agent-presets/README.md` —— preset roots、copy-only 创作方式、shipped/user 来源
- `dsh-skill-filesystem/README.md` —— skill 发现规则、root 优先级、frontmatter 字段
- `dsh-host-plugin-inventory/README.md` —— 插件产物快照语义与边界
- `dsh-tool-todo/lib/index.js` —— §2.3 的最小真实插件样例
- `dsh-llm-pi-ai/README.md` —— pi-ai 多 Provider 适配

ProofBlade 侧：

- `packages/materials/src/index.ts` —— §3.3 的公共 API 清单
- `packages/materials/src/mcp/registry.ts` —— §3.2「纯 client」判定的依据
- `packages/materials/package.json` —— §3.4 的 MCP server 依赖
- `packages/materials/src/orchestration/single-agent-loop.ts` —— §4.3 第 4 条「自带 agent loop」的依据

本机实测配置：

- `~/.dsh/profiles/web/cordis.patch.yml`
- `~/.dsh/profiles/web/package.json`
- `~/.dsh/skills/`（§5.4 的同名冲突核对）
