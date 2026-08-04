import { canonicalJson, estimateTokens, sha256, type MessageAtom } from "@proofblade/atoms";

export interface ContextLayer {
  id: string;
  content: string;
  required: boolean;
}

export interface LayeredContext {
  messages: Array<MessageAtom<"system" | "user", string>>;
  layerTokens: Record<string, number>;
  estimatedTokens: number;
  hash: string;
}

export function compileContextLayers(layers: readonly ContextLayer[]): LayeredContext {
  const layerTokens = Object.fromEntries(layers.map((layer) => [layer.id, estimateTokens(layer.content)]));
  const estimatedTokens = Object.values(layerTokens).reduce((sum, value) => sum + value, 0);
  const messages = layers.map((layer, index) => ({ role: index === 0 ? "system" as const : "user" as const, content: layer.content }));
  return { messages, layerTokens, estimatedTokens, hash: sha256(canonicalJson({ layers, layerTokens })) };
}
