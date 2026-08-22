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

const gdbBatchParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative ELF path" },
    commands: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 256 }, description: "Non-interactive GDB commands such as break, run, info registers, x, and assertions." },
    timeoutMs: { type: "integer", minimum: 100, maximum: 120_000 },
  },
  required: ["path", "commands"],
  additionalProperties: false,
} as const;

const reverseFunctionsParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative binary path" },
    maxResults: { type: "integer", minimum: 1, maximum: 10_000 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const reverseAddressParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative binary path" },
    address: { type: "string", minLength: 3, maxLength: 18, pattern: "^0x[0-9a-fA-F]{1,16}$", description: "64-bit hexadecimal virtual address from identify, sections, or functions" },
  },
  required: ["path", "address"],
  additionalProperties: false,
} as const;

const reverseDisassembleParameters = {
  ...reverseAddressParameters,
  properties: {
    ...reverseAddressParameters.properties,
    maxInstructions: { type: "integer", minimum: 1, maximum: 512 },
  },
} as const;

const reverseXrefsParameters = {
  ...reverseAddressParameters,
  properties: {
    ...reverseAddressParameters.properties,
    direction: { type: "string", enum: ["to", "from", "both"] },
    maxResults: { type: "integer", minimum: 1, maximum: 10_000 },
  },
} as const;

const firmwarePathParameters = {
  type: "object",
  properties: { path: { type: "string", description: "Visible fixture-relative firmware image path" } },
  required: ["path"],
  additionalProperties: false,
} as const;

const firmwareResultsParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative firmware image path" },
    maxResults: { type: "integer", minimum: 1, maximum: 2_000 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const firmwareEntropyParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative firmware image path" },
    blockSize: { type: "integer", minimum: 256, maximum: 1_048_576 },
    maxResults: { type: "integer", minimum: 1, maximum: 4_096 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const firmwareFileTreeParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative firmware image path" },
    maxResults: { type: "integer", minimum: 1, maximum: 4_000 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const firmwareExtractParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Visible fixture-relative firmware image path" },
    archiveOffset: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991, description: "Archive byte offset returned by file_tree" },
    entryPath: { type: "string", minLength: 1, maxLength: 1_024, description: "Relative regular-file path returned by file_tree" },
    maxBytes: { type: "integer", minimum: 1, maximum: 65_536 },
  },
  required: ["path", "archiveOffset", "entryPath"],
  additionalProperties: false,
} as const;

const manifests: CapabilityManifest[] = [
  withCapabilityHash({
    id: "proofblade.firmware",
    version: "1.0.0",
    description: "Read-only structural triage of visible firmware images, partitions, filesystems, entropy, and embedded TAR/CPIO entries.",
    trust: "bundled",
    operations: [
      {
        name: "scan",
        description: "Scan a firmware image for bounded, recognizable container, compression, filesystem, archive, and executable signatures.",
        parameters: firmwareResultsParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "partitions",
        description: "Parse MBR, GPT, and recognized TRX firmware partition boundaries without extracting files.",
        parameters: firmwarePathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "filesystems",
        description: "Find recognizable SquashFS, CramFS, UBI, UBIFS, and ext-family filesystem headers.",
        parameters: firmwareResultsParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "entropy",
        description: "Measure Shannon entropy over bounded firmware blocks to locate compressed, encrypted, and sparse regions.",
        parameters: firmwareEntropyParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "file_tree",
        description: "List entries in embedded USTAR TAR and ASCII newc CPIO archives without writing them to disk.",
        parameters: firmwareFileTreeParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "extract",
        description: "Read one regular TAR or CPIO archive entry into a durable Artifact as bounded UTF-8 or base64 content.",
        parameters: firmwareExtractParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
    ],
  }),
  withCapabilityHash({
    id: "proofblade.binary",
    version: "1.3.0",
    description: "Read-only structural and deep analysis of visible PE and ELF binaries.",
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
      {
        name: "inspect_elf",
        description: "Return ELF identity, checksec signals, sections, and symbols in one structured result.",
        parameters: binaryPathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "packed_probe",
        description: "Detect bounded UPX/packed-binary signatures and return a deterministic unpacking fallback plan.",
        parameters: binaryPathParameters,
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "gdb_batch",
        description: "Run bounded, non-interactive GDB commands for breakpoints, registers, memory, and assertions.",
        parameters: gdbBatchParameters,
        readOnly: true,
        sideEffect: "process",
        replay: "idempotent",
        outputPolicy: "artifact",
        executionMode: "sequential",
      },
      {
        name: "functions",
        description: "List normalized function ranges and names using an available deep reverse Backend.",
        parameters: reverseFunctionsParameters,
        readOnly: true,
        sideEffect: "process",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "disassemble",
        description: "Disassemble a bounded instruction window at a hexadecimal virtual address.",
        parameters: reverseDisassembleParameters,
        readOnly: true,
        sideEffect: "process",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      },
      {
        name: "xrefs",
        description: "List normalized code or data cross-references to or from a hexadecimal address.",
        parameters: reverseXrefsParameters,
        readOnly: true,
        sideEffect: "process",
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
