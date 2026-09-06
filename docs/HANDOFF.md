# ProofBlade 交接文档

面向接手这个项目的人。目标是让你在一小时内知道：这东西为什么这样设计、哪些地方踩过坑、下一步该做什么。

最后更新：2026-08-27。上一阶段完整 `npm run verify` 基线包含 API index、component/change-contract、CI-gates 29/29、平台故障矩阵 6/6、staged fast/slow/integration 692/692、22/22、80/80（794/794）、offline eval 30/30 和 `npm audit --omit=dev`（0 vulnerabilities）；本轮新增 Browser handoff marker、required fail-closed 传播及 Competition handoff 后，最新 `npm run test:staged` 为 fast 700/700、slow 22/22、integration 86/86（808/808），统一部署预检契约加入后 CI gates 40/40（此前 Browser Runtime 阶段的 36/36 为历史基线），Browser/Binding/Web 定向回归 59/59，required Browser 回归 1/1，Competition Browser handoff 回归 1/1，Browser service 回归 6/6，Competition solver runtime preflight 回归 31/31；平台环境幂等 key 已移除随机 lease 组成并补充同一 Run/challenge 重复 reservation fail-closed 回归；本轮又收紧为按题目 `target_kind` 只预检必需的 runtime kind，避免无关 broker 扩大故障域。build/typecheck/API index/changed-tests/component/contract 检查均通过。本轮 canonical `npm run verify` 已全链路通过（staged 808/808、offline eval 30/30、`npm audit --omit=dev` 0 vulnerabilities）；一次误用 workspace glob 的全量 Node test 命令仍会触发既有 Windows/Pwn worker 环境依赖失败，不能替代 staged runner 证据。Pwn supervisor 契约、detached-worker 重启接管、Docker fault matrix、Browser smoke 和 CI 日志归档保持现状；真实 Provider 评测仍需显式 `--allow-live` 和外部凭据。

---

本轮 Competition runtime preflight 改动后的最新分层回归为 fast 700/700、slow 22/22、integration 86/86（808/808）；此前 Browser handoff 阶段的 698/698、22/22、86/86（806/806）为上一阶段基线。当前 CI gates 为 36/36；本轮 canonical `npm run verify` 已全链路通过（component/change-contract、API index、platform fault 6/6、staged 808/808、offline eval 30/30、`npm audit --omit=dev` 0 vulnerabilities）。

统一部署预检新增 4 条脚本契约后，CI gates 当前为 40/40；上文 36/36 为上一阶段历史基线。

## 1. 这是什么

ProofBlade（证锋）是一个**参赛用**的 CTF 解题 Agent，不是研究框架。比赛形态决定了一切设计：

- 线上初赛，**限时**，平台分批开放大量题目，题量明显超过人工能完成的规模
- **只有统一 API 接口**（取题目信息、开环境、提交 flag、拿反馈），没有 Web UI
- 鼓励人机协同：可以持续调整任务目标、解题优先级、提示词，查看运行状态
- 类别：Web / Misc / Crypto / 脚本分析 / 漏洞利用基础
- 计分：Flag 得分为主，同分依次看 **完成时间 → 解题数量 → 错误提交次数 → API 调用效率**

最后两项 tiebreaker 是很多设计决策的直接原因，看到「为什么要走 Journal」这类问题时先回来看这一条。

底座是 Pi AgentHarness（`@earendil-works/pi-agent-core`，版本锁定）。**核心原则：模型是底座，框架的每一处改动都只应该让模型解题更快、更准。** ProofBlade 不把模型文本当成事实或终态；Verifier、Evidence 和 Effect Journal 只约束完成判定与外部副作用，保持模型可以自由探索，同时避免“模型说成功但平台没有得分”。

---

## 2. 五分钟跑起来

```powershell
npm install
npm test                    # 本地全量测试；固定 2 个 worker，全绿才算环境正常
npm run test:staged         # CI 同款：构建一次，按 fast/slow/integration 分阶段执行
npm run test:fast           # 只重跑 fast 阶段（默认假设产物已构建）
npm run test:slow           # 只重跑 slow 阶段（holdout/评测）
npm run test:integration    # 只重跑 integration 阶段
npm run gui                 # GUI 在 http://127.0.0.1:4173
npm run platform:selfcheck  # 只读检查 DASCTF API/凭据，不建环境、不提交 flag
npm run runtime:selfcheck   # 只读检查 Browser/HTTP/Pwn broker health 与跨重启能力
npm run session:service -- --host-module scripts/session-runtime-http-host.ts  # 参考 HTTP 持久 runtime；需两个 SESSION_RUNTIME_* 密钥
npm run session:service -- --host-module scripts/session-runtime-pwn-host.ts   # Pwn host adapter；另需 Pwn supervisor module
npm run session:service -- --host-module scripts/session-runtime-combined-host.ts # 同一 broker 同时提供 HTTP/Pwn；需 Pwn supervisor module
npm run session:service:combined  # 上一行的固定启动入口
npm run session:service:combined:required  # health 非 READY 或不具备稳定句柄时启动即失败
npm run browser:service -- --host-module scripts/browser-runtime-playwright-host.ts  # Browser 持久 runtime；需 Playwright 与 token
npm run browser:service:required -- --host-module scripts/browser-runtime-playwright-host.ts  # Browser 发布入口；health 非 READY 时不绑定端口
npm run session:service -- --host-module <deployment-host.mjs>  # 生产 Pwn/HTTP runtime；真实 tube supervisor 由部署提供
```

本地要试 detached-worker 参考 Pwn supervisor 时，可在启动服务前设置：

```powershell
$env:PROOFBLADE_PWN_SUPERVISOR_MODULE = "scripts/pwn-supervisor-host.ts"
$env:PROOFBLADE_PWN_ALLOW_LOCAL_COMMANDS = "1"  # 仅隔离开发环境；生产不要开启
# $env:PROOFBLADE_PWN_REMOTE_ALLOWED_HOSTS = "127.0.0.1"
# $env:PROOFBLADE_PWN_REMOTE_ALLOWED_PORTS = "31337"
npm run session:service -- --host-module scripts/session-runtime-pwn-host.ts
```

该参考 supervisor 现在也提供受 scope 约束的 raw TCP fixture 传输；它证明
进程级 ledger/worker 接管和 endpoint fail-closed 行为，但不等同于 Docker 的生产隔离。
生产部署仍必须替换为受控 supervisor，并显式配置远程 host/port allowlist。

如果一个 broker 同时承载 Web HTTP session 和 Pwn session，可使用
`scripts/session-runtime-combined-host.ts`。它按不可变的 `request.kind` 分派到
两个独立的 host，并且只有两者都 `READY + stableAcrossRestart` 时才报告整体
`READY`；单方向故障会让整个共享端点保持 fail-closed，不会把能力误报给另一方向。
Session Runtime 服务默认仍可启动以供诊断，但会把状态明确输出为 `degraded`；发布部署应使用 `--require-ready`（或 `PROOFBLADE_SESSION_RUNTIME_REQUIRE_READY=1`），在绑定端口前拒绝非 `READY` host。
Browser Runtime 服务同样默认允许诊断启动并准确输出 `ready|degraded`；发布部署应使用
`npm run browser:service:required`、`--require-ready` 或
`PROOFBLADE_BROWSER_RUNTIME_REQUIRE_READY=1`，在绑定端口前拒绝非 `READY` 或
`stableAcrossRestart=false` 的 host。服务启动还会先扫描并精确对账 `STARTING`
reservation，不能确认的句柄保持 `UNKNOWN/pending`，不会重新创建 context。Session
Runtime 的同名门禁语义一致。

受控 Docker 路径提供一个不连接 CTF 服务的固定镜像 smoke：

```powershell
$env:PROOFBLADE_PWN_SMOKE_IMAGE = "registry.example/pwn-fixture@sha256:<digest>"
$env:PROOFBLADE_PWN_FAULT_MATRIX_REPORT = ".proofblade/pwn-fault-matrix.json"
npm run pwn:docker:smoke              # 没有 daemon/镜像时报告 SKIPPED，退出 0
npm run pwn:docker:smoke:required     # 发布环境 gate；缺失依赖时退出 2
npm run pwn:docker:fault-matrix:required # 发布环境 fault matrix gate
npm run deployment:preflight           # 汇总 runtime/browser/pwn 发布证据；外部依赖缺失标记 SKIPPED
npm run deployment:preflight:required  # 将 Browser/Pwn SKIPPED 提升为发布阻断
```

它会启动部署拥有的容器，经过 `docker exec` 建立 detached worker，验证
`pwn_read/write`、supervisor 重启后的 `inspect/adopt` 以及 release，再清理容器。
fault matrix 另外注入 `after_external_started`、`after_intent`、
`after_external_confirmed`、`after_control_commit`、`after_finalize`，验证每个边界
都不会创建替代 tube；普通 `pwn:docker:fault-matrix` 在依赖缺失时同样只报告 SKIPPED。
设置 `PROOFBLADE_PWN_FAULT_MATRIX_REPORT` 后会用原子替换写入带 schema 和时间戳的
JSON 证据文件，发布流水线应归档该文件；报告写入失败会使 gate 失败。
镜像必须包含 `/bin/sh`；CI 不默认执行该 gate，避免把 Docker daemon 或真实平台凭据
变成离线测试的隐式依赖。

部署前可以只运行一次 `deployment:preflight`：它按固定顺序聚合配置 broker 的
`runtime selfcheck`、Browser smoke、Pwn Docker smoke 和 Pwn fault matrix，输出一个有界
JSON 报告。普通模式不会把缺少 Playwright、Docker 或固定镜像包装成通过；带
`--required` 的发布模式会以退出码 2 阻断这些缺口。该命令不创建 CTF 环境、不提交
flag，也不替代显式授权的真实 Provider 评测。

模型凭据**不在仓库里**，放在 `~/.proofblade/gui-provider.json`，由 GUI 的 Provider 设置界面管理。仓库里只有 `.env.example`。

已验证可用的配置：`claude-opus-4.8`，`thinkingLevel: high`，`contextWindow: 200000`，`maxTokens: 16384`。

> ⚠️ `contextWindow` 和 `maxTokens` 这两个值是**踩过坑的**。原来是 20000 / 2048，会让模型在长题目上永远收敛不了。见第 6 节。

---

## 3. 架构（只讲你必须知道的）

四层依赖漏斗，由 `tests/dependency-funnel.test.ts` 强制：

```
atoms → molecules → materials → apps
```

反向引用会导致测试失败，别绕过它。

### 统一解题 lane

| | **Unified Coding Lane** |
| --- | --- |
| 工具 | 真 `bash`/`read`/`edit`/`write` + 一等 MCP + 技能库；Fixture 任务额外启用证据与复现约束 |
| 能不能解真题 | 能，已解出多道真题 |
| 比赛是否使用 | **是** |

`SingleAgentLoop` 是 Fixture 自动执行的编排器，它创建统一的 `PiCodingLane`；旧的生产 Solver Lane 已删除。评测和单元测试仍可注入确定性 `AgentLaneFactory` 作为测试替身。

所有入口再经过同一个 `RunCoordinator`：它推进
`INTAKE → RECON → TARGET_MODEL → HYPOTHESIS → EXPERIMENT → REPRODUCE → REPORT → SUBMIT`，
认领和结算 `WorkItem`，并把 verifier-owned Evidence、Effect 和 Completion 绑定到终态。
`submit_flag` 的平台结果不能单独让 Run 成功；动态 flag 快速路径也必须创建候选 Artifact、执行 verifier-owned `fixture_score` Effect，再由 `RunCoordinator` 完成终态。

### 竞赛路径（`packages/materials/src/competition/`）

```
FleetScheduler          并发 worker 池 + 控制面
  └─ CompetitionChallengeSolver   一题 = 一次完整 Run
       ├─ CompetitionApi          与平台之间唯一的接缝（通用 HTTP + DASCTF 专用适配器）
       ├─ CompetitionSandbox      解附件、写 connection-info.txt、fixture_score → 提交平台
       ├─ RunCoordinator           阶段、WorkItem、Verifier-first 终态
       └─ runCompetitionLoop       唯一 PiCodingLane，有界轮数/deadline/abort/assist
```

GUI 和本地 Fixture 通过 `SingleAgentLoop` 进入同一个 Coordinator；区别只在于 Task Contract 的验证类型和是否注入平台 API，不再存在独立的比赛 Solver Lane。

Pwn/HTTP 的跨进程会话不是由 GUI 或 lane 自行猜测。部署时由 `scripts/session-runtime-service.ts` 启动独立 broker：`DurableSessionRuntimeService` 负责 reservation、幂等和账本，部署提供的 `SessionRuntimeHost` 负责真实 socket/process。没有 host、health 或稳定 opaque handle 时，服务必须返回 `DEGRADED/UNKNOWN`，不能伪造可恢复会话。

**控制面没有全局暂停**，这是刻意的：限时赛里暂停整支队伍等于送分。有的是逐题优先级、逐题 auto/assist、逐题取消、运行中动态调并发。

---

## 4. 提交链（最容易改错的地方）

```
submit_flag → runtime.submitCandidate(格式校验 / 提交预算 / 候选哈希去重)
            → IndependentVerifier → Journal fixture_score
            → CompetitionSandbox → api.submitFlag   ← 真正到平台
```

### 三条不能违反的规则

**① 必须走 Effect Journal，不许在 lane 里直接调 `api.submitFlag`。**
理由就是计分规则：Journal 的 idempotency key 会把重复提交同一 flag 折叠成回放而不是第二次真实 API 调用，事件日志本身就是「错误提交次数」和「API 调用效率」两项的账本。这不是洁癖，是两个计分项。

**② `submit_flag` 只在 `verification.kind === "platform_submission"` 时注册。**
GUI 聊天运行拿的是 `verification: { kind: "reproduction" }` 和 `max_submissions: 0`，没有可提交的对象。**所以你没法在 GUI 聊天框里测提交链** —— 这是结构性的，不是配置问题。要测就用 `e2e-submit.mjs`（见第 5 节）。

**③ 「submittable completion」这个概念必须保持。**
`verify_claim` 和 `submit_flag` 都会产生 completion，但**产物格式不同**：

| 来源 | artifact 内容 | mime |
| --- | --- | --- |
| `submit_flag` | 裸 flag 文本 | `text/plain` |
| `verify_claim` | 复现记录 JSON blob | `application/json` |

判定标准是 `sha256(artifact 内容) === candidateHash`，这**正是 `IndependentVerifier` 自己的前置条件**，所以通过判定的 completion 一定能通过验证。别改成按 mime 或文件名判断——那是脆的。

这两个格式混淆过一次，代价是一次已经算对的 flag 根本没提交出去。详见第 6 节 Bug 3、Bug 4。

### assist 模式

`assist` 下候选只记录成 PROPOSED completion，**完全不联系平台**，返回给模型的消息明确说「没有花掉提交次数」。fleet 里显示为 `awaiting_approval`（待放行），不是失败——它在等你决定。模式 getter 是**实时**读的，运行中翻 assist 会拦下下一次提交。

---

## 5. 怎么测

```powershell
npm test                                                        # 全套
node --import tsx --test packages/materials/tests/competition-*.test.ts   # 竞赛部分
node --import tsx --test packages/materials/tests/coding-resources.test.ts # 工具层
npm run cli -- run-anonymize <run-id>                                  # 脱敏历史 Run 事件回放
```

### `e2e-submit.mjs`（真模型 + 本地附件 + 假平台）

这是本地组合回归工具：假的只有 `CompetitionApi`，其下仍走生产提交链。真实 DASCTF 适配器已经存在；真实平台只读连通性用 `npm run platform:selfcheck`，不会把登录、建环境或远程 tube 放进自动化测试。

```powershell
npx tsx e2e-submit.mjs
# 可覆盖：PB_E2E_FILE / PB_E2E_FLAG / PB_E2E_TITLE / PB_E2E_DESC / PB_E2E_CATEGORY / PB_E2E_TURNS
```

它会花真钱调模型。**别删它** —— 它一个人抓出了两个真 bug（Bug 2、Bug 3），而单元测试当时全绿。

最近一次结果：SQLite 取证/密码题，1.2 分钟，1 次提交，0 次错误提交，正确。

---

## 6. 踩过的坑（改代码前务必看）

这一节是这份文档最有价值的部分。每一条都是真实跑挂过的。

### Bug 1：MCP 结果四层 JSON 嵌套 —— 烧掉 100 轮

MCP 工具的返回值线缆形状是四层套娃：工具自己的 JSON 是 `result.content[].text` 里的字符串，外面套 `{server, tool, result}` 信封，信封又是 `RawEffectResult.stdout` 里的字符串。再 `JSON.stringify` 一次，模型看到的就是没有真换行的 `\\\"instruction\\\"` 转义串。

**后果**：模型判断「我的输出被截断了」，然后反复重发同一个调用。一次真实运行 127 轮、7,696,770 tokens，其中 19 轮在抱怨截断，同一个函数的反汇编取了 16 次。实测一次 idalib `disasm` 从 835 字符膨胀到 10778 字符（**12.9 倍**）。

**修法**：`renderMcpPayload` 一次性解包所有层；`asm.lines` 扁平成 `addr  instruction` 并内联 label/ref；`decompiled`/`pseudocode`/`code`/`source` 按原文输出；`null` 和空容器丢弃。

**修完对照**：同一道题从 127 轮降到 40 轮，7.7M tokens 降到 2.6M，抱怨截断 19 → **0**。

> 别把任何一层重新包回去。`coding-resources.test.ts` 里有测试钉着这个形状。

### Bug 2：虚假 artifact 锚点 —— 教会模型去追不存在的东西

原来给**每一条** bash/read 结果都追加 `[ProofBlade artifact A-...; use this id with the evidence tool]`。但 84 条锚点里 77 条 `savedBytes=0`——什么都没截留。这个锚点在主动暗示模型「有内容被藏起来了」，模型照做去取，然后 `evidence search` 又查不到（当时只索引元数据，不索引正文），于是回去重跑命令。闭环。

**修法**：锚点只在 `savedBytes > 0 || rawTruncated` 时出现，并写明截留字节数；`read` 彻底不加锚点（它归档的就是它显示的）；`evidence search` 在元数据未命中时检索归档正文（单 artifact 上限 512 KB）。系统提示里那句「read 和 bash 结果都带锚点」也删了——正是它教坏的。

### Bug 3：`verify_claim` 冒充解题成功 ⚠️ 最危险

`verify_claim` 会用**本地复现**结果 dispatch `completion_verified accepted:true`。竞赛循环原来只看 completion 状态，于是：**运行报告 `solved: true`，而平台从没被联系过。** 在比赛里这是「你以为拿分了其实没拿」。

**修法（两道独立防线，都得留着）**：
1. `CodingClaimVerifier` 在 `platform_submission` 运行里不再标记 ACCEPTED（复现证据仍然记录，它是有价值的提交前校验），completion 停在 PROPOSED
2. `runCompetitionLoop` 的 `accepted()` 额外要求存在真实的 `fixture_score` effect

两道防线各自单独回滚都会让 `competition-solver.test.ts` 里对应的测试失败——我逐个验证过。

### Bug 4：completion 去重撞车 —— 算对的 flag 没提交出去

`submitCandidate` 原来只按 `candidateHash` 去重，于是把 `verify_claim` 的 completion 交了回来。那个 completion 的 artifact 是复现 JSON blob，`IndependentVerifier` 拿它算 `sha256` 对不上 `candidateHash`，抛 `Candidate hash mismatch`。

真实后果：模型**已经算出正确的 flag**，三次 `completion_proposed`，零次真实提交。

**修法**：去重只匹配 submittable completion（见第 4 节 ③）。

### Bug 5：`verify_claim` 吃掉提交预算

`max_submissions` 原来按**所有** completion 计数。`verify_claim` 每次也产生 completion 且永不联系平台，所以 5 次本地复现就能把预算耗光，一次真提交都发不出去。

**修法**：预算和上报的计数都只算 submittable completion；`runCompetitionLoop` 上报的 `submissions` 直接数 `fixture_score` effect 的次数。所以 **assist 模式下 `submissions` 是 0**（确实没提交），候选另外用 PROPOSED completion 表示。

### Bug 6：`contextWindow` 卡死收敛

`proofblade.config.json` 里的 `contextWindow: 20000` / `maxTokens: 2048` 被套在**每一个**模型上。改成 200000 / 16384 是让长题目真正能解出来的关键一步。

### Bug 7：`max_tool_calls` 40 太小

它只约束进 Journal 的调用（capability invoke、artifact read、fixture_score），coding lane 的 bash/read/edit/write 和一等 MCP 工具**都不过 Journal**。但实跑出现过 130+ 次工具调用，40 有可能因为记账把一次本可成功的解题打断。现在是 200。

### Bug 8：skills 和 MCP 从错误的根目录加载

原来从**挑战工作区**加载 `skills/` 和 `.mcp.json`，应该从 ProofBlade 安装根目录加载。加了 `installRoot` 选项区分两者（`projectRoot` 是题目工作区，bash 在那里跑）。

### Bug 9：MCP 工具藏在 `mcp_call` 代理后面

模型不会驱动一个通用代理。现在每个 MCP 工具展开成一等公民 `mcp__<server>__<tool>`，带真实 inputSchema，跟 Claude Code / Anthropic API 的做法一致。`mcp_call` 保留作为兜底。这是「为什么模型在 Claude Code 里会用 MCP 而在我们这里不会」的答案。

### Bug 10：bash 无超时，挂死 30+ 分钟

`bash` 没有默认超时，一次真实运行里一个调用挂了 30 分钟没人管。竞赛运行现在有 180 秒上限（`bashTimeoutSecondsMax`）。超过一分钟的活该用 `shell_background`。

### 环境类坑

- **Windows host + bash shell**：绝不能用 cmd.exe 语法。不要 `cd /d`、`dir`、`2>nul`、`%VAR%`；要用 `cd`、`ls`、`2>/dev/null`、`$VAR`。Python 用 `python`/`py`，不是 `python3`。
- **不要往 `/tmp` 写文件再让 Windows read 工具去读** —— bash 的 `/tmp` 和 node 看到的路径不是一回事。中间文件放工作区相对目录（如 `work/`）。
- **解压产物的同名目录陷阱**：`digital_key_trace.sqlite` 本身是个**目录**，里面才是真的同名文件。`sqlite3 x` 会打开目录然后失败。系统提示里已经要求先 `ls -la` 确认。

---

## 7. 后台任务

`bash` 是同步的，长任务会冻住整个回合——在 fleet 里等于一个 worker 槽位空转。

```
shell_background {command, label?}     → 立即返回 jobId + pid + logPath
shell_job {operation, jobId?, maxChars?}  → read / stop / list
```

实现细节，改的时候注意：
- **存活判定用 pid 文件 + `kill -0`，不能用 `pgrep -f <日志路径>`**。重定向是**父** shell 做的，日志路径不在子进程的 argv 里，永远匹配不到。
- `stop` 先杀子进程（`pkill -P`）再杀父进程，必要时升级到 `-9`。记录的 pid 是 `bash -c` 包装器，真正干活的在它的子进程里。
- **轮询在 effect policy 里是只读的**，`stop` 才是 process 副作用。否则反复轮询看起来像有副作用的调用，会重置本该抓住卡死 agent 的 no-progress 窗口。

统一 coding lane 的 `shell_background` 用于长任务；它返回可恢复的 job id，后续用 `shell_job` 读取或停止，不会阻塞整个回合。

---

## 8. 技能库

`skills-library/ctf-skills/` 是 vendor 进来的第三方仓库（[ljagiello/ctf-skills](https://github.com/ljagiello/ctf-skills)，MIT，commit `d6662d2`），9 个类别，`LICENSE` 和版权声明**原样保留**。嵌套的 `.git` 已删除。

模型通过 bash 直接 `cat` 读它，不走 `load_skill`。系统提示里的编排器是**类别无关**的：侦察 → 归类 → `cat "<lib>/ctf-<category>/SKILL.md"` → 照着做 → 收敛。这样切换题型只是读不同的文件，提示本身不用改，也不会给不匹配的题型塞错误引导。

`skills/` 下另有项目自己的技能（`ctf-reverse` 等），走 `load_skill`。注意 `skills.test.ts` 断言 `ctf-reverse/SKILL.md` 里有字面量 `invoke_capability`，改那个文件时别删掉这个词。

---

## 9. 下一步（按优先级）

### 🔴 平台链接 API（已落地）

通用 `HttpCompetitionApi` 与 DASCTF `DasctfCompetitionApi` 已实现五个操作，并由 fake HTTP/contract tests 覆盖鉴权、附件、环境轮询、错旗、限流/重试、响应流上限和 fail-closed 行为。不要把真实 DASCTF 登录、远程 tube 或 pwn E2E 放进自动测试；本任务只要求平台链接 API 能力。Fleet → Run Actor → Observer → Verifier 的离线组合回放也已覆盖原子终态提交。`CompetitionEnvironmentJanitor` 已补上并发环境容量 reservation、`expires_at` 回收、重启恢复和清理失败重试。

### 🔴 当前最高优先：真实模型能力评测

本地 holdout 已经证明 Run、Evidence、Verifier 和 replay 管道可以工作，但不代表模型会解题。下一步应准备至少 20 个匿名化 Web/Pwn case、两个带 token pricing 的 Provider 配置，并运行 `eval-real --allow-live --enforce-gate`。CLI 会拒绝没有 Provider telemetry 或题目数不足的报告；在这个评测完成前，不引入第二条解题 Lane，也不让 Planner/Refiner 使用独立模型。

### 🟡 Web / Pwn 的真实运行验证仍未纳入自动化（API 只读自检已具备）

平台 adapter 的鉴权、附件、环境轮询、错旗、限流/重试和 fail-closed 行为由 fake HTTP contract tests 覆盖；`npm run platform:selfcheck` 可在用户明确授权后只读验证真实 host。Web/Pwn 的 session、scope、Artifact、clean replay 和 barrier 仍使用 fake/fixture 契约覆盖，不把真实题目、远程 tube 或凭据作为自动验收前提。Web 和 Pwn 是不同性质的东西：

- **Web** 需要能跨回合保持 cookie/session 的 HTTP 客户端，以及真实可达的目标。Task scope、session generation 和 clean verifier replay 已由离线契约测试强制；浏览器侧现在有版本化 `HttpBrowserRuntimeBroker` wire（`inspect/adopt/release`）、服务端字段校验、脱敏约束、有界响应读取、超时和 retry fixture；真实浏览器 broker 服务及其跨平台稳定句柄仍未作为自动测试前提。
- **Pwn** 需要跨回合保持的交互式 socket。容器内工具 profile、持久 tube、session ownership 和 shell/flag 双 barrier 已由离线契约测试覆盖；真实远程服务仍未作为自动测试前提。
- **验证方式反而更有利**：web/pwn 的 flag 是从活服务**回来**的，会落在 recorded observation 里。crypto/RE 才是难的情况——flag 是离线算出来的，从不出现在任何工具输出里，这正是 `submitCandidate` 对 platform-judged 运行放宽 observation 锚定的原因。

当前边界：先用 fake API、fixture、session contract 和 clean replay 测试验证 Web/Pwn 接口与生命周期，不把真实题目、远程 tube 或平台凭据作为自动验收前提；如未来需要连通性检查，必须是用户明确授权后的独立运维动作。HTTP session 每次请求都会生成脱敏 exchange Artifact，并由统一 Observer 记录候选类型；coding lane 的 `web_session_open/request/close` 只允许访问 task scope，session 随 lane 关闭；WebReproducer 只接受当前 Run 新建的 verifier session，generation 变化后旧 session 不能继续请求。

### 🟢 可选

- GUI Fleet 面板在没有平台配置时使用 demo API；配置 `competition.json` 或对应环境变量后，会装配真实 HTTP/DASCTF API、journal、环境 janitor 和真实 `CompetitionChallengeSolver`。
- 继续收敛 verifier 与事件溯源的边界（生产 Solver Lane 已删除，不能再恢复第二条解题路径）
- GUI 里支持逐 profile 的 `contextWindow`
- 动态 flag 直提路径（`solver.ts`）是**未经真实平台验证的假设**：只有平台在开环境时返回 `teamFlag` 才有意义。API 文档到了要么证实要么删。

---

## 10. 改代码时的规矩

1. **先跑 `npm run test:staged`**，三阶段全绿再动手。改完至少重跑受影响阶段；合并前再跑组件、契约、API index、CI-gates 和 offline eval；是否执行完整 `npm run verify` 要单独确认 `npm audit` 环境。
2. **不要为了让测试通过而改测试的语义**。第 6 节里每个 bug 都有对应的钉子测试，它们钉的是真实事故。
3. **改了工具契约要更新哈希**：`coding-resources.test.ts` 里的 `CODING_TOOL_CONTRACT_HASH`。它守的是 provider prompt cache 前缀，不是形式主义。
4. **每个模块的 `COMPONENT.md` 是有约束力的**，不是摆设。改了行为要同步改它。
5. **模型是底座**。任何一处改动，问一句：这让模型解题更快或更准了吗？如果增加了流程约束，必须证明它只保护副作用和终态，并且不会替模型决定解题路径。

## 11. P0/P1/P2 当前交付（2026-08-22）

- P0：`RunCoordinator` 已统一 Competition、GUI、Fixture 的阶段和 Verifier-first 终态；`npm run check:changed-tests` 已成为变更测试门禁；Janitor v2 使用原子账本、跨进程锁、reservation 和 schema 迁移，避免并发超限与崩溃遗留。
- P1：`ApprovalPolicy` 和 `ProofBladeAppServer` 已接入 GUI；未批准的提交/启动/网络/session 副作用会停在 pending approval，App Server 通过游标事件 API 提供可恢复观测。
- P2：本地 `fixtures/holdout` 提供 27 个 hash-bound case（Web 12、Pwn 12、Reverse/Crypto/Forensics 各 1），`LocalHoldoutEvaluationRunner` 不访问 Provider 网络，可验证成功率、Evidence、成本、重放和候选脱敏；`run-anonymize` 可导出事件级匿名历史；严格 `eval-real` 还要求至少 20 个真实 case 且每个 Variant 有真实 Provider telemetry。

### 2026-08-25 继续审计

- Competition `TaskContract.inputs` 现在绑定平台附件与生成的 `connection-info.txt` 的相对路径、只读标记和 SHA-256；Competition 首轮 prompt 与本地 Run 使用同一套安装根/父目录隔离提示，附件路径穿越也会在 Sandbox 边界拒绝。
- Competition convergence/sandbox/solver 定向回归为 39/39；完整 `npm run verify` 为 583/583，provider-free eval 为 30/30，审计无漏洞。
- 本机没有可用 Provider 凭据，未擅自启动付费真实评测。已有私有 24-case Web/Pwn 报告仍是探索性结果，历史最佳 Variant 成功率约 66.7%，严格 baseline/regression gate 未通过；因此 P2 的真实模型能力门槛仍未完成，不能用 27-case provider-free holdout 冒充模型解题率。

本轮回归通过 materials targeted tests、App Server/审批/Janitor/holdout tests、materials build、GUI typecheck/build 和 CI gate。真实 DASCTF、远程 tube、远程 pwn E2E 仍不在自动化范围。

### 2026-08-26 当前审计补充

- 新增 `npm run platform:selfcheck`：只调用 DASCTF 题目列表和详情/附件 GET；缺少 `PROOFBLADE_COMPETITION_ACCESS_KEY` 返回退出码 2，host 中的 URL userinfo 被拒绝，输出只显示脱敏 origin。
- Browser verifier 已有可选 Playwright adapter 和 `npm run browser:smoke[:required]`；Pwn 已有 ret2libc、format-string、heap/UAF、stack-pivot 四类离线阶段契约矩阵。二者都不把 fake/fixture 结果宣称为真实解题率。
- P0 恢复闭环新增多命令 JSONL 批次的原子替换、`ControlStore.reconcileProjection()` 和启动恢复投影修复；故障发生在事件落盘与 Projection 写入之间时，重启以事件流重建并幂等修复 Projection。
- Control Store 现在对每个 Run 持有跨进程文件锁，锁内重新读取快照并完成事件/Projection 写入；已用两个独立 Node 进程验证并发序号连续、stale lock 回收和活跃 owner 不被抢占。
- 当前历史验证：`npm test` 618/618、DASCTF adapter 33/33、offline eval 30/30、API index check 通过；本轮最新完整门禁见文档顶部。真实 Provider 评测仍需用户准备私有 corpus 和显式授权，Docker Pwn smoke/fault matrix 仍需在具备固定镜像和 Docker daemon 的发布环境执行 required 模式。
- CI 的 staged 测试日志位于 `.proofblade/test-logs/`，workflow 会在成功或失败后以 14 天保留期上传 `proofblade-test-logs-<run-id>`，便于诊断 watchdog 超时和 runner 差异；这不改变默认测试依赖。

### 2026-08-27 broker 接线补充

- CLI、GUI、Competition solver 和唯一 Coding lane 已统一读取 `runtime.sessionBroker`；有配置无 token 时显式 fail-closed，无配置时仍使用本地 Docker/HTTP 路径。
- Pwn/HTTP create wire 现在携带严格校验的方向输入，broker 返回的 opaque session 通过 `SessionRegistry`/`HttpSessionBackend` 绑定到 external-resource ledger；恢复先 inspect/adopt，adopt 会在 projection 缺失时幂等补账，不创建替代 session。
- Coding lane 在首个 Provider 回合前执行 broker health/capability preflight：仅 `READY`、覆盖对应 kind 且 `stableAcrossRestart=true` 的 broker 进入活动组合；配置存在但 token 缺失、探针失败或能力不匹配时按 kind fail-closed，不能静默退回 Docker/进程内 HTTP。没有 health 方法的注入 broker 只作为测试/开发兼容路径，生产 HTTP broker 必须实现该探针。
- `SessionRecord` 与 external-resource ledger 共享 `bindingTxnId` 及 request/policy/recipe/scope hash。新数据严格匹配 marker，旧数据缺 marker 时按不可变身份字段兼容恢复。
- Browser Runtime 现在通过版本化 `bind` wire 将同一 `bindingTxnId` 写入服务端 ledger；带 marker 的 action/heartbeat 不接受未绑定记录，重复 bind 是幂等操作。
- 本轮 staged 三阶段分别执行为 fast 683/683、slow 22/22、integration 80/80；metadata 变更后的定向恢复测试、typecheck、CI gates、changed-tests、component 文档检查和 API index check 也全部通过。Pwn runtime host 定向测试现为 10/10，新增真实 remote TCP worker 的 Control Store commit 边界恢复和五点 fault matrix。新增 `pwn:docker:smoke[:required]` 与 `pwn:docker:fault-matrix[:required]`：普通命令在依赖缺失时显式 SKIPPED，required 命令在发布环境缺依赖时以退出码 2 阻断发布。
- RunRecovery 现在先处理无 owner 的精确 release，再执行外部资源 inspect/adopt，最后才由 BindingTransactionCoordinator 修复 Control Store 绑定；`STARTED/UNKNOWN` 资源不会仅凭 immutable identity 被提升为 `BOUND`，未知句柄转入人工恢复。
- 尚未完成的是部署环境对生产 Pwn supervisor 的完整 Docker/remote fault 证明、逐平台稳定实例句柄及带真实 Provider telemetry 的 20+ case 评测。跨 ledger 已新增 Control Store `FINALIZING → BOUND` fence 与并发 close 回归，但这仍不是物理多文件事务，部署级故障矩阵仍需执行。仓库已提供 `DurablePwnSessionSupervisor`、`scripts/pwn-session-worker.mjs` 和固定镜像 `pwn:docker:smoke[:required]`；broker health/capability preflight 只负责阻止错误降级，不等于每个部署的跨重启证明。不要把当前协议/fake/holdout 结果当作真实解题率。
