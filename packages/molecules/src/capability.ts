import { canonicalJson, sha256, type ToolExecutionModeAtom, type ToolOutputPolicyAtom, type ToolSideEffectAtom } from "@proofblade/atoms";

export type CapabilitySideEffect = ToolSideEffectAtom;
export type CapabilityOutputPolicy = ToolOutputPolicyAtom;
export type CapabilityReplayPolicy = "pure" | "idempotent" | "resumable" | "reconcile" | "manual" | "forbidden-replay";

export interface CapabilityOperationAtom {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  sideEffect: CapabilitySideEffect;
  replay: CapabilityReplayPolicy;
  outputPolicy: CapabilityOutputPolicy;
  executionMode: ToolExecutionModeAtom;
}

export interface CapabilityManifestAtom {
  id: string;
  version: string;
  description: string;
  trust: "bundled" | "local" | "remote";
  operations: CapabilityOperationAtom[];
}

export interface CapabilityManifest extends CapabilityManifestAtom {
  hash: string;
}

export function capabilityManifestHash(manifest: CapabilityManifestAtom): string {
  return sha256(canonicalJson({
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    trust: manifest.trust,
    operations: [...manifest.operations].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function withCapabilityHash(manifest: CapabilityManifestAtom): CapabilityManifest {
  return { ...manifest, operations: [...manifest.operations].sort((a, b) => a.name.localeCompare(b.name)), hash: capabilityManifestHash(manifest) };
}

export function capabilityCatalogHash(manifests: readonly CapabilityManifest[]): string {
  return sha256(canonicalJson(manifests
    .map(({ hash: _hash, ...manifest }) => ({ ...manifest, operations: [...manifest.operations].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.id.localeCompare(b.id))));
}
