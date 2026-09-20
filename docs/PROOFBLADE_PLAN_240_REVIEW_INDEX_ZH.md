# PLAN-240 逐条评审索引

本文件是给评审者用的**单页入口**。它不引入新结论，只把已有证据串起来，避免为了审一条改动去翻 24 个提交、5 份文档和 23 个 PR。

- 计划：`docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md`（评审修订 1 + 修订 2）
- 成本分解与全部实测：`docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md`
- Bash `description` 契约（已拆出，不在本计划范围）：`docs/PROOFBLADE_BASH_DESCRIPTION_CONTRACT_ZH.md`
- DSH 插件可行性（本次会话的另一个问题）：`docs/deepseek-harness-plugin-feasibility.md`
- 项目报告为生成物（`docs/project/` 下 `PLAN.md`、`UPDATE_LOG.md`、`COMPLETION_REPORT.md`、`MAINTENANCE_REPORT.md`），**不要直接编辑**；唯一事实来源是根目录 `project-status.json`，改后跑 `npm run reports:project`。

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
| T2 / D0 / D2 / G | 无 | 经实测判定不可行或不必要：T2 → #233；G → #235 | — |

## 3. 门禁现状（顶点 `5f8cae6`）

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
| `artifact-readback` | 2 | `tool-timing` | 21 |
| `projection-hint-currency` | 5 | | |
| `barrier-projection` | 5 | **合计** | **143** |

## 4. 必须连在一起读的三处更正

计划原文与实测不一致的地方，均已就地更正并保留「此前为推断、经实测推翻」的标注。**只看计划会读到错误结论**：

1. **屏障频率**（§6.3）：屏障没有消除 O(历史) 成本，只是把它前移到回合边界；冷读从不变成常数。结论是**维持回合边界，不要加密**。
2. **秒级的归因**（§6.4）：**不是**重放回退。投影陈旧时 `snapshot()` 走「投影 + `applyTail`」，不是 `replay()`。真正成本在 `control-store.ts:736` **无条件解析整条事件流**。
3. **封印的保证边界**（§6.5）：封印防的是「伪造投影覆盖真实事件」，**不承诺事件内容未被改动**。因此把读取降为 O(增量)**不牺牲**任何防篡改能力——读取路径上原本就没有这项能力。

`control-store.ts:739-741` 的注释写「replay the full stream so modified prefixes … are revalidated」，而 `replay()` 里没有 revalidate 步骤。**第 2 条错误结论就是被这句注释引出来的**，建议更正；我未擅自改源码注释。

## 5. 未决事项（需维护者决定）

| # | 事项 | 我为什么不自行推进 |
|---|---|---|
| 1 | 读取路径降为 O(增量)（只解析投影 `lastSeq` 之后的尾部） | 要改 `#readSnapshot`——安全工具的权威读路径。§6.5 已排除安全顾虑，但这类改动应由维护者确认推理后再动 |
| 2 | 23 个 PR 的落地方式 | 已证明可纯快进；选哪种交付是你的决定 |
| 3 | 表项 H/I 的客户端部分（§10 PR 12） | 计划 §6.2 自己要求真机/浏览器验证，本环境无浏览器，提供不了该证据 |
| 4 | §7.2.3 目标段评审 | 门槛值需以 §7.2.1 基线为准；本机数值不可直接当阈值 |

## 6. 本次交付自评中的两处失误（供评审时打折判断）

为免评审者高估这批工作的可靠性，两处失误如实记录：

1. **屏障间隔表曾基于写错的探针**（屏障判定写成 `(offset+200) % barrierEvery`，在所选参数下退化成每 200 事件一次），已用重测数据替换（提交 `8a0d9c6`）。
2. **曾误称「全部还原」**，实际只还原了 `control-store.ts`，`jsonl-store.ts` 的计数器与测试仍在且已交付。已在下一轮逐文件核对工作树与 HEAD 后更正。

共同成因是同一个毛病：**用自己上一步的输出代替对实际状态的核对**。此后改为逐文件比对内容、并用 `gh` 取权威映射。
