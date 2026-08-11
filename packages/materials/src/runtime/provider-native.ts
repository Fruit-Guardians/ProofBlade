import type { ModelProfileConfig, ProviderApi } from "../config.js";

/**
 * A provider-side feature that is known from the selected wire protocol. This
 * is deliberately separate from CapabilityBackend: provider-side tools run
 * inside a model request and cannot be treated as a durable Effect until an
 * adapter captures their inputs, outputs, and policy decisions.
 */
export interface ProviderNativeCapabilityStatus {
  id: string;
  label: string;
  semanticId: string;
  provider: string;
  api: ProviderApi;
  state: "candidate" | "suppressed";
  reason: string;
  managedBy?: string;
}

export interface ManagedToolSemantic {
  semanticId: string;
  owner: string;
}

const managedToolSemantics: readonly ManagedToolSemantic[] = [
  { semanticId: "workspace.read", owner: "read" },
  { semanticId: "workspace.execute", owner: "bash" },
  { semanticId: "workspace.write", owner: "write/edit" },
];

interface NativeCapabilityDefinition {
  id: string;
  label: string;
  semanticId: string;
}

const nativeByApi: Readonly<Record<ProviderApi, readonly NativeCapabilityDefinition[]>> = {
  "openai-completions": [],
  "openai-responses": [
    { id: "openai.web_search", label: "Web search", semanticId: "web.search" },
    { id: "openai.code_interpreter", label: "Code interpreter", semanticId: "workspace.execute" },
    { id: "openai.computer_use", label: "Computer use", semanticId: "computer.use" },
  ],
  "anthropic-messages": [
    { id: "anthropic.web_search", label: "Web search", semanticId: "web.search" },
    { id: "anthropic.code_execution", label: "Code execution", semanticId: "workspace.execute" },
  ],
};

/**
 * Report protocol-declared server tools without sending a probe request. A
 * probe could spend money or perform a remote action, and it cannot prove that
 * a particular gateway/model enables the feature. Future adapters may promote
 * a candidate only after it produces Effect/Artifact-compatible provenance.
 */
export function providerNativeCapabilities(
  profile: Pick<ModelProfileConfig, "provider" | "api">,
  managed: readonly ManagedToolSemantic[] = managedToolSemantics,
): ProviderNativeCapabilityStatus[] {
  const owners = new Map(managed.map((item) => [item.semanticId, item.owner]));
  return nativeByApi[profile.api].map((definition) => {
    const managedBy = owners.get(definition.semanticId);
    if (managedBy) {
      return {
        ...definition,
        provider: profile.provider,
        api: profile.api,
        state: "suppressed" as const,
        managedBy,
        reason: `Suppressed: ProofBlade ${managedBy} owns ${definition.semanticId} with workspace, Effect, Artifact, and Evidence controls.`,
      };
    }
    return {
      ...definition,
      provider: profile.provider,
      api: profile.api,
      state: "candidate" as const,
      reason: "Protocol candidate only. Pi 0.83.0 exposes client function tools here; no audited provider-native adapter is installed.",
    };
  });
}

export function providerNativeCapabilitySummary(profile: Pick<ModelProfileConfig, "provider" | "api">): { api: ProviderApi; candidates: number; suppressed: number } {
  const capabilities = providerNativeCapabilities(profile);
  return {
    api: profile.api,
    candidates: capabilities.filter((capability) => capability.state === "candidate").length,
    suppressed: capabilities.filter((capability) => capability.state === "suppressed").length,
  };
}
