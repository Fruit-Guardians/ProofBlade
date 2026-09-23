# ProofBlade Harness 反馈更新计划

来源：`runs/CHAT-1790096643438`（一次真实对话）的最终结论，以及同一份文本被另一位模型评阅后的版本。两份内容实质相同，本文按同一条目处理。

**读这份文件前必须知道的三件事**

1. **这份反馈是"使用者自述"，不是实测报告。** 它由刚用完 harness 的模型写就，里面的机制名、id 与因果解释都需要逐条对代码与事件核对。本文第 1 节给出核对结果，凡未复现的都标明。
2. **其中两条建议已经在 2026-09-23 落地**（`UPDATE-20260923-001`、`UPDATE-20260923-002`），本文不重复计为待办，只在 §3 说明差异。
3. 反馈里"几十条 bash/read/verify"是模型的印象；该 run 的实际工具结果是 **10 次**（bash 7、read 2、update_phase 1）。计数与事实不符这一点成立，但差的是一个量级以内，不是两个。

---

## 1. 逐条核对

| # | 反馈条目 | 核对结果 | 证据 |
|---|---|---|---|
| 1 | `verify_result` 的反馈"有牙"，两次都给了可执行原因 | **成立，且已加强** | 失败路径给 `verifierFeedback{stage,reason,retryable,nextAction}`；2026-09-23 又补上「候选必须独占一行」的规则说明（旧文案说 "did not contain the exact candidate"，而输出里其实包含），以及无 verifier 规则时的 `retryable:false` 边界说明 |
| 2 | 实验预算提示"把探测改写成小脚本"方向对，但把正常迭代误判为重复探测 | **方向部分成立，误判未复现** | 提示文本来自实验预算/重复探测判定（`experiments` 的 `repeatKey` 机制）；本 run 未逐条复现"误判"，列为待验证项 |
| 3 | Artifact 归档可用稳定 id 精确指回原始输出 | **成立，保留** | 该 run 37 个 artifact，`artifact_registered` + `artifact_annotated` 全链路可查 |
| 4 | skill 自动路由在领域不匹配时仍兜底注入 | **部分核实** | 规则确实存在且宽泛：`packages/materials/src/runtime/skill-routing.ts:28` 用 `/\b(?:ctf\|challenge\|pyjail\|encoding\|unicode\|qr\|audio\|constraint\|题目\|解题\|杂项)\b/i` 给 `ctf-misc` 兜底 12 分。该 run 的系统提示快照里确实出现 `ctf-misc`；但模型自述的 pyjail / HISTFILE / SECCOMP 等**正文未在该快照中命中**（快照只含系统提示，正文可能经 `load_skill` 或 L1 注入）。结论：**兜底规则成立，正文体量待测** |
| 5 | phase 与实际进度脱钩：题已解完，仍停在 reconnaissance 且 `gate.status=blocked, missing=["target-model-or-hypothesis"]` | **成立（RECON 一侧）** | phase 只由 `update_phase` 推进，没有任何"检测到已验证结论就离开该相位"的路径。**注**：本 run 卡在 RECON 的 `target-model-or-hypothesis` 是真实缺口；而 REPRODUCE/REPORT/SUBMIT 对"无 verifier 规则任务"的不可满足要求已在 2026-09-23 去掉 |
| 6 | 预算计数不可信：显示 `run_tool_calls_used: 2 / 998`，实际调用远多于此 | **成立，根因已定位** | `packages/materials/src/domain/phase-budget.ts:27`：`runToolCallsUsed = Object.keys(snapshot.effects).length` —— 它数的是**durable Effect**，不是 tool call。该 run 2 个 effect、10 次工具结果，于是显示 2。字段名与语义不符，`compiler.ts:98` 把它原样发给模型 |
| 7 | 无 verifier 的任务里没有任何 Completion 能被接受，flag 永远只是"未确认候选" | **成立，且是设计** | `claim-verification.ts` 只在任务绑定 verifier 命令时派发 `completion_verified`（`locallyJudged = verifierDefinedCommand`）。2026-09-23 已让它**明说**（`acceptance: observation_only` + policy 反馈），但没有把这类任务变成 observed-only 模式 |
| 8 | 机制持续制造自己还不上的 recovery 债：`VR-1e0de02d…`、`VR-de190718…` | **成立** | 该 run #339/#340 `verification_recovery_required`，reason 均为 "Completion is proposed but no verifier Effect is durable yet."（`recovery/verification-recovery.ts:324`）。两条请求都指向同一个已成功复现的候选 |
| 9 | 同一个结论建了两棵树，其中一棵挂在卡死的 Completion 上 | **成立** | #260 `TREE-b8f448bb`（agent 的 `evidence_record`："Flag = [candidate sha256=ee47119c…]"）与 #295 `TREE-6254a5fe`（harness 验证链："候选观察链"，含 `reproduces → C-af331919`）。两者描述同一结论 |

---

## 2. 更新计划

排序原则：先修**会误导的信号**（改名/弃权/停止生成噪音），再修**推进机制**（phase 与 gate 由真实证据推进），最后才是可选增强。每条都给出可变异验证的验收点。

### P0-1 预算字段按真实 tool call 统计（或改名）

- **问题**：`run_tool_calls_used` 数的是 effects（`phase-budget.ts:27`），模型据此以为只用了 2 次预算。
- **改动**：`phase-budget.ts` 的 `runToolCallsUsed` 改为按真实工具调用计数（`tool_result_recorded` 事件，或 snapshot 里等价的可数事实）；若担心成本，就从 Pi 侧拿 `model_usage` 的工具调用数。**同时**保留 effects 计数但改名为 `durable_effects_used`，两者都发（`compiler.ts:98`）。
- **验收**：断言「同一 Run 里发了 N 次工具结果 → 预算字段 = N」，并断言两个字段不再相同（该 run 是 10 vs 2）；变异：把计数改回 `Object.keys(snapshot.effects)` → 用例转红。
- **风险**：低。纯展示字段，不参与门禁判定。

### P0-2 skill 路由在领域不匹配时弃权

- **问题**：`skill-routing.ts:28` 的 `ctf-misc` 兜底正则过宽，凡出现"题目/挑战/encoding"等就加 12 分。
- **改动**：把"泛 CTF 信号"从**计分项**降级为**只在其他信号已命中时的加权项**；没有任何领域信号（文件类型、工具名、领域词）时返回空选择，并在提示里不出现技能块。
- **验收**：构造一个"固件补丁链 + 密钥派生"的 prompt，断言路由结果为空（当前会命中 ctf-misc）；再构造真正的 pyjail prompt，断言仍命中。变异：恢复兜底计分 → 第一个用例转红。
- **风险**：中。可能让本该校准的场景漏掉技能——用第二个用例兜住。

### P0-3 无 verifier 规则的任务进入 observed-only 模式

- **问题**：这类任务永远无法 ACCEPT（#7），却仍生成 `verification_recovery_required`（#8）并为同一结论建第二棵树（#9）。
- **改动**：在 `verificationBindsRule(task)` 为假时（该判据已由 2026-09-23 的改动导出到 `domain/phase-gate.ts`）：
  1. `verification-recovery.ts` 不再为这类 Completion 产生 `RECOVERY_REQUIRED`，改为一条终态说明（"该任务无 verifier 规则，候选以观察形式保留"）；
  2. `claim-verification.ts` 在 `observation_only` 时不再重复建树——复用 agent 已有的同一结论树，或把验证链作为该树的子节点挂上去，而不是新建 `候选观察链`；
  3. `project()` 的 `unverified` 输出保留（认识论上仍然谨慎），但明确标注 `mode: "observed_only"`。
- **验收**：对无规则任务断言：`completion.status` 保持 PROPOSED、**没有** `verification_recovery_required` 事件、`reasoningTrees` 中同一 candidateHash 只有一棵树；对有规则任务断言上述三条行为不变。变异：去掉 `verificationBindsRule` 分支 → 前三条转红。
- **风险**：中高（触及证据链与恢复语义）。**需要所有者确认**：这是"少做一件事"，不是"放宽接受"——但它改变了恢复义务的产生条件。

### P1-1 phase 与 gate 由真实证据推进

- **问题**：#5。RECON 要求 `target-model-or-hypothesis`，而"读规格 → 写脚本 → 得出并验证结论"这类任务根本不需要显式假设；结论已出仍显示 blocked。
- **改动**：
  1. RECON 的 `target-model-or-hypothesis` 允许由**等价证据**满足：存在当前世代、已复现/已验证的结论（accepted completion 或 `reproduces` 边）时视为满足；
  2. 增加一条单调回退：若出现已验证结论而 phase 仍停留在 RECON/HYPOTHESIS，允许一次 `update_phase` 前进（或在投影里把 gate 标为 `stale` 而不是 `blocked`）；
  3. 提示里对 `missing` 明确区分"你需要做的事"与"该系统自己会收敛的事"——今天两者混在一起。
- **验收**：构造"已 accepted completion、phase 仍是 RECON"的快照，断言 gate 不再是 blocked；构造未解出的快照，断言仍 blocked。变异：恢复只认 hypothesis → 转红。
- **风险**：中。phase 有 domain guard（`moveToPhase`），改动要么走 guard 的白名单，要么只改 gate 展示——**倾向后者**（先让信号正确，再考虑自动化推进）。

### P1-2 「重复探测」判定与正常迭代区分

- **问题**：#2 的误判。判定基于 `repeatKey`（命令/输入的规范化哈希），对"改一处再跑一次"的迭代不友好。
- **改动**：把"重复"从**完全相同的 repeatKey** 放宽为"相同 repeatKey 且**输出指纹相同**"才计为重复；输出不同的重跑不计。或者把提示从"你在重复探测"改成"这次结果与上次相同，建议改输入或改假设"。
- **验收**：连续两次相同命令、输出不同 → 不触发重复提示；两次相同命令、输出相同 → 触发。变异：恢复只比 repeatKey → 第一个用例转红。
- **风险**：低-中。属提示语与判定的组合，先度量再改。

### 不做（除非所有者另行拍板）

- 不为了让对话能"验证通过"而引入**模型自证即 ACCEPT**（改的是"什么算已验证"的语义）。
- 不删除证据链/封印/世代绑定——反馈自己也承认这套机制是为"有 oracle、易自欺"的任务设计的，`pwn_workflow` 的防呆是正向价值。
- 不把技能目录整体去掉：只做"不匹配时弃权"。

---

## 3. 与 2026-09-23 已完成改动的关系

| 反馈建议 | 现状 |
|---|---|
| verify_result 说清边界 | **已完成**（`UPDATE-20260923-001`）：`acceptance: verified \| observation_only` + `retryable:false` 的 policy 反馈；候选匹配失败改为说明"必须独占一行" |
| 无 verifier 的对话不要卡在不可满足的门禁 | **部分完成**（`UPDATE-20260923-002`）：REPRODUCE/REPORT/SUBMIT 对无规则任务不再要求 accepted completion；**observed-only 模式（P0-3）与 RECON 推进（P1-1）仍未做** |
| 对话历史在压缩后消失（本次评估未提，同一时期的另一个 run 报的） | **已完成**：GUI 从完整 entry 路径渲染历史 |
| 预算计数、skill 弃权、双树、VR 债 | **未做**，即本计划的 P0-1 / P0-2 / P0-3 |

---

## 4. 本计划的边界

- 全部结论来自**读码 + 该 run 的事件核对**，未重新跑一遍受控实验；除第 6 条（计数 10 vs 2）与第 9 条（两棵树 id）外，其余"影响有多大"的判断都还没有量化。
- 反馈中"注入了一大段与题目无关的 pyjail/HISTFILE/SECCOMP 正文"这一条**未在 prompt 快照里命中**，需要一次带 `load_skill` 的复现才能定性；在此之前 P0-2 只按"兜底规则过宽"处理，不按"注入了多少 token"处理。
- P0-3 与 P1-1 触及恢复义务与相位推进语义，落地前需要所有者确认；P0-1 与 P0-2 可以直接做。
