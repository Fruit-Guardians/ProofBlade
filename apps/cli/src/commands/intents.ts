/**
 * CLI 命令: Intent 调度器相关命令
 */

import { buildSchedulingContext, type IntentScheduler, type ControlStore, type SchedulerIntent } from '@proofblade/materials';

export { buildSchedulingContext };

export async function handleIntentsCommand(
  args: string[],
  scheduler: IntentScheduler,
  controlStore: ControlStore,
  logFn: (msg: string) => void = console.log
): Promise<void> {
  const [subCommand, runId, ...rest] = args;

  if (!runId) {
    logFn('缺少 run-id 参数');
    logFn('用法:');
    logFn('  proofblade intents list <run-id>');
    logFn('  proofblade intents score <run-id>');
    logFn('  proofblade intents graph <run-id> [format]');
    logFn('  proofblade intents claim <run-id>');
    process.exit(1);
  }

  switch (subCommand) {
    case 'list':
      await listIntents(runId, controlStore, logFn);
      break;

    case 'score':
      await showIntentScores(runId, scheduler, controlStore, logFn);
      break;

    case 'graph':
      await exportIntentGraph(runId, controlStore, rest[0] || 'mermaid', logFn);
      break;

    case 'claim':
      await testClaim(runId, scheduler, controlStore, logFn);
      break;

    default:
      logFn(`未知子命令: ${subCommand}`);
      logFn('用法:');
      logFn('  proofblade intents list <run-id>');
      logFn('  proofblade intents score <run-id>');
      logFn('  proofblade intents graph <run-id> [format]');
      logFn('  proofblade intents claim <run-id>');
      process.exit(1);
  }
}

async function listIntents(runId: string, controlStore: ControlStore, logFn: (msg: string) => void = console.log): Promise<void> {
  logFn(`\n📋 Intent 列表 - ${runId}\n`);

  const snapshot = await controlStore.snapshot(runId);
  const intents: SchedulerIntent[] = Object.values(snapshot.schedulerIntents || {});

  if (intents.length === 0) {
    logFn('暂无 Intent');
    return;
  }

  logFn('ID         | 状态      | 优先级   | 目标                          | 尝试次数');
  logFn('-----------|-----------|----------|-------------------------------|--------');

  for (const intent of intents) {
    const statusEmoji = {
      PROPOSED: '⏳',
      CLAIMED: '🔄',
      COMPLETED: '✅',
      FAILED: '❌',
      CANCELLED: '🚫',
      STALE: '⏰',
    }[intent.status] || '❓';

    logFn(`${intent.id.padEnd(10)} | ${statusEmoji} ${intent.status.padEnd(8)} | ` +
      `${String(intent.priority).padEnd(8)} | ${intent.objective.slice(0, 28).padEnd(28)} | ${intent.attempts}`
    );
  }

  const counts = intents.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  logFn('\n统计:');
  for (const [status, count] of Object.entries(counts)) {
    logFn(`  ${status}: ${count}`);
  }
}

async function showIntentScores(
  runId: string,
  scheduler: IntentScheduler,
  controlStore: ControlStore,
  logFn: (msg: string) => void = console.log
): Promise<void> {
  logFn(`\n🎯 Intent 评分详情 - ${runId}\n`);

  const snapshot = await controlStore.snapshot(runId);
  const intents: SchedulerIntent[] = Object.values(snapshot.schedulerIntents || {});
  const context = buildSchedulingContext(snapshot);

  if (intents.length === 0) {
    logFn('无可评分的 Intent');
    return;
  }

  const scores = await scheduler.scoreIntents(intents, context);

  logFn('排名 | Intent ID | 总分    | 信息增益 | 成功率 | 成本   | 风险');
  logFn('-----|-----------|---------|----------|--------|--------|------');

  scores.forEach((score, index) => {
    logFn(
      `${(index + 1).toString().padStart(4)} | ` +
      `${score.intentId.padEnd(9)} | ` +
      `${score.totalScore.toFixed(2).padStart(7)} | ` +
      `${score.expectedInformationGain.toFixed(2).padStart(8)} | ` +
      `${score.successProbability.toFixed(2).padStart(6)} | ` +
      `${score.normalizedCost.toFixed(2).padStart(6)} | ` +
      `${score.environmentRisk.toFixed(2).padStart(5)}`
    );
  });

  logFn('\n评分权重配置:');
  const weights = scheduler.getScoringWeights();
  logFn(`  信息增益: ${weights.informationGain}`);
  logFn(`  成功概率: ${weights.successProbability}`);
  logFn(`  证据相关性: ${weights.evidenceRelevance}`);
  logFn(`  新颖性: ${weights.novelty}`);
  logFn(`  成本: ${weights.cost}`);
  logFn(`  环境风险: ${weights.environmentRisk}`);
  logFn(`  重复相似度: ${weights.duplicateSimilarity}`);
  logFn(`  依赖深度: ${weights.dependencyDepth}`);
}

async function exportIntentGraph(
  runId: string,
  controlStore: ControlStore,
  format: string,
  logFn: (msg: string) => void = console.log
): Promise<void> {
  const snapshot = await controlStore.snapshot(runId);
  const intents: SchedulerIntent[] = Object.values(snapshot.schedulerIntents || {});

  if (format === 'json') {
    logFn(JSON.stringify(intents, null, 2));
    return;
  }

  if (format === 'mermaid') {
      logFn(`\n📊 导出 Intent 图 - ${runId} (格式: ${format})\n`);
    if (intents.length === 0) {
      logFn('暂无 Intent');
      return;
    }

    logFn('```mermaid');
    logFn('graph TB');

    for (const intent of intents) {
      const nodeId = intent.id.replace(/-/g, '_');
      const label = intent.objective.slice(0, 30);
      const style = {
        PROPOSED: ':::proposed',
        CLAIMED: ':::claimed',
        COMPLETED: ':::completed',
        FAILED: ':::failed',
        CANCELLED: ':::cancelled',
        STALE: ':::stale',
      }[intent.status] || '';

      logFn(`  ${nodeId}["${label}"]${style}`);

      // 依赖关系
      for (const depId of intent.dependencies) {
        const depNodeId = depId.replace(/-/g, '_');
        logFn(`  ${depNodeId} --> ${nodeId}`);
      }
    }

    logFn('\n  classDef proposed fill:#e3f2fd');
    logFn('  classDef claimed fill:#fff3e0');
    logFn('  classDef completed fill:#e8f5e9');
    logFn('  classDef failed fill:#ffebee');
    logFn('  classDef cancelled fill:#eeeeee');
    logFn('  classDef stale fill:#fce4ec');
    logFn('```');
  } else {
    logFn(`不支持的格式: ${format}`);
    logFn('支持的格式: mermaid, json');
  }
}

async function testClaim(
  runId: string,
  scheduler: IntentScheduler,
  controlStore: ControlStore,
  logFn: (msg: string) => void = console.log
): Promise<void> {
  logFn(`\n🔒 测试 Intent 认领 - ${runId}\n`);

  const snapshot = await controlStore.snapshot(runId);
  const context = buildSchedulingContext(snapshot);

  logFn('尝试调度下一个 Intent...\n');

  const claimedIntent = await scheduler.schedule(context);

  if (claimedIntent) {
    logFn('✅ 成功认领 Intent:');
    logFn(`  ID: ${claimedIntent.id}`);
    logFn(`  目标: ${claimedIntent.objective}`);
    logFn(`  优先级: ${claimedIntent.priority}`);
    logFn(`  预估成本: ${claimedIntent.estimatedCost} tokens`);
    logFn(`  Lease ID: ${claimedIntent.leaseId}`);
  } else {
    logFn('❌ 无可认领的 Intent');
    logFn('可能原因:');
    logFn('  - 不满足触发条件');
    logFn('  - 所有 Intent 被过滤');
    logFn('  - 资源全部被占用');
  }
}
