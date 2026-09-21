# PLAN-240 逐条评审索引

本文件是给评审者用的**单页入口**。它不引入新结论，只把已有证据串起来，避免为了审一条改动去翻 24 个提交、5 份文档和 23 个 PR。

- 计划：`docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md`（评审修订 1 + 修订 2）
- 成本分解与全部实测：`docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md`
- Bash `description` 契约（已拆出，不在本计划范围）：`docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`
- DSH 插件可行性（本次会话的另一个问题）：`docs/deepseek-harness-plugin-feasibility.md`
- 项目报告**已移出版本控制**（`docs/project/` 下 `PLAN.md`、`UPDATE_LOG.md`、`COMPLETION_REPORT.md`、`MAINTENANCE_REPORT.md`）。唯一事实来源是根目录 `project-status.json`；本地用 `npm run reports:project` 生成，CI 作为 artifact `proofblade-project-reports-<run_id>` 上传。**不要直接编辑那四份文件，也不要用它们做评审依据**——它们随每次生成而变。
- 之所以移出：每个 PR 都签入自己那一份（内含各自的 `updatedAt` 与组件版本），合并任意一个都会让其余全部相对新 base 变陈旧，`check:project-reports --base` 随即报矛盾。详见本文件 §7。

## 1. 建议的评审顺序

1. **先看计划 §10.1「落地状态」** —— 14 条意图 vs 实际交付，以及每条没做的**原因分类**（实测不可行 / 实测不必要 / 缺本环境无法产出的证据）。
2. **再看成本分解 §6.3–§6.5** —— 这一轮把计划的**根因归因推翻了两次**，只看计划会得到错误结论。
3. **然后看成本分解 §7 变异计分卡** —— 哪些断言已被证明能变红、哪一条不能及其原因。
4. **最后按 PR 逐条看** —— 用下面的映射表定位。

## 2. 交付映射（PR 编号取自 GitHub，不按提交顺序推断）

| 计划表项 | 交付 PR | 核心断言 / 测试入口 | 变异验证 |
|---|---|---|---|
| A 构建一致性 | #222 | `apps/gui/tests/runtime-shape.test.ts` | ✅ M9 |
| T0 计时与基线 | #223 #230 #240 | `packages/materials/tests/tool-timing.test.ts` + 3 个 baseline 脚本 | 计时器本身不写 ControlStore（未变异） |
| C 轻量创建 | #226 | `workspace-settings.test.ts` | ✅ M10 |
| E′ staging 回归 | #225 | `debug-data.test.ts`（双向：普通对话不 staging ∧ 附件任务 staging） | 未单独变异 |
| T3 延后投影 | #228 | `experiment-gate-projection.test.ts` | ✅ M13 |
| T1 回读 | #229 | `artifact-readback.test.ts` | ✅ M3 |
| D3/T4 遥测离路径 | #232 | `telemetry-lazy-payload.test.ts` | ✅ M12 |
| F skill catalog 记忆化 | #234 | `skill-registry-cache.test.ts` | ✅ M14 |
| D 版本快照缓存 | #227 | `version-cache.test.ts` | ✅ M1 M2 |
| J 预算门禁 | #236 | `hot-path-budget.test.ts`（4 条 `[contract:...]`） | ✅ M3 M14 M16 M17 |
| 归档失败语义 | #238 | `archival-failure-semantics.test.ts` | ✅ M15 |
| observer 失败不静默 | #237 | `observer-diagnostics.test.ts` | ✅ M4 |
| I 轮询可见性 | #239 | `polling.test.ts` | ✅ M8 |
| 屏障廉价校验 | #242 | `barrier-projection.test.ts` | ❌ **未抓住**（见 §4） |
| 投影 hint 时效 | #243 | `projection-hint-currency.test.ts` | ✅ M5 |
| RunDetail 缓存失效 | —（既有） | `debug-data.test.ts` | ✅ M11 |
| 读取路径计数 + 归因更正 | #244 | `read-path-parse-budget.test.ts` | 部分 |
| **读取路径降为 O(增量)** | #244 | `projection-read-bound.test.ts`（5 条守恒断言） | 未逐条变异 |
| T2 | `dispatch-transaction-batch.test.ts`（3 条） | **实测可行，已重开**（原判定被推翻，见拆分文档 §2.5） |
| D0 / D2 / G | 无 | 经实测判定不必要：G → #235；D0/D2 → 会引入并行抽象层 |

### 2.1 读取路径降为 O(增量)：已实施（用户授权）

计划原本没有这一项，是实测暴露的。**实测 150 倍**，且快路径**不反序列化任何事件**：

| 场景（10,001 事件，生产形态） | 修改前 | 修改后 |
|---|---:|---:|
| 冷读，投影当前 | **1876 ms**（解析 +10001） | **12.5 ms**（解析 **+0**） |
| 冷读，投影落后于日志 | 1722 ms | 仍走完整解析（预期） |
| 读取方注入了错误的 secret | — | 回退完整解析（2064 ms，fail-safe） |

**规模曲线证明目标达成**：投影当前的冷读**恒定 11–12 ms，不随历史增长**（0 事件与 10,001 事件同价）；投影落后时仍 O(历史)（10,000 事件 1635 ms）。

**残余窗口需要另一条改动**：投影落后时读不到 O(增量)，因为 `loadProjection()` 的封印校验要求**完整前缀**。要覆盖这一档得把封印改成**链式哈希**，那是协议破坏性变更，需单独决策与迁移方案。本条目解决的是「投影当前」——即回合边界屏障之后 GUI 的读取，也就是使用者实际遇到的那一档。

**根因有两处**，这也是第一次改动只从 1877 降到 1845 的原因：`#readSnapshot` 每次缓存未命中先跑 `#migrateLegacyRunBestEffort`，而 `migrateLegacyRun()` **无条件解析整条流**（13.4 ms / +2001 事件）；之后投影那一处再解析一次。两处都已改为有界读（文件头/尾各 64 KiB）＋判断不确定就退回完整解析。

**守恒测试**锁的是代价换来的保证，不是计时：投影当前时解析为 0；投影落后时折叠结果与 `replay()` 完全一致；**伪造投影仍不能覆盖事件日志**；投影缺失仍可从日志重建；**无 seal 的旧投影不被信任**。后两条是 §6.5「封印的保证」的回归防线。

详见成本分解 §6.6。

## 3. 门禁现状（顶点 `60f0f67`）

| 门禁 | 结果 |
|---|---|
| `check:components` | 通过（26 components，0 affected） |
| `check:change-contracts` | 通过（11 contracts / 37 scenarios） |
| `check:project-reports` | 通过（4 reports） |
| `api:index:check` | 通过 |
| `check:changed-tests` | 通过 |
| `test:ci-gates` | 40 通过 |
| `test-matrix` | 23 rules |
| `npm run build` | 无 `error TS` |
| `npm run test:staged` | **1003 用例 / 997 通过 / 2 失败 / 4 跳过**（失败见下） |

### 3.0 全量 `test:staged` 的两处失败：环境性，非本次改动引入

| 失败用例 | 错误 |
|---|---|
| `shell_background returns immediately and shell_job polls then stops the real process` | `EBUSY: resource busy or locked, rmdir '…\Temp\proofblade-shell-bg-test-…'` |
| `bash anchors an artifact only when output was actually withheld` | `EBUSY: resource busy or locked, rmdir '…\Temp\proofblade-anchor-test-…'` |

两条都是**临时目录清理时 `EBUSY`**——Windows 上后台子进程尚未释放句柄，属环境限制而非断言逻辑失败。判定为非本次引入的依据：本次会话在干净基线 `e3ffb3c`（= 当前 `origin/main`）与 `1eaab04` 上分别跑过全量套件，**同样这两条失败**。

**我不能给出的保证**：本次没有在最后一轮再跑一遍干净基线做同轮对照，上句依据的是本会话早前的两次基线运行。若需要严格同轮对照，请在 `e3ffb3c` 上复跑一次。

**合并拓扑**：`origin/main` = `e3ffb3c`；`perf/plan-240-integration` = `589de5e`（`main` 之上 23 个提交）；本 PR 分支位于集成分支之上（提交数会随本文件自身更新而变化，故不写死——用 `git rev-list --count origin/perf/plan-240-integration..<分支>` 取）。

判定依据：`git merge-base origin/main origin/perf/plan-240-integration` = `e3ffb3c`（即当前 `main` 顶点）；`git rev-list --count origin/perf/plan-240-integration..origin/main` = **0**；`git merge-tree --write-tree origin/main origin/perf/plan-240-integration` **exit 0**。即集成分支相对 `main` 是**纯快进，无冲突**。

三个 baseline 脚本：`scripts/tool-hot-path-baseline.ts`（provider-free）、`scripts/tool-hot-path-real-run-baseline.ts`、`scripts/tool-hot-path-long-run-baseline.ts`。

### 3.1 各套件用例数（本机实跑，全绿）

| 套件 | 用例 | 套件 | 用例 |
|---|---:|---|---:|
| `runtime-shape` | 8 | `telemetry-lazy-payload` | 6 |
| `polling` | 7 | `experiment-gate-projection` | 5 |
| `workspace-settings` | 2 | `skill-registry-cache` | 9 |
| `debug-data` | 42 | `archival-failure-semantics` | 3 |
| `version-cache` | 13 | `hot-path-budget` | 5 |
| `observer-diagnostics` | 6 | `read-path-parse-budget` | 4 |
| `artifact-readback` | 2 | `projection-read-bound` | 5 |
| `projection-hint-currency` | 5 | `tool-timing` | 21 |
| `barrier-projection` | 5 | **合计** | **148** |

## 4. 必须连在一起读的三处更正

计划原文与实测不一致的地方，均已就地更正并保留「此前为推断、经实测推翻」的标注。**只看计划会读到错误结论**：

1. **屏障频率**（§6.3）：屏障没有消除 O(历史) 成本，只是把它前移到回合边界；冷读从不变成常数。结论是**维持回合边界，不要加密**。
2. **秒级的归因**（§6.4）：**不是**重放回退。投影陈旧时 `snapshot()` 走「投影 + `applyTail`」，不是 `replay()`。真正成本在 `control-store.ts:736` **无条件解析整条事件流**。
3. **封印的保证边界**（§6.5）：封印防的是「伪造投影覆盖真实事件」，**不承诺事件内容未被改动**。因此把读取降为 O(增量)**不牺牲**任何防篡改能力——读取路径上原本就没有这项能力。

`control-store.ts:739-741` 的注释写「replay the full stream so modified prefixes … are revalidated」，而 `replay()` 里没有 revalidate 步骤。**第 2 条错误结论就是被这句注释引出来的**。该注释已随 §2.1 的改动删除并改写。

## 5. 未决事项（需维护者决定）

| # | 事项 | 状态 |
|---|---|---|
| ~~1~~ | ~~读取路径降为 O(增量)~~ | **已由用户授权并实施**（§2.1）。安全推理见 §6.5 |
| 2 | 23 个 PR 的落地方式 | **用户已明确：先不合并，等他人审查** |
| 3 | 表项 H/I 的客户端部分（§10 PR 12） | **用户已明确：GUI 由用户自己测**。服务端 `afterSeq`/`limit` 已就绪；客户端尚未调用，改动需动 `App.tsx` 的时间线与调试器 |
| 4 | §7.2.3 目标段评审 | 门槛值需以 §7.2.1 基线为准；本机数值不可直接当阈值 |
| 5 | §6.5 那条失准注释 | 已在 §2.1 改动中修正 |

## 6. 本次交付自评中的两处失误（供评审时打折判断）

为免评审者高估这批工作的可靠性，两处失误如实记录：

1. **屏障间隔表曾基于写错的探针**（屏障判定写成 `(offset+200) % barrierEvery`，在所选参数下退化成每 200 事件一次），已用重测数据替换（提交 `8a0d9c6`）。
2. **曾误称「全部还原」**，实际只还原了 `control-store.ts`，`jsonl-store.ts` 的计数器与测试仍在且已交付。已在下一轮逐文件核对工作树与 HEAD 后更正。

共同成因是同一个毛病：**用自己上一步的输出代替对实际状态的核对**。此后改为逐文件比对内容、并用 `gh` 取权威映射。

## 7. 生成报告移出版本控制（为什么，以及影响）

**症状**：每合并一个 PR，其余 PR 就开始报文档矛盾。

**机制**（已实测，不是推断）：每个 PR 都会改同一批「账本文件」，而其中带**每个 PR 自己唯一的时间戳**：

| 文件 | 每个 PR 都改 |
|---|---|
| `project-status.json` | `updatedAt` + 新增 UPDATE 记录 |
| `docs/project/*.md`（4 份） | 由上面那份**生成**，内容含 `updatedAt` 与组件版本/次数/指纹 |
| `COMPONENT.md` | `version`（patch+1）、`updatedAt`、审计次数、`sourceHash` |

实测两个分支各自对 `main` 的改动量：`project-status.json` 我=[+581,−1] / PR227=[+173,−1]；`MAINTENANCE_REPORT.md` 我=[+10,−10] / PR227=[+6,−6]。

**合并第一个 PR 后，其余每个 PR 的这 6 个文件都相对新 base 陈旧** → `check:project-reports --base` 报 `stale generated report`，`check:components --base` 报版本/指纹矛盾。

**讽刺点**：`ci.yml` 原本在检查**之前**就跑了 `npm run reports:project`，把那 4 份报告重新生成了一遍——所以它们在 CI 里的字节比对几乎是恒真的。**签入仓库的唯一实际效果就是每次合并制造矛盾。**

**改动**：
- `docs/project/` 加入 `.gitignore`，四份文件 `git rm --cached` 移出版本控制（仍可随时生成）
- CI 顺序调整：先跑 `--base` 契约检查，再生成报告并作为 artifact 上传
- `check:project-reports` 的**契约本身不变**——生成物仍须与 `project-status.json` 及组件元数据一致

**契约仍会咬人**（变异验证过）：篡改一份报告 → `stale generated report` 失败；只改 `project-status.json` 而不重新生成 → 四份全部 stale 失败；还原后通过。模拟全新克隆（文件缺失）→ 报 `missing`，先 `npm run reports:project` 后通过。

**评审这部分的注意事项**：这是**仓库治理改动**，会改变所有 PR 的行为，值得单独审。剩余冲突面只有 `project-status.json` 与 `COMPONENT.md`；前者是纯 JSON 追加，冲突通常是单行 `updatedAt`。
