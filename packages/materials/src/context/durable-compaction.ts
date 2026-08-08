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
  taskAnchor?: Extract<AgentMessage, { role: "user" }>;
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
    const retainedTail = restoreTaskAnchor(preparation.retainedTail, options.taskAnchor);
    const summary = appendTaskAnchor(checkpoint.content, options.taskAnchor);
    const retainedTailTokensBefore = estimateTokens(JSON.stringify(retainedTail));
    const snipped = pruneAgentMessages(retainedTail, Number.MAX_SAFE_INTEGER, { mode: "snip" });
    const maxContextTokens = options.maxContextTokens === undefined ? undefined : Math.max(256, Math.floor(options.maxContextTokens));
    const targetRatio = Math.min(0.8, Math.max(0.25, options.targetRatio ?? 0.5));
    const summaryTokens = estimateTokens(summary);
    const tailBudget = maxContextTokens === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(256, Math.floor(maxContextTokens * targetRatio) - summaryTokens);
    const retained = pruneAgentMessages(snipped.messages, tailBudget, { mode: "emergency" });
    return {
      summary,
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

function restoreTaskAnchor(messages: AgentMessage[], taskAnchor: DurableCompactionOptions["taskAnchor"]): AgentMessage[] {
  if (!taskAnchor) return messages;
  const anchorKey = userMessageKey(taskAnchor);
  if (messages.some((message) => message.role === "user" && userMessageKey(message) === anchorKey)) return messages;
  return [structuredClone(taskAnchor), ...messages];
}

function appendTaskAnchor(summary: string, taskAnchor: DurableCompactionOptions["taskAnchor"]): string {
  const text = taskAnchorText(taskAnchor);
  if (!text) return summary;
  return `${summary.trimEnd()}\n\n## Active user request\n${text}\n`;
}

function taskAnchorText(message: DurableCompactionOptions["taskAnchor"]): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n").trim();
}

function userMessageKey(message: Extract<AgentMessage, { role: "user" }>): string {
  return JSON.stringify([message.timestamp, message.content]);
}
