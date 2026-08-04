import type { ArtifactAtom, ToolErrorAtom, ToolErrorPhaseAtom, ToolFailureAtom } from "@proofblade/atoms";
import { canonicalJson, redactSecrets, sha256 } from "../domain/utils.js";

export interface ToolErrorOptions<TArtifactRef = ArtifactAtom & { id?: string }> {
  code: string;
  message: string;
  retryable?: boolean;
  phase?: ToolErrorPhaseAtom;
  partialArtifactRef?: TArtifactRef;
  nextHint?: string;
  cause?: unknown;
}

export class ProofBladeToolError<TArtifactRef = ArtifactAtom & { id?: string }> extends Error {
  public readonly details: ToolErrorAtom<TArtifactRef>;

  public constructor(options: ToolErrorOptions<TArtifactRef>) {
    const message = safeMessage(options.message);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProofBladeToolError";
    const phase = options.phase ?? "execute";
    this.details = {
      code: options.code,
      message,
      retryable: options.retryable ?? false,
      signature: errorSignature(options.code, phase, message),
      phase,
      ...(options.partialArtifactRef ? { partial_artifact_ref: options.partialArtifactRef } : {}),
      ...(options.nextHint ? { next_hint: options.nextHint } : {}),
    };
  }
}

export function toToolFailure(error: unknown): ToolFailureAtom {
  if (error instanceof ProofBladeToolError) return { ok: false, error: error.details };
  const message = safeMessage(error instanceof Error ? error.message : String(error));
  const classified = classifyError(error, message);
  return {
    ok: false,
    error: {
      ...classified,
      message,
      signature: errorSignature(classified.code, classified.phase, message),
    },
  };
}

function classifyError(error: unknown, message: string): Pick<ToolErrorAtom, "code" | "retryable" | "phase" | "next_hint"> {
  if ((error instanceof Error && error.name === "AbortError") || /\babort(?:ed)?\b/i.test(message)) {
    return { code: "TOOL_ABORTED", retryable: true, phase: "execute", next_hint: "Retry only if the run is still active and the operation is replayable." };
  }
  if (/\btimeout|timed out\b/i.test(message)) {
    return { code: "TOOL_TIMEOUT", retryable: true, phase: "execute", next_hint: "Retry with a bounded scope or use a background job." };
  }
  if (/\bunknown\b.*\b(?:tool|capability|operation|job|skill|artifact)\b|\bnot found\b/i.test(message)) {
    return { code: "TOOL_NOT_FOUND", retryable: false, phase: "preflight", next_hint: "Refresh the relevant catalog or status before choosing an id." };
  }
  if (/\binvalid\b|\brequired\b|\bmust\b|\bexpected\b/i.test(message)) {
    return { code: "BAD_TOOL_ARGS", retryable: false, phase: "validate", next_hint: "Inspect the tool schema and submit corrected arguments." };
  }
  if (/\bpermission\b|\bdenied\b|\boutside\b.*\bscope\b/i.test(message)) {
    return { code: "PERMISSION_DENIED", retryable: false, phase: "preflight", next_hint: "Use a resource inside the task scope." };
  }
  return { code: "TOOL_EXECUTION_FAILED", retryable: false, phase: "execute", next_hint: "Inspect the error signature and existing artifacts before choosing a different action." };
}

function safeMessage(message: string): string {
  return redactSecrets(message)
    .replace(/(?:PB|FLAG)\{[^}\r\n]+\}/g, "[REDACTED_CANDIDATE]")
    .slice(0, 2_000);
}

function errorSignature(code: string, phase: ToolErrorPhaseAtom, message: string): string {
  return sha256(canonicalJson({ code, phase, message: message.toLowerCase().replace(/\b\d+\b/g, "#") }));
}
