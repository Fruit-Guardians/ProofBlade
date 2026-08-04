export type ContextMaintenanceStage = "stable" | "notice" | "snip" | "prune" | "compact";

export interface ContextMaintenancePolicy {
  softRatio: number;
  snipRatio: number;
  compactRatio: number;
  forceRatio: number;
  targetRatio: number;
}

export interface ContextMaintenancePlan {
  stage: ContextMaintenanceStage;
  usedTokens: number;
  availableTokens: number;
  ratio: number;
  shouldSnip: boolean;
  shouldPrune: boolean;
  shouldCompact: boolean;
  forceCompact: boolean;
}

export const DEFAULT_CONTEXT_MAINTENANCE_POLICY: Readonly<ContextMaintenancePolicy> = {
  softRatio: 0.5,
  snipRatio: 0.6,
  compactRatio: 0.8,
  forceRatio: 0.9,
  targetRatio: 0.5,
};

export function planContextMaintenance(
  usedTokens: number,
  availableTokens: number,
  policy: ContextMaintenancePolicy = DEFAULT_CONTEXT_MAINTENANCE_POLICY,
): ContextMaintenancePlan {
  const normalizedAvailable = Math.max(1, Math.floor(availableTokens));
  const normalizedUsed = Math.max(0, Math.floor(usedTokens));
  const ratio = normalizedUsed / normalizedAvailable;
  const forceCompact = ratio >= policy.forceRatio;
  const shouldCompact = ratio >= policy.compactRatio;
  const shouldPrune = ratio >= policy.snipRatio;
  const shouldSnip = ratio >= policy.snipRatio;
  const stage: ContextMaintenanceStage = forceCompact
    ? "compact"
    : shouldCompact
      ? "prune"
      : shouldSnip
        ? "snip"
        : ratio >= policy.softRatio
          ? "notice"
          : "stable";
  return {
    stage,
    usedTokens: normalizedUsed,
    availableTokens: normalizedAvailable,
    ratio,
    shouldSnip,
    shouldPrune,
    shouldCompact,
    forceCompact,
  };
}
