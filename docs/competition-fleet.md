# 比赛并行解题(Fleet)功能说明

本文档说明为线上初赛新增的**比赛适配层 + 并行调度(Fleet)** 功能:它做什么、当前实现到哪一步、怎么测。

> 状态标记:✅ 已完成且可测 · ⏳ 进行中 · ⛔ 阻塞(需要明确外部依赖或用户授权)

---

## 1. 这套功能解决什么

赛制要求「题量超过人工能力,靠自研 Agent 批量分析、自动尝试、持续提交」,且**只开放统一 API**。原框架是**一道一道串行**解合成靶场,方向不对。这套改动把它变成:

- 一个**接缝层**(`CompetitionApi`),把"拉题 / 取附件 / 启动环境 / 提交 flag / 停环境"抽象成 5 个操作；同时提供通用 `HttpCompetitionApi` 与 DASCTF 专用 `DasctfCompetitionApi`，GUI 可通过配置选择，未配置时才使用演示实现。
- 一个**并行调度器**(`FleetScheduler`),按分值优先级并行解多道题,支持运行中实时控制。
- 一套**比赛档规则调整**:提交后由平台判分(不再本地复现),`required_reproductions=1` 避免重复提交,提交门禁对动态/算出来的 flag 放宽。

---

## 2. 已完成的部分

### ✅ 后端(packages/materials/src/competition/)
| 文件 | 作用 |
| --- | --- |
| `api.ts` | `CompetitionApi` 抽象接口(唯一接缝)+ 通用 `HttpCompetitionApi` + `NotConfiguredCompetitionApi` + `normalizeCategory` |
| `dasctf-api.ts` | DASCTF `/slab-match/api/v1/agent` 适配器：AccessKey、五个操作、附件、环境轮询、错旗与限流策略 |
| `task.ts` | `competitionTask()` —— 用 `platform_submission` 校验类型、`required_reproductions=1`、`external_network=true` |
| `sandbox.ts` | `CompetitionSandbox`(实现 `SandboxPort`):解附件、`fixture_score`→提交平台、生命周期→停环境 |
| `fleet.ts` | `FleetScheduler` —— 并发/优先级/生命周期/快照 + 控制面(见下) |
| `loop.ts` | `runCompetitionLoop()` —— 在 **coding lane** 上驱动单题(有界轮数 / deadline / abort / assist 提交前停下) |
| `solver.ts` | `CompetitionChallengeSolver` —— 把单题包成一次完整运行;动态 flag 题跳过模型 turn，但仍走 Run/Artifact/Journal/verifier 终态 |

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

### ✅ 测试(离线契约覆盖)
- `packages/materials/tests/competition-sandbox.test.ts`(4)
- `packages/materials/tests/competition-fleet.test.ts`(6)—— 并发上限、优先级、失败隔离、跳过已解、取消
- `packages/materials/tests/competition-solver.test.ts`(7)—— coding lane 经 `external_submit` 解出、assist 只记录不联系平台、重复同一结果只调一次 API、平台提供结果的无模型但 journaled run、assist 只记录 proposal、运行中翻 assist 拦下下一次提交、fleet 跑真 solver
- `packages/materials/tests/competition-control-plane.test.ts`(5)—— 取消 pending/running、动态增/减并发、运行中翻 mode
- `dasctf-api.test.ts` 与 `competition-api.test.ts` 使用 fake `fetch` 覆盖平台链接契约；不需要真实 DASCTF 凭据，也不建立远程 tube。

---

### ✅ 提交链(coding lane)

Competition 的 `external_submit` 只在 `verification.kind = "platform_submission"` 时注册,GUI 聊天运行拿不到它。链路:

```
external_submit → runtime.submitExternal(不透明结果/提交预算/结果哈希去重)
               → IndependentVerifier → Journal fixture_score
               → CompetitionSandbox → api.submitFlag   ← 平台适配器内部调用
```

走 Journal 而不是直接调 API 是刻意的:规则把**错误提交次数**和 **API 调用效率**并列作为 tiebreaker,Journal 的 idempotency key 会把重复提交同一结果折叠成回放而非第二次真实调用,事件日志本身就是这两项的账本。assist 模式下结果只记录为 PROPOSED completion,**完全不联系平台**,fleet 里显示为 `awaiting_approval`(待放行)而非失败。

`max_tool_calls` 提到 200:它只约束进 Journal 的调用(capability invoke / artifact read / fixture_score),coding lane 的 bash/read/edit/write 和一等 MCP 工具都不过 Journal。实跑已出现过 130+ 次工具调用,原来的 40 会因为记账把一次本可成功的解题打断。

---

## 3. 还没完成的部分

- ⏳ **赛事字段漂移监控**。适配器与 fake contract 已完成；如果赛事 API 的 envelope/字段变化，只需更新适配器映射与契约测试，不把真实联网调用放进 CI。
- ✅ 统一 coding lane 提供 `shell_background`/`shell_job`，长时间爆破不会阻塞整个 Provider 回合；Fleet 仍按 worker deadline 和任务预算回收槽位。
- ✅ 环境生命周期 janitor：`CompetitionEnvironmentJanitor` 在启动前保留容量槽，持久化 `instanceId`/`expiresAt`，新进程可 sweep 过期环境；stop 失败保留 ACTIVE 记录并可重试。它已接入 GUI live backend 创建的 `CompetitionChallengeSolver`，不需要真实 DASCTF 才能通过 fake API 验证。
- ⚠️ 动态 flag 的赛事字段仍需持续监控；当前 adapter contract 已固化已知响应形状，提交仍经过本地 Effect Journal 与 fake verifier，不通过真实平台调用猜测行为。

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

## 5. 接真实比赛需要做的(仅在用户明确授权并提供凭据时)

1. 在 `~/.proofblade/competition.json` 或环境变量配置 `platform: "dasctf"`、`serverHost` 与 `accessKey`；GUI 会装配 `DasctfCompetitionApi`，AccessKey 不写入日志。
2. 确认 `proofblade.config.json` 的模型端点可用(现在指向本地 LM Studio `127.0.0.1:1234`)。
3. 完成 FleetView 面板 + 环境 janitor；任何真实平台连通性检查都必须是显式、单独的运维动作，不属于自动测试或本任务验收。

## 6. P0/P1/P2 补充（2026-08-22）

- Janitor v2 已把环境容量 reservation 在启动前写入持久账本，并通过原子写入、跨进程锁、过期 sweep 和 schema v1 迁移支持崩溃恢复。
- Fleet 使用的 Solver 已接入 `ApprovalPolicy`：平台提交、环境启动、网络请求和 session 打开均可配置为人工批准；未批准时 challenge 停在 `awaiting_approval`，不会发出平台副作用。
- GUI `/api/v2/runs/:id`、`events`、`approvals` 和审批批准路由提供 App Server 风格的只读/控制边界，事件按 `afterSeq` 游标恢复。
- 本地 holdout 评测位于 `fixtures/holdout/`，仅使用 Web/Pwn transcript fixture 和 fake/deterministic lane；不做真实 DASCTF、远程 tube 或 pwn E2E。

验收入口：

```powershell
npm run check:changed-tests
node --import tsx --test packages/materials/tests/environment-janitor.test.ts packages/materials/tests/approval-policy.test.ts packages/materials/tests/app-server.test.ts packages/materials/tests/local-holdout.test.ts
```
