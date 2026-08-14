# 比赛并行解题(Fleet)功能说明

本文档说明为线上初赛新增的**比赛适配层 + 并行调度(Fleet)** 功能:它做什么、当前实现到哪一步、怎么测。

> 状态标记:✅ 已完成且可测 · ⏳ 进行中 · ⛔ 阻塞(等赛事 API 文档)

---

## 1. 这套功能解决什么

赛制要求「题量超过人工能力,靠自研 Agent 批量分析、自动尝试、持续提交」,且**只开放统一 API**。原框架是**一道一道串行**解合成靶场,方向不对。这套改动把它变成:

- 一个**接缝层**(`CompetitionApi`),把"拉题 / 取附件 / 启动环境 / 提交 flag / 停环境"抽象成 5 个操作,真 HTTP 实现等文档到了再填(现在是可运行的演示实现)。
- 一个**并行调度器**(`FleetScheduler`),按分值优先级并行解多道题,支持运行中实时控制。
- 一套**比赛档规则调整**:提交后由平台判分(不再本地复现),`required_reproductions=1` 避免重复提交,提交门禁对动态/算出来的 flag 放宽。

---

## 2. 已完成的部分

### ✅ 后端(packages/materials/src/competition/)
| 文件 | 作用 |
| --- | --- |
| `api.ts` | `CompetitionApi` 抽象接口(唯一接缝)+ `NotConfiguredCompetitionApi` 占位 + `normalizeCategory` |
| `task.ts` | `competitionTask()` —— 用 `platform_submission` 校验类型、`required_reproductions=1`、`external_network=true` |
| `sandbox.ts` | `CompetitionSandbox`(实现 `SandboxPort`):解附件、`fixture_score`→提交平台、生命周期→停环境 |
| `fleet.ts` | `FleetScheduler` —— 并发/优先级/生命周期/快照 + 控制面(见下) |
| `loop.ts` | `runCompetitionLoop()` —— 在 **coding lane** 上驱动单题(有界轮数 / deadline / abort / assist 提交前停下) |
| `solver.ts` | `CompetitionChallengeSolver` —— 把单题包成一次完整 coding lane 运行;动态 flag 题直接提交不跑模型 |

**控制面(FleetScheduler 方法)**:
- `reprioritize(id, priority)` —— 改优先级(对 pending 题生效)
- `setChallengeMode(id, "auto"|"assist")` —— **第二档动态模式**:翻成 assist 后,该题跑到下一个提交点会暂停等人确认(不是原地打断)
- `cancelChallenge(id)` —— pending 直接丢弃;running 中止其运行
- `setConcurrency(n)` —— 运行中动态增/减并发 worker(1..32)

### ✅ GUI 服务端(apps/gui/src/)
- `fleet.ts` —— 演示用 `DemoCompetitionApi` + `DemoChallengeSolver`(12 道假题,抖动延迟,无需模型/网络),以及 `FleetController`(持有调度器,把快照广播给所有 SSE 订阅者)。
- `server.ts` 新增路由(见第 4 节接口)。
- `api.ts` 新增客户端封装(`streamFleet` 等)。

### ✅ FleetView 可视化面板(apps/gui App.tsx)
左侧栏「并行解题 (Fleet)」按钮进入全局面板:工具栏(开始 / 并发数 / 解出·运行·等待·失败·得分汇总)+ 实时挑战表格(状态徽章、题目、类别、分值、Auto/Assist 切换、置顶优先级、取消)。通过 SSE(`/api/fleet/stream`)实时刷新,控制按钮仅在 pending/running 行可用。已用 Playwright 在浏览器端验证:开始→全部跑到终态、取消一道 pending 题、把运行中的题翻成 Assist 都实时生效。

### ✅ 测试(全绿)
- `packages/materials/tests/competition-sandbox.test.ts`(4)
- `packages/materials/tests/competition-fleet.test.ts`(6)—— 并发上限、优先级、失败隔离、跳过已解、取消
- `packages/materials/tests/competition-solver.test.ts`(6)—— coding lane 经 `submit_flag` 解出、assist 只记录不联系平台、重复同一 flag 只调一次 API、动态 flag 直提、运行中翻 assist 拦下下一次提交、fleet 跑真 solver
- `packages/materials/tests/competition-control-plane.test.ts`(5)—— 取消 pending/running、动态增/减并发、运行中翻 mode
- materials 全套 **238/238 通过**。

---

### ✅ 提交链(coding lane)

`submit_flag` 只在 `verification.kind = "platform_submission"` 时注册,GUI 聊天运行拿不到它。链路:

```
submit_flag → runtime.submitCandidate(格式校验/提交预算/候选哈希去重)
            → IndependentVerifier → Journal fixture_score
            → CompetitionSandbox → api.submitFlag   ← 真正到平台
```

走 Journal 而不是直接调 API 是刻意的:规则把**错误提交次数**和 **API 调用效率**并列作为 tiebreaker,Journal 的 idempotency key 会把重复提交同一 flag 折叠成回放而非第二次真实调用,事件日志本身就是这两项的账本。assist 模式下候选只记录为 PROPOSED completion,**完全不联系平台**,fleet 里显示为 `awaiting_approval`(待放行)而非失败。

`max_tool_calls` 提到 200:它只约束进 Journal 的调用(capability invoke / artifact read / fixture_score),coding lane 的 bash/read/edit/write 和一等 MCP 工具都不过 Journal。实跑已出现过 130+ 次工具调用,原来的 40 会因为记账把一次本可成功的解题打断。

---

## 3. 还没完成的部分

- ⛔ **真 HTTP `CompetitionApi` 实现**。这是用**实题**测试的唯一拦路石,需要赛事 API 文档(端点、鉴权、5 个操作的请求/响应字段)。solver 本身已经是真的了。
- ⚠️ coding lane 没有后台任务工具(solver lane 有 `run_background`/`read_job_output`/`stop_job`)。实跑出现过一次 12 分钟阻塞的 C 爆破,在 fleet 里等于一个 worker 槽位空转 12 分钟。要不要移植看实际吞吐。
- ⛔ 环境生命周期 janitor(并发环境上限 + `expires_at` 回收)——等 API 文档一起做。
- ⚠️ 动态 flag 直提路径(`solver.ts`)是**未经真实平台验证的假设**:若平台在启动时返回 `teamFlag` 才有意义,否则是无害死代码。文档到了要么证实要么删。

---

## 4. 怎么测(现在就能做)

### A. 跑测试套件
```powershell
npm run build --workspace=@proofblade/materials
node --import tsx --test packages/materials/tests/competition-*.test.ts
```

### B. 起 GUI 服务端,用 curl 打接口(演示数据,无需模型)
```powershell
npm run gui -- --port 4199
```
另开一个终端:
```powershell
# 启动并行解题(返回当前快照)
curl -s -X POST http://127.0.0.1:4199/api/fleet/start -d "{}"

# 运行中把并发改成 5(worker 池实时扩容)
curl -s -X POST http://127.0.0.1:4199/api/fleet/concurrency -H "content-type: application/json" -d "{\"concurrency\":5}"

# 把某题翻成 assist(下次提交前暂停)
curl -s -X POST http://127.0.0.1:4199/api/fleet/challenges/DEMO-05/mode -H "content-type: application/json" -d "{\"mode\":\"assist\"}"

# 取消某题
curl -s -X POST http://127.0.0.1:4199/api/fleet/challenges/DEMO-03/cancel -d "{}"

# 把某题优先级提到最前
curl -s -X POST http://127.0.0.1:4199/api/fleet/challenges/DEMO-08/priority -H "content-type: application/json" -d "{\"priority\":9999}"

# 实时快照流(SSE,每次状态变化推一条)
curl -s -N http://127.0.0.1:4199/api/fleet/stream
```

### 接口一览
| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/fleet/stream` | SSE:每次状态变化推 `FleetSnapshot` |
| POST | `/api/fleet/start` | 启动一次并行解题 |
| POST | `/api/fleet/concurrency` | `{concurrency:1..32}` 动态改并发 |
| POST | `/api/fleet/challenges/:id/cancel` | 取消一道题 |
| POST | `/api/fleet/challenges/:id/mode` | `{mode:"auto"\|"assist"}` |
| POST | `/api/fleet/challenges/:id/priority` | `{priority:number}` |

`FleetSnapshot` = `{ concurrency, active, solvedValue, totals, challenges[] }`;每题 `challenges[i]` = `{ challengeId, title, category, value, priority, mode, state, flag?, submissions?, reason? }`,`state ∈ pending|running|solved|failed|skipped|cancelled`。

---

## 5. 接真实比赛需要做的(等 API 文档)

1. 写真 HTTP `CompetitionApi`(实现 `api.ts` 的 5 个方法),替换 `apps/gui/src/fleet.ts` 里的 `DemoCompetitionApi`,并把 `DemoChallengeSolver` 换成 `CompetitionChallengeSolver`。
2. 确认 `proofblade.config.json` 的模型端点可用(现在指向本地 LM Studio `127.0.0.1:1234`)。
3. 完成 FleetView 面板 + 环境 janitor。
