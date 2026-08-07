import { capabilityCatalogHash, withCapabilityHash, type CapabilityManifest } from "@proofblade/molecules";

const targetParameters = {
  type: "object",
  properties: { path: { type: "string", description: "Visible fixture-relative path" } },
  additionalProperties: false,
} as const;

const artifactParameters = {
  type: "object",
  properties: { artifactId: { type: "string" }, maxChars: { type: "integer", minimum: 256, maximum: 12_000 } },
  required: ["artifactId"],
  additionalProperties: false,
} as const;

const webRequestParameters = {
  type: "object",
  properties: {
    method: { type: "string", enum: ["GET", "HEAD", "POST"], description: "HTTP method; defaults to GET." },
    path: { type: "string", minLength: 1, description: "Origin-relative target path, including an optional query string." },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "Non-sensitive request headers." },
    body: { type: "string", maxLength: 16_384, description: "Optional POST body." },
    timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
    maxBytes: { type: "integer", minimum: 256, maximum: 1_048_576 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const manifests: CapabilityManifest[] = [
  withCapabilityHash({
    id: "proofblade.target",
    version: "1.0.0",
    description: "Read-only access to the visible synthetic target fixture.",
    trust: "bundled",
    operations: [
      {
        name: "list",
        description: "List visible target files without reading their contents.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "inline",
        executionMode: "sequential",
      },
      {
        name: "inspect",
        description: "Read all visible target files or one visible relative path.",
        parameters: targetParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "read",
        description: "Read one visible target-relative file.",
        parameters: { ...targetParameters, required: ["path"] },
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "delay",
        description: "Wait for a bounded duration to exercise cancellation and timeout recovery.",
        parameters: { type: "object", properties: { milliseconds: { type: "integer", minimum: 50, maximum: 120_000 } }, required: ["milliseconds"], additionalProperties: false },
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "inline",
        executionMode: "sequential",
      },
    ],
  }),
  withCapabilityHash({
    id: "proofblade.artifact",
    version: "1.0.0",
    description: "Read-only bounded access to durable ProofBlade artifacts.",
    trust: "bundled",
    operations: [
      {
        name: "read",
        description: "Read a durable artifact by id with a bounded output window.",
        parameters: artifactParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
    ],
  }),
  withCapabilityHash({
    id: "proofblade.web",
    version: "2.0.0",
    description: "Send one bounded HTTP request to the active task target under its network scope.",
    trust: "bundled",
    operations: [
      {
        name: "request",
        description: "Send a scoped GET, HEAD, or POST request without following redirects.",
        parameters: webRequestParameters,
        readOnly: false,
        sideEffect: "network",
        replay: "manual",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
    ],
  }),
];

export function listBundledCapabilities(): CapabilityManifest[] {
  return manifests.map((manifest) => ({ ...manifest, operations: manifest.operations.map((operation) => ({ ...operation, parameters: structuredClone(operation.parameters) })) }));
}

export function bundledCapabilityCatalogHash(): string {
  return capabilityCatalogHash(listBundledCapabilities());
}
