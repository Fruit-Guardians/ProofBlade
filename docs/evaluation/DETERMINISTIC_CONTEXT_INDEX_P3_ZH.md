# Deterministic Context Index P3 实现记录

本功能对应 OpenViking 风格 Context Database 计划的 P3：先建立可重建的确定性检索层，再考虑向量或查询规划。代码、测试、组件说明和本文档属于同一个 PR。

## 首错归因

此前 `CodingEvidenceGraph.search()` 在元数据未命中时，每次查询都会重新读取所有符合条件的文本 Artifact。重复检索会产生 O(Artifact 数量 × 文本字节数) 的尾延迟，模型可能因为等待过长而重复执行原命令。首错属于检索基础设施，不是模型策略，也不是 Evidence 权威关系。

## 修复

- 新增 Run-scoped `DeterministicArtifactIndex`，按 Artifact ID + 内容 SHA-256 缓存归一化文本和 token 集合。
- `evidence.search` 首次查询只读取新 hash；相同 Artifact/hash 的后续查询复用缓存。
- Artifact 内容 hash 改变时旧索引立即失效；ControlStore generation 改变时清空整组索引，避免跨代污染。
- ControlStore 与 ArtifactStore 仍是 canonical source；索引丢失可从原始 Artifact 重建，索引不会生成 Evidence 或 Fact。
- `maxBytes` 按 UTF-8 字节计算，替换同一 artifact 会先扣除旧条目字节数再计入新内容，避免中文/emoji 或更新后的计数漂移。

## 行为比较

修复前：查询 `reveal_marker` 和随后查询 `verify_magic` 都会再次读取同一 L2 Artifact。修复后：第一条查询读取一次并建立索引，第二条查询只做确定性命中；内容 hash 变化会再次读取，保证不会返回过期文本。该行为减少检索 IO 和尾延迟，但不改变命中排序的 Evidence 信任级别。

## 验收

- `deterministic-index.test.ts` 覆盖规范化、hash 失效、关键词命中和清空。
- `evidence-search-index.test.ts` 用真实 ArtifactStore 统计同一 generation 的读取次数为一次，新 Artifact 只增加一次读取。
- 回归覆盖中文、emoji 的 UTF-8 字节驱逐、总字节上限和同 artifact 替换计数。
- 现有 knowledge projection、Evidence Graph、materials build/typecheck 和 `check:components` 继续通过。

## 当前边界与下一步

这是关键词/精确索引，不是向量 RAG；没有新增 Embedding 请求、跨 Run 记忆或远程服务。下一步若实现 RetrievalTrace，应分别记录 query、候选、选中、注入 ModelContextFrame、模型 Recall 和后续动作，不能把索引命中直接当成策略收益。
