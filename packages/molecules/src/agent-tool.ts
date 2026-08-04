import type { ToolAtom } from "@proofblade/atoms";

export interface AgentTool<TParameters = unknown, TInput = unknown, TResult = unknown, TContext = unknown>
  extends ToolAtom<TParameters> {
  execute(input: TInput, context: TContext, signal?: AbortSignal): Promise<TResult>;
}

export interface ToolDefinition<TParameters = unknown, TInput = unknown, TResult = unknown, TContext = unknown>
  extends AgentTool<TParameters, TInput, TResult, TContext> {
  executionMode: "parallel" | "sequential";
}
