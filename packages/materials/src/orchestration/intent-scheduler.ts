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
import type { ControlStore } from '../control/control-store.js';
import { randomUUID } from 'node:crypto';

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
    private controlStore: ControlStore,
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
    this.filter = new IntentFilter(leaseManager, this.config);
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
    // Load existing proposed intents before evaluating trigger conditions.
    const snapshot = await this.controlStore.snapshot(context.runId);
    const persistedIntents = Object.values(snapshot.schedulerIntents || {});
    const existingIntents = persistedIntents.filter(intent => intent.status === 'PROPOSED');
    const persistedOpenIntents = persistedIntents.filter(
      intent => intent.status === 'PROPOSED' || intent.status === 'CLAIMED'
    ).length;
    const openIntents = Math.max(context.openIntents, persistedOpenIntents);
    const schedulingContext = openIntents === context.openIntents
      ? context
      : { ...context, openIntents };

    // Open intents, including proposed reservations, consume capacity.
    if (openIntents >= this.config.maxOpenIntents) {
      return null;
    }

    // Without a trigger, only claim an existing candidate; do not generate more.
    const triggered = this.shouldSchedule(schedulingContext);
    if (!triggered && existingIntents.length === 0) {
      return null;
    }

    // Generate new candidates only when a scheduling trigger is active.
    const remainingCapacity = Math.max(0, this.config.maxOpenIntents - openIntents);
    const newIntents = triggered
      ? await this.generateIntents(schedulingContext, remainingCapacity)
      : [];

    const candidates = [...existingIntents, ...newIntents];
    if (candidates.length === 0) {
      return null;
    }

    const filtered = this.filter.filter(candidates, schedulingContext);
    if (filtered.length === 0) {
      return null;
    }

    const scored = this.scorer.scoreAndRank(filtered, schedulingContext);
    return this.selectBest(scored, filtered, schedulingContext);
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
   * Uses deterministic rules today and can be extended through a Planner adapter.
   */
  private async generateIntents(
    context: SchedulingContext,
    maxIntents: number,
  ): Promise<Intent[]> {
    const intents: Intent[] = [];

    const add = (intent: Intent) => {
      if (intents.length < maxIntents) intents.push(intent);
    };

    // 策略 1: 基于新 Fact 生成探索 Intent
    if (context.newHighValueFacts > 0 && intents.length < maxIntents) {
      add(this.createExplorationIntent(context, 'high_value_fact_follow_up'));
    }

    // 策略 2: 基于假设生成验证 Intent
    for (const hypothesisId of context.hypotheses.slice(0, 3)) {
      if (intents.length >= maxIntents) break;
      add(this.createVerificationIntent(context, hypothesisId));
    }

    // 策略 3: 基于连续失败生成替代路线 Intent
    if (context.consecutiveFailures >= 2 && intents.length < maxIntents) {
      add(this.createAlternativeIntent(context, 'failure_recovery'));
    }

    // 策略 4: 基于 Hint 生成定向 Intent
    for (const hint of context.newHints) {
      if (intents.length >= maxIntents) break;
      add(this.createHintBasedIntent(context, hint));
    }

    if (intents.length === 0) return intents;

    for (const intent of intents) {
      await this.controlStore.dispatch(context.runId, {
        type: 'scheduler_intent',
        intent,
      });
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

      // 尝试原子认领所有资源
      if (intent.resourceKeys.length > 0) {
        const leases = [];

        try {
          // 逐个获取所有资源的 lease
          for (const resourceKey of intent.resourceKeys) {
            const lease = await this.leaseManager.acquire(
              context.runId,
              resourceKey,
              'executor',
              intent.estimatedDuration * 2 // 2倍预估时间作为超时
            );
            leases.push(lease);
          }

          // 所有资源都成功获取，认领成功
          intent.status = 'CLAIMED';
          intent.claimedAt = new Date().toISOString();
          intent.leaseId = leases.map(l => l.resourceKey).join(',');

          // 持久化认领状态
          await this.controlStore.dispatch(context.runId, {
            type: 'scheduler_intent',
            intent,
          });

          return intent;
        } catch (error) {
          // 资源获取失败，释放已获取的资源
          for (const lease of leases) {
            try {
              await this.leaseManager.release(context.runId, lease);
            } catch (releaseError) {
              // 释放失败，记录但继续
              console.warn(`Failed to release lease for ${lease.resourceKey}:`, releaseError);
            }
          }

          // 尝试下一个 Intent
          continue;
        }
      } else {
        // 无需资源，直接认领
        intent.status = 'CLAIMED';
        intent.claimedAt = new Date().toISOString();

        // 持久化认领状态
        await this.controlStore.dispatch(context.runId, {
          type: 'scheduler_intent',
          intent,
        });

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

  /**
   * 标记 Intent 为完成
   */
  async completeIntent(
    runId: string,
    intentId: string,
    result: {
      producedObservations?: string[];
      producedEvidence?: string[];
      producedFacts?: string[];
    }
  ): Promise<void> {
    const snapshot = await this.controlStore.snapshot(runId);
    const intent = snapshot.schedulerIntents[intentId];

    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    intent.status = 'COMPLETED';
    intent.completedAt = new Date().toISOString();
    intent.producedObservations = result.producedObservations;
    intent.producedEvidence = result.producedEvidence;
    intent.producedFacts = result.producedFacts;

    await this.releaseIntentLeases(runId, intent);
    await this.controlStore.dispatch(runId, {
      type: 'scheduler_intent',
      intent,
    });
  }

  /**
   * 标记 Intent 为失败
   */
  async failIntent(
    runId: string,
    intentId: string,
    error: string
  ): Promise<void> {
    const snapshot = await this.controlStore.snapshot(runId);
    const intent = snapshot.schedulerIntents[intentId];

    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    intent.status = 'FAILED';
    intent.completedAt = new Date().toISOString();
    intent.lastError = error;
    intent.attempts += 1;

    await this.releaseIntentLeases(runId, intent);
    await this.controlStore.dispatch(runId, {
      type: 'scheduler_intent',
      intent,
    });
  }

  /**
   * 取消 Intent
   */
  async cancelIntent(
    runId: string,
    intentId: string,
    reason: string
  ): Promise<void> {
    const snapshot = await this.controlStore.snapshot(runId);
    const intent = snapshot.schedulerIntents[intentId];

    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    intent.status = 'CANCELLED';
    intent.lastError = reason;

    await this.releaseIntentLeases(runId, intent);
    await this.controlStore.dispatch(runId, {
      type: 'scheduler_intent',
      intent,
    });
  }

  // ========== Intent 生成辅助方法 ==========

  private createIntentId(kind: string): string {
    return `intent-${kind}-${randomUUID()}`;
  }

  private async releaseIntentLeases(runId: string, intent: Intent): Promise<void> {
    if (!intent.leaseId || intent.resourceKeys.length === 0) return;

    const leasedResources = new Set(intent.leaseId.split(',').filter(Boolean));
    const snapshot = await this.controlStore.snapshot(runId);
    for (const resourceKey of intent.resourceKeys) {
      if (!leasedResources.has(resourceKey)) continue;
      const lease = snapshot.leases?.[resourceKey];
      if (!lease || lease.ownerLane !== 'executor') continue;
      await this.leaseManager.release(runId, lease);
    }
  }

  private createExplorationIntent(
    context: SchedulingContext,
    reason: string
  ): Intent {
    return {
      id: this.createIntentId('explore'),
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
      id: this.createIntentId('alternative'),
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
      id: this.createIntentId('hint'),
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
