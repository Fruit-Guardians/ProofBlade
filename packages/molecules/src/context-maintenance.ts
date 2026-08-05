export type ContextMaintenanceStage = "stable" | "notice" | "snip" | "prune" | "compact";

export interface ContextMaintenancePolicy {
  softRatio: number;
  snipRatio: number;
  pruneRatio: number;
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
  softRatio: 0.55,
  snipRatio: 0.6,
  pruneRatio: 0.75,
  compactRatio: 0.8,
  forceRatio: 0.9,
  targetRatio: 0.5,
};

export function planContextMaintenance(
  usedTokens: number,
  availableTokens: number,
  policy: ContextMaintenancePolicy = DEFAULT_CONTEXT_MAINTENANCE_POLICY,
): ContextMaintenancePlan {
  validatePolicy(policy);
  const normalizedAvailable = Math.max(1, Math.floor(availableTokens));
  const normalizedUsed = Math.max(0, Math.floor(usedTokens));
  const ratio = normalizedUsed / normalizedAvailable;
  const forceCompact = ratio >= policy.forceRatio;
  const shouldCompact = ratio >= policy.compactRatio;
  const shouldPrune = ratio >= policy.pruneRatio;
  const shouldSnip = ratio >= policy.snipRatio;
  const stage: ContextMaintenanceStage = forceCompact
    ? "compact"
    : shouldCompact
      ? "compact"
      : shouldPrune
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

function validatePolicy(policy: ContextMaintenancePolicy): void {
  const ordered = [policy.targetRatio, policy.softRatio, policy.snipRatio, policy.pruneRatio, policy.compactRatio, policy.forceRatio];
  if (ordered.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Context maintenance ratios must be finite values between 0 and 1");
  if (!(policy.targetRatio < policy.softRatio
    && policy.softRatio < policy.snipRatio
    && policy.snipRatio < policy.pruneRatio
    && policy.pruneRatio < policy.compactRatio
    && policy.compactRatio < policy.forceRatio)) {
    throw new Error("Context maintenance ratios must increase from target through force");
  }
}
