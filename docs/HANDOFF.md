# ProofBlade 交接文档

面向接手这个项目的人。目标是让你在一小时内知道：这东西为什么这样设计、哪些地方踩过坑、下一步该做什么。

最后更新：2026-08-14。测试状态：**243/243 通过**（`npm test`）。

---

## 1. 这是什么

ProofBlade（证锋）是一个**参赛用**的 CTF 解题 Agent，不是研究框架。比赛形态决定了一切设计：

- 线上初赛，**限时**，平台分批开放大量题目，题量明显超过人工能完成的规模
- **只有统一 API 接口**（取题目信息、开环境、提交 flag、拿反馈），没有 Web UI
- 鼓励人机协同：可以持续调整任务目标、解题优先级、提示词，查看运行状态
- 类别：Web / Misc / Crypto / 脚本分析 / 漏洞利用基础
- 计分：Flag 得分为主，同分依次看 **完成时间 → 解题数量 → 错误提交次数 → API 调用效率**

最后两项 tiebreaker 是很多设计决策的直接原因，看到「为什么要走 Journal」这类问题时先回来看这一条。

底座是 Pi AgentHarness（`@earendil-works/pi-agent-core`，版本锁定）。**核心原则：模型是底座，框架的每一处改动都只应该让模型解题更快、更准。** 历史上违反这条原则的设计（门禁、证据链强制流程）已经被移除，因为它们真的把一次成功的解题搞坏了。

---

## 2. 五分钟跑起来

```powershell
npm install
npm test                    # 243 个测试，全绿才算环境正常
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

### 两条 lane，只有一条有用

| | Solver Lane | **Coding Lane** |
| --- | --- | --- |
| 工具 | 只读代理（`inspect_target` 等） | 真 `bash`/`read`/`edit`/`write` + 一等 MCP + 技能库 |
| 能不能解真题 | **不能**（跑不了利用、写不了脚本、驱动不了反编译器） | 能，已解出多道真题 |
| 比赛是否使用 | 否 | **是** |

`SingleAgentCtfLoop`（solver lane 的编排器）已经不在比赛路径上。solver lane 目前只被 evaluator 和测试引用，暂时留着没删——删它是独立的一次改动，跟别的混在一起出问题会分不清锅。

### 竞赛路径（`packages/materials/src/competition/`）

```
FleetScheduler          并发 worker 池 + 控制面
  └─ CompetitionChallengeSolver   一题 = 一次完整运行
       ├─ CompetitionApi          与平台之间唯一的接缝（尚未实现真 HTTP 客户端）
       ├─ CompetitionSandbox      解附件、写 connection-info.txt、fixture_score → 提交平台
       └─ runCompetitionLoop      在 coding lane 上驱动，有界轮数/deadline/abort/assist
```

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

注意 solver lane 的 `run_background` **不能**解决这个问题——它只启动 capability job（`capabilityId` + `operation`），不是 shell 命令。

---

## 8. 技能库

`skills-library/ctf-skills/` 是 vendor 进来的第三方仓库（[ljagiello/ctf-skills](https://github.com/ljagiello/ctf-skills)，MIT，commit `d6662d2`），9 个类别，`LICENSE` 和版权声明**原样保留**。嵌套的 `.git` 已删除。

模型通过 bash 直接 `cat` 读它，不走 `load_skill`。系统提示里的编排器是**类别无关**的：侦察 → 归类 → `cat "<lib>/ctf-<category>/SKILL.md"` → 照着做 → 收敛。这样切换题型只是读不同的文件，提示本身不用改，也不会给不匹配的题型塞错误引导。

`skills/` 下另有项目自己的技能（`ctf-reverse` 等），走 `load_skill`。注意 `skills.test.ts` 断言 `ctf-reverse/SKILL.md` 里有字面量 `invoke_capability`，改那个文件时别删掉这个词。

---

## 9. 下一步（按优先级）

### 🔴 阻塞项：真 HTTP `CompetitionApi`

**这是唯一挡在实战前面的东西。** solver、sandbox、fleet、提交链全都是真的了，只差平台客户端。需要赛事 API 文档：端点、鉴权方式、5 个操作（listChallenges / getChallenge / startEnvironment / submitFlag / stopEnvironment）的请求响应字段。

写的时候：`NotConfiguredCompetitionApi` 是 fail-closed 的占位，**别让它静默退回假数据**。

同时要做环境生命周期 janitor（并发环境上限 + `expires_at` 回收）。

### 🟡 Web / Pwn 类型还没验证过

目前只验证了 **RE 和 Crypto**，这两类都是「本地文件 + 不需要网络」。Web 和 Pwn 是不同性质的东西：

- **Web** 需要能跨回合保持 cookie/session 的 HTTP 客户端，以及真实可达的目标。`external_network: true` 和 `allowed_hosts` 在 task 里设了，但**我没有验证过有任何东西真的在强制这个 scope**。
- **Pwn** 需要跨回合保持的交互式 socket。现实答案是脚本里用 `pwntools`，但**没确认装了没有**。`shell_background` 在这里很关键：本地目标或代理得在回合之间一直活着。
- **验证方式反而更有利**：web/pwn 的 flag 是从活服务**回来**的，会落在 recorded observation 里。crypto/RE 才是难的情况——flag 是离线算出来的，从不出现在任何工具输出里，这正是 `submitCandidate` 对 platform-judged 运行放宽 observation 锚定的原因。

建议做法：**各挑一道真题跑，让它大声失败**，然后按暴露出的问题修。别提前建设推测出来的支持。

### 🟢 可选

- GUI Fleet 面板目前默认接 demo API。接上真 solver + 本地文件 API 就能在 GUI 里看真题跑完整流程，比脚本更接近实战形态。
- 删 solver lane / verifier / 事件溯源（确认真的没人用之后）
- GUI 里支持逐 profile 的 `contextWindow`
- 动态 flag 直提路径（`solver.ts`）是**未经真实平台验证的假设**：只有平台在开环境时返回 `teamFlag` 才有意义。API 文档到了要么证实要么删。

---

## 10. 改代码时的规矩

1. **先跑 `npm test`**，243 全绿再动手。改完再跑一遍。
2. **不要为了让测试通过而改测试的语义**。第 6 节里每个 bug 都有对应的钉子测试，它们钉的是真实事故。
3. **改了工具契约要更新哈希**：`coding-resources.test.ts` 里的 `CODING_TOOL_CONTRACT_HASH`。它守的是 provider prompt cache 前缀，不是形式主义。
4. **每个模块的 `COMPONENT.md` 是有约束力的**，不是摆设。改了行为要同步改它。
5. **模型是底座**。任何一处改动，问一句：这让模型解题更快或更准了吗？如果答案是「让流程更规范」，那大概是应该删掉的东西——门禁和证据链就是这么没的。
