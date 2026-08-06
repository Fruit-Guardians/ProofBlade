/**
 * Intent 调度器
 * 设计文档: §6.5 Intent 选择算法
 *
 * 职责：
 * 1. 根据触发条件生成 Intent
 * 2. 评分和排序
 * 3. 硬过滤
 * 4. 原子认领
 * 5. 结果提交
 */

import type {
  Intent,
  IntentStatus,
  SchedulingContext,
  IntentGenerationRequest,
  IntentGenerationResult,
  IntentScore,
} from '../domain/intent.js';
import { IntentScorer } from './intent-scorer.js';
import { IntentFilter } from './intent-filter.js';
import { LeaseManager } from '../control/lease-manager.js';

export interface IntentSchedulerConfig {
  maxOpenIntents: number;              // 最大并发 Intent 数
  maxAttemptsPerIntent: number;        // 每个 Intent 最大尝试次数
  scoringWeights?: Record<string, number>;
}

export class IntentScheduler {
  private scorer: IntentScorer;
  private filter: IntentFilter;
  private leaseManager: LeaseManager;
  private config: IntentSchedulerConfig;

  constructor(
    leaseManager: LeaseManager,
    config?: Partial<IntentSchedulerConfig>
  ) {
    this.leaseManager = leaseManager;
    this.config = {
      maxOpenIntents: 8,
      maxAttemptsPerIntent: 3,
      ...config,
    };

    this.scorer = new IntentScorer(config?.scoringWeights);
    this.filter = new IntentFilter(leaseManager);
  }

  /**
   * 主调度流程
   *
   * 设计文档 §6.5 调度流程：
   * 1. reason 生成 Intent
   * 2. Reducer 校验、去重、过滤
   * 3. Scheduler 评分排序
   * 4. Worker 原子 claim
   */
  async schedule(context: SchedulingContext): Promise<Intent | null> {
    // 1. 检查触发条件
    if (!this.shouldSchedule(context)) {
      return null;
    }

    // 2. 生成候选 Intent
    const candidates = await this.generateIntents(context);
    if (candidates.length === 0) {
      return null;
    }

    // 3. 硬过滤
    const filtered = this.filter.filter(candidates, context);
    if (filtered.length === 0) {
      return null;
    }

    // 4. 评分排序
    const scored = this.scorer.scoreAndRank(filtered, context);

    // 5. 选择最高分的可认领 Intent
    return this.selectBest(scored, filtered, context);
  }

  /**
   * 检查是否应触发调度
   *
   * 设计文档 §6.5: 触发条件
   * - 新增高价值 Fact
   * - open Intent 归零
   * - 连续失败达到阈值
   * - 阶段预算过半
   * - Hint 到达
   * - Verifier 推翻结论
   */
  shouldSchedule(context: SchedulingContext): boolean {
    // 已达到最大并发数，暂不调度
    if (context.openIntents >= this.config.maxOpenIntents) {
      return false;
    }

    // 触发条件（任一满足即触发）
    return (
      context.newHighValueFacts > 0 ||          // 新增高价值 Fact
      context.openIntents === 0 ||              // Intent 归零
      context.consecutiveFailures >= 2 ||       // 连续失败 ≥2 次
      context.phaseBudgetUsed > 0.5 ||          // 阶段预算过半
      context.newHints.length > 0 ||            // 新 Hint 到达
      context.verifierRejected                  // Verifier 否决
    );
  }

  /**
   * 生成候选 Intent
   *
   * 简化实现：从知识图中提取候选方向
   * TODO: 实际应调用 Planner 模型或规则引擎
   */
  private async generateIntents(
    context: SchedulingContext
  ): Promise<Intent[]> {
    const intents: Intent[] = [];

    // 策略 1: 基于新 Fact 生成探索 Intent
    if (context.newHighValueFacts > 0) {
      intents.push(
        this.createExplorationIntent(context, 'high_value_fact_follow_up')
      );
    }

    // 策略 2: 基于假设生成验证 Intent
    for (const hypothesisId of context.hypotheses.slice(0, 3)) {
      intents.push(
        this.createVerificationIntent(context, hypothesisId)
      );
    }

    // 策略 3: 基于连续失败生成替代路线 Intent
    if (context.consecutiveFailures >= 2) {
      intents.push(
        this.createAlternativeIntent(context, 'failure_recovery')
      );
    }

    // 策略 4: 基于 Hint 生成定向 Intent
    for (const hint of context.newHints) {
      intents.push(
        this.createHintBasedIntent(context, hint)
      );
    }

    return intents;
  }

  /**
   * 选择最佳 Intent 并尝试认领
   */
  private async selectBest(
    scores: IntentScore[],
    intents: Intent[],
    context: SchedulingContext
  ): Promise<Intent | null> {
    // 按评分从高到低尝试认领
    for (const score of scores) {
      const intent = intents.find(i => i.id === score.intentId);
      if (!intent) continue;

      // 尝试原子认领资源
      const lease = await this.leaseManager.tryAcquire(
        intent.resourceKeys,
        'scheduler',  // TODO: 使用实际 Worker ID
        {
          generation: context.currentGeneration,
          intentId: intent.id,
          expiresIn: intent.estimatedDuration * 2, // 2倍预估时间作为超时
        }
      );

      if (lease) {
        // 认领成功，更新 Intent 状态
        intent.status = 'CLAIMED';
        intent.claimedAt = new Date().toISOString();
        intent.leaseId = lease.id;

        return intent;
      }
    }

    // 所有 Intent 都无法认领
    return null;
  }

  /**
   * 批量评分（用于调试和分析）
   */
  async scoreIntents(
    intents: Intent[],
    context: SchedulingContext
  ): Promise<IntentScore[]> {
    return this.scorer.scoreAndRank(intents, context);
  }

  /**
   * 获取评分权重配置
   */
  getScoringWeights() {
    return this.scorer.getWeights();
  }

  /**
   * 更新评分权重（用于 A/B 测试）
   */
  updateScoringWeights(weights: Record<string, number>) {
    this.scorer.updateWeights(weights);
  }

  // ========== Intent 生成辅助方法 ==========

  private createExplorationIntent(
    context: SchedulingContext,
    reason: string
  ): Intent {
    return {
      id: `intent-explore-${Date.now()}`,
      status: 'PROPOSED',
      priority: 'high',
      createdAt: new Date().toISOString(),
      knowledgeVersion: context.knowledgeVersion,
      fixtureGeneration: context.currentGeneration,
      phase: context.phase,
      objective: `探索基于新 Fact 的后续方向 (${reason})`,
      startFromFacts: context.facts.slice(-3), // 最近 3 个 Fact
      expectedEvidence: {
        kind: 'observation',
        description: '新的观察数据',
        minimumConfidence: 'medium',
      },
      suggestedTools: ['invoke_capability', 'run_command'],
      estimatedCost: 500,
      estimatedDuration: 30000,
      resourceKeys: ['workspace:read', 'target:read'],
      dependencies: [],
      attempts: 0,
    };
  }

  private createVerificationIntent(
    context: SchedulingContext,
    hypothesisId: string
  ): Intent {
    return {
      id: `intent-verify-${hypothesisId}`,
      status: 'PROPOSED',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      knowledgeVersion: context.knowledgeVersion,
      fixtureGeneration: context.currentGeneration,
      phase: context.phase,
      objective: `验证假设 ${hypothesisId}`,
      hypothesis: hypothesisId,
      startFromFacts: [],
      expectedEvidence: {
        kind: 'reproduction',
        description: '可复现的验证结果',
        minimumConfidence: 'high',
      },
      suggestedTools: ['run_experiment', 'run_background'],
      estimatedCost: 800,
      estimatedDuration: 60000,
      resourceKeys: ['target:write', 'workspace:write'],
      dependencies: [],
      attempts: 0,
    };
  }

  private createAlternativeIntent(
    context: SchedulingContext,
    reason: string
  ): Intent {
    return {
      id: `intent-alternative-${Date.now()}`,
      status: 'PROPOSED',
      priority: 'critical',
      createdAt: new Date().toISOString(),
      knowledgeVersion: context.knowledgeVersion,
      fixtureGeneration: context.currentGeneration,
      phase: context.phase,
      objective: `尝试替代路线 (${reason})`,
      startFromFacts: context.facts,
      expectedEvidence: {
        kind: 'observation',
        description: '不同方法的观察结果',
        minimumConfidence: 'low',
      },
      suggestedTools: ['invoke_capability'],
      estimatedCost: 300,
      estimatedDuration: 20000,
      resourceKeys: ['workspace:read'],
      dependencies: [],
      attempts: 0,
    };
  }

  private createHintBasedIntent(
    context: SchedulingContext,
    hint: string
  ): Intent {
    return {
      id: `intent-hint-${Date.now()}`,
      status: 'PROPOSED',
      priority: 'high',
      createdAt: new Date().toISOString(),
      knowledgeVersion: context.knowledgeVersion,
      fixtureGeneration: context.currentGeneration,
      phase: context.phase,
      objective: `执行 Hint 建议: ${hint}`,
      startFromFacts: [],
      expectedEvidence: {
        kind: 'observation',
        description: 'Hint 指引的观察结果',
        minimumConfidence: 'medium',
      },
      suggestedTools: ['run_command'],
      estimatedCost: 200,
      estimatedDuration: 15000,
      resourceKeys: ['workspace:read', 'target:read'],
      dependencies: [],
      attempts: 0,
    };
  }
}
