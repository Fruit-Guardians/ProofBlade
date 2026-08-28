import type { CompetitionApiJournal } from "./api-journal.js";
import type { CompetitionApiJournalRecord } from "./api-journal.js";

/** A non-secret request script used to drive an offline CompetitionApi replay. */
export type CompetitionApiReplayStep =
  | { operation: "listChallenges" }
  | { operation: "getChallenge"; challengeId: string }
  | { operation: "startEnvironment"; challengeId: string }
  | { operation: "inspectEnvironment"; challengeId: string; instanceId?: string; idempotencyKey?: string }
  | { operation: "submitFlag"; challengeId: string; flag: string }
  | { operation: "stopEnvironment"; challengeId: string; instanceId?: string };

export interface CompetitionApiReplayResult {
  operation: CompetitionApiJournalRecord["operation"];
  result: unknown;
}

/** Execute a caller-supplied request script against a journal, never the network. */
export async function replayCompetitionApiScript(api: Pick<CompetitionApiJournal, "listChallenges" | "getChallenge" | "startEnvironment" | "inspectEnvironment" | "submitFlag" | "stopEnvironment">, steps: readonly CompetitionApiReplayStep[]): Promise<CompetitionApiReplayResult[]> {
  const results: CompetitionApiReplayResult[] = [];
  for (const step of steps) {
    switch (step.operation) {
      case "listChallenges": results.push({ operation: step.operation, result: await api.listChallenges() }); break;
      case "getChallenge": results.push({ operation: step.operation, result: await api.getChallenge(step.challengeId) }); break;
      case "startEnvironment": results.push({ operation: step.operation, result: await api.startEnvironment(step.challengeId) }); break;
      case "inspectEnvironment": results.push({ operation: step.operation, result: await api.inspectEnvironment(step.challengeId, step.instanceId, { idempotencyKey: step.idempotencyKey }) }); break;
      case "submitFlag": results.push({ operation: step.operation, result: await api.submitFlag(step.challengeId, step.flag) }); break;
      case "stopEnvironment": results.push({ operation: step.operation, result: await api.stopEnvironment(step.challengeId, step.instanceId) }); break;
      default: throw new Error(`Unsupported competition API replay operation: ${String((step as { operation?: unknown }).operation)}`);
    }
  }
  return results;
}
