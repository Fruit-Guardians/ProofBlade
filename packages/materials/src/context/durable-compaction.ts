import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextManifest } from "../domain/types.js";
import { estimateTokens } from "../domain/utils.js";
import { pruneAgentMessages } from "./agent-pruner.js";
import type { CheckpointService } from "./checkpoint.js";

export interface CompactionPreparationPort {
  firstKeptEntryId: string;
  tokensBefore: number;
  retainedTail: AgentMessage[];
}

export interface DurableCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  retainedTail: AgentMessage[];
  details: {
    checkpointId: string;
    artifactId: string;
    kind: "mechanical";
    retainedTailTokensBefore: number;
    retainedTailTokensAfter: number;
    droppedEntries: number;
  };
}

export interface DurableCompactionOptions {
  maxContextTokens?: number;
  targetRatio?: number;
}

export type CompactionFaultPoint = "after_checkpoint";
export type CompactionFaultInjector = (point: CompactionFaultPoint, checkpointId: string) => void | Promise<void>;

export class DurableCompactionCoordinator {
  public constructor(
    private readonly checkpointService: CheckpointService,
    private readonly injectFault?: CompactionFaultInjector,
  ) {}

  public async provide(runId: string, preparation: CompactionPreparationPort, manifest?: ContextManifest, options: DurableCompactionOptions = {}): Promise<DurableCompaction> {
    const checkpoint = await this.checkpointService.create(runId, "pi-compaction", manifest);
    await this.injectFault?.("after_checkpoint", checkpoint.checkpointId);
    const retainedTailTokensBefore = estimateTokens(JSON.stringify(preparation.retainedTail));
    const snipped = pruneAgentMessages(preparation.retainedTail, Number.MAX_SAFE_INTEGER, { mode: "snip" });
    const maxContextTokens = options.maxContextTokens === undefined ? undefined : Math.max(256, Math.floor(options.maxContextTokens));
    const targetRatio = Math.min(0.8, Math.max(0.25, options.targetRatio ?? 0.5));
    const summaryTokens = estimateTokens(checkpoint.content);
    const tailBudget = maxContextTokens === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(256, Math.floor(maxContextTokens * targetRatio) - summaryTokens);
    const retained = pruneAgentMessages(snipped.messages, tailBudget, { mode: "emergency" });
    return {
      summary: checkpoint.content,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      retainedTail: retained.messages,
      details: {
        checkpointId: checkpoint.checkpointId,
        artifactId: checkpoint.artifactId,
        kind: "mechanical",
        retainedTailTokensBefore,
        retainedTailTokensAfter: retained.estimatedTokens,
        droppedEntries: snipped.dropped.length + retained.dropped.length,
      },
    };
  }
}
