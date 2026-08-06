export interface CacheUsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CacheUsageProjection {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  inputBasis: number;
  hitRate: number;
}

export type ActiveConversationState = "running" | "stopping" | "paused" | "failed";

export function projectCacheUsage(usage: CacheUsageLike): CacheUsageProjection {
  const uncachedInput = Math.max(0, usage.input);
  const cacheRead = Math.max(0, usage.cacheRead);
  const cacheWrite = Math.max(0, usage.cacheWrite);
  const inputBasis = uncachedInput + cacheRead;
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    inputBasis,
    hitRate: inputBasis > 0 ? cacheRead / inputBasis : 0,
  };
}

export function isConversationInFlight(state: ActiveConversationState | undefined, localSending: boolean): boolean {
  return localSending || state === "running" || state === "stopping" || state === "paused";
}

export function currentModelLabel(preferredModel: string | undefined, latestResponseModel: string | undefined, fallback: string): string {
  return preferredModel?.trim() || latestResponseModel?.trim() || fallback;
}
