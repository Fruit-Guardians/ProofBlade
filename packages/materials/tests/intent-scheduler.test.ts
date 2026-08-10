/**
 * Intent 调度器单元测试
 */

import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { IntentScheduler } from '../src/orchestration/intent-scheduler.js';
import { IntentScorer } from '../src/orchestration/intent-scorer.js';
import type { SchedulingContext, Intent } from '../src/domain/intent.js';

function createTransactionalControlStore(state: any) {
  const commands: any[] = [];
  const apply = (command: any) => {
    commands.push(structuredClone(command));
    if (command.type === 'scheduler_intent') state.schedulerIntents[command.intent.id] = structuredClone(command.intent);
    if (command.type === 'lease_acquired') state.leases[command.lease.resourceKey] = structuredClone(command.lease);
    if (command.type === 'lease_released') delete state.leases[command.resourceKey];
  };
  return {
    commands,
    store: {
      snapshot: mock.fn(async () => state),
      dispatch: mock.fn(async (_runId: string, command: any) => {
        apply(command);
        return [];
      }),
      dispatchTransaction: mock.fn(async (_runId: string, prepare: any) => {
        const transaction = prepare(state);
        transaction.commands.forEach(apply);
        return transaction.project(state);
      }),
    },
  };
}

describe('IntentScheduler', () => {
  // Mock ControlStore
  const mockControlStore = {
    dispatch: mock.fn(async () => []),
    snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
  } as any;

  // Mock LeaseManager
  const mockLeaseManager = {
    acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'test', expiresAt: new Date() })),
    isOccupied: mock.fn(() => false),
    release: mock.fn(async () => {}),
  } as any;

  test('shouldSchedule - 新增高价值 Fact 触发调度', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

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
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager, { maxOpenIntents: 5 });

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

  test('schedule - an existing proposed intent can be claimed at the concurrency limit', async () => {
    const dispatch = mock.fn(async () => []);
    const snapshot = mock.fn(async () => ({
      schedulerIntents: {
        'intent-proposed': {
          id: 'intent-proposed', status: 'PROPOSED', priority: 'high', createdAt: new Date().toISOString(),
          knowledgeVersion: 1, fixtureGeneration: 1, phase: 'RECON', objective: 'Claim existing',
          startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Test', minimumConfidence: 'medium' },
          suggestedTools: [], estimatedCost: 1, estimatedDuration: 1, resourceKeys: [], dependencies: [], attempts: 0,
        },
      },
      leases: {}, facts: {}, hypotheses: {}, evidence: {}, observations: {},
    }));
    const scheduler = new IntentScheduler(
      { dispatch, snapshot } as any,
      mockLeaseManager,
      { maxOpenIntents: 1 }
    );
    const context: SchedulingContext = {
      runId: 'RUN-CONCURRENCY',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: [],
      hypotheses: [],
      evidence: [],
      openIntents: 0, // Simulate a stale context; the snapshot has one proposed Intent.
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 },
      occupiedResources: [],
    };

    const claimed = await scheduler.schedule(context);
    assert.equal(claimed?.id, 'intent-proposed');
    assert.equal(claimed?.status, 'CLAIMED');
    assert.equal(dispatch.mock.calls.length, 1);
  });

  test('schedule - generation is truncated to the remaining capacity', async () => {
    const state: any = { schedulerIntents: {}, leases: {} };
    const controlStore = {
      snapshot: mock.fn(async () => state),
      dispatch: mock.fn(async (_runId: string, command: any) => {
        state.schedulerIntents[command.intent.id] = structuredClone(command.intent);
        return [];
      }),
    };
    const leaseManager = {
      acquire: mock.fn(async (_runId: string, resourceKey: string) => ({
        resourceKey,
        ownerLane: 'executor',
        generation: 1,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      release: mock.fn(async () => {}),
    };
    const scheduler = new IntentScheduler(controlStore as any, leaseManager as any, { maxOpenIntents: 1 });

    const claimed = await scheduler.schedule({
      runId: 'RUN-CAPACITY', phase: 'RECON', knowledgeVersion: 1, currentGeneration: 1,
      facts: ['F-001'], hypotheses: ['H-001', 'H-002', 'H-003'], evidence: [], openIntents: 0,
      newHighValueFacts: 1, consecutiveFailures: 3, phaseBudgetUsed: 0.8,
      newHints: ['hint-1', 'hint-2'], verifierRejected: true,
      remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
    });

    assert.ok(claimed);
    assert.equal(Object.values(state.schedulerIntents).length, 1);
    assert.equal(Object.values(state.schedulerIntents).filter((intent: any) =>
      intent.status === 'PROPOSED' || intent.status === 'CLAIMED').length, 1);
  });

  test('schedule - generated intents have unique IDs within one cycle', async () => {
    const state: any = { schedulerIntents: {}, leases: {} };
    const controlStore = {
      snapshot: mock.fn(async () => state),
      dispatch: mock.fn(async (_runId: string, command: any) => {
        state.schedulerIntents[command.intent.id] = structuredClone(command.intent);
        return [];
      }),
    };
    const scheduler = new IntentScheduler(controlStore as any, {
      acquire: mock.fn(async (_runId: string, resourceKey: string) => ({
        resourceKey, ownerLane: 'executor', generation: 1,
        acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      release: mock.fn(async () => {}),
    } as any, { maxOpenIntents: 8 });

    await scheduler.schedule({
      runId: 'RUN-IDS', phase: 'RECON', knowledgeVersion: 1, currentGeneration: 1,
      facts: ['F-001'], hypotheses: ['H-001', 'H-002'], evidence: [], openIntents: 0,
      newHighValueFacts: 1, consecutiveFailures: 3, phaseBudgetUsed: 0.8,
      newHints: ['hint-1', 'hint-2'], verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
    });

    const ids = Object.keys(state.schedulerIntents);
    assert.equal(ids.length, 6);
    assert.equal(ids.length, new Set(ids).size);
  });

  test('schedule - proposed intents remain claimable after the first intent completes', async () => {
    const state: any = { schedulerIntents: {}, leases: {} };
    const { store: controlStore } = createTransactionalControlStore(state);
    const leaseManager = {
      acquire: mock.fn(async (_runId: string, resourceKey: string) => ({
        resourceKey, ownerLane: 'executor', generation: 1,
        acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      release: mock.fn(async () => {}),
    };
    const scheduler = new IntentScheduler(controlStore as any, leaseManager as any, { maxOpenIntents: 3 });
    const context: SchedulingContext = {
      runId: 'RUN-RECLAIM', phase: 'RECON', knowledgeVersion: 1, currentGeneration: 1,
      facts: ['F-001'], hypotheses: ['H-001', 'H-002'], evidence: [], openIntents: 0,
      newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3, newHints: [], verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
    };
    const first = await scheduler.schedule(context);
    assert.ok(first);
    await scheduler.completeIntent(context.runId, first.id, {});

    const second = await scheduler.schedule({ ...context, newHighValueFacts: 0 });
    assert.ok(second);
    assert.notEqual(second.id, first.id);
  });
  test('shouldSchedule - 多个触发条件同时满足', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

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
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);
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
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

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
        status: 'PROPOSED',
        priority: 'low',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 1',
        startFromFacts: ['F-001'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 1000,
        estimatedDuration: 30000,
        resourceKeys: [],
        dependencies: [],
        attempts: 2,
      },
      {
        id: 'I-002',
        status: 'PROPOSED',
        priority: 'critical',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 2',
        startFromFacts: ['F-002'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'high',
        },
        suggestedTools: [],
        estimatedCost: 200,
        estimatedDuration: 10000,
        resourceKeys: [],
        dependencies: [],
        attempts: 0,
      },
      {
        id: 'I-003',
        status: 'PROPOSED',
        priority: 'high',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 3',
        startFromFacts: ['F-003'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 500,
        estimatedDuration: 20000,
        resourceKeys: [],
        dependencies: [],
        attempts: 1,
      },
    ];

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001', 'F-002', 'F-003'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 0,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    const ranked = scorer.scoreAndRank(intents, context);

    assert.strictEqual(ranked.length, 3);
    // 第一个应该是最高分
    assert.ok(ranked[0].totalScore >= ranked[1].totalScore);
    assert.ok(ranked[1].totalScore >= ranked[2].totalScore);
  });
});

describe('IntentScheduler - 持久化', () => {
  test('生成和认领 Intent 都会持久化', async () => {
    const dispatchMock = mock.fn(async () => []);
    const mockControlStore = {
      dispatch: dispatchMock,
      snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
    } as any;

    const mockLeaseManager = {
      acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'test', expiresAt: new Date() })),
      release: mock.fn(async () => {}),
    } as any;

    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 1,  // 触发生成
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    await scheduler.schedule(context);

    // 验证 dispatch 被调用（生成时持久化 PROPOSED + 认领时持久化 CLAIMED）
    assert.ok(dispatchMock.mock.calls.length >= 2);

    // 验证所有调用都是 scheduler_intent 类型
    for (const call of dispatchMock.mock.calls) {
      assert.strictEqual(call.arguments[0], 'RUN-001');
      assert.strictEqual(call.arguments[1].type, 'scheduler_intent');
    }
  });

  test('认领 Intent 后持久化 CLAIMED 状态', async () => {
    const dispatchMock = mock.fn(async () => []);
    const mockControlStore = {
      dispatch: dispatchMock,
      snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
    } as any;

    const mockLeaseManager = {
      acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'workspace:read', expiresAt: new Date() })),
      release: mock.fn(async () => {}),
    } as any;

    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    const claimedIntent = await scheduler.schedule(context);

    // 验证返回了认领的 Intent
    assert.ok(claimedIntent);
    assert.strictEqual(claimedIntent.status, 'CLAIMED');
    assert.ok(claimedIntent.claimedAt);

    // 验证 dispatch 被调用至少两次（生成 + 认领）
    assert.ok(dispatchMock.mock.calls.length >= 2);

    // 验证最后一次调用是认领
    const lastCall = dispatchMock.mock.calls[dispatchMock.mock.calls.length - 1];
    assert.strictEqual(lastCall.arguments[1].type, 'scheduler_intent');
    assert.strictEqual(lastCall.arguments[1].intent.status, 'CLAIMED');
  });

  test('completeIntent 持久化 COMPLETED 状态', async () => {
    const intentId = 'intent-test-123';
    const state = {
      generation: 0,
      leases: {},
      schedulerIntents: {
        [intentId]: {
            id: intentId,
            status: 'CLAIMED',
            priority: 'high',
            createdAt: new Date().toISOString(),
            knowledgeVersion: 1,
            fixtureGeneration: 1,
            phase: 'RECON',
            objective: 'Test',
            startFromFacts: [],
            expectedEvidence: { kind: 'observation', description: 'Test', minimumConfidence: 'medium' },
            suggestedTools: [],
            estimatedCost: 500,
            estimatedDuration: 30000,
            resourceKeys: [],
            dependencies: [],
            attempts: 0,
        },
      },
    };
    const { store: mockControlStore, commands } = createTransactionalControlStore(state);

    const mockLeaseManager = {} as any;
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    await scheduler.completeIntent('RUN-001', intentId, {
      producedFacts: ['F-NEW-001'],
      producedEvidence: ['E-NEW-001'],
    });

    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].type, 'scheduler_intent');
    assert.strictEqual(commands[0].intent.status, 'COMPLETED');
    assert.ok(commands[0].intent.completedAt);
    assert.deepStrictEqual(commands[0].intent.producedFacts, ['F-NEW-001']);
  });

  test('terminal transitions release every lease owned by the Intent', async () => {
    for (const transition of ['complete', 'fail', 'cancel'] as const) {
      const intentId = `intent-${transition}`;
      const leases = {
        'workspace:read': {
          resourceKey: 'workspace:read', ownerLane: 'executor', generation: 1,
          acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        'target:read': {
          resourceKey: 'target:read', ownerLane: 'executor', generation: 1,
          acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      const intent = {
        id: intentId, status: 'CLAIMED', priority: 'high', createdAt: new Date().toISOString(),
        knowledgeVersion: 1, fixtureGeneration: 1, phase: 'RECON', objective: 'Test',
        startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Test', minimumConfidence: 'medium' },
        suggestedTools: [], estimatedCost: 1, estimatedDuration: 1,
        resourceKeys: Object.keys(leases), leaseId: Object.keys(leases).join(','),
        leaseClaims: Object.fromEntries(Object.values(leases).map(lease => [
          lease.resourceKey,
          { ownerLane: 'executor' as const, generation: lease.generation },
        ])),
        dependencies: [], attempts: 0,
      };
      const state = { generation: 0, schedulerIntents: { [intentId]: intent }, leases: { ...leases } };
      const { store, commands } = createTransactionalControlStore(state);
      const scheduler = new IntentScheduler(store as any, {} as any);

      if (transition === 'complete') await scheduler.completeIntent('RUN-LEASES', intentId, {});
      if (transition === 'fail') await scheduler.failIntent('RUN-LEASES', intentId, 'failed');
      if (transition === 'cancel') await scheduler.cancelIntent('RUN-LEASES', intentId, 'cancelled');

      assert.equal(commands.filter(command => command.type === 'lease_released').length, 2);
      assert.deepStrictEqual(state.leases, {});
    }
  });
});

describe('IntentScheduler - replay 持久化', () => {
  test('资源被占用时仍持久化一次性 Hint Intent', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-occupied-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager, { maxOpenIntents: 1 });
      const runId = 'INTENT-OCCUPIED-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Occupied resource test',
      } as any);
      const occupied = await leaseManager.acquire(runId, 'workspace:read', 'main', 30_000);

      const result = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: [], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 0, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: ['inspect this target'], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });

      const snapshot = await controlStore.snapshot(runId);
      const intents = Object.values(snapshot.schedulerIntents);
      assert.equal(result, null);
      assert.equal(intents.length, 1);
      assert.equal(intents[0].status, 'PROPOSED');
      assert.match(intents[0].objective, /inspect this target/);

      await leaseManager.release(runId, occupied);
      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: snapshot.lastSeq, currentGeneration: 1,
        facts: [], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 0, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.equal(claimed?.id, intents[0].id);
      assert.equal(claimed?.status, 'CLAIMED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('已完成验证假设不会被新调度覆盖或重复执行', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-completed-hypothesis-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-COMPLETED-HYPOTHESIS-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Completed hypothesis test',
      } as any);
      const context: SchedulingContext = {
        runId, phase: 'hypothesis', knowledgeVersion: 1, currentGeneration: 1,
        facts: [], hypotheses: ['H-001'], evidence: [], openIntents: 0,
        newHighValueFacts: 0, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      };
      const first = await scheduler.schedule(context);
      assert.ok(first);
      assert.equal(first.hypothesis, 'H-001');
      await scheduler.completeIntent(runId, first.id, {});
      const completed = (await controlStore.snapshot(runId)).schedulerIntents[first.id];
      assert.equal(completed.status, 'COMPLETED');

      const second = await scheduler.schedule(context);
      const after = await controlStore.snapshot(runId);
      assert.equal(second, null);
      assert.equal(Object.keys(after.schedulerIntents).length, 1);
      assert.equal(after.schedulerIntents[first.id].status, 'COMPLETED');
      assert.equal(after.schedulerIntents[first.id].completedAt, completed.completedAt);

      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 2 });
      const third = await scheduler.schedule({
        ...context,
        currentGeneration: 2,
        completedHypothesisIds: new Set(['H-001']),
      });
      const afterReset = await controlStore.snapshot(runId);
      assert.ok(third);
      assert.notEqual(third.id, first.id);
      assert.equal(third.hypothesis, 'H-001');
      assert.equal(third.fixtureGeneration, 2);
      assert.equal(afterReset.schedulerIntents[first.id].status, 'COMPLETED');
      assert.equal(afterReset.schedulerIntents[first.id].completedAt, completed.completedAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fixture reset 后旧 PROPOSED 变为 STALE 且不会阻止新代调度', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-stale-generation-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-STALE-GENERATION-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Stale generation test',
      } as any);
      const oldIntent: Intent = {
        id: 'intent-old-generation', status: 'PROPOSED', priority: 'high', createdAt: new Date().toISOString(),
        knowledgeVersion: 0, fixtureGeneration: 1, phase: 'reconnaissance', objective: 'Old environment work',
        startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Old evidence', minimumConfidence: 'medium' },
        suggestedTools: [], estimatedCost: 1, estimatedDuration: 1, resourceKeys: [], dependencies: [], attempts: 0,
      };
      await controlStore.dispatch(runId, { type: 'scheduler_intent', intent: oldIntent });
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 2 });

      const result = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 0, currentGeneration: 2,
        facts: [], hypotheses: ['H-NEW'], evidence: [], openIntents: 1,
        newHighValueFacts: 0, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      const snapshot = await controlStore.snapshot(runId);
      assert.ok(result);
      assert.equal(result.hypothesis, 'H-NEW');
      assert.equal(result.fixtureGeneration, 2);
      assert.equal(snapshot.schedulerIntents[oldIntent.id].status, 'STALE');
      assert.equal(Object.values(snapshot.schedulerIntents).filter(intent =>
        (intent.status === 'PROPOSED' || intent.status === 'CLAIMED')
          && intent.fixtureGeneration === 1).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('同 generation 的知识过期 PROPOSED 会原子变为 STALE 并释放容量', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-stale-knowledge-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-STALE-KNOWLEDGE-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Stale knowledge capacity test',
      } as any);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 1 });
      const oldIntent: Intent = {
        id: 'intent-old-knowledge', status: 'PROPOSED', priority: 'high', createdAt: new Date().toISOString(),
        knowledgeVersion: 1, fixtureGeneration: 1, phase: 'reconnaissance', objective: 'Outdated work',
        startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Old evidence', minimumConfidence: 'medium' },
        suggestedTools: [], estimatedCost: 1, estimatedDuration: 1, resourceKeys: [], dependencies: [], attempts: 0,
      };
      await controlStore.dispatch(runId, { type: 'scheduler_intent', intent: oldIntent });
      for (const factId of ['F-001', 'F-002', 'F-003']) {
        await controlStore.dispatch(runId, {
          type: 'fact',
          fact: { id: factId, statement: `Knowledge ${factId}`, status: 'CANDIDATE', evidenceIds: [] },
        });
      }

      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001', 'F-002', 'F-003'], hypotheses: [], evidence: [], openIntents: 1,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.ok(claimed);
      assert.notEqual(claimed.id, oldIntent.id);

      const snapshot = await controlStore.snapshot(runId);
      assert.equal(snapshot.schedulerIntents[oldIntent.id].status, 'STALE');
      assert.equal(Object.values(snapshot.schedulerIntents).filter(intent =>
        (intent.status === 'PROPOSED' || intent.status === 'CLAIMED')
          && intent.fixtureGeneration === 1).length, 1);
      assert.equal(snapshot.schedulerIntents[claimed.id].status, 'CLAIMED');

      const replayed = await new ControlStore(events).replay(runId);
      assert.equal(replayed.schedulerIntents[oldIntent.id].status, 'STALE');
      assert.equal(replayed.schedulerIntents[claimed.id].status, 'CLAIMED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('并发 schedule 清理知识过期占位时仍保持单一开放 Intent', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-stale-knowledge-concurrent-'));

    try {
      const controlStore = new ControlStore(new JsonlControlStore(join(root, 'runs')));
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-STALE-KNOWLEDGE-CONCURRENT-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Concurrent stale knowledge test',
      } as any);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 1 });
      await controlStore.dispatch(runId, {
        type: 'scheduler_intent',
        intent: {
          id: 'intent-concurrent-old-knowledge', status: 'PROPOSED', priority: 'high', createdAt: new Date().toISOString(),
          knowledgeVersion: 1, fixtureGeneration: 1, phase: 'reconnaissance', objective: 'Outdated concurrent work',
          startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Old evidence', minimumConfidence: 'medium' },
          suggestedTools: [], estimatedCost: 1, estimatedDuration: 1, resourceKeys: [], dependencies: [], attempts: 0,
        },
      });
      for (const factId of ['F-001', 'F-002', 'F-003']) {
        await controlStore.dispatch(runId, {
          type: 'fact', fact: { id: factId, statement: factId, status: 'CANDIDATE', evidenceIds: [] },
        });
      }
      const context: SchedulingContext = {
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001', 'F-002', 'F-003'], hypotheses: [], evidence: [], openIntents: 1,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      };

      const results = await Promise.all([scheduler.schedule(context), scheduler.schedule(context)]);
      assert.equal(results.filter(Boolean).length, 1);
      const snapshot = await controlStore.snapshot(runId);
      assert.equal(snapshot.schedulerIntents['intent-concurrent-old-knowledge'].status, 'STALE');
      assert.equal(Object.values(snapshot.schedulerIntents).filter(intent =>
        (intent.status === 'PROPOSED' || intent.status === 'CLAIMED')
          && intent.fixtureGeneration === 1).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fixture reset 原子失效旧 CLAIMED Intent 并释放匹配 Lease', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-reset-claimed-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-RESET-CLAIMED-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Reset claimed intent test',
      } as any);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 1 });
      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001'], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.ok(claimed);
      const beforeReset = await controlStore.snapshot(runId);
      assert.ok(Object.keys(beforeReset.leases).length > 0);
      const leaseEpochs = { ...beforeReset.leaseEpochs };

      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 2 });
      const afterReset = await controlStore.snapshot(runId);
      assert.equal(afterReset.schedulerIntents[claimed.id].status, 'STALE');
      assert.deepStrictEqual(afterReset.leases, {});
      assert.deepStrictEqual(afterReset.leaseEpochs, leaseEpochs);

      const replayed = await new ControlStore(events).replay(runId);
      assert.equal(replayed.schedulerIntents[claimed.id].status, 'STALE');
      assert.deepStrictEqual(replayed.leases, {});
      assert.deepStrictEqual(replayed.leaseEpochs, leaseEpochs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fixture reset 迁移旧 leaseId Intent、释放 Lease 并保持 replay 一致', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager, projectionHash } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-legacy-lease-reset-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const runId = 'INTENT-LEGACY-LEASE-RESET-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Legacy lease reset test',
      } as any);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 1 });
      const lease = await leaseManager.acquire(runId, 'workspace:read', 'executor', 30_000);
      const legacyIntent: Intent = {
        id: 'intent-legacy-claimed', status: 'CLAIMED', priority: 'high', createdAt: new Date().toISOString(),
        knowledgeVersion: 0, fixtureGeneration: 1, phase: 'reconnaissance', objective: 'Legacy claimed work',
        startFromFacts: [], expectedEvidence: { kind: 'observation', description: 'Legacy evidence', minimumConfidence: 'medium' },
        suggestedTools: [], estimatedCost: 1, estimatedDuration: 1, resourceKeys: ['workspace:read'],
        dependencies: [], attempts: 0, claimedAt: new Date().toISOString(), leaseId: 'workspace:read',
      };
      await controlStore.dispatch(runId, { type: 'scheduler_intent', intent: legacyIntent });

      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 2 });
      const afterReset = await controlStore.snapshot(runId);
      assert.equal(afterReset.schedulerIntents[legacyIntent.id].status, 'STALE');
      assert.deepStrictEqual(afterReset.schedulerIntents[legacyIntent.id].leaseClaims, {
        'workspace:read': { ownerLane: 'executor', generation: lease.generation },
      });
      assert.deepStrictEqual(afterReset.leases, {});
      assert.equal(afterReset.leaseEpochs['workspace:read'], lease.generation);

      const replayed = await new ControlStore(events).replay(runId);
      assert.equal(projectionHash(replayed), projectionHash(afterReset));
      assert.equal(replayed.schedulerIntents[legacyIntent.id].status, 'STALE');
      assert.deepStrictEqual(replayed.schedulerIntents[legacyIntent.id].leaseClaims, {
        'workspace:read': { ownerLane: 'executor', generation: lease.generation },
      });
      assert.deepStrictEqual(replayed.leases, {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reset 后旧 Worker 不能完成或失败已失效 Intent', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-reject-old-worker-'));

    try {
      const controlStore = new ControlStore(new JsonlControlStore(join(root, 'runs')));
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-REJECT-OLD-WORKER-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Reject old worker test',
      } as any);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 1 });
      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001'], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.ok(claimed);
      await controlStore.dispatch(runId, { type: 'fixture_reset', generation: 2 });

      await assert.rejects(() => scheduler.completeIntent(runId, claimed.id, {}), /fixture generation/);
      await assert.rejects(() => scheduler.failIntent(runId, claimed.id, 'late failure'), /fixture generation/);
      await assert.rejects(() => scheduler.cancelIntent(runId, claimed.id, 'late cancel'), /fixture generation/);
      assert.equal((await controlStore.snapshot(runId)).schedulerIntents[claimed.id].status, 'STALE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 终态转换要求 CLAIMED 且同目标重复提交幂等', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-terminal-state-'));

    try {
      const controlStore = new ControlStore(new JsonlControlStore(join(root, 'runs')));
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-TERMINAL-STATE-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Intent terminal state test',
      } as any);
      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001'], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.ok(claimed);

      await scheduler.completeIntent(runId, claimed.id, { producedFacts: ['F-FIRST'] });
      const completed = (await controlStore.snapshot(runId)).schedulerIntents[claimed.id];
      await scheduler.completeIntent(runId, claimed.id, { producedFacts: ['F-SECOND'] });
      const repeated = (await controlStore.snapshot(runId)).schedulerIntents[claimed.id];
      assert.equal(repeated.completedAt, completed.completedAt);
      assert.deepStrictEqual(repeated.producedFacts, ['F-FIRST']);

      await assert.rejects(() => scheduler.failIntent(runId, claimed.id, 'overwrite'), /from COMPLETED to FAILED/);
      await assert.rejects(() => scheduler.cancelIntent(runId, claimed.id, 'overwrite'), /from COMPLETED to CANCELLED/);
      const proposed = { ...claimed, id: 'intent-proposed-terminal-guard', status: 'PROPOSED' as const, leaseClaims: undefined };
      await controlStore.dispatch(runId, { type: 'scheduler_intent', intent: proposed });
      await assert.rejects(() => scheduler.completeIntent(runId, proposed.id, {}), /from PROPOSED to COMPLETED/);
      const final = (await controlStore.snapshot(runId)).schedulerIntents[claimed.id];
      assert.equal(final.status, 'COMPLETED');
      assert.deepStrictEqual(final.producedFacts, ['F-FIRST']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('旧 Intent 终态不会释放回收后新建的 Lease epoch', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-lease-epoch-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager, { maxOpenIntents: 1 });
      const runId = 'INTENT-LEASE-EPOCH-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Intent lease epoch test',
      } as any);
      const claimed = await scheduler.schedule({
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001'], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      });
      assert.ok(claimed);
      const oldGeneration = claimed.leaseClaims?.['workspace:read'].generation;
      assert.ok(oldGeneration);

      await leaseManager.reapExpired(runId, Date.now() + claimed.estimatedDuration * 3);
      const replacement = await leaseManager.acquire(runId, 'workspace:read', 'executor', 30_000);
      assert.ok(replacement.generation > oldGeneration);

      await scheduler.completeIntent(runId, claimed.id, {});
      const remaining = (await controlStore.snapshot(runId)).leases['workspace:read'];
      assert.equal(remaining.generation, replacement.generation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('并发 schedule 保持 maxOpenIntents 原子上限', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-concurrent-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 1 });
      const runId = 'INTENT-CONCURRENT-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Concurrent intent test',
      } as any);
      const context: SchedulingContext = {
        runId, phase: 'reconnaissance', knowledgeVersion: 1, currentGeneration: 1,
        facts: ['F-001'], hypotheses: [], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      };

      const results = await Promise.all([scheduler.schedule(context), scheduler.schedule(context)]);
      const snapshot = await controlStore.snapshot(runId);
      const open = Object.values(snapshot.schedulerIntents).filter(intent =>
        intent.status === 'PROPOSED' || intent.status === 'CLAIMED'
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(open.length, 1);
      assert.equal(open[0].status, 'CLAIMED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('剩余 PROPOSED Intent 使用知识版本而非 lastSeq 过滤', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-version-'));

    try {
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const scheduler = new IntentScheduler(controlStore, new LeaseManager(controlStore), { maxOpenIntents: 3 });
      const runId = 'INTENT-VERSION-001';
      await controlStore.createRun(runId, {
        id: runId, kind: 'fixture_evaluation', targetKind: 'web', title: 'Intent version test',
      } as any);
      await controlStore.dispatch(runId, {
        type: 'fact',
        fact: { id: 'F-001', statement: 'stable fact', status: 'CONFIRMED', evidenceIds: [] },
        lane: 'verifier',
      });
      await controlStore.dispatch(runId, {
        type: 'hypothesis',
        hypothesis: { id: 'H-001', statement: 'first route', status: 'OPEN', evidenceIds: [] },
      });
      await controlStore.dispatch(runId, {
        type: 'hypothesis',
        hypothesis: { id: 'H-002', statement: 'second route', status: 'OPEN', evidenceIds: [] },
      });
      const initial = await controlStore.snapshot(runId);
      const context: SchedulingContext = {
        runId, phase: 'reconnaissance', knowledgeVersion: initial.lastSeq, currentGeneration: 1,
        facts: ['F-001'], hypotheses: ['H-001', 'H-002'], evidence: [], openIntents: 0,
        newHighValueFacts: 1, consecutiveFailures: 0, phaseBudgetUsed: 0.3,
        newHints: [], verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1, timeMs: 300000 }, occupiedResources: [],
      };
      const first = await scheduler.schedule(context);
      assert.ok(first);
      await scheduler.completeIntent(runId, first.id, {});

      const afterCompletion = await controlStore.snapshot(runId);
      const second = await scheduler.schedule({
        ...context,
        knowledgeVersion: afterCompletion.lastSeq,
        openIntents: 0,
        newHighValueFacts: 0,
      });
      assert.ok(second);
      assert.notEqual(second.id, first.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 认领后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-replay-'));

    try {
      // 创建真实的 JsonlControlStore 和 ControlStore
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager, {
        maxOpenIntents: 8,
        maxAttemptsPerIntent: 3,
      });

      const runId = 'INTENT-REPLAY-001';

      // 创建 Run
      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent replay test',
      } as any);

      // 构建触发调度的上下文
      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1, // 触发调度
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      // 调度并认领 Intent
      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent, 'Should claim an intent');
      assert.strictEqual(claimedIntent.status, 'CLAIMED');

      // 验证持久化到 JSONL
      const snapshot1 = await controlStore.snapshot(runId);
      assert.ok(snapshot1.schedulerIntents[claimedIntent.id], 'Intent should be persisted');
      assert.strictEqual(snapshot1.schedulerIntents[claimedIntent.id].status, 'CLAIMED');

      // 创建新的 ControlStore 实例模拟进程重启
      const controlStore2 = new ControlStore(events);

      // Replay
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态保持
      assert.ok(replayed.schedulerIntents[claimedIntent.id], 'Intent should exist after replay');
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'CLAIMED',
        'Intent status should remain CLAIMED after replay'
      );
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].objective,
        claimedIntent.objective,
        'Intent objective should match after replay'
      );

      // 验证投影哈希一致性
      const { projectionHash } = await import('../src/control/reducer.js');
      const persisted = await events.loadProjection(runId);
      assert.strictEqual(
        projectionHash(replayed),
        projectionHash(persisted!),
        'Replay projection hash should match persisted projection'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 完成后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-complete-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-COMPLETE-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent complete test',
      } as any);

      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1,
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent);

      // 完成 Intent
      await scheduler.completeIntent(runId, claimedIntent.id, {
        producedFacts: ['F-NEW-001'],
        producedEvidence: ['E-NEW-001'],
      });

      // 验证完成状态持久化
      const snapshot = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].status, 'COMPLETED');
      assert.ok(snapshot.schedulerIntents[claimedIntent.id].completedAt);
      assert.deepStrictEqual(Object.keys(snapshot.leases), []);

      // Replay
      const controlStore2 = new ControlStore(events);
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'COMPLETED',
        'Intent should remain COMPLETED after replay'
      );
      assert.ok(
        replayed.schedulerIntents[claimedIntent.id].completedAt,
        'completedAt should be preserved'
      );
      assert.deepStrictEqual(
        replayed.schedulerIntents[claimedIntent.id].producedFacts,
        ['F-NEW-001'],
        'producedFacts should be preserved'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('schedule 能够认领已存在的 PROPOSED Intent', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-existing-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-EXISTING-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Existing intent test',
      } as any);

      // 手动创建一个 PROPOSED Intent
      const proposedIntent: Intent = {
        id: 'INTENT-MANUAL-001',
        status: 'PROPOSED',
        priority: 'high',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'reconnaissance',
        objective: 'Manually created intent',
        startFromFacts: ['F-001'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test evidence',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 500,
        estimatedDuration: 30000,
        resourceKeys: [],
        dependencies: [],
        attempts: 0,
      };

      await controlStore.dispatch(runId, {
        type: 'scheduler_intent',
        intent: proposedIntent,
      });

      // 验证 PROPOSED Intent 已持久化
      const snapshot1 = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot1.schedulerIntents[proposedIntent.id].status, 'PROPOSED');

      // 构建上下文（无新 Fact，但 openIntents === 0 应该触发）
      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0, // 触发条件：Intent 归零
        newHighValueFacts: 0, // 无新 Fact
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      // 调用 schedule，应该认领已存在的 PROPOSED Intent
      const claimedIntent = await scheduler.schedule(context);

      assert.ok(claimedIntent, 'Should claim the existing PROPOSED intent');
      assert.strictEqual(claimedIntent.id, proposedIntent.id);
      assert.strictEqual(claimedIntent.status, 'CLAIMED');

      // 验证状态更新
      const snapshot2 = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot2.schedulerIntents[proposedIntent.id].status, 'CLAIMED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 失败后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-failed-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-FAILED-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent failed test',
      } as any);

      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1,
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent);

      // 标记 Intent 失败
      await scheduler.failIntent(runId, claimedIntent.id, 'Test failure reason');

      // 验证失败状态持久化
      const snapshot = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].status, 'FAILED');
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].lastError, 'Test failure reason');
      assert.deepStrictEqual(Object.keys(snapshot.leases), []);

      // Replay
      const controlStore2 = new ControlStore(events);
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'FAILED',
        'Intent should remain FAILED after replay'
      );
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].lastError,
        'Test failure reason',
        'lastError should be preserved'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
