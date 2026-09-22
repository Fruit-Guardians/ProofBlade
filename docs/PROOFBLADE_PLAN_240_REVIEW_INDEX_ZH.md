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
| ~~**读取路径降为 O(增量)**~~ | ~~#244~~ | **已实施后撤销**：`projection-read-bound.test.ts`（6 条守恒断言；其中「原地改写同长度历史事件」是撤销依据） | 见 §2.1 |
| T2 | `dispatch-transaction-batch.test.ts`（3 条） | **实测可行，已重开**（原判定被推翻，见拆分文档 §2.5） |
| D0 / D2 / G | 无 | 经实测判定不必要：G → #235；D0/D2 → 会引入并行抽象层 |

### 2.1 读取路径降为 O(增量)：**已实施后撤销**

> **本节此前写作「已实施（用户授权）」并给出 150 倍收益表。那些数字描述的是一个已经不在任何分支上的快路径。**以下为撤销后的实际状态。

**做了什么，以及为什么撤销。** 曾经实现过一条快路径：`#readSnapshot` 在缓存未命中时先问 `loadProjectionHint()`，投影当前就直接采用它、不解析事件流（10,001 事件下 **1876 ms → 12.5 ms**，解析量 +0）。它被撤回，因为**封印无法为「历史字节就是前缀哈希所覆盖的那一份」作证**：

- `projectionSealPayload()` 是 `canonicalJson({ schemaVersion: 1, runId, lastSeq, snapshotHash, eventPrefixHash })`——**没有 size 字段**，所以「文件长度未变」不是封印提供的保证；
- `hashEventPrefix()` 算的是 `sha256(canonicalJson(prefix))`，即**解析后事件的规范化 JSON**，无法从磁盘原始字节复算。

于是「保持字节长度、原地改写某条历史事件的 payload、保持末尾 `seq`」能通过快路径的**全部**检查，快路径返回封印时的状态，而 `replay()` 折叠改写后的事件——**两条路径对同一个 Run 给出不同答案**。这就是撤销的直接原因。边界与推演写在 `packages/materials/src/control/control-store.ts` 的注释里（以 “Why the authoritative path does not take the `loadProjectionHint()` shortcut” 开头），回归测试是 `packages/materials/tests/projection-read-bound.test.ts` 的 `snapshot and replay agree after a historical event is rewritten in place`（本机 6 条全绿）。

**当前设计：权威读取按设计付 O(历史)。** 读取路径先取回并解析整条事件流，再用投影 + `applyTail` 增量折叠；投影陈旧或缺失时回退到 `replay()`。这是有意保留的成本，不是待修的性能缺陷——除非封印本身能证明前缀。

**仍然成立的残余窗口**：投影落后时读不到 O(增量)，因为 `loadProjection()` 的封印校验要求**完整前缀**（`hashEventPrefix()` 在 `prefix.length !== lastSeq` 时抛错）。要覆盖这一档得把封印改成**链式哈希**，那是事件/投影协议的破坏性变更，需要单独决策与迁移方案。

**那次工作里活下来的部分**：`jsonl-store.ts` 的**有界头/尾读**。它们与封印无关，用于「时效」与「迁移」两类判断，都在当前代码里：

| 机制 | 位置 | 用途 |
|---|---|---|
| `readBounded()` | `jsonl-store.ts` | 读一段字节，并**检查 `bytesRead`**——短读会让 `Buffer.alloc` 的尾部零填充，使所有行解析失败，那会被读成「没有记录」而不是「未知」；短读一律 fail-closed |
| `firstEvent()` | 同上（头 64 KiB） | 判断第一条事件是否为合法的 `run_started` 锚 |
| `lastEvent()` / `lastEventSeq()` | 同上（尾 64 KiB） | 投影时效与 legacy 迁移的 `anchored`/`read_only` 判定；两者对「已提交」采用同一条规则（丢弃 split 后的最后一个元素，未终结的尾行不算提交） |

**守恒测试**锁的是代价换来的保证，不是计时：投影当前时解析为 0；投影落后时折叠结果与 `replay()` 完全一致；**伪造投影仍不能覆盖事件日志**；投影缺失仍可从日志重建；**无 seal 的旧投影不被信任**。后两条是 §6.5「封印的保证」的回归防线。

**评审时需要知道的一处历史状态**：撤销发生在 `abfade5`。本地 ref `origin/fix/barrier-cadence-evidence`（PR #244 的分支）顶点是 `b01e822`，**仍带着那条不安全的快路径**（`const fastPath = await this.eventStore.loadProjectionHint(runId, this.#authoritySecret)`），且**不含**撤销注释。也就是说按 PR 编号评审时，#244 指向的是已知不安全的版本；本集成分支与 `origin/perf/plan-240-integration`（`9dcf527`）都不含快路径。**正反两面都实测过**（`git grep -c`）：在 `b01e822` 上 `loadProjectionHint(runId, this.#authoritySecret)` 命中 1 次、撤销注释命中 0 次；在 HEAD `51595fb` 与 `9dcf527` 上该表达式**均 0 命中**、撤销注释在 HEAD 上命中 1 次。我未能确认 GitHub 上的 PR head 是否等于这个本地 ref——`gh pr view 244` 当时返回 `EOF`（网络中断），所以这一条只对本地 ref 成立。

详见成本分解 §6.6。

## 3. 门禁现状（顶点 `51595fb`）

**测量说明（先读这一段，它决定下面哪些行可以信）**：本节所有数值是 2026-09-22 在 `fix/review-blockers` 的工作树上实跑得到的，最后一次重测的顶点是 `51595fb`。**顶点会动**——本轮测量期间它三次前进（`0f297c6` → `3c8ca54` → `e957ae5` → `51595fb`），我在后三个顶点各重测了一遍门禁。`3c8ca54` 与 `51595fb` 两次之间只有两处不同：`check:change-contracts` 的 changed-files 数 `1142` → `1144`，`api:index:check` 由红转绿（见 §3.0）；其余各行两次逐字一致，17 个套件的用例数也**三次前进都没有变化**。所以下表读作「`51595fb` 当时的工作树」。

| 门禁 | 打印的汇总行 |
|---|---|
| `check:components` | `Component documentation check passed (26 components, 0 affected)` |
| `check:change-contracts` | `Change contract check passed (11 contracts, 1144 changed files)` |
| `check:project-reports` | `Project report check passed (4 reports, complete)` |
| `api:index:check` | `API index check passed (atoms, molecules, materials)`（在 `3c8ca54` 上曾报三文件 stale，见 §3.0） |
| `test:ci-gates` | `# tests 43 / # pass 43 / # fail 0` |
| `npm run build` | 无 `error TS`（exit 0，于 `e957ae5` 测得；该顶点到 `51595fb` 之间只有 `project-status.json` 变动） |
| `check:changed-tests` | **可运行但 CI 未调用**（见下，不再计入「通过」） |
| `npm run test:staged` | 未由我在本轮重跑；见 §3.0 与 §3.1 的口径 |

### 3.0 三处情况：一处已消，一处曾红已转绿，一处只在实验检出里成立

**已消：`test:staged` 的两条 `EBUSY` 清理失败。** 此前全文的两个失败用例（`shell_background returns immediately and shell_job polls then stops the real process`、`bash anchors an artifact only when output was actually withheld`）都是临时目录清理时的 `EBUSY`——Windows 上后台子进程尚未释放句柄。它们的清理已改为重试（`maxRetries: 20, retryDelay: 250`），最近一次全量 `node scripts/run-test-stage.mjs all` 的三段记录是：

| 阶段 | 记录 |
|---|---|
| fast | `# tests 1068 / # pass 1064 / # fail 0 / # skipped 4` |
| slow | `# tests 25 / # pass 25 / # fail 0` |
| integration | `# tests 92 / # pass 92 / # fail 0` |

**这三行来自 `.proofblade/test-logs/*.log`，是维护者在本轮稍早跑的，不是我在本轮重跑的。** 我能独立确认的是其中 integration 的数字：本会话另一次三段运行的 integration 同为 `92 / 92 / fail 0`。fast/slow 的用例总数我没有重跑。

**曾红过、现已转绿：提交的 API 索引一度落后于源码。** 在 `3c8ca54` 上 `api:index:check` 失败，报 `docs/generated/api/materials.json`、`docs/generated/api/materials.md`、`docs/generated/agent/materials-context.json` 三个文件 stale；跑一次 `npm run api:index` 之后通过，所以这是**索引落后于源码**，不是检查器故障。`e957ae5`（`chore: regenerate the api index after the read-path comment change`）已把这三个文件重新生成，当前顶点上该门禁打印 `API index check passed (atoms, molecules, materials)`。留这条有两个用处：一是它是本会话里**唯一真的红过**的门禁，说明它不是恒真；二是**从 `3c8ca54` 之前的顶点继续开发的人会看到红**，跑一次 `npm run api:index` 即可。

**新见但只在一个实验检出里成立：`check:components` 报 `materials-cli` 版本未递增。** 我把 `HEAD` 导出成一个临时检出（`work/head-check`，`git archive` 产物）并在其中 `npm run build` 后运行门禁，得到 `Component documentation check failed (2): materials-cli: version must increase from 0.1.1 / updatedAt must be later than 2026-08-07T17:39:20+08:00`，同时 `check:change-contracts` / `check:project-reports` / `api:index:check` 也在那里失败。**但那个检出没有 `.git`，检查器按设计是拿 `HEAD` 作基线做「版本必须递增」比较的，无历史时行为不可比**；且这四项在工作树上都不复现（`check:components` 通过）。所以我**不把这条当作本分支的缺陷**，只记录为「用无历史检出测这套门禁不可靠」的一个反例。若关心 `materials-cli`，请在完整克隆里跑一次 `npm run check:components`。

**`check:changed-tests` 的口径更正**：`package.json` 的 `verify` 里**没有**它，`.github/workflows/ci.yml` 也**没有任何步骤**调用它（本会话实测：`verify` 的脚本串不含该名；对 `ci.yml` 全文匹配 `changed-tests` 零命中）。它是一个**可运行但 CI 不跑**的检查，因此列在「通过」里是没有依据的 —— 已改为这一行。本会话在工作树上跑过它，当时报 `Changed-test check passed (no source rule requires a targeted test)`；那个结果只对当时的改动集成立，不构成门禁。

**合并拓扑**（只读核对，顶点 `51595fb`）：本地 `refs/heads/main` = `e3ffb3c`，而 `refs/remotes/origin/main` = `dea28a6`（本地 `main` 落后 **6** 个提交）——**两个 ref 不同值，引用「main」时必须写明是哪一个**。实测 `git merge-base --is-ancestor`：本地 `main` 与 `origin/main` **都是** HEAD 的祖先（exit 0），即集成分支确实含 `main` 的提交（`0f297c6` 那次 `Merge main into the integration branch`）——是「含 `main`」，不是「已合入 `main`」。**远端的集成分支 ref 与本地不同步**：`refs/remotes/origin/perf/plan-240-integration` = `9dcf527`，是 `589de5e` 与 `dea28a6` 的合并提交，且两边互不为祖先（`--is-ancestor` 双向 exit 1），共同祖先就是 `dea28a6`——也就是远端那份**不含**本地 `dea28a6` 之后的提交。（它相对本地 `main` 仍是纯快进：`merge-base refs/heads/main 9dcf527` = `e3ffb3c` 本身。）**PR 编号与分支的对应关系不要从本文件推断**——见 §2.1 末尾关于 #244 的说明：按 PR 编号取到的分支可能是已知不安全的旧顶点。

三个 baseline 脚本：`scripts/tool-hot-path-baseline.ts`（provider-free）、`scripts/tool-hot-path-real-run-baseline.ts`、`scripts/tool-hot-path-long-run-baseline.ts`。

### 3.1 各套件用例数（本机实跑，全绿）

顶点 `51595fb` 工作树，逐个 `node --import tsx --test <file>`（文件路径由 `git ls-files` 解析），取各文件自己打印的 `# pass N`：

| 套件 | 用例 | 套件 | 用例 |
|---|---:|---|---:|
| `runtime-shape` | 9 | `telemetry-lazy-payload` | 8 |
| `polling` | 7 | `experiment-gate-projection` | 5 |
| `workspace-settings` | 2 | `skill-registry-cache` | 18 |
| `debug-data` | 45 | `archival-failure-semantics` | 6 |
| `version-cache` | 17 | `hot-path-budget` | 6 |
| `observer-diagnostics` | 7 | `read-path-parse-budget` | 4 |
| `artifact-readback` | 2 | `projection-read-bound` | 6 |
| `projection-hint-currency` | 8 | `tool-timing` | 23 |
| `barrier-projection` | 8 | **合计** | **181** |

17 个文件全部 `fail 0 / skipped 0`。与本节此前版本（合计 148）的差额来自三处：`skill-registry-cache` 9 → 18、`debug-data` 42 → 45、`version-cache` 13 → 17，另加其余各套件随修复新增的用例。**这 17 个文件只覆盖映射表里点名的套件，不是全量套件**——全量的三段口径见 §3.0。

**重测口径**：这 17 个数字在 `3c8ca54` 与 `51595fb` 两个顶点上各跑了一遍、逐个同值（`projection-hint-currency` 另在 `e957ae5` 单独复测，仍 8）。复测时有一个容易踩的坑：`git ls-files "*observer-diagnostics.test.ts"` 会先匹配到同目录的 `lane-observer-diagnostics.test.ts`，那个文件只有 **2** 条；本节记的 7 条来自 `packages/materials/tests/observer-diagnostics.test.ts`。

## 4. 必须连在一起读的三处更正

计划原文与实测不一致的地方，均已就地更正并保留「此前为推断、经实测推翻」的标注。**只看计划会读到错误结论**：

1. **屏障频率**（§6.3）：屏障没有消除 O(历史) 成本，只是把它前移到回合边界；冷读从不变成常数。结论是**维持回合边界，不要加密**。
2. **秒级的归因**（§6.4）：**不是**重放回退。投影陈旧时 `snapshot()` 走「投影 + `applyTail`」，不是 `replay()`。真正成本在 `#readSnapshot` 里那句 `eventStore.events(runId)`——**无条件取回并解析整条事件流**（引用函数与调用名而不是行号：该调用在本次评审期间已因注释增删换过三次位置）。
3. **封印的保证边界**（§6.5）：封印防的是「伪造投影覆盖真实事件」——它用 HMAC 把投影绑定到本 Run 的权威密钥与某条前缀，因此**未密封或伪造正文的投影不会被采纳**。它**不**承诺事件内容未被改动：`projectionSealPayload()` 没有 size 字段，`hashEventPrefix()` 算的是解析后事件的规范化 JSON。**这正是快路径被撤销的理由，而不是可以据此取用它的许可**——正因为封印不为历史字节作证，那条捷径才会在「原地改写同长度事件」时与 `replay()` 静默分歧（详见 §2.1）。此前本节写作「因此把读取降为 O(增量)不牺牲任何防篡改能力——读取路径上原本就没有这项能力」，那半句是错的：**读取路径上没有的能力是「封印证明事件内容」，而快路径省掉的恰恰是唯一会做这件事的步骤**，所以省掉它换来的是分歧，不是零代价。

那条**已被删除**的注释（原先在 `control-store.ts` 的 `#readSnapshot` 上方，本文件早期版本按当时的行号 `739-741` 引用它）写着「replay the full stream so modified prefixes … are revalidated」，而 `replay()` 里没有 revalidate 步骤。**第 2 条错误结论就是被这句注释引出来的**。它已随 §2.1 的改动删除并改写为撤销理由；行号不再引用，因为那段代码本身已经不在了。

## 5. 未决事项（需维护者决定）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 读取路径降为 O(增量) | **已实施后撤销**——封印无法为历史字节作证，快路径会在原地改写同长度事件时与 `replay()` 静默分歧（§2.1） |
| 2 | 23 个 PR 的落地方式 | **用户已明确：先不合并，等他人审查**。分支取舍见 §8a |
| 3 | 表项 H/I 的客户端部分（§10 PR 12） | **用户已明确：GUI 由用户自己测**。服务端 `afterSeq`/`limit` 已就绪；客户端尚未调用，改动需动 `App.tsx` 的时间线与调试器 |
| 4 | §7.2.3 目标段评审 | 门槛值需以 §7.2.1 基线为准；本机数值不可直接当阈值 |
| 5 | §6.5 那条失准注释 | 已随 §2.1 的改动删除并改写 |
| 6 | 报表字节校验的取舍 | 已记录，见 §8b：门禁已无牙，取而代之的是渲染器测试与 `--base` 的账本义务 |
| 7 | Windows/NTFS 上 inode/ctime 能否独立识别改写 | 已实测并记录，见 §8c |

## 6. 本次交付自评中的三处失误（供评审时打折判断）

为免评审者高估这批工作的可靠性，三处失误如实记录：

1. **屏障间隔表曾基于写错的探针**（屏障判定写成 `(offset+200) % barrierEvery`，在所选参数下退化成每 200 事件一次），已用重测数据替换（提交 `8a0d9c6`）。
2. **曾误称「全部还原」**，实际只还原了 `control-store.ts`，`jsonl-store.ts` 的计数器与测试仍在且已交付。已在下一轮逐文件核对工作树与 HEAD 后更正。
3. **把一条已撤销的快路径当作已交付**。§2.1 曾以「已实施（用户授权）」和一张 150 倍收益表上报 O(增量) 读取，依据是那次改动**自己的测量**；直到把封印的保证边界推演清楚（§6.5 / §4-3）才确认它与 `replay()` 会对同一个 Run 给出不同答案，随即撤销。**这与前两处是同一个毛病**：拿上一步的输出当结论，而没有回头核对它现在是否还成立。代价具体可见——本文件把「已实施」写进了给评审者的单页入口，而按 PR 编号取到的 #244 分支至今仍指向带该快路径的顶点（§2.1 末尾）。

共同成因是同一个毛病：**用自己上一步的输出代替对实际状态的核对**。此后改为逐文件比对内容、并用 `gh` 取权威映射。

## 7. 生成报告移出版本控制（为什么，以及影响）

**症状**：每合并一个 PR，其余 PR 就开始报文档矛盾。

**机制**（已实测，不是推断）：每个 PR 都会改同一批「账本文件」，而其中带**每个 PR 自己唯一的时间戳**：

| 文件 | 每个 PR 都改 |
|---|---|
| `project-status.json` | `updatedAt` + 新增 UPDATE 记录 |
| `docs/project/*.md`（4 份） | 由上面那份**生成**，内容含 `updatedAt` 与组件版本/次数/指纹 |
| `COMPONENT.md` | `version`（patch+1）、`updatedAt`、审计次数、`sourceHash` |

实测两个分支各自相对 `origin/main`（`dea28a6`）的改动量（`git diff --numstat`；本集成分支取顶点 `51595fb`，PR227 取 `53b6e9b`）：`project-status.json` 本集成分支=[+1496,−692] / PR227=[+881,−687]；`docs/project/MAINTENANCE_REPORT.md` 本集成分支=[0,−129]（该文件已被 `git rm --cached` 移出版本控制，所以相对旧 base 记为整份删除）/ PR227=[+6,−6]。**本行此前给的是另一组数（我=[+581,−1] / PR227=[+173,−1]）且未写 base**——那组数在 `origin/main` 与本地 `main` 两个 base 上现在都复现不出来，已按上面的实测替换。

**合并第一个 PR 后，其余每个 PR 的这 6 个文件都相对新 base 陈旧** → `check:project-reports --base` 报 `stale generated report`，`check:components --base` 报版本/指纹矛盾。

**讽刺点**：`ci.yml` 原本在检查**之前**就跑了 `npm run reports:project`，把那 4 份报告重新生成了一遍——所以它们在 CI 里的字节比对几乎是恒真的。**签入仓库的唯一实际效果就是每次合并制造矛盾。**

**改动**：
- `docs/project/` 加入 `.gitignore`，四份文件 `git rm --cached` 移出版本控制（仍可随时生成）
- CI 顺序调整：先跑 `--base` 契约检查，再生成报告并作为 artifact 上传
- `check:project-reports` 的**契约本身不变**——生成物仍须与 `project-status.json` 及组件元数据一致

**契约仍会咬人**（变异验证过）：篡改一份报告 → `stale generated report` 失败；只改 `project-status.json` 而不重新生成 → 四份全部 stale 失败；还原后通过。模拟全新克隆（文件缺失）→ 报 `missing`，先 `npm run reports:project` 后通过。

**评审这部分的注意事项**：这是**仓库治理改动**，会改变所有 PR 的行为，值得单独审。剩余冲突面只有 `project-status.json` 与 `COMPONENT.md`；前者是纯 JSON 追加，冲突通常是单行 `updatedAt`。

## 8. 第三/四轮评审要求的三项记录

第三、四轮评审（§7.4 / §7.5 / §7.6）要求就三件事给出显式记录。以下每条都写清了依据与边界。

### 8a. 分支取舍：内容摘要修复由哪个分支承载（§7.4-3 / §7.6-3）

同一处改动（把版本快照的 revision 从「元数据为键的摘要缓存」改为「无条件对字节做内容摘要」）曾存在于两个分支，两轮评审都要求明确取一个，避免后落地的一侧静默覆盖另一侧：

| 分支 | 顶点 | 相对 `main` | 内容摘要 | 说明 |
|---|---|---|---|---|
| `perf/version-snapshot-cache` | `53b6e9b` | 从 `1eaab04` 那条线上长起，`53b6e9b` 自身即 `Merge main into perf/version-snapshot-cache`（`origin/main` = `dea28a6` 是它的祖先，`--is-ancestor` exit 0）；**但它没有合入 `main`**（`--is-ancestor 53b6e9b origin/main` = exit 1） | ✅ `version.ts` 的 `fileDigest()` 无条件读字节 | **PR #227 的 head**；本会话实测 `git show 53b6e9b:…/version.ts` 含 `fileDigest`、`revisions.get(` 零命中 |
| `fix/version-revision-key` | `0c3b349` | `1eaab04` 之上 **4** 个提交（`ad4c771`、`2c112d8`、`4a8967a`、`0c3b349`，其中 `4a8967a` 即内容摘要改动）；`1eaab04` 与 `0c3b349` **都不在** `origin/main` 里（`--is-ancestor` 均 exit 1） | 同内容 | 已被取代 |
| `fix/review-blockers`（集成） | `51595fb` | 本地 `main`（`e3ffb3c`）与 `origin/main`（`dea28a6`）**都是它的祖先**（`--is-ancestor` exit 0），即它含 `main` 而不是被合入 `main` | ✅ 已把同一改动移植过来 | 本会话实测：`version.ts` 只含 `fileDigest`，`revisions.get(` 零命中 |

**结论：以 PR #227 的分支 `perf/version-snapshot-cache` 为权威承载，`fix/version-revision-key` 视为已被取代，应丢弃而不是合并**——两者是同一改动的两份搬运，合在一起不会增加内容，只会给「哪一份是准的」留下第二次判断机会。

**边界**：本会话核对的是**本地 ref** 的顶点与文件内容（`git show <ref>:<path>` 与 `git merge-base --is-ancestor`），**没有**用 `gh` 确认 GitHub 上 #227 的 head 恰好等于 `53b6e9b`（那次 `gh pr view` 遇到网络 `EOF`）。**没有任何东西被合并**：上表三个分支都没有合入 `main`，本集成分支只是**含** `main`（`--is-ancestor` 方向相反），`main` 未被触碰，维护者明确要求先由他人审查再决定合并。**更正**：`perf/version-snapshot-cache` 一行此前写作「由 `main` 顶点切出，并已合入 `main`」，两半都不对——它是在 `1eaab04` 那条线上长出来的，且从未合入 `main`；`fix/review-blockers` 一行此前的顶点写作 `0f297c6`，也已过期。修正依据就是本表右列那些 `--is-ancestor` / `rev-list --count` 实测。这条记录只说明「哪一份该留」，不构成合并动作。

### 8b. 报表字节校验的取舍（§7.4-4 / §7.6-4）

**事实**：四份报表已移出版本控制（`docs/project/` 在 `.gitignore` 中），而 CI 在检查**之前**先生成它们（`.github/workflows/ci.yml` 的 `Generate project reports` 步骤，其注释本身就写明「必须先于 `check:project-reports`」）。因此 `check:project-reports` 里的**逐字节比对**比较的是「刚刚写出的文件」与「由同一个 `project-status.json` 现算的内容」——**它不可能失败，已经不是渲染器门禁**。这是移出版本控制的直接代价，不是缺陷：把这些文件签回来正是本文件 §7 记录的 11 个合并冲突的来源。

**取而代之的**：渲染器本身的用例，在 `scripts/tests/ci-gates.test.mjs`，用例名 **`the project reports are deterministic and carry the ledger's content`**（本会话已读到该用例体，第 201 行起）。它断言三件事：同一份 `project-status.json` 渲染两次得到**逐字节相同**的结果；四个文件由 `PROJECT_REPORT_FILES` 枚举且都非空、含非空白内容；`project-status.json` 里**每一个 plan id、update id、completion id 都出现在对应的报表里**（PLAN / UPDATE_LOG / COMPLETION_REPORT）——即内容来自账本而不是桩。

**仍然有约束力的是**：`check:project-reports --base` 的**账本义务**——必须新增一条 update 记录且 `updatedAt` 递增。§7 记录的变异验证针对的正是这条：只改 `project-status.json` 而不重新生成、或篡改一份报告，都会失败；模拟全新克隆（文件缺失）报 `missing`，先 `npm run reports:project` 后通过。

**结论（如实说明，不粉饰）**：四份报表**不再是可评审产物**——它们不进仓库、随每次生成而变、且字节校验恒真。**唯一事实来源是根目录 `project-status.json`**；要审「项目状态说了什么」，审账本，不要审报表。

### 8c. Windows/NTFS 上 inode/ctime 的结论（§7.5 末 / §7.6-4）

评审要求对「在项目主要开发平台（Windows/NTFS）上，以元数据为键的缓存标识是否足以独立识别一次改写」给出明确结论，而不是停在「reasoned rather than gated」。

**本会话实测**（`node` v22.23.2，Windows/NTFS，临时目录，一次性探针，未入库）：

| 测量 | 结果 |
|---|---|
| 对同一文件连续 40 次写入，`ctimeMs` 出现正向推进的次数 | 四次运行分别 **31 / 9 / 13 / 13** 次 |
| 观察到的**最小**正向推进 | 四次运行分别 **0.506 / 0.906 / 0.424 / 0.311 ms** |
| 观察到的**最大**正向推进 | 0.5 量级至 **2.511 ms** |
| `ctimeMs` 的不同小数部分个数 | 30 / 10 / 14 / 14（即亚毫秒精度真实存在） |
| 同长度原地改写 + `utimes` 还原整秒 `mtimeMs` | `size` 不变 ✅、`mtimeMs` 精确不变 ✅、`ino` 不变 ✅、**`ctimeMs` 前进** 2.515 / 1.005 / 2.029 / 1.870 ms |

**读法**：推进**次数**不是一个稳定量（9–31 次）——它取决于写入速度与系统时钟推进，所以「40 次写入里有多少次能看见 ctime 变化」不该被引用为常数。**稳定的部分是量级**：NTFS 的 `ctime` 精度在**亚毫秒**级（四次运行最小推进 0.31–0.91 ms，小数部分各不相同），**不是**常被引述的约 15.6 ms 系统时钟刻度。因此「同长度改写 + 还原 mtime」在**整秒**这一档上必然被 `ctime` 看见——四次运行全部看见，且同时确认 `size`/`mtimeMs`/`ino` 三者都没变，也就是说**捕获它的唯一字段就是 `ctimeMs`**。

**派生结论（三个消费方各自的做法，均已核到具体位置）**：

1. **`packages/materials/src/runtime/version.ts` 完全不用元数据。** 本会话实测该文件只有 `fileDigest()`，其主体是 `stat` 判类型后 `return sha256(await fs.readFile(file, "utf8"))`，**没有任何 `stats.ino` / `mtimeMs` / `ctimeMs` / `size` 参与**。理由是元数据键无法被宽化到「可靠」：能保留长度、还原 mtime 的写入者，剩下能被看见的只有 ctime，而 ctime 不是内容。
2. **两个仍然使用该键的地方各有一条「冻结 mtime + 同长度改写 + 还原 mtime」的回归测试**，都已核到文件名与用例名：
   - `packages/materials/src/skills/registry.ts` 的 `collectSkillFiles()` 条目是 `` `${path}\u0000${stats.ino}\u0000${stats.size}\u0000${stats.mtimeMs}\u0000${stats.ctimeMs}` ``（第 365 行，本会话已读）；测试 **`packages/materials/tests/skill-registry-cache.test.ts` → "a same-size rewrite with the mtime put back still invalidates the memo"**（第 58 行）。该用例把 mtime 冻在**整秒**（注释写明：还原写入产生的那个值只会与文件系统的舍入比较，亚毫秒差会让前置断言以无关理由失败），断言 `size`/`mtimeMs` 精确不变、**`ctimeMs` 必须前进**，然后要求 memo 不命中（`hits 0`、`parses 2`）、新 front matter 进入目录且 `catalogHash()` 变化。
   - `apps/gui/src/debug-data.ts` 的 `runDetailEventsVersion()` 是 `` `${eventsStat.ino}\0${eventsStat.size}\0${eventsStat.mtimeMs}\0${eventsStat.ctimeMs}` ``（第 807 行，本会话已读），run-detail 与 run-list 两个缓存**共用它**（`runListCache` 的命中判断在 §0 修复前只比 `mtimeMs`）；测试 **`apps/gui/tests/debug-data.test.ts` → "a rewritten event log is not served from the run-list cache either"**（第 489 行）。该用例的注释记录了一个我自己踩过的坑，值得保留：mtime 必须在**第一次列表读取之前**冻结，否则冻结动作本身就会让缓存条目失效，断言会为一个「只带 `mtimeMs` 的键」通过——也就是说它曾在**没有门禁任何东西**的情况下是绿的。
3. **残余窗口，如实说明**：`ctime` 只在**同一亚毫秒时钟刻度内、同一 inode、同一长度**的两次改写时才可能无法区分。上面测到的偏移量级是 0.31–2.5 ms，所以常规的同长度改写会被抓到；但这是一条**经验边界**，不是不变量。**需要更强保证的调用方应直接对字节做摘要**（`version.ts` 就是这么做的），不要扩大这个键然后声称它可靠。
