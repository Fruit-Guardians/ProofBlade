import type { AgentHarness, AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { ContextManifest, Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { solverToolContractSnapshot } from "../runtime/solver-tools.js";
import { toToolFailure } from "../tools/errors.js";

export interface PiObservabilityOptions {
  runId: string;
  lane: Lane;
  controlStore: ControlStore;
  estimateContextTokens?: () => Promise<number>;
  getContextSnapshot?: () => Promise<{
    estimatedTokens?: number;
    manifestHash?: string;
    cache?: ContextManifest["cache"];
  } | undefined>;
}

interface PendingProvider {
  requestId: string;
  startedAt: number;
  phase: string;
  provider: string;
  model: string;
  contextEstimatedTokens?: number;
  contextManifestHash?: string;
  contextCache?: ContextManifest["cache"];
  responseStatus?: number;
}

interface PendingTool {
  scheduledAt: number;
  startedAt?: number;
  argsHash: string;
}

const toolPolicies = new Map(solverToolContractSnapshot().map((contract) => [String(contract.name), contract]));

export function attachPiObservability<TContext extends object | undefined>(harness: AgentHarness<TContext>, options: PiObservabilityOptions): () => void {
  const providers: PendingProvider[] = [];
  const tools = new Map<string, PendingTool>();
  const unsubscribeBefore = harness.on("before_provider_request", async (event) => {
    const snapshot = await options.controlStore.snapshot(options.runId);
    const context = await options.getContextSnapshot?.();
    const pending: PendingProvider = {
      requestId: id("PR"),
      startedAt: Date.now(),
      phase: snapshot.phase,
      provider: event.model.provider,
      model: event.model.id,
      ...(context?.estimatedTokens !== undefined
        ? { contextEstimatedTokens: context.estimatedTokens }
        : options.estimateContextTokens
          ? { contextEstimatedTokens: await options.estimateContextTokens() }
          : {}),
      ...(context?.manifestHash ? { contextManifestHash: context.manifestHash } : {}),
      ...(context?.cache ? { contextCache: context.cache } : {}),
    };
    providers.push(pending);
    await append(options, "provider_request_started", "model", {
      requestId: pending.requestId,
      provider: pending.provider,
      model: pending.model,
      api: event.model.api,
      phase: pending.phase,
      contextEstimatedTokens: pending.contextEstimatedTokens,
      contextManifestHash: pending.contextManifestHash,
      contextCache: pending.contextCache,
      retryLimit: event.streamOptions.maxRetries ?? 0,
      cacheRetention: event.streamOptions.cacheRetention ?? "short",
    });
    return undefined;
  });
  const unsubscribeAfter = harness.on("after_provider_response", async (event) => {
    const pending = providers.find((item) => item.responseStatus === undefined);
    if (!pending) return undefined;
    pending.responseStatus = event.status;
    await append(options, "provider_response_received", "model", {
      requestId: pending.requestId,
      status: event.status,
      headerNames: Object.keys(event.headers).map((name) => name.toLowerCase()).sort(),
      responseHeaderCount: Object.keys(event.headers).length,
    });
    return undefined;
  });
  const unsubscribeEvents = harness.subscribe(async (event) => {
    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const pending = providers.shift();
      const message = event.message;
      await append(options, "model_usage", "model", {
        requestId: pending?.requestId,
        provider: message.provider,
        model: message.model,
        phase: pending?.phase ?? (await options.controlStore.snapshot(options.runId)).phase,
        durationMs: pending ? Date.now() - pending.startedAt : undefined,
        httpStatus: pending?.responseStatus,
        finishReason: message.stopReason,
        toolCallCount: message.content.filter((item) => item.type === "toolCall").length,
        contextEstimatedTokens: pending?.contextEstimatedTokens,
        contextManifestHash: pending?.contextManifestHash,
        contextCache: pending?.contextCache,
        usage: message.usage,
      });
      return;
    }
    if (event.type === "tool_call") {
      tools.set(event.toolCallId, { scheduledAt: Date.now(), argsHash: sha256(canonicalJson(event.input)) });
      return;
    }
    if (event.type === "tool_execution_start") {
      const existing = tools.get(event.toolCallId) ?? { scheduledAt: Date.now(), argsHash: sha256(canonicalJson(event.args ?? {})) };
      existing.startedAt = Date.now();
      tools.set(event.toolCallId, existing);
      const policy = toolPolicies.get(event.toolName);
      await append(options, "tool_call_recorded", "model", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsHash: existing.argsHash,
        waitMs: existing.startedAt - existing.scheduledAt,
        executionMode: policy?.executionMode ?? "sequential",
        sensitivity: policy?.sensitivity ?? "target",
        timeoutMs: policy?.timeoutMs,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const pending = tools.get(event.toolCallId);
      tools.delete(event.toolCallId);
      const details = toolResultDetails(event.result);
      const snapshot = await options.controlStore.snapshot(options.runId);
      const artifactIds = collectStringRefs(details, "artifact");
      const evidenceIds = collectStringRefs(details, "evidence");
      const errorSignature = event.isError ? structuredErrorSignature(details) : undefined;
      await append(options, "tool_result_recorded", "tool", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: pending?.startedAt ? Date.now() - pending.startedAt : undefined,
        outputBytes: byteLength(event.result),
        isError: event.isError,
        errorSignature,
        artifactHashes: artifactIds.map((artifactId) => snapshot.artifacts[artifactId]?.sha256).filter((hash): hash is string => Boolean(hash)),
        evidenceAdded: evidenceIds.some((evidenceId) => Boolean(snapshot.evidence[evidenceId])),
      });
      return;
    }
    if (event.type === "session_compact") {
      await append(options, "compaction_recorded", "orchestrator", {
        fromHook: event.fromHook,
        entryId: event.compactionEntry.id,
        tokensBefore: event.compactionEntry.tokensBefore,
      });
    }
  });
  return () => {
    unsubscribeEvents();
    unsubscribeAfter();
    unsubscribeBefore();
  };
}

function append(options: PiObservabilityOptions, type: "provider_request_started" | "provider_response_received" | "tool_call_recorded" | "tool_result_recorded" | "compaction_recorded" | "model_usage", actor: "model" | "tool" | "orchestrator", payload: Record<string, unknown>): Promise<void> {
  return options.controlStore.append(options.runId, [{ schemaVersion: 1, lane: options.lane, correlationId: `${options.runId}:${options.lane}:telemetry`, actor, type, payload }]);
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return Boolean(message && typeof message === "object" && (message as { role?: string }).role === "assistant" && "usage" in message);
}

function toolResultDetails(result: unknown): unknown {
  return result && typeof result === "object" && "details" in result ? (result as { details?: unknown }).details : result;
}

function collectStringRefs(value: unknown, prefix: "artifact" | "evidence"): string[] {
  const refs = new Set<string>();
  const visit = (current: unknown, key = ""): void => {
    if (typeof current === "string" && (key.toLowerCase() === `${prefix}id` || key.toLowerCase() === `${prefix}_id`)) refs.add(current);
    else if (Array.isArray(current)) current.forEach((item) => visit(item, key));
    else if (current && typeof current === "object") Object.entries(current as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
  return [...refs].sort();
}

function structuredErrorSignature(details: unknown): string {
  if (details && typeof details === "object") {
    const error = (details as { error?: unknown }).error;
    if (error && typeof error === "object" && typeof (error as { signature?: unknown }).signature === "string") return (error as { signature: string }).signature;
  }
  return toToolFailure(new Error("Pi tool execution returned an error result")).error.signature;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(canonicalJson(value));
  } catch {
    return 0;
  }
}
