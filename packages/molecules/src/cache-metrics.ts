export interface PromptCacheUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export function cacheInputTokens(usage: PromptCacheUsage): number {
  return Math.max(0, usage.input) + Math.max(0, usage.cacheRead);
}

export function cacheHitRate(usage: PromptCacheUsage): number {
  const basis = cacheInputTokens(usage);
  return basis > 0 ? usage.cacheRead / basis : 0;
}

export function cacheWriteRate(usage: PromptCacheUsage): number {
  const basis = cacheInputTokens(usage);
  return basis > 0 ? usage.cacheWrite / basis : 0;
}
