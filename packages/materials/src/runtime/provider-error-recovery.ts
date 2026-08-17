import { isRetryableAssistantError, retryAssistantCall, type AssistantMessage, type RetryPolicy } from "@earendil-works/pi-ai";

/**
 * Default bounded retries for a transient provider stream error (e.g. the
 * provider returns HTTP 200 then errors mid-body after a token or two). Kept
 * small: a healthy retry self-heals a flaky gateway, but a persistent fault
 * should surface quickly rather than stall the challenge on backoff.
 */
export const DEFAULT_PROVIDER_ERROR_RETRIES = 2;
/** Base backoff; per-attempt delay is `baseDelayMs * 2^(attempt-1)` plus the framework's jitter. */
export const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 750;

export interface ProviderErrorRetryResult {
  response: AssistantMessage;
  /** Number of retries actually attempted (0 = the first call succeeded or failed deterministically). */
  retryCount: number;
  /** True when retries were spent but the final response is still a retryable error. */
  exhausted: boolean;
}

export interface ProviderErrorRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Emitted before each retry's backoff sleep (attempt is 1-indexed). */
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void | Promise<void>;
}

/**
 * Run one assistant-producing call with bounded retry on a TRANSIENT provider
 * error, distinct from context-length recovery (which compacts and re-prompts).
 *
 * A provider can return HTTP 200 and then error mid-stream; the agent loop folds
 * that into an `AssistantMessage` with `stopReason: "error"` and ends the turn,
 * leaving the run idle with no auto-recovery. Here we re-issue the SAME input a
 * few times when the framework classifies the failure as transient
 * ({@link isRetryableAssistantError}). Aborts are terminal and never retried;
 * deterministic errors (quota/billing) fail fast so we do not burn backoff on a
 * fault that will not clear.
 *
 * The framework's {@link retryAssistantCall} owns the classify/backoff/abort
 * mechanics; this wrapper only supplies ProofBlade's default policy and reports
 * how many retries were spent so the turn projection can record it.
 */
export async function promptWithProviderErrorRetry(
  produce: () => Promise<AssistantMessage>,
  options: ProviderErrorRetryOptions = {},
): Promise<ProviderErrorRetryResult> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_PROVIDER_ERROR_RETRIES));
  const policy: RetryPolicy = {
    enabled: maxRetries > 0,
    maxRetries,
    baseDelayMs: Math.max(0, Math.floor(options.baseDelayMs ?? DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS)),
  };
  let retryCount = 0;
  const response = await retryAssistantCall(produce, policy, options.signal, {
    onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
      // `attempt` is 1-indexed and monotonically increasing, so its final value
      // equals the number of retries that were actually attempted.
      retryCount = attempt;
      await options.onRetry?.(attempt, maxAttempts, delayMs, errorMessage);
    },
  });
  // Aborts are not retryable, so a cancelled turn reports exhausted=false.
  return { response, retryCount, exhausted: isRetryableAssistantError(response) };
}
