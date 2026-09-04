# Knowledge Observer

```json component-metadata
{
  "id": "materials-knowledge",
  "name": "Knowledge Observer",
  "version": "0.6.6",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-02T14:08:00.000+08:00",
  "qualityAudit": {
    "bugAuditCount": 5,
    "securityAuditCount": 5,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "d8899a59b40eebce607826d43616f19aebbdd25bbb0dbf21a0cb84fabd5df611",
    "result": "passed"
  }
}
```

## 职责

把不可信目标输出转换为有来源的 Observation/Evidence，并通过共享 DAG、推理树和森林索引为 Fact、Hypothesis 与 completion grounding 提供确定性依据。

## 入口与边界

- `observer.ts` 负责观察归一化与证据锚定。
- `evidence-graph.ts` 为 Coding lane 提供 Artifact 标注、Evidence 归纳、带类型边的共享 DAG、Reasoning Tree 整理、Forest 摘要和局部树检查。
- `evidence-curation-gate.ts` 追踪未审阅的 `read/bash` 产物；软检查点提示整理，硬检查点阻止继续侦察，直至 Agent 将产物提升为 Evidence，或受信 user/harness 显式审阅普通/调试输出。
- 模型只能提出知识命令；Reducer 决定知识状态。
- 原始大输出留在 Artifact，Knowledge 只保存可检索索引与引用。
- `deterministic-index.ts` 为当前 Run/generation 提供可重建的文本索引；Artifact 内容 hash 变化会失效旧条目，generation 切换会清空索引。它是性能缓存，不是第二个事实库。

## 开发规则与验证

所有目标内容保持不可信标签和来源。Routine Tool 输出默认只是 intermediate/debug Artifact；只有具备名称、摘要、标签和来源引用的发现才提升为 Evidence。Evidence Curator 通过固定代理命名、解释、连边和组织树；主 Agent 默认读取 Forest 摘要，需要溯源时才展开局部树。底层图允许节点被多树采用，GUI 的树形结构只是投影。

`evidence.search` 优先查询当前 generation 的确定性 Artifact 索引；首次遇到新内容时才从 ArtifactStore 读取一次。索引命中、L2 读取、进入 ModelContextFrame 和后续模型使用仍是四个独立状态，不能因为缓存命中就声称模型已经读取或验证内容。

证据整理门按唯一内容哈希投影互斥状态 `promoted > reviewed > viewed > unviewed`。普通 Agent annotation 只能把产物标为 `viewed`，仍属于 pending，不能解除门禁；只有来源明确的 Evidence promotion，或通过受信 capability 产生的 user/harness `artifact_annotated` 事件，才能移出 pending。Artifact 注册时自带的 harness semantic metadata 不算审阅。重复输出不重复占用预算，同哈希副本共享最高可信状态；测试必须覆盖软提示、硬阻断、去重、promotion、trusted review，以及批量 Agent annotation 仍无法清账。

Forest 索引保留完整 orphan 总数，但只投影最近 24 个 orphan 的稳定 ID、类型、名称和摘要；即使当前没有 Tree，只要存在 orphan 知识，也必须向下一回合提供有界的方向记忆。

Fact/Hypothesis 等权威语句保持完整；投影到 Reasoning Node/Tree 的展示名称独立限制为 160 字符。长 claim 不得让 `recordEvidence` 在 Evidence/Fact 已落盘后因展示标题校验而失败。

`recordEvidence` 在落盘前完成全部字段、引用、Artifact 语义、图节点、边和 Tree 校验，并通过原子事务提交。Artifact 标签和关联 ID 使用确定性有界合并；相同 Artifact 集合、摘要、claim 与依赖无论顺序或并发重复提交，都必须复用同一 Evidence、Fact 和 Tree。持久进展身份使用 Artifact 内容哈希、claim 与依赖，不使用临时 Artifact ID 或展示摘要；相同字节的副本和改写措辞只能报告一次持久进展。`annotateArtifact` 只报告“已查看”进展，同一内容后续改名、改摘要或标注其副本均不得伪装成可信审阅或重置收敛窗口。

```powershell
npm run test:materials
```
