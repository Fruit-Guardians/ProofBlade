import type { AgentHarness, AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { captureProviderPrefixShape, type ProviderPrefixShape } from "@proofblade/molecules";
import type { ControlStore } from "../control/control-store.js";
import type { ContextManifest, Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { solverToolContractSnapshot } from "../runtime/solver-tools.js";
import { toToolFailure } from "../tools/errors.js";
import type { ProviderRequestCancelInfo, ProviderRequestQueueInfo, ProviderRequestSchedulingObserver, ProviderRequestStartInfo } from "../runtime/provider-scheduler.js";

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
  scheduling?: ProviderSchedulingTelemetry;
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
  cachePrefix?: ProviderPrefixShape;
  responseStatus?: number;
  api: string;
  retryLimit: number;
  cacheRetention: string;
}

/** Correlates Pi's pre-request hook with the scheduler's later slot grant. */
export class ProviderSchedulingTelemetry {
  private readonly waiting = new Map<string, PendingProvider[]>();
  private readonly requests = new Map<string, PendingProvider>();
  private readonly cancelled = new Set<string>();

  public constructor(private readonly options: Pick<PiObservabilityOptions, "runId" | "lane" | "controlStore">) {}

  public readonly observer: ProviderRequestSchedulingObserver = {
    queued: async (info) => await this.queued(info),
    started: async (requestId, info) => await this.started(requestId, info),
    cancelled: async (requestId, info) => await this.cancelledRequest(requestId, info),
    payload: async (requestId, payload) => await this.payload(requestId, payload),
    response: async (requestId, response) => await this.response(requestId, response),
    completed: async (requestId, message) => await this.completed(requestId, message),
  };

  public register(pending: PendingProvider): void {
    const key = providerKey(pending.provider, pending.model);
    const waiting = this.waiting.get(key) ?? [];
    waiting.push(pending);
    this.waiting.set(key, waiting);
  }

  public isCancelled(requestId: string | undefined): boolean {
    return requestId !== undefined && this.cancelled.has(requestId);
  }

  private async queued(info: ProviderRequestQueueInfo): Promise<string> {
    const pending = this.waiting.get(providerKey(info.provider, info.model))?.shift();
    const requestId = pending?.requestId ?? id("PR");
    if (pending) this.requests.set(requestId, pending);
    await append(this.options, "provider_request_queued", "orchestrator", { requestId, provider: info.provider, model: info.model, maxConcurrentRequests: info.maxConcurrentRequests, queueDepth: info.queueDepth });
    return requestId;
  }

  private async started(requestId: string | undefined, info: ProviderRequestStartInfo): Promise<void> {
    const pending = requestId ? this.requests.get(requestId) : undefined;
    if (pending) pending.startedAt = Date.now();
    await append(this.options, "provider_request_slot_acquired", "orchestrator", { requestId, provider: info.provider, model: info.model, maxConcurrentRequests: info.maxConcurrentRequests, queueDepth: info.queueDepth, waitMs: info.waitMs });
    await append(this.options, "provider_request_started", "model", {
      requestId,
      provider: info.provider,
      model: info.model,
      ...(pending ? {
        api: pending.api,
        phase: pending.phase,
        contextEstimatedTokens: pending.contextEstimatedTokens,
        contextManifestHash: pending.contextManifestHash,
        contextCache: pending.contextCache,
        retryLimit: pending.retryLimit,
        cacheRetention: pending.cacheRetention,
      } : {}),
    });
  }

  private async cancelledRequest(requestId: string | undefined, info: ProviderRequestCancelInfo): Promise<void> {
    if (requestId) this.cancelled.add(requestId);
    await append(this.options, "provider_request_queue_cancelled", "orchestrator", { requestId, provider: info.provider, model: info.model, maxConcurrentRequests: info.maxConcurrentRequests, queueDepth: info.queueDepth, waitMs: info.waitMs, reason: info.reason });
    if (requestId) this.requests.delete(requestId);
  }

  private async payload(requestId: string | undefined, payload: unknown): Promise<void> {
    const pending = requestId ? this.requests.get(requestId) : undefined;
    if (pending) pending.cachePrefix = captureProviderPrefixShape(payload);
  }

  private async response(requestId: string | undefined, response: { status: number; headers: Record<string, string> }): Promise<void> {
    const pending = requestId ? this.requests.get(requestId) : undefined;
    if (pending) pending.responseStatus = response.status;
    await append(this.options, "provider_response_received", "model", {
      requestId,
      status: response.status,
      headerNames: Object.keys(response.headers).map((name) => name.toLowerCase()).sort(),
      responseHeaderCount: Object.keys(response.headers).length,
    });
  }

  private async completed(requestId: string | undefined, message: AssistantMessage): Promise<void> {
    const pending = requestId ? this.requests.get(requestId) : undefined;
    await append(this.options, "model_usage", "model", {
      requestId,
      provider: message.provider,
      model: message.model,
      phase: pending?.phase ?? (await this.options.controlStore.snapshot(this.options.runId)).phase,
      durationMs: pending ? Date.now() - pending.startedAt : undefined,
      httpStatus: pending?.responseStatus,
      finishReason: message.stopReason,
      toolCallCount: message.content.filter((item) => item.type === "toolCall").length,
      contextEstimatedTokens: pending?.contextEstimatedTokens,
      contextManifestHash: pending?.contextManifestHash,
      contextCache: pending?.contextCache,
      cachePrefix: pending?.cachePrefix,
      queueCancelled: this.isCancelled(requestId),
      usage: message.usage,
    });
    if (requestId) {
      this.requests.delete(requestId);
      this.cancelled.delete(requestId);
    }
  }
}

export function createProviderSchedulingTelemetry(options: Pick<PiObservabilityOptions, "runId" | "lane" | "controlStore">): ProviderSchedulingTelemetry {
  return new ProviderSchedulingTelemetry(options);
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
      api: event.model.api,
      retryLimit: event.streamOptions.maxRetries ?? 0,
      cacheRetention: event.streamOptions.cacheRetention ?? "short",
    };
    if (options.scheduling) options.scheduling.register(pending);
    else {
      providers.push(pending);
      await append(options, "provider_request_started", "model", {
      requestId: pending.requestId,
      provider: pending.provider,
      model: pending.model,
      api: pending.api,
      phase: pending.phase,
      contextEstimatedTokens: pending.contextEstimatedTokens,
      contextManifestHash: pending.contextManifestHash,
      contextCache: pending.contextCache,
      retryLimit: pending.retryLimit,
      cacheRetention: pending.cacheRetention,
      });
    }
    return undefined;
  });
  const unsubscribeAfter = options.scheduling ? undefined : harness.on("after_provider_response", async (event) => {
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
  const unsubscribePayload = options.scheduling ? undefined : harness.on("before_provider_payload", async (event) => {
    const pending = providers.find((item) => item.responseStatus === undefined);
    if (pending) pending.cachePrefix = captureProviderPrefixShape(event.payload);
    return undefined;
  });
  const unsubscribeEvents = harness.subscribe(async (event) => {
    if (!options.scheduling && event.type === "message_end" && isAssistantMessage(event.message)) {
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
        cachePrefix: pending?.cachePrefix,
        queueCancelled: false,
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
    unsubscribePayload?.();
    unsubscribeAfter?.();
    unsubscribeBefore();
  };
}

function append(options: PiObservabilityOptions, type: "provider_request_started" | "provider_request_queued" | "provider_request_slot_acquired" | "provider_request_queue_cancelled" | "provider_response_received" | "tool_call_recorded" | "tool_result_recorded" | "compaction_recorded" | "model_usage", actor: "model" | "tool" | "orchestrator", payload: Record<string, unknown>): Promise<void> {
  return options.controlStore.append(options.runId, [{ schemaVersion: 1, lane: options.lane, correlationId: `${options.runId}:${options.lane}:telemetry`, actor, type, payload }]);
}

function providerKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
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
