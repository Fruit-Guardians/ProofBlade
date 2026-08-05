import { canonicalJson, estimateTokens, sha256 } from "@proofblade/atoms";

export interface PromptCacheLayer {
  id: string;
  content: string;
  stablePrefix: boolean;
}

export interface PromptCacheMetadata {
  strategy: "stable-prefix";
  prefixHash: string;
  dynamicHash: string;
  prefixLayerIds: string[];
  dynamicLayerIds: string[];
  prefixTokens: number;
  dynamicTokens: number;
}

/**
 * Fingerprint the provider-facing prompt as a stable prefix plus a changing tail.
 * Stable layers must be contiguous and come before dynamic layers so providers
 * can reuse their prefix cache without guessing which messages changed.
 */
export function buildPromptCacheMetadata(layers: readonly PromptCacheLayer[]): PromptCacheMetadata {
  const prefix: PromptCacheLayer[] = [];
  const dynamic: PromptCacheLayer[] = [];
  let dynamicStarted = false;
  for (const layer of layers) {
    if (layer.stablePrefix && dynamicStarted) {
      throw new Error(`Prompt cache stable prefix is not contiguous at layer ${layer.id}`);
    }
    if (layer.stablePrefix) prefix.push(layer);
    else {
      dynamicStarted = true;
      dynamic.push(layer);
    }
  }
  return {
    strategy: "stable-prefix",
    prefixHash: sha256(canonicalJson(prefix.map(({ id, content }) => ({ id, content })))),
    dynamicHash: sha256(canonicalJson(dynamic.map(({ id, content }) => ({ id, content })))),
    prefixLayerIds: prefix.map((layer) => layer.id),
    dynamicLayerIds: dynamic.map((layer) => layer.id),
    prefixTokens: prefix.reduce((sum, layer) => sum + estimateTokens(layer.content), 0),
    dynamicTokens: dynamic.reduce((sum, layer) => sum + estimateTokens(layer.content), 0),
  };
}
