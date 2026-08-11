export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** Validate the filesystem-facing Run identity before deriving any Run paths. */
export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Run ID must contain only letters, numbers, dots, underscores, and hyphens");
}
