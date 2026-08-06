/**
 * CLI 命令: Intent 调度器相关命令
 */

import type { IntentScheduler, ControlStore, Intent } from '@proofblade/materials';

export async function handleIntentsCommand(
  args: string[],
  scheduler: IntentScheduler,
  controlStore: ControlStore
): Promise<void> {
  const [subCommand, runId, ...rest] = args;

  switch (subCommand) {
    case 'list':
      await listIntents(runId, controlStore);
      break;

    case 'score':
      await showIntentScores(runId, scheduler, controlStore);
      break;

    case 'graph':
      await exportIntentGraph(runId, controlStore, rest[0] || 'mermaid');
      break;

    case 'claim':
      await testClaim(runId, scheduler, controlStore);
      break;

    default:
      console.error(`未知子命令: ${subCommand}`);
      console.log('用法:');
      console.log('  proofblade intents list <run-id>');
      console.log('  proofblade intents score <run-id>');
      console.log('  proofblade intents graph <run-id> [format]');
      console.log('  proofblade intents claim <run-id>');
      process.exit(1);
  }
}

async function listIntents(runId: string, controlStore: ControlStore): Promise<void> {
  console.log(`\n📋 Intent 列表 - ${runId}\n`);

  // TODO: 从 Control Store 加载 Intent
  const intents: Intent[] = []; // await controlStore.getIntents(runId);

  if (intents.length === 0) {
    console.log('暂无 Intent');
    return;
  }

  console.log('ID         | 状态      | 优先级   | 目标                          | 尝试次数');
  console.log('-----------|-----------|----------|-------------------------------|--------');

  for (const intent of intents) {
    const statusEmoji = {
      PROPOSED: '⏳',
      CLAIMED: '🔄',
      COMPLETED: '✅',
      FAILED: '❌',
      CANCELLED: '🚫',
      STALE: '⏰',
    }[intent.status] || '❓';

    console.log(`${intent.id.padEnd(10)} | ${statusEmoji} ${intent.status.padEnd(8)} | ` +
      `${String(intent.priority).padEnd(8)} | ${intent.objective.slice(0, 28).padEnd(28)} | ${intent.attempts}`
    );
  }

  const counts = intents.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\n统计:');
  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status}: ${count}`);
  }
}

async function showIntentScores(
  runId: string,
  scheduler: IntentScheduler,
  controlStore: ControlStore
): Promise<void> {
  console.log(`\n🎯 Intent 评分详情 - ${runId}\n`);

  // TODO: 加载 Intent 和上下文
  const intents: Intent[] = []; // await controlStore.getIntents(runId);
  const context: any = null; // await controlStore.getSchedulingContext(runId);

  if (!context || intents.length === 0) {
    console.log('无可评分的 Intent');
    return;
  }

  const scores = await scheduler.scoreIntents(intents, context);

  console.log('排名 | Intent ID | 总分    | 信息增益 | 成功率 | 成本   | 风险');
  console.log('-----|-----------|---------|----------|--------|--------|------');

  scores.forEach((score, index) => {
    console.log(
      `${(index + 1).toString().padStart(4)} | ` +
      `${score.intentId.padEnd(9)} | ` +
      `${score.totalScore.toFixed(2).padStart(7)} | ` +
      `${score.expectedInformationGain.toFixed(2).padStart(8)} | ` +
      `${score.successProbability.toFixed(2).padStart(6)} | ` +
      `${score.normalizedCost.toFixed(2).padStart(6)} | ` +
      `${score.environmentRisk.toFixed(2).padStart(5)}`
    );
  });

  console.log('\n评分权重配置:');
  const weights = scheduler.getScoringWeights();
  console.log(`  信息增益: ${weights.informationGain}`);
  console.log(`  成功概率: ${weights.successProbability}`);
  console.log(`  证据相关性: ${weights.evidenceRelevance}`);
  console.log(`  新颖性: ${weights.novelty}`);
  console.log(`  成本: ${weights.cost}`);
  console.log(`  环境风险: ${weights.environmentRisk}`);
  console.log(`  重复相似度: ${weights.duplicateSimilarity}`);
  console.log(`  依赖深度: ${weights.dependencyDepth}`);
}

async function exportIntentGraph(
  runId: string,
  controlStore: ControlStore,
  format: string
): Promise<void> {
  console.log(`\n📊 导出 Intent 图 - ${runId} (格式: ${format})\n`);

  // TODO: 加载 Intent 图
  const intents: Intent[] = []; // await controlStore.getIntents(runId);

  if (intents.length === 0) {
    console.log('暂无 Intent');
    return;
  }

  if (format === 'mermaid') {
    console.log('```mermaid');
    console.log('graph TB');

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

      console.log(`  ${nodeId}["${label}"]${style}`);

      // 依赖关系
      for (const depId of intent.dependencies) {
        const depNodeId = depId.replace(/-/g, '_');
        console.log(`  ${depNodeId} --> ${nodeId}`);
      }
    }

    console.log('\n  classDef proposed fill:#e3f2fd');
    console.log('  classDef claimed fill:#fff3e0');
    console.log('  classDef completed fill:#e8f5e9');
    console.log('  classDef failed fill:#ffebee');
    console.log('  classDef cancelled fill:#eeeeee');
    console.log('  classDef stale fill:#fce4ec');
    console.log('```');
  } else if (format === 'json') {
    console.log(JSON.stringify(intents, null, 2));
  } else {
    console.error(`不支持的格式: ${format}`);
    console.log('支持的格式: mermaid, json');
  }
}

async function testClaim(
  runId: string,
  scheduler: IntentScheduler,
  controlStore: ControlStore
): Promise<void> {
  console.log(`\n🔒 测试 Intent 认领 - ${runId}\n`);

  // TODO: 加载上下文
  const context: any = null; // await controlStore.getSchedulingContext(runId);

  if (!context) {
    console.log('无法加载调度上下文');
    return;
  }

  console.log('尝试调度下一个 Intent...\n');

  const claimedIntent = await scheduler.schedule(context);

  if (claimedIntent) {
    console.log('✅ 成功认领 Intent:');
    console.log(`  ID: ${claimedIntent.id}`);
    console.log(`  目标: ${claimedIntent.objective}`);
    console.log(`  优先级: ${claimedIntent.priority}`);
    console.log(`  预估成本: ${claimedIntent.estimatedCost} tokens`);
    console.log(`  Lease ID: ${claimedIntent.leaseId}`);
  } else {
    console.log('❌ 无可认领的 Intent');
    console.log('可能原因:');
    console.log('  - 不满足触发条件');
    console.log('  - 所有 Intent 被过滤');
    console.log('  - 资源全部被占用');
  }
}
