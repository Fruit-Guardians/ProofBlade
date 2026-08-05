export interface OutputRewriteRequest {
  toolCallId: string;
  command: string;
  cwd: string;
}

export interface OutputRewriteTicket {
  requestedProvider: string;
  provider: string;
  providerVersion: string;
  applied: boolean;
  command: string;
  originalCommandHash: string;
  rewrittenCommandHash: string;
  executionEnv: Record<string, string>;
  fallbackReason?: string;
  metadata?: Record<string, unknown>;
}

export interface OutputRewriteResult {
  ticket: OutputRewriteTicket;
  rawOutput: string;
  rawCapture: "rtk-tee" | "visible-output";
  rawBytes: number;
  visibleBytes: number;
  rawTruncated: boolean;
}

/** Generic boundary between a Tool executor and a command-aware output reducer. */
export interface OutputRewritePort {
  prepare(request: OutputRewriteRequest, signal?: AbortSignal): Promise<OutputRewriteTicket>;
  finalize(ticket: OutputRewriteTicket, visibleOutput: string): Promise<OutputRewriteResult>;
}
