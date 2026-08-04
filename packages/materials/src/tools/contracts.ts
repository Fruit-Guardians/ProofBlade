import type { ReplayPolicy } from "../domain/types.js";
import type { ToolDefinition } from "@proofblade/molecules";

export interface ProofBladeToolContract<TParameters = unknown, TInput = unknown, TResult = unknown, TContext = unknown>
  extends ToolDefinition<TParameters, TInput, TResult, TContext> {
  version: string;
  readOnly: boolean;
  sideEffect: "none" | "workspace" | "process" | "network" | "platform";
  replay: ReplayPolicy;
  outputPolicy: "inline" | "artifact" | "summary";
  evidenceKinds: string[];
}
