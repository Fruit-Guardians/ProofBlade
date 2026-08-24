# ProofBlade 交接文档

面向接手这个项目的人。目标是让你在一小时内知道：这东西为什么这样设计、哪些地方踩过坑、下一步该做什么。

最后更新：2026-08-24。测试状态：**561/561 通过**（`npm test`，`npm run verify`）。

---

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
npm test                    # 561 个测试，全绿才算环境正常
npm run gui                 # GUI 在 http://127.0.0.1:4172
```

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

`SingleAgentCtfLoop` 仍是 Fixture 自动执行的编排器，但它现在创建统一的 `PiCodingLane`；旧的生产 Solver Lane 已删除。评测和单元测试仍可注入确定性 `AgentLaneFactory` 作为测试替身。

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

GUI 和本地 Fixture 通过 `SingleAgentCtfLoop` 进入同一个 Coordinator；区别只在于 Task Contract 的验证类型和是否注入平台 API，不再存在独立的比赛 Solver Lane。

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

### `e2e-submit.mjs`（真模型 + 真题 + 假平台）

目前**唯一**能完整走通提交链的方式，因为真 API 还没有。假的只有 `CompetitionApi`，它下面全是生产代码。

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

通用 `HttpCompetitionApi` 与 DASCTF `DasctfCompetitionApi` 已实现五个操作，并由 fake HTTP/contract tests 覆盖鉴权、附件、环境轮询、错旗、限流/重试和 fail-closed 行为。不要把真实 DASCTF 登录、远程 tube 或 pwn E2E 放进自动测试；本任务只要求平台链接 API 能力。Fleet → Run Actor → Observer → Verifier 的离线组合回放也已覆盖原子终态提交。`CompetitionEnvironmentJanitor` 已补上并发环境容量 reservation、`expires_at` 回收、重启恢复和清理失败重试。

### 🔴 当前最高优先：真实模型能力评测

本地 holdout 已经证明 Run、Evidence、Verifier 和 replay 管道可以工作，但不代表模型会解题。下一步应准备至少 20 个匿名化 Web/Pwn case、两个带 token pricing 的 Provider 配置，并运行 `eval-real --allow-live --enforce-gate`。CLI 会拒绝没有 Provider telemetry 或题目数不足的报告；在这个评测完成前，不引入第二条解题 Lane，也不让 Planner/Refiner 使用独立模型。

### 🟡 Web / Pwn 的真实平台连通性仍未验证（离线契约已覆盖）

目前真实平台连通性仍未验证；Web/Pwn 的 session、scope、Artifact、clean replay 和 barrier 使用 fake/fixture 契约覆盖。Web 和 Pwn 是不同性质的东西：

- **Web** 需要能跨回合保持 cookie/session 的 HTTP 客户端，以及真实可达的目标。Task scope、session generation 和 clean verifier replay 已由离线契约测试强制；真实平台目标仍未作为自动测试前提。
- **Pwn** 需要跨回合保持的交互式 socket。容器内工具 profile、持久 tube、session ownership 和 shell/flag 双 barrier 已由离线契约测试覆盖；真实远程服务仍未作为自动测试前提。
- **验证方式反而更有利**：web/pwn 的 flag 是从活服务**回来**的，会落在 recorded observation 里。crypto/RE 才是难的情况——flag 是离线算出来的，从不出现在任何工具输出里，这正是 `submitCandidate` 对 platform-judged 运行放宽 observation 锚定的原因。

当前边界：先用 fake API、fixture、session contract 和 clean replay 测试验证 Web/Pwn 接口与生命周期，不把真实题目、远程 tube 或平台凭据作为自动验收前提；如未来需要连通性检查，必须是用户明确授权后的独立运维动作。HTTP session 每次请求都会生成脱敏 exchange Artifact，并由统一 Observer 记录候选类型；coding lane 的 `web_session_open/request/close` 只允许访问 task scope，session 随 lane 关闭；WebReproducer 只接受当前 Run 新建的 verifier session，generation 变化后旧 session 不能继续请求。

### 🟢 可选

- GUI Fleet 面板目前默认接 demo API。接上真 solver + 本地文件 API 就能在 GUI 里看真题跑完整流程，比脚本更接近实战形态。
- 继续收敛 verifier 与事件溯源的边界（生产 Solver Lane 已删除，不能再恢复第二条解题路径）
- GUI 里支持逐 profile 的 `contextWindow`
- 动态 flag 直提路径（`solver.ts`）是**未经真实平台验证的假设**：只有平台在开环境时返回 `teamFlag` 才有意义。API 文档到了要么证实要么删。

---

## 10. 改代码时的规矩

1. **先跑 `npm test`**，561 全绿再动手。改完再跑一遍；合并前再跑 `npm run verify`。
2. **不要为了让测试通过而改测试的语义**。第 6 节里每个 bug 都有对应的钉子测试，它们钉的是真实事故。
3. **改了工具契约要更新哈希**：`coding-resources.test.ts` 里的 `CODING_TOOL_CONTRACT_HASH`。它守的是 provider prompt cache 前缀，不是形式主义。
4. **每个模块的 `COMPONENT.md` 是有约束力的**，不是摆设。改了行为要同步改它。
5. **模型是底座**。任何一处改动，问一句：这让模型解题更快或更准了吗？如果增加了流程约束，必须证明它只保护副作用和终态，并且不会替模型决定解题路径。

## 11. P0/P1/P2 当前交付（2026-08-22）

- P0：`RunCoordinator` 已统一 Competition、GUI、Fixture 的阶段和 Verifier-first 终态；`npm run check:changed-tests` 已成为变更测试门禁；Janitor v2 使用原子账本、跨进程锁、reservation 和 schema 迁移，避免并发超限与崩溃遗留。
- P1：`ApprovalPolicy` 和 `ProofBladeAppServer` 已接入 GUI；未批准的提交/启动/网络/session 副作用会停在 pending approval，App Server 通过游标事件 API 提供可恢复观测。
- P2：本地 `fixtures/holdout` 提供 27 个 hash-bound case（Web 12、Pwn 12、Reverse/Crypto/Forensics 各 1），`LocalHoldoutEvaluationRunner` 不访问 Provider 网络，可验证成功率、Evidence、成本、重放和候选脱敏；`run-anonymize` 可导出事件级匿名历史；严格 `eval-real` 还要求至少 20 个真实 case 且每个 Variant 有真实 Provider telemetry。

本轮回归通过 materials targeted tests、App Server/审批/Janitor/holdout tests、materials build、GUI typecheck/build 和 CI gate。真实 DASCTF、远程 tube、远程 pwn E2E 仍不在自动化范围。
