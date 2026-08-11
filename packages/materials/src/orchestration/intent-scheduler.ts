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
import type { ControlStore, DomainCommand } from '../control/control-store.js';
import type { Lease, RunSnapshot } from '../domain/types.js';
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
    if (typeof this.controlStore.dispatchTransaction === 'function') {
      return this.scheduleAtomically(context);
    }

    // Load existing proposed intents before evaluating trigger conditions.
    const snapshot = await this.controlStore.snapshot(context.runId);
    const persistedIntents = Object.values(snapshot.schedulerIntents || {});
    const currentGeneration = snapshot.generation > 0 ? snapshot.generation : context.currentGeneration;
    const recovery = this.prepareClaimRecovery(
      persistedIntents,
      snapshot.leases || {},
      currentGeneration,
      Date.now(),
    );
    const effectiveIntents = recovery.intents;
    const knowledgeVersion = this.knowledgeVersion(snapshot, context.knowledgeVersion);
    const freshnessContext = { ...context, currentGeneration, knowledgeVersion };
    const staleProposedIntents = effectiveIntents.filter(
      intent => intent.status === 'PROPOSED' && this.filter.isStale(intent, freshnessContext)
    );
    const staleProposedIds = new Set(staleProposedIntents.map(intent => intent.id));
    const existingIntents = effectiveIntents.filter(
      intent => intent.status === 'PROPOSED' && !staleProposedIds.has(intent.id)
    );
    const persistedOpenIntents = existingIntents.length + effectiveIntents.filter(
      intent => intent.status === 'CLAIMED' && intent.fixtureGeneration === currentGeneration
    ).length;
    const openIntents = persistedOpenIntents;
    const schedulingContext = {
      ...context,
      openIntents,
      currentGeneration,
      knowledgeVersion,
      occupiedResources: Object.keys(recovery.leases),
      completedIntentIds: new Set([
        ...effectiveIntents
          .filter(intent => intent.status === 'COMPLETED' && intent.fixtureGeneration === currentGeneration)
          .map(intent => intent.id),
      ]),
      completedHypothesisIds: new Set([
        ...effectiveIntents
          .filter(intent => intent.status === 'COMPLETED'
            && intent.fixtureGeneration === currentGeneration
            && intent.hypothesis)
          .map(intent => intent.hypothesis!),
      ]),
    };

    for (const command of recovery.commands) {
      await this.controlStore.dispatch(context.runId, command);
    }
    for (const intent of staleProposedIntents) {
      await this.controlStore.dispatch(context.runId, {
        type: 'scheduler_intent',
        intent: { ...intent, status: 'STALE' },
      });
    }

    // Capacity limits creation only. Existing PROPOSED intents may still be claimed.
    if (openIntents >= this.config.maxOpenIntents && existingIntents.length === 0) {
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

    for (const intent of newIntents) {
      await this.controlStore.dispatch(context.runId, {
        type: 'scheduler_intent',
        intent,
      });
    }

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

  private async scheduleAtomically(context: SchedulingContext): Promise<Intent | null> {
    return this.controlStore.dispatchTransaction(context.runId, (snapshot) => {
      const persistedIntents = Object.values(snapshot.schedulerIntents || {});
      const currentGeneration = snapshot.generation > 0 ? snapshot.generation : context.currentGeneration;
      const recovery = this.prepareClaimRecovery(
        persistedIntents,
        snapshot.leases || {},
        currentGeneration,
        Date.now(),
      );
      const effectiveIntents = recovery.intents;
      const knowledgeVersion = this.knowledgeVersion(snapshot, context.knowledgeVersion);
      const freshnessContext = { ...context, currentGeneration, knowledgeVersion };
      const staleProposedIntents = effectiveIntents.filter(
        intent => intent.status === 'PROPOSED' && this.filter.isStale(intent, freshnessContext)
      );
      const staleProposedIds = new Set(staleProposedIntents.map(intent => intent.id));
      const existingIntents = effectiveIntents.filter(
        intent => intent.status === 'PROPOSED' && !staleProposedIds.has(intent.id)
      );
      const persistedOpenIntents = existingIntents.length + effectiveIntents.filter(
        intent => intent.status === 'CLAIMED' && intent.fixtureGeneration === currentGeneration
      ).length;
      const openIntents = persistedOpenIntents;
      const schedulingContext = {
        ...context,
        openIntents,
        currentGeneration,
        knowledgeVersion,
        occupiedResources: Object.keys(recovery.leases),
        completedIntentIds: new Set([
          ...effectiveIntents
            .filter(intent => intent.status === 'COMPLETED' && intent.fixtureGeneration === currentGeneration)
            .map(intent => intent.id),
        ]),
        completedHypothesisIds: new Set([
          ...effectiveIntents
            .filter(intent => intent.status === 'COMPLETED'
              && intent.fixtureGeneration === currentGeneration
              && intent.hypothesis)
            .map(intent => intent.hypothesis!),
        ]),
      };
      const staleCommands: DomainCommand[] = staleProposedIntents.map(intent => ({
        type: 'scheduler_intent',
        intent: { ...intent, status: 'STALE' },
      }));
      const baseCommands = [...recovery.commands, ...staleCommands];

      if (openIntents >= this.config.maxOpenIntents && existingIntents.length === 0) {
        return { commands: baseCommands, project: () => null };
      }

      const triggered = this.shouldSchedule(schedulingContext);
      if (!triggered && existingIntents.length === 0) {
        return { commands: baseCommands, project: () => null };
      }

      const remainingCapacity = Math.max(0, this.config.maxOpenIntents - openIntents);
      const generated = triggered
        ? this.generateIntents(schedulingContext, remainingCapacity)
        : [];
      const candidates = [...existingIntents, ...generated];
      const filtered = this.filter.filter(candidates, schedulingContext);
      const generatedCommands: DomainCommand[] = generated.map(intent => ({
        type: 'scheduler_intent',
        intent,
      }));
      if (filtered.length === 0) {
        return { commands: [...baseCommands, ...generatedCommands], project: () => null };
      }

      const scores = this.scorer.scoreAndRank(filtered, schedulingContext);
      for (const score of scores) {
        const candidate = candidates.find(intent => intent.id === score.intentId);
        if (!candidate) continue;
        const claimed = structuredClone(candidate);
        const leases: Lease[] = [];
        const candidateCommands: DomainCommand[] = [...baseCommands];
        let claimable = true;
        const projectedLeases = { ...recovery.leases };

        for (const resourceKey of candidate.resourceKeys) {
          const existingLease = projectedLeases[resourceKey];
          if (existingLease && Date.parse(existingLease.expiresAt) > Date.now()) {
            claimable = false;
            break;
          }
          if (existingLease) {
            candidateCommands.push({
              type: 'lease_released',
              resourceKey,
              ownerLane: existingLease.ownerLane,
              generation: existingLease.generation,
              lane: 'main',
            });
            delete projectedLeases[resourceKey];
          }
          const now = new Date().toISOString();
          const lease: Lease = {
            resourceKey,
            ownerLane: 'executor',
            generation: (snapshot.leaseEpochs?.[resourceKey] ?? existingLease?.generation ?? 0) + 1,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: new Date(Date.now() + candidate.estimatedDuration * 2).toISOString(),
          };
          projectedLeases[resourceKey] = lease;
          leases.push(lease);
        }
        if (!claimable) continue;

        claimed.status = 'CLAIMED';
        claimed.claimedAt = new Date().toISOString();
        claimed.leaseId = leases.map(lease => lease.resourceKey).join(',');
        claimed.leaseClaims = Object.fromEntries(leases.map(lease => [
          lease.resourceKey,
          { ownerLane: 'executor' as const, generation: lease.generation },
        ]));

        for (const intent of generated) {
          if (intent.id === candidate.id) continue;
          candidateCommands.push({ type: 'scheduler_intent', intent });
        }
        for (const lease of leases) candidateCommands.push({ type: 'lease_acquired', lease, lane: 'executor' });
        candidateCommands.push({ type: 'scheduler_intent', intent: claimed });

        return {
          commands: candidateCommands,
          project: (after) => after.schedulerIntents[claimed.id] ?? null,
        };
      }

      return { commands: [...baseCommands, ...generatedCommands], project: () => null };
    });
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
  private generateIntents(
    context: SchedulingContext,
    maxIntents: number,
  ): Intent[] {
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
      if (context.completedHypothesisIds?.has(hypothesisId)) continue;
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
          intent.leaseClaims = Object.fromEntries(leases.map(lease => [
            lease.resourceKey,
            { ownerLane: 'executor' as const, generation: lease.generation },
          ]));

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
    await this.transitionIntentToTerminal(runId, intentId, 'COMPLETED', intent => {
      intent.completedAt = new Date().toISOString();
      intent.producedObservations = result.producedObservations;
      intent.producedEvidence = result.producedEvidence;
      intent.producedFacts = result.producedFacts;
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
    await this.transitionIntentToTerminal(runId, intentId, 'FAILED', intent => {
      intent.completedAt = new Date().toISOString();
      intent.lastError = error;
      intent.attempts += 1;
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
    await this.transitionIntentToTerminal(runId, intentId, 'CANCELLED', intent => {
      intent.lastError = reason;
    });
  }

  // ========== Intent 生成辅助方法 ==========

  private prepareClaimRecovery(
    intents: Intent[],
    leases: RunSnapshot['leases'],
    currentGeneration: number,
    now: number,
  ): { intents: Intent[]; leases: RunSnapshot['leases']; commands: DomainCommand[] } {
    const retryableById = new Map<string, Intent>();
    const leasesToRelease = new Map<string, Lease>();

    for (const intent of intents) {
      if (intent.status !== 'CLAIMED'
        || intent.fixtureGeneration !== currentGeneration
        || intent.resourceKeys.length === 0
        || this.hasActiveClaim(intent, leases, now)) {
        continue;
      }

      const retryable = structuredClone(intent);
      retryable.status = 'PROPOSED';
      delete retryable.claimedBy;
      delete retryable.claimedAt;
      delete retryable.leaseId;
      delete retryable.leaseClaims;
      retryableById.set(retryable.id, retryable);

      const legacyResourceKeys = new Set(this.legacyLeaseResourceKeys(intent));
      for (const resourceKey of intent.resourceKeys) {
        const lease = leases[resourceKey];
        if (!lease) continue;
        const claim = intent.leaseClaims?.[resourceKey];
        const ownsLease = claim
          ? lease.ownerLane === claim.ownerLane && lease.generation === claim.generation
          : legacyResourceKeys.has(resourceKey) && lease.ownerLane === 'executor';
        if (ownsLease) leasesToRelease.set(resourceKey, lease);
      }
    }

    if (retryableById.size === 0) return { intents, leases, commands: [] };

    const projectedLeases = { ...leases };
    const commands: DomainCommand[] = [];
    for (const lease of leasesToRelease.values()) {
      delete projectedLeases[lease.resourceKey];
      commands.push({
        type: 'lease_released',
        resourceKey: lease.resourceKey,
        ownerLane: lease.ownerLane,
        generation: lease.generation,
        lane: 'main',
      });
    }
    for (const intent of retryableById.values()) {
      commands.push({ type: 'scheduler_intent', intent });
    }

    return {
      intents: intents.map(intent => retryableById.get(intent.id) ?? intent),
      leases: projectedLeases,
      commands,
    };
  }

  private hasActiveClaim(intent: Intent, leases: RunSnapshot['leases'], now: number): boolean {
    if (intent.leaseClaims) {
      return intent.resourceKeys.every(resourceKey => {
        const claim = intent.leaseClaims?.[resourceKey];
        const lease = leases[resourceKey];
        return claim !== undefined
          && lease !== undefined
          && lease.ownerLane === claim.ownerLane
          && lease.generation === claim.generation
          && Date.parse(lease.expiresAt) > now;
      });
    }

    const legacyResourceKeys = new Set(this.legacyLeaseResourceKeys(intent));
    return intent.resourceKeys.every(resourceKey => {
      const lease = leases[resourceKey];
      return legacyResourceKeys.has(resourceKey)
        && lease?.ownerLane === 'executor'
        && Date.parse(lease.expiresAt) > now;
    });
  }

  private legacyLeaseResourceKeys(intent: Intent): string[] {
    if (!intent.leaseId) return [];
    return intent.leaseId.split(',')
      .map(resourceKey => resourceKey.trim())
      .filter(resourceKey => resourceKey.length > 0 && intent.resourceKeys.includes(resourceKey));
  }

  private knowledgeVersion(snapshot: Awaited<ReturnType<ControlStore['snapshot']>>, fallback: number): number {
    const hasKnowledgeProjection = snapshot.facts !== undefined
      && snapshot.hypotheses !== undefined
      && snapshot.evidence !== undefined
      && snapshot.observations !== undefined;
    if (!hasKnowledgeProjection) return fallback;

    const versions = [
      ...Object.values(snapshot.facts || {}).map(item => item.createdSeq),
      ...Object.values(snapshot.hypotheses || {}).map(item => item.createdSeq),
      ...Object.values(snapshot.evidence || {}).map(item => item.createdSeq),
      ...Object.values(snapshot.observations || {}).map(item => item.createdSeq),
    ];
    return Math.max(0, ...versions);
  }

  private createIntentId(kind: string): string {
    return `intent-${kind}-${randomUUID()}`;
  }

  private async transitionIntentToTerminal(
    runId: string,
    intentId: string,
    targetStatus: Extract<IntentStatus, 'COMPLETED' | 'FAILED' | 'CANCELLED'>,
    update: (intent: Intent) => void,
  ): Promise<void> {
    await this.controlStore.dispatchTransaction(runId, snapshot => {
      const current = snapshot.schedulerIntents[intentId];
      if (!current) throw new Error(`Intent ${intentId} not found`);

      const currentGeneration = snapshot.generation > 0 ? snapshot.generation : current.fixtureGeneration;
      if (current.fixtureGeneration !== currentGeneration) {
        throw new Error(`Intent ${intentId} belongs to fixture generation ${current.fixtureGeneration}, current generation is ${currentGeneration}`);
      }
      if (current.status === targetStatus) {
        return { commands: [], project: () => undefined };
      }
      if (current.status !== 'CLAIMED') {
        throw new Error(`Cannot transition Intent ${intentId} from ${current.status} to ${targetStatus}`);
      }

      const intent = { ...current, status: targetStatus };
      update(intent);
      const commands: DomainCommand[] = [];
      for (const [resourceKey, claim] of Object.entries(intent.leaseClaims ?? {})) {
        const lease = snapshot.leases[resourceKey];
        if (!lease || lease.ownerLane !== claim.ownerLane || lease.generation !== claim.generation) continue;
        commands.push({
          type: 'lease_released',
          resourceKey,
          ownerLane: claim.ownerLane,
          generation: claim.generation,
          lane: claim.ownerLane,
        });
      }
      commands.push({ type: 'scheduler_intent', intent });
      return { commands, project: () => undefined };
    });
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
      id: this.createIntentId(`verify-${hypothesisId}`),
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
