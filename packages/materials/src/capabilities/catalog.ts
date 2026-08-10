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

const binaryPathParameters = {
  type: "object",
  properties: { path: { type: "string", description: "Visible fixture-relative binary path" } },
  required: ["path"],
  additionalProperties: false,
} as const;

const binaryReadRangeParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative binary path" },
    offset: { type: "integer", minimum: 0 },
    length: { type: "integer", minimum: 1, maximum: 65_536 },
  },
  required: ["path", "offset", "length"],
  additionalProperties: false,
} as const;

const binaryStringsParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative binary path" },
    minLength: { type: "integer", minimum: 3, maximum: 64 },
    maxResults: { type: "integer", minimum: 1, maximum: 10_000 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const manifests: CapabilityManifest[] = [
  withCapabilityHash({
    id: "proofblade.binary",
    version: "1.0.0",
    description: "Read-only structural analysis of visible PE and ELF binaries.",
    trust: "bundled",
    operations: [
      {
        name: "identify",
        description: "Identify a PE, ELF, or unknown binary and report stable header metadata.",
        parameters: binaryPathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "read_range",
        description: "Read a bounded byte range as hexadecimal and printable ASCII.",
        parameters: binaryReadRangeParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "sections",
        description: "List PE or ELF sections with offsets, sizes, addresses, and flags.",
        parameters: binaryPathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "symbols",
        description: "Extract available PE COFF or ELF symbol table entries.",
        parameters: binaryPathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "strings",
        description: "Extract bounded printable ASCII and UTF-16LE strings.",
        parameters: binaryStringsParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
    ],
  }),
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
];

export function listBundledCapabilities(): CapabilityManifest[] {
  return manifests.map((manifest) => ({ ...manifest, operations: manifest.operations.map((operation) => ({ ...operation, parameters: structuredClone(operation.parameters) })) }));
}

export function bundledCapabilityCatalogHash(): string {
  return capabilityCatalogHash(listBundledCapabilities());
}
