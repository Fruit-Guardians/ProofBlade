import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextManifest } from "../domain/types.js";
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
  };
}

export type CompactionFaultPoint = "after_checkpoint";
export type CompactionFaultInjector = (point: CompactionFaultPoint, checkpointId: string) => void | Promise<void>;

export class DurableCompactionCoordinator {
  public constructor(
    private readonly checkpointService: CheckpointService,
    private readonly injectFault?: CompactionFaultInjector,
  ) {}

  public async provide(runId: string, preparation: CompactionPreparationPort, manifest?: ContextManifest): Promise<DurableCompaction> {
    const checkpoint = await this.checkpointService.create(runId, "pi-compaction", manifest);
    await this.injectFault?.("after_checkpoint", checkpoint.checkpointId);
    return {
      summary: checkpoint.content,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      retainedTail: preparation.retainedTail,
      details: { checkpointId: checkpoint.checkpointId, artifactId: checkpoint.artifactId, kind: "mechanical" },
    };
  }
}
