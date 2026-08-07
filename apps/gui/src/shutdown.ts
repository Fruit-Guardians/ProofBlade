export interface GuiShutdownStages {
  closeData(): Promise<void>;
  closeHttp(): Promise<void>;
  closeVite(): Promise<void>;
}

export async function closeGuiResources(stages: GuiShutdownStages): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => stages.closeData()),
    Promise.resolve().then(() => stages.closeHttp()),
    Promise.resolve().then(() => stages.closeVite()),
  ]);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "ProofBlade GUI resource cleanup failed");
}
