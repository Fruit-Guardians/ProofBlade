# 证据管理 Agent 与非阻塞证据栅栏开发建议

## 1. 结论

建议为 ProofBlade 增加独立的证据管理角色，但不建议直接增加一个与 solver 平级、可以自由调用工具并直接写入 `ACCEPTED` 证据的“大模型子 Agent”。

推荐采用两层结构：

```text
Solver / Executor
    -> 产生观察、工具效果和候选结论
    -> Evidence Steward（确定性服务，必要时调用小型复核模型）
    -> Independent Verifier（唯一的最终确认者）
    -> Control Store / finish
```

其中：

- `Evidence Steward` 负责整理、去重、关联、检查新颖性、判断当前证据是否足够，以及给 solver 返回下一步建议。
- `Independent Verifier` 负责执行隐藏 scorer、复现命令或平台提交，并且是唯一可以确认 completion、confirmed fact 和成功结束 run 的角色。
- solver 可以提交观察和候选证据，但不能直接决定 Evidence 已经足以证明结论。

这样既能把证据管理从主推理循环中拆出来，又不会把最终信任边界扩展到第二个可以自证自验的模型。

## 2. 为什么需要单独的证据管理角色

当前系统中的证据职责分散在以下位置：

- `ControlStore` 负责接收 Evidence 和 completion 命令；
- `EvidenceGraph` 负责关联 artifact、Evidence、Fact 和 reasoning tree；
- `EvidenceCurationGate` 负责调查产物整理门禁；
- `CodingClaimVerifier` 负责普通代码结果的复现；
- `IndependentVerifier` 负责隐藏 scorer 复现；
- solver lane 负责决定何时观察、何时实验、何时提出候选。

这种结构会产生两个相反的问题：

1. 证据写入边界过宽时，主 agent 可以制造格式上完整但来源不完整的 Evidence。
2. 证据栅栏过严时，主 agent 会反复执行相同命令、重复写入相同证据，无法继续探索。

独立证据管理角色的价值不是“增加一个模型来多审一遍”，而是把下面四个判断集中起来：

1. 这条记录是否是新证据；
2. 它是否改善了当前 claim 的覆盖度；
3. 它是否足以触发一次独立验证；
4. 如果不足，下一步应该换工具、换假设、换目标还是停止。

## 3. 推荐的角色边界

### 3.1 Solver / Executor

solver 继续负责探索和执行：

- 读取目标和任务契约；
- 调用允许的工具；
- 产生原始 observation 和 artifact；
- 提出 hypothesis、fact、candidate；
- 根据 Steward 的下一步建议继续推进。

solver 不应拥有以下权限：

- 直接生成 `kind: reproduction` 的最终 Evidence；
- 直接将 completion 标记为 `ACCEPTED`；
- 将任意 artifact 标记成“已经完成证据审查”；
- 修改 task scope、verification policy 或 fixture generation。

### 3.2 Evidence Steward

Steward 是本方案新增的角色，优先实现为无模型的确定性服务，必要时再增加一个受限模型调用。

它负责：

- 接收 observation、effect、artifact、candidate 和已有 Evidence 的增量；
- 计算内容摘要、命令摘要、目标范围摘要和 generation；
- 判断是否重复、过期、悬空或缺少来源；
- 为证据建立 claim、artifact、effect、completion 之间的引用；
- 计算证据覆盖度和验证缺口；
- 选择 `continue`、`pivot`、`verify`、`stop`、`need_human` 之一；
- 生成结构化 handoff，而不是替 solver 写自然语言结论。

Steward 不负责：

- 自己执行未授权的 shell、网络或容器命令；
- 自己选择任务外的目标；
- 直接产生最高信任等级的 reproduction Evidence；
- 直接提交最终答案。

### 3.3 Independent Verifier

Verifier 保持当前独立验证职责，但需要变成严格的受信边界：

- 只消费固定格式的 candidate artifact；
- 只执行任务契约中定义的 verifier 或 hidden scorer；
- 产生带完整 provenance 的 reproduction/negative Evidence；
- 原子地更新 completion 状态；
- 绑定 `completionId`、candidate hash、generation 和 evidence IDs；
- 最终决定是否允许 `finish`。

## 4. 不要把证据栅栏设计成“每一步都必须有新 Evidence”

证据是最终结论的约束，不应该成为每一个探索动作的硬门禁。推荐将流程分成三个区段：

### 4.1 探索区段

目标是产生信息，不要求每次调用都进入 Evidence ledger。

允许：

- 多次读取同一个 artifact 的不同区段；
- 同一 hypothesis 下的短期试探；
- 调试命令和失败命令；
- 尚未能支持任何 claim 的观察。

要求：

- 每个 effect 仍然记录 artifact、退出状态和 generation；
- Steward 对重复结果做去重，但不阻止第一次和第二次合理重试；
- solver 必须能够看到重复原因和下一步建议。

### 4.2 收敛区段

当 solver 提出 candidate 或明确声称“已经找到结果”时，才启用较严格的证据栅栏。

要求：

- candidate 必须有来源 artifact；
- artifact 必须来自当前 generation；
- candidate hash、命令 hash、工作目录和 effect 必须可追溯；
- supporting Evidence 必须存在且引用完整；
- 必须有明确的验证缺口列表。

### 4.3 最终确认区段

只有 Independent Verifier 可以进入最终确认区段。此时栅栏可以是硬性的：

- reproduction 次数满足任务契约；
- 每次复现都使用受控 verifier；
- 证据全部属于同一个 completion；
- 证据没有跨 generation、悬空引用或未完成 effect；
- 完成状态只能单向从 `PROPOSED` 变成 `ACCEPTED` 或 `REJECTED`。

## 5. 防止“重复证据循环”的核心机制

### 5.1 用证据指纹去重，而不是只按 Evidence ID 去重

建议为每条候选证据计算：

```text
noveltyKey = sha256(
  runId +
  generation +
  targetScopeDigest +
  artifactSha256 +
  effectOperation +
  commandHash +
  candidateHash +
  verifierVersion
)
```

同一 `noveltyKey` 的记录只能有一条主 Evidence。后续重复执行可以作为 attempt 记录保留，但不能增加证据强度，也不能让 confidence 累加。

### 5.2 区分“重复尝试”和“独立复现”

以下情况不应被视为新的独立证据：

- 同一 generation、同一命令、同一目标范围、同一 verifier 版本；
- 仅改变输出格式或重新读取同一个 artifact；
- 同一 session 中重复打印相同候选；
- 只改变 Evidence summary，不改变底层 artifact 或 effect。

以下情况才可以计为新的 attempt：

- verifier 明确要求多次独立执行；
- 使用新的 session 或新的容器实例；
- 使用不同的受控输入或 fixture state；
- 产生了不同且可审计的 effect artifact。

### 5.3 设置重复阈值和策略切换

建议默认策略：

| 情况 | 动作 |
| --- | --- |
| 第一次重复 | 允许一次重试，并返回重复原因 |
| 连续第二次重复 | 禁止原命令重跑，要求改变假设、工具或输入 |
| 连续第三次无新信息 | 自动生成 `pivot` handoff，转入新的 hypothesis |
| 达到任务预算的 70% 仍无覆盖增加 | 降低探索范围，优先验证最高排名候选 |
| 达到预算的 90% 仍无可验证候选 | 进入 `need_human` 或 `exhausted`，不再刷 Evidence |

阈值应按 run 记录，而不是按进程内存记录，重启后不能清零。

### 5.4 采用“进展向量”而不是单一 Evidence 数量

Steward 每轮计算：

```text
progress = {
  newArtifacts,
  newEffects,
  newHypotheses,
  newClaimCoverage,
  newTargetCoverage,
  newVerifierAttempts,
  closedUnknowns,
  repeatedActions,
}
```

只要 `newArtifacts` 或 `newEffects` 增加，并且它们不是重复指纹，就可以判定本轮有进展，即使没有新增最终 Evidence。

反过来，如果只有 `repeatedActions` 增加，Steward 应返回 `pivot`，而不是继续要求“再提交一条证据”。

### 5.5 给每个 claim 维护“缺口列表”

不要把门禁提示写成“Evidence 不足”。应改成可行动的缺口：

```text
claim C-123 缺口：
- 缺少当前 generation 的原始 artifact
- 缺少 effect exitCode=0 的执行记录
- 缺少针对 completion C-123 的第二次独立复现
- 已有两次尝试使用同一 commandHash，必须更换输入或策略
```

solver 只有在知道缺口是什么时，才有机会继续推进而不是盲目重复。

## 6. 建议的数据模型

### 6.1 Evidence 增加 provenance 和生命周期字段

建议扩展 `Evidence`：

```ts
interface EvidenceProvenance {
  runId: string;
  generation: number;
  targetScopeDigest: string;
  artifactIds: string[];
  artifactSha256: string[];
  effectIds: string[];
  effectOutcomes: Array<"success" | "error" | "timeout" | "unknown">;
  commandHash?: string;
  candidateHash?: string;
  verifierVersion?: string;
  attemptId?: string;
  noveltyKey: string;
  createdBy: "solver" | "steward" | "verifier" | "harness";
}

type EvidenceStatus =
  | "RAW"
  | "NORMALIZED"
  | "LINKED"
  | "REVIEWED"
  | "PROMOTED"
  | "STALE"
  | "REJECTED";
```

`PROMOTED` 不等于 `ACCEPTED`。它只表示该 Evidence 可以作为某个 claim 的输入；最终 accepted 仍然只能由 verifier 产生。

### 6.2 Completion 必须携带绑定信息

建议补充：

```ts
interface CompletionProposal {
  id: string;
  candidateHash: string;
  artifactId: string;
  generation: number;
  requiredEvidenceIds: string[];
  status: "PROPOSED" | "ACCEPTED" | "REJECTED";
}
```

`finish` 命令必须增加 `completionId`，不能只传一组孤立的 `evidenceIds`。

## 7. 建议的 Steward 接口

第一版可以完全不调用模型：

```ts
interface EvidenceSteward {
  ingest(runId: string, input: {
    artifactIds?: string[];
    effectIds?: string[];
    candidateId?: string;
    hypothesisIds?: string[];
  }): Promise<StewardDecision>;

  assess(runId: string, completionId: string): Promise<EvidenceAssessment>;

  markStale(runId: string, generation: number): Promise<void>;

  recover(runId: string): Promise<void>;
}

type StewardDecision =
  | { action: "continue"; gaps: EvidenceGap[] }
  | { action: "pivot"; reason: string; prohibitedRepeats: string[] }
  | { action: "verify"; completionId: string; evidenceIds: string[] }
  | { action: "stop"; reason: string }
  | { action: "need_human"; reason: string };
```

如果后续引入小型模型，应限制为：

- 只能读取裁剪后的 Evidence index 和 gap 列表；
- 只能输出结构化 `StewardDecision`；
- 不能直接发 `evidence`、`completion_verified` 或 `finish` 命令；
- 不能自行调用 shell、网络、容器或平台提交工具；
- 输出必须经过确定性 schema 和重复检测。

## 8. Control Store 的命令边界调整

建议增加专用命令，而不是让所有模块直接写原始 Evidence：

```text
observation_recorded
evidence_normalized
evidence_linked
evidence_promoted
verification_requested
completion_verified
run_finished
```

其中：

1. `observation_recorded` 可以由 solver 产生，但必须引用已存在 artifact/effect。
2. `evidence_normalized` 只能由 Steward 产生，负责固定摘要、指纹和引用。
3. `evidence_promoted` 只能由 Steward 产生，表示它可以进入 claim 的证据集合。
4. `completion_verified` 只能由 verifier 产生，并且必须原子校验全部 Evidence。
5. `run_finished` 必须携带 `completionId`，并重新检查 snapshot，而不是相信调用方缓存。

在过渡期至少应在现有 `validateCommand()` 中增加以下检查：

- Evidence ID 不得覆盖已有记录；
- `confidence` 必须为有限的 `0..1`；
- source artifact/effect 必须存在；
- source effect 必须属于当前 generation；
- `dependsOn/supports/refutes` 必须全部可解析；
- reproduction Evidence 必须包含 verifier artifact 和 effect；
- `completion_verified.accepted` 必须要求完整 Evidence 集合；
- `finish` 必须增加并校验 `completionId`。

## 9. 证据门禁的推荐算法

可以使用下面的确定性流程：

```text
on each solver turn:
  collect new artifacts/effects
  calculate noveltyKey for each candidate record
  discard exact duplicates from evidence count
  mark stale records from old generation
  update claim coverage and evidence gaps

  if no new artifact/effect and repeatedActions >= 2:
      return pivot

  if candidate exists and all mandatory gaps are closed:
      return verify

  if candidate exists but only verifier gaps remain:
      return verify

  if exploration budget remains:
      return continue with ranked gap

  return need_human or exhausted
```

排序建议：

```text
priority =
  claimImpact
  * targetCoverageGain
  * expectedInformationGain
  / estimatedCost
```

这样系统追求的是“关闭关键缺口”，而不是“增加 Evidence 行数”。

## 10. 与当前五类容器/运行环境的关系

证据管理角色不应为每个容器再创建一个常驻模型进程。建议：

- solver container 只负责目标交互和工具执行；
- Evidence Steward 运行在 host-side control plane；
- verifier 根据 task profile 进入对应的 solver/container；
- 每个 effect 绑定 container ID、network ID、image digest 和 generation；
- 容器重建后必须生成新的 attemptId，不能复用旧容器的 reproduction Evidence；
- host 重启后由 Steward 从 Control Store 重建索引，而不是依赖进程内数组。

这样可以避免“容器数量增加，证据 agent 数量也线性增加”的管理失控。

## 11. 分阶段实施计划

### 阶段一：先修完整性，不引入第二个模型

目标是堵住当前证据写入边界：

1. 在 `ControlStore.validateCommand()` 增加 Evidence provenance 校验。
2. 在 reducer 中禁止 Evidence ID 覆盖。
3. 为 Evidence 增加 generation、noveltyKey、artifact/effect 引用。
4. 为 `finish` 增加 `completionId`。
5. 使 `completion_verified` 成为单向原子状态转换。
6. 增加 malformed evidence、dangling reference、stale generation 测试。

### 阶段二：实现确定性 Evidence Steward

1. 新建 `EvidenceSteward` 服务。
2. 将 `EvidenceCurationGate`、EvidenceGraph 的去重和关联逻辑集中到 Steward。
3. 为每个 run 保存重复计数、gap 列表和最近动作摘要。
4. 将重复阈值和 pivot handoff 接入 `PlannerCoordinator`。
5. 从 durable snapshot 恢复 Steward 索引。

### 阶段三：接入受限复核模型

只在确定性 Steward 已能稳定判断重复和缺口后，再增加模型：

1. 模型只做 gap 解释和下一步排序；
2. 输出必须经过 schema 校验；
3. 模型不能改变 Evidence 状态；
4. 模型不能直接触发最终 verifier；
5. 记录模型建议与实际执行结果，用于评估是否真正减少循环。

### 阶段四：迁移 pwn/web/platform verifier

逐类迁移：

1. hidden scorer；
2. local reproduction；
3. pwn fresh-session reproduction；
4. platform submission。

每类 verifier 都必须输出统一 provenance，并通过相同的 `completionId + generation + noveltyKey` 校验。

## 12. 必须补充的测试

### Control Store

- 普通 lane 写入 reproduction Evidence 应失败；
- source artifact 不存在应失败；
- effect 未完成应失败；
- generation 不一致应失败；
- `confidence = NaN`、负数、大于 1 应失败；
- 重复 Evidence ID 不得覆盖；
- `completion_verified` 引用未知 Evidence 应失败；
- accepted completion 不得被再次改写；
- 两个 completion 同时存在时，finish 必须按 completionId 校验。

### Steward

- 相同 `noveltyKey` 不增加证据计数；
- 同一命令连续两次后返回 pivot；
- 新 artifact 但无最终 Evidence 时仍判定为有进展；
- generation reset 后旧 Evidence 自动变为 stale；
- 重启后重复计数和 gap 列表保持一致。

### Verifier

- reproduction 必须有 artifact、effect、session/attempt provenance；
- 不同 candidate 不能共享 accepted Evidence；
- pwn 目标不在 task scope 内时必须拒绝；
- 模型自定义 flag regex 不能单独决定 accepted；
- 平台验证未发生时不能把 completion 标记为 accepted。

### 运行时与容器

- 容器重建生成新的 attemptId；
- 旧容器的 Evidence 不能自动支持新 generation；
- host 重启后 Steward 可以恢复索引；
- 容器清理不会删除仍被当前 completion 引用的 artifact。

## 13. 观测指标

上线后至少记录以下指标：

- 每个 run 的 unique Evidence 数量；
- duplicate Evidence 比例；
- 连续重复动作次数；
- pivot 次数及 pivot 后是否产生新 artifact；
- 从 candidate 到 accepted 的平均 verifier 次数；
- stale Evidence 比例；
- 无 Evidence 但有新 artifact 的探索轮数；
- 因门禁导致的 `need_human` 数量；
- accepted Evidence 中缺失 provenance 的数量，目标必须为 0。

判断方案是否有效的核心指标不是 Evidence 总数，而是：

```text
有效推进率 = 产生新 artifact/effect 且关闭至少一个关键 gap 的轮数 / 总轮数
```

如果增加 Steward 后 Evidence 数量上升但有效推进率下降，说明栅栏仍然过严或 Steward 的缺口排序错误。

## 14. 最终建议

当前最适合的落地方式是：

1. 先实现确定性 `EvidenceSteward`，不要马上增加一个自由行动的大模型子 agent。
2. 把 Evidence 管理从 solver lane 中抽离，但保留 solver 的探索自由度。
3. 只在 candidate、completion 和最终 finish 阶段启用硬栅栏。
4. 用 noveltyKey、attempt 上限、progress vector 和 pivot handoff 阻断重复循环。
5. 将 verifier 作为唯一的 accepted Evidence 和成功状态来源。
6. 等确定性版本运行稳定后，再引入只能输出结构化建议的轻量复核模型。

一句话概括：**证据管理应该是独立的控制平面，不应该是第二个可以自证自验的 solver；证据栅栏应该约束“最终声明”，而不是阻止“继续探索”。**
