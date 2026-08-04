import type { ReplayPolicy } from "../domain/types.js";
import type { ToolDefinition } from "@proofblade/molecules";
import type { ToolSensitivityAtom, ToolSideEffectAtom, ToolOutputPolicyAtom } from "@proofblade/atoms";

export interface ProofBladeToolContract<TParameters = unknown, TInput = unknown, TResult = unknown, TContext = unknown>
  extends ToolDefinition<TParameters, TInput, TResult, TContext> {
  version: string;
  readOnly: boolean;
  sideEffect: ToolSideEffectAtom;
  timeoutMs: number;
  replay: ReplayPolicy;
  outputPolicy: ToolOutputPolicyAtom;
  resourceKeys: string[];
  sensitivity: ToolSensitivityAtom;
  evidenceKinds: string[];
}
