import { canonicalJson, estimateTokens, sha256 } from "@proofblade/atoms";

export interface ProviderPrefixShape {
  version: 1;
  rewriteVersion: number;
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  instructionMessageCount: number;
  toolCount: number;
  systemTokens: number;
  toolSchemaTokens: number;
}

export interface ProviderPrefixComparison {
  changed: boolean;
  reasons: Array<"system" | "tools" | "rewrite">;
}

/**
 * Capture only the provider-visible stable prefix. Conversation messages are
 * deliberately excluded so diagnostics never persist prompt text or secrets.
 */
export function captureProviderPrefixShape(payload: unknown, rewriteVersion = 1): ProviderPrefixShape {
  const body = record(payload);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions = messages.filter((message) => {
    const role = record(message).role;
    return role === "system" || role === "developer";
  });
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const systemJson = canonicalJson(instructions);
  const toolsJson = canonicalJson(tools);
  return {
    version: 1,
    rewriteVersion,
    prefixHash: sha256(canonicalJson({ rewriteVersion, instructions, tools })),
    systemHash: sha256(systemJson),
    toolsHash: sha256(toolsJson),
    instructionMessageCount: instructions.length,
    toolCount: tools.length,
    systemTokens: estimateTokens(systemJson),
    toolSchemaTokens: estimateTokens(toolsJson),
  };
}

export function compareProviderPrefixShapes(previous: ProviderPrefixShape, current: ProviderPrefixShape): ProviderPrefixComparison {
  const reasons: ProviderPrefixComparison["reasons"] = [];
  if (previous.systemHash !== current.systemHash) reasons.push("system");
  if (previous.toolsHash !== current.toolsHash) reasons.push("tools");
  if (previous.rewriteVersion !== current.rewriteVersion) reasons.push("rewrite");
  return { changed: reasons.length > 0, reasons };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
