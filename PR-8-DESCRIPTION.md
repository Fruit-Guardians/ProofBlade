## PR #8: feat(orchestration): 实现 Intent 调度器和评分系统

### 动机
设计文档 §6.5 要求实现可解释的 Intent 调度和评分系统，以避免模型重复探索和低效路线选择。当前项目缺少：
- Intent 的生成、评分和选择机制
- 基于证据的智能调度
- 资源冲突的 lease 管理
- 可追溯的决策依据

此 PR 交付完整的 Intent 调度器，实现 8 维度评分公式和确定性触发条件。

---

### 变更内容

#### 1. 核心数据模型
**新增文件**: `packages/materials/src/domain/intent.ts`

定义完整的 Intent 数据结构：
- `Intent` - 探索意图的核心类型
- `IntentStatus` - 6 种状态（PROPOSED/CLAIMED/COMPLETED/FAILED/CANCELLED/STALE）
- `IntentScore` - 8 维度评分结果
- `SchedulingContext` - 调度上下文
- `IntentScoringWeights` - 可配置权重

**设计依据**: 设计文档 §6.5, §9.1

---

#### 2. 评分引擎
**新增文件**: `packages/materials/src/orchestration/intent-scorer.ts`

实现 8 维度可解释评分系统：

```typescript
score(intent) = 
  2.0 * expected_information_gain +
  1.5 * success_probability +
  1.2 * evidence_relevance +
  0.8 * novelty -
  1.0 * normalized_cost -
  1.2 * environment_risk -
  1.5 * duplicate_similarity -
  0.8 * dependency_depth
```

**关键特性**:
- ✅ 每个维度归一化到 [0, 1]
- ✅ 权重可配置（支持 A/B 测试）
- ✅ 生成人类可读的评分解释
- ✅ 批量评分和排序

**设计依据**: 设计文档 §6.5 评分公式

---

#### 3. 硬过滤器
**新增文件**: `packages/materials/src/orchestration/intent-filter.ts`

实现 6 条硬过滤规则（在评分前执行）：

1. ✅ **依赖检查** - 所有依赖 Intent 必须已完成
2. ✅ **资源检查** - 所需资源不能被占用
3. ✅ **预算检查** - 预估成本不能超过剩余预算
4. ✅ **证据否决** - 不能被同代环境证据否定
5. ✅ **尝试次数** - 不能超过最大尝试次数
6. ✅ **版本检查** - 知识版本不能过期

**设计依据**: 设计文档 §6.5 硬过滤规则

---

#### 4. 调度器主类
**新增文件**: `packages/materials/src/orchestration/intent-scheduler.ts`

实现完整调度流程：

```typescript
// 主调度流程（设计文档 §6.5）
1. 检查触发条件 (shouldSchedule)
2. 生成候选 Intent (generateIntents)
3. 硬过滤 (filter)
4. 评分排序 (scoreAndRank)
5. 原子认领 (selectBest + LeaseManager)
```

**触发条件**（任一满足即触发）:
- ✅ 新增高价值 Fact
- ✅ Intent 归零
- ✅ 连续失败 ≥2 次
- ✅ 阶段预算过半
- ✅ 新 Hint 到达
- ✅ Verifier 推翻结论

**设计依据**: 设计文档 §6.5 调度流程

---

#### 5. CLI 命令
**新增文件**: `apps/cli/src/commands/intents.ts`

提供 4 个子命令：

```powershell
# 列出所有 Intent 及其状态
proofblade intents list <run-id>

# 显示详细评分（8 维度分解）
proofblade intents score <run-id>

# 导出 Intent 依赖图（Mermaid/JSON）
proofblade intents graph <run-id> [format]

# 测试 Intent 认领流程
proofblade intents claim <run-id>
```

---

#### 6. 单元测试
**新增文件**: `packages/materials/tests/intent-scheduler.test.ts`

覆盖核心逻辑：
- ✅ 触发条件检查
- ✅ 评分计算
- ✅ 权重配置
- ✅ 批量评分排序

---

#### 7. 配置文档
**新增文件**: `docs/intent-scheduler-configuration.md`

包含：
- 配置项详细说明
- 4 种场景的权重调优建议
- 调试技巧和常见问题
- 性能考虑

---

### 测试验证

```powershell
# 单元测试
npm run test -- packages/materials/tests/intent-scheduler.test.ts
# 预期：8 个测试全部通过

# TypeScript 编译
npm run build
# 预期：无编译错误

# CLI 命令测试
npm run cli -- intents list DEMO-001
npm run cli -- intents score DEMO-001
```

---

### 配置示例

在 `proofblade.config.json` 中添加：

```json
{
  "intentScheduler": {
    "maxOpenIntents": 8,
    "maxAttemptsPerIntent": 3,
    "scoringWeights": {
      "informationGain": 2.0,
      "successProbability": 1.5,
      "evidenceRelevance": 1.2,
      "novelty": 0.8,
      "cost": -1.0,
      "environmentRisk": -1.2,
      "duplicateSimilarity": -1.5,
      "dependencyDepth": -0.8
    }
  }
}
```

---

### 破坏性变更

**无** - 此 PR 为新增功能

---

### 检查清单

- [x] 所有新文件通过 TypeScript 编译
- [x] 单元测试覆盖核心逻辑
- [x] CLI 命令可用且输出格式正确
- [x] 配置文档完整
- [x] 遵循设计文档 §6.5 规范
- [x] 代码注释引用设计文档章节
- [x] 组件文档需更新：`packages/materials/src/orchestration/COMPONENT.md` v1.1.0

---

### 相关设计文档

- **核心**: §6.5 Intent 选择算法（第 890-918 行）
- **数据模型**: §9.1 领域对象（第 1162-1189 行）
- **触发条件**: §6.5 调度流程（第 908-918 行）
- **评分公式**: §6.5 评分公式（第 893-904 行）
- **参考实现**: §2.5 Cairn 的 Fact/Intent/Hint 图（第 301-339 行）
