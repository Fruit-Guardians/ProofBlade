import { canonicalJson, sha256 } from "../domain/utils.js";
import { redactRequestValue } from "./request-epoch.js";

export type RuntimeConfigField = "provider" | "mcp" | "skills" | "workspace" | "routingPolicy" | "toolContract";

export interface RuntimeConfigSnapshot {
  provider: unknown;
  mcp: unknown;
  skills: unknown;
  workspace: unknown;
  routingPolicy: unknown;
  toolContract: unknown;
}

export interface RuntimeConfigScopeMap {
  [field: string]: string[] | undefined;
  provider?: string[];
  mcp?: string[];
  skills?: string[];
  workspace?: string[];
  routingPolicy?: string[];
  toolContract?: string[];
}

export interface RuntimeConfigReconciliation {
  schemaVersion: 1;
  changedFields: RuntimeConfigField[];
  fieldHashes: Record<RuntimeConfigField, { previous: string; desired: string }>;
  affectedScopes: string[];
  refreshCatalog: boolean;
  refreshCacheEpoch: boolean;
  changedCatalogFields: RuntimeConfigField[];
}

const FIELDS: readonly RuntimeConfigField[] = ["provider", "mcp", "skills", "workspace", "routingPolicy", "toolContract"];
const CATALOG_FIELDS = new Set<RuntimeConfigField>(["provider", "mcp", "skills", "workspace", "toolContract"]);

/** Compare only the six runtime boundaries that can change a live binding. */
export function reconcileRuntimeConfig(previous: RuntimeConfigSnapshot, desired: RuntimeConfigSnapshot, scopes: RuntimeConfigScopeMap = {}): RuntimeConfigReconciliation {
  const fieldHashes = Object.fromEntries(FIELDS.map((field) => [field, { previous: configHash(previous[field]), desired: configHash(desired[field]) }])) as RuntimeConfigReconciliation["fieldHashes"];
  const changedFields = FIELDS.filter((field) => fieldHashes[field].previous !== fieldHashes[field].desired);
  const affectedScopes = [...new Set(changedFields.flatMap((field) => scopes[field] ?? [`runtime:${field}`]))].sort();
  const changedCatalogFields = changedFields.filter((field) => CATALOG_FIELDS.has(field));
  return {
    schemaVersion: 1,
    changedFields,
    fieldHashes,
    affectedScopes,
    refreshCatalog: changedCatalogFields.length > 0,
    refreshCacheEpoch: changedFields.length > 0,
    changedCatalogFields,
  };
}

function configHash(value: unknown): string {
  return sha256(canonicalJson(redactRequestValue(value)));
}
