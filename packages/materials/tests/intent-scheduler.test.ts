/**
 * Intent 调度器单元测试
 */

import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { IntentScheduler } from '../src/orchestration/intent-scheduler.js';
import { IntentScorer } from '../src/orchestration/intent-scorer.js';
import type { SchedulingContext, Intent } from '../src/domain/intent.js';

describe('IntentScheduler', () => {
  // Mock LeaseManager
  const mockLeaseManager = {
    tryAcquire: mock.fn(async () => ({ id: 'lease-123', expiresAt: new Date() })),
    isOccupied: mock.fn(() => false),
    release: mock.fn(async () => {}),
  } as any;

  test('shouldSchedule - 新增高价值 Fact 触发调度', () => {
    const scheduler = new IntentScheduler(mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 2,
      newHighValueFacts: 1,  // 触发条件
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), true);
  });

  test('shouldSchedule - 达到最大并发数不触发', () => {
    const scheduler = new IntentScheduler(mockLeaseManager, { maxOpenIntents: 5 });

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: [],
      hypotheses: [],
      evidence: [],
      openIntents: 5,  // 已达上限
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), false);
  });

  test('shouldSchedule - 多个触发条件同时满足', () => {
    const scheduler = new IntentScheduler(mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'EXPERIMENT',
      knowledgeVersion: 2,
      currentGeneration: 1,
      facts: ['F-001', 'F-002'],
      hypotheses: ['H-001'],
      evidence: [],
      openIntents: 0,  // Intent 归零 - 触发条件 1
      newHighValueFacts: 0,
      consecutiveFailures: 3,  // 连续失败 - 触发条件 2
      phaseBudgetUsed: 0.6,  // 预算过半 - 触发条件 3
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 5000,
        costUsd: 0.5,
        timeMs: 150000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), true);
  });

  test('getScoringWeights - 返回默认权重', () => {
    const scheduler = new IntentScheduler(mockLeaseManager);
    const weights = scheduler.getScoringWeights();

    assert.strictEqual(weights.informationGain, 2.0);
    assert.strictEqual(weights.successProbability, 1.5);
    assert.strictEqual(weights.evidenceRelevance, 1.2);
    assert.strictEqual(weights.novelty, 0.8);
    assert.strictEqual(weights.cost, -1.0);
    assert.strictEqual(weights.environmentRisk, -1.2);
    assert.strictEqual(weights.duplicateSimilarity, -1.5);
    assert.strictEqual(weights.dependencyDepth, -0.8);
  });

  test('updateScoringWeights - 更新权重配置', () => {
    const scheduler = new IntentScheduler(mockLeaseManager);

    scheduler.updateScoringWeights({
      informationGain: 3.0,
      cost: -2.0,
    });

    const weights = scheduler.getScoringWeights();
    assert.strictEqual(weights.informationGain, 3.0);
    assert.strictEqual(weights.cost, -2.0);
    assert.strictEqual(weights.successProbability, 1.5); // 其他不变
  });
});

describe('IntentScorer', () => {
  test('score - 计算总分', () => {
    const scorer = new IntentScorer();

    const intent: Intent = {
      id: 'I-001',
      status: 'PROPOSED',
      priority: 'high',
      createdAt: new Date().toISOString(),
      knowledgeVersion: 1,
      fixtureGeneration: 1,
      phase: 'RECON',
      objective: '探索新路径',
      startFromFacts: ['F-001'],
      expectedEvidence: {
        kind: 'observation',
        description: '新观察',
        minimumConfidence: 'medium',
      },
      suggestedTools: ['run_command'],
      estimatedCost: 500,
      estimatedDuration: 30000,
      resourceKeys: ['workspace:read'],
      dependencies: [],
      attempts: 0,
    };

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 2,
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    const score = scorer.score(intent, context);

    assert.strictEqual(score.intentId, 'I-001');
    assert.ok(typeof score.totalScore === 'number');
    assert.ok(score.expectedInformationGain >= 0 && score.expectedInformationGain <= 1);
    assert.ok(score.successProbability >= 0 && score.successProbability <= 1);
    assert.ok(score.details.includes('总分'));
  });

  test('scoreAndRank - 排序返回最高分在前', () => {
    const scorer = new IntentScorer();

    const intents: Intent[] = [
      {
        id: 'I-001',
        priority: 'low',
        estimatedCost: 1000,
        attempts: 2,
      } as Intent,
      {
        id: 'I-002',
        priority: 'critical',
        estimatedCost: 200,
        attempts: 0,
      } as Intent,
      {
        id: 'I-003',
        priority: 'high',
        estimatedCost: 500,
        attempts: 1,
      } as Intent,
    ];

    const context: SchedulingContext = {
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
    } as SchedulingContext;

    const ranked = scorer.scoreAndRank(intents, context);

    assert.strictEqual(ranked.length, 3);
    // 第一个应该是最高分
    assert.ok(ranked[0].totalScore >= ranked[1].totalScore);
    assert.ok(ranked[1].totalScore >= ranked[2].totalScore);
  });
});
