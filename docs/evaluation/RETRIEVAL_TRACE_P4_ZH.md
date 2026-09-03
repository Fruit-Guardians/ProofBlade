# RetrievalTrace P4 实现记录

本功能对应 OpenViking 风格 Context Database 计划的 P4：让检索结果的来源、选择和进入模型上下文的状态可审计。它建立在确定性 Artifact 索引之上，不引入向量模型或第二事实库。

## 首错

原有 `evidence.search` 只返回结果数组，无法回答“为什么命中、哪些候选被选中、结果是否进入模型上下文、检索用了多久”。这会把检索遗漏或延迟误判为模型没有使用记忆，也无法区分命中、召回和后续 Recall。

## 修复

- `CodingEvidenceGraph.searchWithTrace()` 返回原搜索结果和 `RetrievalTrace`。
- Trace 记录 query/normalizedQuery、Run/generation、keyword 模式、候选 kind/score/reason、selectedRefs、injectedRefs、是否发生 Recall 和耗时。
- `evidence` 工具的 `search` 返回 `{ results, trace }`；旧 `search()` API 保持兼容，仍只返回结果数组。
- Trace 是派生观测，不改变 Artifact/Evidence/Fact 的权威性，也不会把正文或凭据写入日志。
- Search/inspect 返回的 metadata、数组和深层对象使用统一有界投影；大 summary、tags、related IDs 通过截断标记保留显式 `readArtifact` 回取路径。
- Search/inspect 返回的 metadata、数组和深层对象使用统一有界投影；大 summary、tags、related IDs 通过截断标记保留显式 `readArtifact` 回取路径。

## 行为与解释

确定性索引首次读取 Artifact L2，后续同 hash 查询复用索引；Trace 将这些候选标为 keyword/exact，并把最终返回项列入 selectedRefs。命中不等于模型已经读取或使用：`modelUsedRecall=false` 只说明这次搜索本身没有执行 L2 Recall，后续 `evidence.read` 仍需单独记录。

## 验收

- `evidence-search-index.test.ts` 验证真实 Artifact 命中、Run/generation、selected/injected refs、keyword 模式和耗时。
- 大结果回归覆盖 JSON/UTF-8 正文、超长 summary、tags、related IDs、截断 marker 和显式 Artifact 读取。
- 大结果回归覆盖 JSON/UTF-8 正文、超长 summary、tags、related IDs、截断 marker 和显式 Artifact 读取。
- 确定性索引、knowledge projection、materials build/typecheck 与变更契约继续通过。

## 当前边界与下一步

当前 Trace 只覆盖本地确定性 keyword search，候选是最终有界结果集，不包含未返回的全量候选评分。后续可单独加入层级目录 L0/L1、查询规划或向量检索；每种模式必须保持“命中 -> 注入 Frame -> 模型 Recall -> 后续动作使用”四段分开统计。
