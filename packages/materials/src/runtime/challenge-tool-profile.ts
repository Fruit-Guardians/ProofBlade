import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "@proofblade/atoms";
import type { McpProjectRegistry, McpServerSummary, McpToolchainState } from "../mcp/registry.js";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ActionBundle, FirstActionPlan, RunSnapshot, RunToolPreparation, TargetKind, ToolPreparationRuntime } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ProofBladeToolCatalogRegistry } from "../tools/catalog.js";
import type { ToolCatalogBootstrapSpec } from "../tools/catalog.js";

/** The stable challenge directions known to the solver. */
export type ChallengeCategory = "reverse" | "pwn" | "web" | "crypto" | "forensics" | "misc" | "malware" | "osint" | "mobile";

/**
 * A prepared, bounded capability set for one challenge direction.
 *
 * `hostToolIds` describes tools that should already be installed and health
 * checked on the operator machine. It is intentionally separate from the
 * tools exposed to Pi: prepared does not mean every tool is sent to the model.
 */
export interface ChallengeToolProfile {
  id: ChallengeCategory;
  targetKind: Exclude<TargetKind, "unknown" | "mixed">;
  /**
   * The bounded action the first solver turn must perform for this direction.
   * This is deliberately a contract, not a tool list: it turns preflight's
   * classification into useful progress without asking the model to rediscover
   * the direction or launch an unbounded experiment.
  */
  firstAction: string;
  firstActionPlan: FirstActionPlan;
  skillNames: string[];
  hostToolIds: string[];
  requiredToolIds: string[];
  optionalToolIds: string[];
  mcpServers: string[];
  capabilities: string[];
  fallbackStrategies: string[];
  actionBundles: ActionBundle[];
}

export interface ChallengeClassification {
  profile: ChallengeToolProfile;
  confidence: "high" | "medium";
  reasons: string[];
}

const COMMON_HOST_TOOLS = ["python311", "python", "jq", "xxd"];

const FIRST_ACTION_PLANS: Record<ChallengeCategory, FirstActionPlan> = {
  reverse: { id: "reverse-recon", allowedToolNames: ["read", "bash", "capability", "mcp_call", "mcp__*"], maxCalls: 3 },
  mobile: { id: "mobile-manifest", allowedToolNames: ["read", "bash", "capability", "mcp_call", "mcp__*"], maxCalls: 3 },
  pwn: { id: "pwn-binary-or-tube", allowedToolNames: ["read", "bash", "capability", "pwn_open", "pwn_recv"], maxCalls: 2 },
  web: { id: "web-request-or-artifact", allowedToolNames: ["read", "bash", "web_open", "web_request"], maxCalls: 2 },
  crypto: { id: "crypto-normalize", allowedToolNames: ["read", "bash"], maxCalls: 2 },
  forensics: { id: "forensics-container", allowedToolNames: ["read", "bash", "capability", "mcp_call", "mcp__*"], maxCalls: 3 },
  malware: { id: "malware-static", allowedToolNames: ["read", "bash", "capability", "mcp_call", "mcp__*"], maxCalls: 3 },
  osint: { id: "osint-source", allowedToolNames: ["read", "bash", "web_open", "web_request"], maxCalls: 2 },
  misc: { id: "misc-input", allowedToolNames: ["read", "bash", "capability", "mcp_call", "mcp__*"], maxCalls: 2 },
};

function genericActionBundles(toolNames: string[], capabilityIds: string[]): ActionBundle[] {
  return [
    {
      id: "recon-surface",
      domainPhase: "RECON",
      objective: "Establish the input format, execution boundary, and one reliable observation.",
      toolNames: [...toolNames],
      capabilityIds: [...capabilityIds],
      preconditions: ["The challenge workspace and task inputs are available."],
      successCriteria: ["A bounded observation identifies the target format or surface."],
      failureCriteria: ["The tool is missing, times out, or returns an untrusted/no-signal observation."],
      maxCalls: 3,
    },
    {
      id: "target-model",
      domainPhase: "TARGET_MODEL",
      objective: "Turn the recon observation into one structured hypothesis with a falsifiable risk.",
      toolNames: ["read", "bash", ...toolNames.filter((name) => name !== "read" && name !== "bash")],
      capabilityIds: [...capabilityIds],
      preconditions: ["A RECON observation exists in the current generation."],
      successCriteria: ["A hypothesis names its supporting evidence and a counterexample to test."],
      failureCriteria: ["The hypothesis only restates the prompt or has no falsifiable prediction."],
      maxCalls: 2,
    },
    {
      id: "hypothesis-plan",
      domainPhase: "HYPOTHESIS",
      objective: "Choose one experiment with explicit inputs, expected evidence, and a stop condition.",
      toolNames: ["read", "bash"],
      capabilityIds: [...capabilityIds],
      preconditions: ["A target model and at least one supporting Evidence item exist."],
      successCriteria: ["The next probe has a bounded input and both success and failure predicates."],
      failureCriteria: ["The plan only changes payload syntax or has no new observation it can produce."],
      maxCalls: 2,
    },
    {
      id: "bounded-experiment",
      domainPhase: "EXPERIMENT",
      objective: "Run one bounded probe that can add evidence or reject the active hypothesis.",
      toolNames: [...toolNames, "read", "bash"].filter((name, index, all) => all.indexOf(name) === index),
      capabilityIds: [...capabilityIds],
      preconditions: ["An open hypothesis and a concrete success/failure predicate exist."],
      successCriteria: ["The probe produces new evidence or a durable negative result."],
      failureCriteria: ["The probe repeats a prior input, has no predicate, or produces no durable observation."],
      maxCalls: 4,
    },
    {
      id: "clean-reproduce",
      domainPhase: "REPRODUCE",
      objective: "Re-run the candidate path from clean state and bind the result to verifier-owned evidence.",
      toolNames: ["verify_claim", "read", "bash"],
      capabilityIds: ["verifier.reproduce"],
      preconditions: ["A candidate is derived from current-generation evidence."],
      successCriteria: ["A clean reproduction produces verifier-accepted evidence."],
      failureCriteria: ["The candidate depends on stale state, prompt text, or a non-reproducible side effect."],
      maxCalls: 2,
    },
  ];
}

const ACTION_BUNDLES: Record<ChallengeCategory, ActionBundle[]> = {
  pwn: [
    {
      id: "pwn-recon",
      domainPhase: "RECON",
      objective: "Record binary protections and one complete protocol prompt before crafting a payload.",
      toolNames: ["read", "bash", "capability", "pwn_open", "pwn_recv"],
      capabilityIds: ["pwn.tube", "proofblade.binary"],
      preconditions: ["The binary or scoped remote endpoint is available."],
      successCriteria: ["Architecture/protections and a state-specific prompt anchor are persisted."],
      failureCriteria: ["EOF, timeout, or a generic prompt suffix is mistaken for a valid protocol state."],
      maxCalls: 4,
    },
    {
      id: "pwn-target-model",
      domainPhase: "TARGET_MODEL",
      objective: "Model the vulnerable primitive, protocol state, and address/offset assumptions from durable evidence.",
      toolNames: ["read", "bash", "pwn_recv", "pwn_record_primitive", "capability", "mcp_call"],
      capabilityIds: ["pwn.tube", "reverse.binary"],
      preconditions: ["RECON contains protections and a transcript anchor."],
      successCriteria: ["One primitive and one falsifiable address/protocol assumption are recorded."],
      failureCriteria: ["The model assumes a shell, leak, or libc without an observed marker."],
      maxCalls: 3,
    },
    {
      id: "pwn-hypothesis",
      domainPhase: "HYPOTHESIS",
      objective: "Select one synchronized payload experiment and define its expected leak or state transition.",
      toolNames: ["read", "bash", "pwn_list", "pwn_record_primitive"],
      capabilityIds: ["pwn.tube"],
      preconditions: ["A primitive, protocol anchor, and address assumption are recorded."],
      successCriteria: ["The payload input, expected bytes, and failure boundary are explicit."],
      failureCriteria: ["The plan relies on a guessed offset, generic recv suffix, or shell claim."],
      maxCalls: 2,
    },
    {
      id: "pwn-experiment",
      domainPhase: "EXPERIMENT",
      objective: "Drive one synchronized tube step or bounded local probe and classify its result.",
      toolNames: ["pwn_send", "pwn_recv", "pwn_signal", "pwn_list", "read", "bash"],
      capabilityIds: ["pwn.tube"],
      preconditions: ["A protocol anchor and explicit payload success/failure predicate exist."],
      successCriteria: ["A new leak, primitive, state transition, or negative result is persisted."],
      failureCriteria: ["Timeout/EOF, unsynchronized input, or repeated payload is treated as success."],
      maxCalls: 6,
    },
    {
      id: "pwn-reproduce",
      domainPhase: "REPRODUCE",
      objective: "Use a fresh tube and verifier barriers to confirm shell control and extract the candidate.",
      toolNames: ["pwn_reproduce", "verify_claim", "read"],
      capabilityIds: ["pwn.reproduce", "verifier.reproduce"],
      preconditions: ["A current-generation exploit path and task-owned pwn verifier contract exist."],
      successCriteria: ["Fresh-session shell marker and flag extraction both pass."],
      failureCriteria: ["A proposal, EOF, or one-shot shell guess is treated as reproduction."],
      maxCalls: 2,
    },
  ],
  web: [
    {
      id: "web-recon",
      domainPhase: "RECON",
      objective: "Capture one baseline request/response and persist origin, route, cookies, and CSRF state.",
      toolNames: ["web_open", "web_request", "web_list", "read", "bash"],
      capabilityIds: ["web.http-session"],
      preconditions: ["The target URL is inside the immutable host/port scope."],
      successCriteria: ["Status, headers, body summary, and session state are recorded."],
      failureCriteria: ["A redirect, error page, or empty response is misclassified as an exploit signal."],
      maxCalls: 4,
    },
    {
      id: "web-target-model",
      domainPhase: "TARGET_MODEL",
      objective: "Map an input trust boundary and select one minimal primitive with a falsifiable response predicate.",
      toolNames: ["web_request", "web_replay", "web_list", "read", "bash"],
      capabilityIds: ["web.http-session", "web.browser"],
      preconditions: ["RECON contains a baseline route and state summary."],
      successCriteria: ["One sink, variable, or auth boundary is linked to supporting evidence."],
      failureCriteria: ["The hypothesis is only a payload list without a route or observable difference."],
      maxCalls: 3,
    },
    {
      id: "web-hypothesis",
      domainPhase: "HYPOTHESIS",
      objective: "Choose one minimal request mutation and define the response difference that would confirm it.",
      toolNames: ["web_list", "web_replay", "read", "bash"],
      capabilityIds: ["web.http-session"],
      preconditions: ["A route, trust boundary, and baseline response are recorded."],
      successCriteria: ["The mutation, session state, and positive/negative response predicates are explicit."],
      failureCriteria: ["The plan sprays payload variants or treats reflection/status changes as proof."],
      maxCalls: 2,
    },
    {
      id: "web-experiment",
      domainPhase: "EXPERIMENT",
      objective: "Send one controlled request or replay and compare the response against the predicate.",
      toolNames: ["web_request", "web_replay", "web_list", "read", "bash"],
      capabilityIds: ["web.http-session", "web.browser"],
      preconditions: ["An in-scope route, input, and success/failure predicate exist."],
      successCriteria: ["A new response difference or durable negative result is recorded."],
      failureCriteria: ["A timeout, 500, reflection, or stale cookie is treated as proof of impact."],
      maxCalls: 5,
    },
    {
      id: "web-reproduce",
      domainPhase: "REPRODUCE",
      objective: "Replay the complete exploit chain in a clean HTTP session and bind the extracted candidate to evidence.",
      toolNames: ["web_reproduce", "verify_claim", "read"],
      capabilityIds: ["web.reproduce", "verifier.reproduce"],
      preconditions: ["A complete chain and immutable web flag policy exist."],
      successCriteria: ["Every chain assertion passes in a clean session and the candidate is extracted from its response."],
      failureCriteria: ["The candidate comes from prompt text, stale cookies, or an unverified partial step."],
      maxCalls: 2,
    },
  ],
  reverse: genericActionBundles(["read", "bash", "capability", "mcp_call", "mcp__*"], ["reverse.binary", "mcp.reverse"]),
  mobile: genericActionBundles(["read", "bash", "capability", "mcp_call", "mcp__*"], ["reverse.android", "mcp.reverse"]),
  crypto: genericActionBundles(["read", "bash"], ["crypto.python", "crypto.solver"]),
  forensics: genericActionBundles(["read", "bash", "capability", "mcp_call", "mcp__*"], ["forensics.files", "forensics.pcap", "forensics.memory"]),
  malware: genericActionBundles(["read", "bash", "capability", "mcp_call", "mcp__*"], ["malware.static", "malware.memory"]),
  osint: genericActionBundles(["read", "bash", "web_open", "web_request"], ["osint.web", "osint.artifact"]),
  misc: genericActionBundles(["read", "bash", "capability", "mcp_call", "mcp__*"], ["misc.solver"]),
};

const PROFILE_DATA: Record<ChallengeCategory, Omit<ChallengeToolProfile, "id" | "actionBundles">> = {
  reverse: {
    targetKind: "reverse",
    firstAction: "Identify the artifact once with file/headers/strings and one targeted entrypoint or decompiler probe; persist format, architecture, and mitigations before following xrefs.",
    firstActionPlan: FIRST_ACTION_PLANS.reverse,
    skillNames: ["ctf-reverse"],
    hostToolIds: ["file", "strings", "readelf", "objdump", "gdb", "upx", "patchelf", "qemu", "ghidra-headless", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["strings", "python"],
    optionalToolIds: ["readelf", "objdump", "gdb", "upx", "patchelf", "qemu", "ghidra-headless", "jq", "xxd"],
    mcpServers: ["idalib-mcp", "jadx"],
    capabilities: ["reverse.binary", "mcp.reverse"],
    fallbackStrategies: ["static:packed_probe-then-file-strings-readelf-objdump", "packed:local-upx-test-then-gdb-memory-dump", "decompiler:mcp-first-class-then-mcp-call", "dynamic:qemu-or-gdb"],
  },
  mobile: {
    targetKind: "reverse",
    firstAction: "Extract the APK manifest/package and main activity, then decompile one relevant class; persist exported components and secret-bearing paths before broad source browsing.",
    firstActionPlan: FIRST_ACTION_PLANS.mobile,
    skillNames: ["ctf-reverse"],
    hostToolIds: ["jadx", "apktool", "adb", "aapt", "python311", "python", "file", "strings", "xxd"],
    requiredToolIds: ["jadx", "python"],
    optionalToolIds: ["apktool", "adb", "aapt", "strings", "xxd"],
    mcpServers: ["jadx"],
    capabilities: ["reverse.android", "mcp.reverse"],
    fallbackStrategies: ["android:manifest-then-main-activity", "android:jadx-source-then-search", "native:extract-lib-and-use-reverse-profile"],
  },
  pwn: {
    targetKind: "pwn",
    firstAction: "Run file/checksec or the prepared proofblade.binary identify capability and one bounded protocol probe (pwn_open plus pwn_recv when a tube is ready); persist architecture, mitigations, prompt anchor, and interaction state before crafting a payload.",
    firstActionPlan: FIRST_ACTION_PLANS.pwn,
    skillNames: ["ctf-pwn"],
    hostToolIds: ["checksec", "gdb", "pwntools", "ropgadget", "one_gadget", "patchelf", "qemu", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["checksec", "python"],
    optionalToolIds: ["gdb", "pwntools", "ropgadget", "one_gadget", "patchelf", "qemu", "jq", "xxd"],
    mcpServers: [],
    capabilities: ["pwn.tube", "proofblade.binary", "pwn.reproduce"],
    fallbackStrategies: ["local:checksec-gdb-reproducer", "remote:pwn-tube-with-bounded-recv", "rop:libc-search-then-ropgadget"],
  },
  web: {
    targetKind: "web",
    firstAction: "Make one bounded request through the prepared web session or curl; capture status, headers, body, and auth/CSRF state, then persist the route and state before any mutation.",
    firstActionPlan: FIRST_ACTION_PLANS.web,
    skillNames: ["ctf-web"],
    hostToolIds: ["curl", "python311", "playwright", "chromium", "jwt-tool", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["curl", "python"],
    optionalToolIds: ["playwright", "chromium", "jwt-tool", "jq"],
    mcpServers: [],
    capabilities: ["web.http-session", "web.browser", "web.reproduce"],
    fallbackStrategies: ["http:curl-session-then-browser", "auth:cookie-csrf-state-preserving-session", "injection:reproducer-before-claim"],
  },
  crypto: {
    targetKind: "crypto",
    firstAction: "Normalize the supplied encoding and identify the primitive, operation, and parameters; write one parser/recompute check and persist an invariant before trying attacks.",
    firstActionPlan: FIRST_ACTION_PLANS.crypto,
    skillNames: ["ctf-crypto"],
    hostToolIds: ["python311", "gmpy2", "sympy", "pycryptodome", "sage", "fpylll", "hashcat", "john", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["python"],
    optionalToolIds: ["gmpy2", "sympy", "pycryptodome", "sage", "fpylll", "hashcat", "john"],
    mcpServers: [],
    capabilities: ["crypto.python", "crypto.solver"],
    fallbackStrategies: ["identify:primitive-and-operation-first", "number-theory:gmpy2-sympy-before-bruteforce", "verification:independent-recompute"],
  },
  forensics: {
    targetKind: "misc",
    firstAction: "Identify the file/container and metadata, enumerate its layers or streams once, and persist format, offsets, and boundaries before extracting content.",
    firstActionPlan: FIRST_ACTION_PLANS.forensics,
    skillNames: ["ctf-forensics"],
    hostToolIds: ["file", "binwalk", "exiftool", "7z", "tshark", "volatility", "python311", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["python"],
    optionalToolIds: ["binwalk", "exiftool", "7z", "tshark", "volatility"],
    mcpServers: [],
    capabilities: ["forensics.files", "forensics.pcap", "forensics.memory"],
    fallbackStrategies: ["identify:file-magic-and-container-boundaries", "pcap:tshark-filter-before-follow-stream", "memory:volatility-profile-then-targeted-plugin"],
  },
  malware: {
    targetKind: "misc",
    firstAction: "Hash and identify the sample, then run bounded static metadata/strings/YARA/CAPA checks; persist the family, IOC, and config location before emulation.",
    firstActionPlan: FIRST_ACTION_PLANS.malware,
    skillNames: ["ctf-malware"],
    hostToolIds: ["yara", "capa", "pefile", "oletools", "volatility", "python311", "python", "file", "strings"],
    requiredToolIds: ["python"],
    optionalToolIds: ["yara", "capa", "pefile", "oletools", "volatility", "strings"],
    mcpServers: [],
    capabilities: ["malware.static", "malware.memory"],
    fallbackStrategies: ["static:hash-file-yara-capa-strings", "pe:imports-and-config-before-emulation", "memory:targeted-process-and-injection-analysis"],
  },
  osint: {
    targetKind: "misc",
    firstAction: "State the exact claim to prove and collect one timestamped, attributable source or artifact; persist its provenance before broadening the search.",
    firstActionPlan: FIRST_ACTION_PLANS.osint,
    skillNames: ["ctf-osint"],
    hostToolIds: ["curl", "python311", "exiftool", "tshark", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["curl", "python"],
    optionalToolIds: ["exiftool", "tshark"],
    mcpServers: [],
    capabilities: ["osint.web", "osint.artifact"],
    fallbackStrategies: ["web:collect-source-and-timestamp", "image:metadata-then-reverse-search", "dns:passive-enumeration-before-active-checks"],
  },
  misc: {
    targetKind: "misc",
    firstAction: "Identify the input format and dominant constraint with one bounded probe, then write a small reproducer and persist the first invariant before branching.",
    firstActionPlan: FIRST_ACTION_PLANS.misc,
    skillNames: ["ctf-misc"],
    hostToolIds: ["python311", "python", "z3", "jq", "xxd", "imagemagick", "file"],
    requiredToolIds: ["python"],
    optionalToolIds: ["z3", "jq", "xxd", "imagemagick", "file"],
    mcpServers: [],
    capabilities: ["misc.solver"],
    fallbackStrategies: ["triage:identify-format-and-constraint", "solver:write-small-reproducer-early", "hybrid:route-to-dominant-specialist"],
  },
};

/** Return a fresh immutable-by-convention profile object for a category. */
export function challengeToolProfile(category: ChallengeCategory): ChallengeToolProfile {
  const data = PROFILE_DATA[category];
  return { id: category, ...data, firstActionPlan: copyFirstActionPlan(data.firstActionPlan), skillNames: [...data.skillNames], hostToolIds: [...data.hostToolIds], requiredToolIds: [...data.requiredToolIds], optionalToolIds: [...data.optionalToolIds], mcpServers: [...data.mcpServers], capabilities: [...data.capabilities], fallbackStrategies: [...data.fallbackStrategies], actionBundles: copyActionBundles(ACTION_BUNDLES[category]) };
}

/** Return every built-in profile in deterministic order for one-time setup/doctor commands. */
export function challengeToolProfiles(): ChallengeToolProfile[] {
  return (Object.keys(PROFILE_DATA) as ChallengeCategory[]).sort().map((category) => challengeToolProfile(category));
}

const TOOL_BOOTSTRAP_DEFINITIONS: Record<string, Omit<ToolCatalogBootstrapSpec, "id" | "profiles">> = {
  python311: { name: "python311", kind: "interpreter", description: "Pinned Python 3.11 interpreter for reproducible solvers.", candidates: ["python3.11", "python311"] },
  python: { name: "python", kind: "interpreter", description: "Host Python interpreter for bounded solver scripts.", candidates: ["python", "python3", "py"] },
  file: { name: "file", kind: "tool", description: "File format and magic identification.", candidates: ["file"] },
  strings: { name: "strings", kind: "tool", description: "Printable string extraction from binary artifacts.", candidates: ["strings"] },
  readelf: { name: "readelf", kind: "tool", description: "ELF headers, sections, symbols and relocations.", candidates: ["readelf"] },
  objdump: { name: "objdump", kind: "tool", description: "Disassembly and binary section inspection.", candidates: ["objdump"] },
  gdb: { name: "gdb", kind: "tool", description: "Non-interactive debugger and memory assertions.", candidates: ["gdb"] },
  upx: { name: "upx", kind: "tool", description: "UPX packed-binary inspection and unpacking.", candidates: ["upx"] },
  patchelf: { name: "patchelf", kind: "tool", description: "ELF loader and RPATH patching.", candidates: ["patchelf"] },
  qemu: { name: "qemu", kind: "tool", description: "User-mode emulation for non-native binaries.", candidates: ["qemu-x86_64", "qemu-aarch64", "qemu"] },
  "ghidra-headless": { name: "ghidra-headless", kind: "tool", description: "Headless Ghidra analyzer.", candidates: ["analyzeHeadless.bat", "analyzeHeadless"] },
  checksec: { name: "checksec", kind: "tool", description: "ELF security mitigation inspection.", candidates: ["checksec"] },
  pwntools: { name: "pwntools", kind: "toolchain", description: "Python pwntools package; health is checked through the selected interpreter.", candidates: ["pwn"] },
  ropgadget: { name: "ROPgadget", kind: "tool", description: "ROP gadget enumeration.", candidates: ["ROPgadget", "ropgadget"] },
  one_gadget: { name: "one_gadget", kind: "tool", description: "libc one-gadget constraint search.", candidates: ["one_gadget"] },
  curl: { name: "curl", kind: "tool", description: "Bounded HTTP request client.", candidates: ["curl"] },
  playwright: { name: "playwright", kind: "tool", description: "Playwright browser automation CLI/runtime.", candidates: ["playwright"] },
  chromium: { name: "chromium", kind: "tool", description: "Headless Chromium browser.", candidates: ["chromium", "chromium-browser", "chrome"] },
  "jwt-tool": { name: "jwt-tool", kind: "tool", description: "JWT inspection and attack helper.", candidates: ["jwt_tool", "jwt-tool"] },
  gmpy2: { name: "gmpy2", kind: "toolchain", description: "Python GMP arithmetic package.", candidates: ["gmpy2"] },
  sympy: { name: "sympy", kind: "toolchain", description: "Python symbolic mathematics package.", candidates: ["sympy"] },
  pycryptodome: { name: "pycryptodome", kind: "toolchain", description: "Python cryptography package.", candidates: ["pycryptodome"] },
  sage: { name: "sage", kind: "tool", description: "SageMath computer algebra system.", candidates: ["sage"] },
  fpylll: { name: "fpylll", kind: "toolchain", description: "Python lattice reduction package.", candidates: ["fpylll"] },
  hashcat: { name: "hashcat", kind: "tool", description: "Password/hash recovery tool.", candidates: ["hashcat"] },
  john: { name: "john", kind: "tool", description: "John the Ripper password recovery tool.", candidates: ["john"] },
  binwalk: { name: "binwalk", kind: "tool", description: "Firmware/container signature scanner.", candidates: ["binwalk"] },
  exiftool: { name: "exiftool", kind: "tool", description: "Metadata and embedded object extractor.", candidates: ["exiftool"] },
  "7z": { name: "7z", kind: "tool", description: "Archive extraction and inspection.", candidates: ["7z", "7zz"] },
  tshark: { name: "tshark", kind: "tool", description: "Bounded PCAP protocol analysis.", candidates: ["tshark"] },
  volatility: { name: "volatility", kind: "tool", description: "Memory image analysis framework.", candidates: ["vol", "vol.py", "volatility"] },
  yara: { name: "yara", kind: "tool", description: "YARA rule scanner.", candidates: ["yara"] },
  capa: { name: "capa", kind: "tool", description: "Malware capability identification.", candidates: ["capa"] },
  pefile: { name: "pefile", kind: "toolchain", description: "Python PE parsing package.", candidates: ["pefile"] },
  oletools: { name: "oletools", kind: "toolchain", description: "Office/OLE malware analysis package.", candidates: ["olevba", "oleid"] },
  z3: { name: "z3", kind: "tool", description: "SMT solver CLI.", candidates: ["z3"] },
  jq: { name: "jq", kind: "tool", description: "JSON filtering and normalization.", candidates: ["jq"] },
  xxd: { name: "xxd", kind: "tool", description: "Hex dump and byte inspection.", candidates: ["xxd"] },
  imagemagick: { name: "ImageMagick", kind: "tool", description: "Image conversion and steganography helpers.", candidates: ["magick", "convert"] },
  apktool: { name: "apktool", kind: "tool", description: "Android APK resource and smali decoding.", candidates: ["apktool", "apktool.bat"] },
  adb: { name: "adb", kind: "tool", description: "Android device/emulator bridge.", candidates: ["adb"] },
  aapt: { name: "aapt", kind: "tool", description: "Android package metadata inspection.", candidates: ["aapt"] },
  jadx: { name: "jadx", kind: "tool", description: "Android/Java decompiler CLI.", candidates: ["jadx"] },
};

/** Build the reviewed executable aliases used by `proofblade tools init`. */
export function challengeToolCatalogSpecs(): ToolCatalogBootstrapSpec[] {
  const profiles = challengeToolProfiles();
  const profileIds = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const id of profile.hostToolIds) profileIds.set(id, [...(profileIds.get(id) ?? []), profile.id]);
  }
  return Object.entries(TOOL_BOOTSTRAP_DEFINITIONS)
    .filter(([id]) => profileIds.has(id))
    .map(([id, definition]) => ({ id, ...definition, profiles: [...new Set(profileIds.get(id) ?? [])].sort() }));
}

/** Map a durable task target kind to the default prepared profile. */
export function profileForTargetKind(targetKind: TargetKind, target = ""): ChallengeToolProfile | undefined {
  if (targetKind === "reverse") return classifyChallengePrompt(target)?.profile ?? challengeToolProfile("reverse");
  if (targetKind === "pwn" || targetKind === "web" || targetKind === "crypto") return challengeToolProfile(targetKind);
  if (targetKind === "misc") {
    // Platforms often collapse forensics, malware, OSINT and misc into one
    // bucket. Keep the durable TargetKind compatible with that wire value, but
    // still select the specialized prepared tool profile when the target text
    // carries a stronger direction marker.
    return classifyChallengePrompt(`CTF ${target}`)?.profile ?? challengeToolProfile("misc");
  }
  // GUI/chat tasks can legitimately arrive with an unknown or mixed wire kind.
  // Do the same deterministic text classification before the first Pi turn so
  // they receive a bounded profile instead of falling through to an unprepared
  // generic tool set. Ordinary non-challenge conversations still return none.
  if (targetKind === "mixed") return classifyChallengePrompt(`CTF ${target}`)?.profile;
  if (targetKind === "unknown") return classifyChallengePrompt(target)?.profile;
  return undefined;
}

/** Return the phase-scoped action contract selected by a prepared profile. */
export function actionBundleForPhase(profile: ChallengeToolProfile, domainPhase: string): ActionBundle | undefined {
  return profile.actionBundles.find((bundle) => bundle.domainPhase === domainPhase);
}

/**
 * Conservative prompt/workspace classifier used before a GUI lane is created.
 * Ordinary coding requests return undefined; challenge-shaped requests receive
 * one deterministic profile and a small confidence explanation.
 */
export function classifyChallengePrompt(text: string, workspaceHint = ""): ChallengeClassification | undefined {
  const haystack = `${text}\n${workspaceHint}`.toLowerCase();
  const challengeSignal = /\b(?:ctf|challenge|flag|pyjail|pwn|nc|netcat|apk|dex|aab|elf|upx|shellcode|remote service)\b|flag\s*\{/i.test(haystack) || /题目|附件|靶机|求解|解题|夺旗|逆向题|漏洞题|二进制题/i.test(haystack);
  if (!challengeSignal) return undefined;
  const rules: Array<{ category: ChallengeCategory; confidence: "high" | "medium"; markers: RegExp; reason: string }> = [
    { category: "mobile", confidence: "high", markers: /\b(?:android|apk|dex|aab|jadx|adb|manifest|smali)\b/i, reason: "Android/mobile artifact marker" },
    { category: "pwn", confidence: "high", markers: /\b(?:pwn|pwntools|buffer overflow|format string|ret2|rop|heap|libc|nc\s+|netcat|栈溢出|堆利用|远程服务)\b/i, reason: "native exploitation or service marker" },
    { category: "web", confidence: "high", markers: /\b(?:web|http|https|xss|sqli|sql injection|ssti|ssrf|csrf|jwt|cookie|浏览器|网页)\b/i, reason: "HTTP/web vulnerability marker" },
    { category: "crypto", confidence: "high", markers: /\b(?:crypto|cryptography|rsa|aes|ecc|lattice|xor|padding oracle|hashcat|密码学|加密|密文)\b/i, reason: "cryptography marker" },
    { category: "malware", confidence: "high", markers: /\b(?:malware|ransomware|yara|capa|pefile|oletools|恶意软件|木马)\b/i, reason: "malware-analysis marker" },
    { category: "forensics", confidence: "high", markers: /\b(?:forensics?|pcap|memory dump|volatility|binwalk|exiftool|取证|流量分析|磁盘镜像)\b/i, reason: "forensics marker" },
    { category: "osint", confidence: "medium", markers: /\b(?:osint|open source intelligence|geolocation|dns|wayback|社工|公开信息)\b/i, reason: "OSINT marker" },
    { category: "reverse", confidence: "high", markers: /\b(?:reverse(?:[- ]engineering)?|reversing|binary|elf|pe file|ida|ghidra|upx|packed|shellcode|native|逆向|二进制|脱壳|反调试)\b/i, reason: "native reverse-engineering marker" },
    { category: "misc", confidence: "medium", markers: /(?:\b(?:ctf|challenge|pyjail)\b|flag\s*\{|题目描述|求解\s*flag|解题|夺旗|杂项|编码题)/i, reason: "generic challenge marker" },
  ];
  const match = rules.find((rule) => rule.markers.test(haystack));
  return match ? { profile: challengeToolProfile(match.category), confidence: match.confidence, reasons: [match.reason] } : undefined;
}

export interface ToolHealthRecord {
  id: string;
  name: string;
  path: string;
  status: "ready" | "missing";
}

export interface McpHealthRecord {
  name: string;
  status: McpServerSummary["status"];
  toolchainState?: McpToolchainState;
}

export interface ChallengeToolPreflight {
  profileId: ChallengeCategory;
  targetKind: Exclude<TargetKind, "unknown" | "mixed">;
  runtime: ToolPreparationRuntime;
  runtimeKey: string;
  cacheKey: string;
  toolCatalogHash: string;
  mcpCatalogHash: string;
  cacheHit: boolean;
  checkedAt: number;
  tools: ToolHealthRecord[];
  mcpServers: McpHealthRecord[];
  missingRequiredTools: string[];
  missingOptionalTools: string[];
  fallbackStrategies: string[];
  firstActionPlan?: FirstActionPlan;
  actionBundles?: ActionBundle[];
}

interface PersistedPreflight {
  schemaVersion: 1;
  cacheKey: string;
  profileId: ChallengeCategory;
  targetKind: ChallengeToolPreflight["targetKind"];
  runtime?: ToolPreparationRuntime;
  runtimeKey?: string;
  tools: ToolHealthRecord[];
  mcpServers: McpHealthRecord[];
  toolCatalogHash?: string;
  mcpCatalogHash?: string;
  missingRequiredTools: string[];
  /** Added after the initial cache format; old health entries remain readable. */
  missingOptionalTools?: string[];
  firstActionPlan?: FirstActionPlan;
  actionBundles?: ActionBundle[];
  checkedAt: number;
}

interface PersistedPreflightCache {
  schemaVersion: 1;
  entries: Record<string, PersistedPreflight>;
}

/**
 * Performs one bounded local readiness check and persists the result by catalog
 * and MCP config hash. A later challenge reuses the result instead of asking
 * the model to rediscover or request the same tools again.
 */
export class ToolPreflightService {
  public constructor(private readonly cacheRoot?: string, private readonly options: { maxAgeMs?: number; force?: boolean } = {}) {}

  public async prepare(profile: ChallengeToolProfile, catalog: ProofBladeToolCatalogRegistry, mcp: Pick<McpProjectRegistry, "catalogHash" | "summaries">): Promise<ChallengeToolPreflight> {
    const selected = catalog.selectForProfile(profile.id, profile.hostToolIds);
    const cacheKey = sha256(canonicalJson({
      profile: {
        id: profile.id,
        targetKind: profile.targetKind,
        hostToolIds: profile.hostToolIds,
        requiredToolIds: profile.requiredToolIds,
        optionalToolIds: profile.optionalToolIds,
        mcpServers: profile.mcpServers,
        firstActionPlan: profile.firstActionPlan,
        actionBundles: profile.actionBundles,
      },
      catalog: catalog.catalogHash(),
      mcp: mcp.catalogHash(),
      runtime: "host",
      runtimeKey: "host",
      tools: selected.map((entry) => entry.id),
    }));
    const cached = await this.readCached(cacheKey);
    if (cached) return { ...cached, firstActionPlan: copyFirstActionPlan(cached.firstActionPlan ?? profile.firstActionPlan), actionBundles: copyActionBundles(cached.actionBundles ?? profile.actionBundles), runtime: "host", runtimeKey: "host", toolCatalogHash: catalog.catalogHash(), mcpCatalogHash: mcp.catalogHash(), cacheHit: true };
    const checkedAt = Date.now();
    const diagnostics = await catalog.probeEntries(selected);
    const missingPaths = new Set(diagnostics.filter((item) => item.code === "path_missing").map((item) => item.id));
    const tools = selected.map((entry) => ({ id: entry.id, name: entry.name, path: entry.path, status: missingPaths.has(entry.id) ? "missing" as const : "ready" as const }));
    const configured = new Set(selected.map((entry) => entry.id));
    const missingRequiredTools = profile.requiredToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const missingOptionalTools = profile.optionalToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const mcpServers = mcp.summaries().filter((server) => profile.mcpServers.includes(server.name) && !server.disabled).map((server) => ({ name: server.name, status: server.status, ...(server.toolchain ? { toolchainState: server.toolchain.state } : {}) }));
    const persisted: PersistedPreflight = { schemaVersion: 1, cacheKey, profileId: profile.id, targetKind: profile.targetKind, runtime: "host", runtimeKey: "host", toolCatalogHash: catalog.catalogHash(), mcpCatalogHash: mcp.catalogHash(), tools, mcpServers, missingRequiredTools, missingOptionalTools, firstActionPlan: copyFirstActionPlan(profile.firstActionPlan), actionBundles: copyActionBundles(profile.actionBundles), checkedAt };
    await this.writeCached(persisted);
    return { ...persisted, runtime: "host", runtimeKey: "host", toolCatalogHash: persisted.toolCatalogHash!, mcpCatalogHash: persisted.mcpCatalogHash!, missingOptionalTools, fallbackStrategies: [...profile.fallbackStrategies], firstActionPlan: copyFirstActionPlan(profile.firstActionPlan), actionBundles: copyActionBundles(profile.actionBundles), cacheHit: false };
  }

  /**
   * Probe the actual execution backend used by the lane. Host catalog paths are
   * intentionally unavailable inside Docker, so this method checks command and
   * Python-module availability through the container's ExecutionEnv instead of
   * trusting the host machine.
   */
  public async prepareInExecution(
    profile: ChallengeToolProfile,
    env: ExecutionEnv,
    mcp: Pick<McpProjectRegistry, "catalogHash" | "summaries">,
    options: { runtimeKey: string; force?: boolean } = { runtimeKey: "container" },
  ): Promise<ChallengeToolPreflight> {
    const specs = challengeToolCatalogSpecs().filter((spec) => profile.hostToolIds.includes(spec.id));
    const toolCatalogHash = sha256(canonicalJson(specs.map(({ id, name, kind, candidates }) => ({ id, name, kind, candidates }))));
    const runtimeKey = options.runtimeKey.trim() || "container";
    const cacheKey = sha256(canonicalJson({ profile: profile.id, targetKind: profile.targetKind, firstActionPlan: profile.firstActionPlan, actionBundles: profile.actionBundles, runtime: "container", runtimeKey, catalog: toolCatalogHash, mcp: mcp.catalogHash(), tools: specs.map((entry) => entry.id) }));
    const cached = options.force ? undefined : await this.readCached(cacheKey);
    if (cached) return { ...cached, firstActionPlan: copyFirstActionPlan(cached.firstActionPlan ?? profile.firstActionPlan), actionBundles: copyActionBundles(cached.actionBundles ?? profile.actionBundles), runtime: "container", runtimeKey, toolCatalogHash, mcpCatalogHash: mcp.catalogHash(), cacheHit: true };
    const checkedAt = Date.now();
    const tools: ToolHealthRecord[] = [];
    for (const spec of specs) {
      const ready = await probeExecutionTool(env, spec.id, spec.candidates);
      tools.push({ id: spec.id, name: spec.name, path: `container:${spec.candidates[0] ?? spec.id}`, status: ready ? "ready" : "missing" });
    }
    const configured = new Set(specs.map((spec) => spec.id));
    const missingRequiredTools = profile.requiredToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const missingOptionalTools = profile.optionalToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const mcpServers = mcp.summaries().filter((server) => profile.mcpServers.includes(server.name) && !server.disabled).map((server) => ({ name: server.name, status: server.status, ...(server.toolchain ? { toolchainState: server.toolchain.state } : {}) }));
    const persisted: PersistedPreflight = { schemaVersion: 1, cacheKey, profileId: profile.id, targetKind: profile.targetKind, runtime: "container", runtimeKey, toolCatalogHash, mcpCatalogHash: mcp.catalogHash(), tools, mcpServers, missingRequiredTools, missingOptionalTools, firstActionPlan: copyFirstActionPlan(profile.firstActionPlan), actionBundles: copyActionBundles(profile.actionBundles), checkedAt };
    await this.writeCached(persisted);
    return { ...persisted, runtime: "container", runtimeKey, toolCatalogHash, mcpCatalogHash: persisted.mcpCatalogHash!, missingOptionalTools, fallbackStrategies: [...profile.fallbackStrategies], firstActionPlan: copyFirstActionPlan(profile.firstActionPlan), actionBundles: copyActionBundles(profile.actionBundles), cacheHit: false };
  }

  public async prepareAll(profiles: readonly ChallengeToolProfile[], catalog: ProofBladeToolCatalogRegistry, mcp: Pick<McpProjectRegistry, "catalogHash" | "summaries">): Promise<ChallengeToolPreflight[]> {
    const results: ChallengeToolPreflight[] = [];
    for (const profile of profiles) results.push(await this.prepare(profile, catalog, mcp));
    return results;
  }

  private async readCached(cacheKey: string): Promise<ChallengeToolPreflight | undefined> {
    if (!this.cacheRoot || this.options.force === true) return undefined;
    try {
      const parsed = JSON.parse(await readFile(join(this.cacheRoot, ".proofblade", "tool-health.json"), "utf8")) as PersistedPreflightCache | PersistedPreflight;
      const cached = "entries" in parsed ? parsed.entries[cacheKey] : parsed.cacheKey === cacheKey ? parsed : undefined;
      const maxAgeMs = this.options.maxAgeMs ?? 10 * 60_000;
      if (!cached || cached.schemaVersion !== 1 || cached.cacheKey !== cacheKey || !Number.isFinite(cached.checkedAt) || Date.now() - cached.checkedAt > maxAgeMs) return undefined;
      const profile = challengeToolProfile(cached.profileId);
      return {
        ...cached,
        runtime: cached.runtime ?? "host",
        runtimeKey: cached.runtimeKey ?? "host",
        toolCatalogHash: cached.toolCatalogHash ?? "",
        mcpCatalogHash: cached.mcpCatalogHash ?? "",
        missingOptionalTools: cached.missingOptionalTools ?? [],
        firstActionPlan: copyFirstActionPlan(cached.firstActionPlan ?? profile.firstActionPlan),
        actionBundles: copyActionBundles(cached.actionBundles ?? profile.actionBundles),
        fallbackStrategies: [...profile.fallbackStrategies],
        cacheHit: true,
      };
    } catch {
      return undefined;
    }
  }

  private async writeCached(value: PersistedPreflight): Promise<void> {
    if (!this.cacheRoot) return;
    try {
      const directory = join(this.cacheRoot, ".proofblade");
      await mkdir(directory, { recursive: true });
      const cachePath = join(directory, "tool-health.json");
      await withFileLock(`${cachePath}.lock`, async () => {
        let cache: PersistedPreflightCache = { schemaVersion: 1, entries: {} };
        try {
          const existing = JSON.parse(await readFile(cachePath, "utf8")) as PersistedPreflightCache;
          if (existing.schemaVersion === 1 && existing.entries && typeof existing.entries === "object") cache = existing;
        } catch {
          // Start a fresh cache when the optional local file is absent or corrupt.
        }
        cache.entries[value.cacheKey] = value;
        const keys = Object.keys(cache.entries);
        for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete cache.entries[key];
        await atomicWriteFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
      }, { timeoutMs: 5_000, staleMs: 30_000 });
    } catch {
      // Readiness must never make a lane fail; a later run can simply probe again.
    }
  }
}

/** Convert the transient preflight result into the bounded durable Run state. */
export function runToolPreparationFromPreflight(preflight: ChallengeToolPreflight, profile: ChallengeToolProfile, generation: number): RunToolPreparation {
  const base = {
    schemaVersion: 1 as const,
    generation,
    profileId: preflight.profileId,
    targetKind: preflight.targetKind,
    runtime: preflight.runtime,
    runtimeKey: preflight.runtimeKey,
    cacheKey: preflight.cacheKey,
    toolCatalogHash: preflight.toolCatalogHash,
    mcpCatalogHash: preflight.mcpCatalogHash,
    checkedAt: preflight.checkedAt,
    health: preflight.missingRequiredTools.length === 0 ? "ready" as const : "degraded" as const,
    tools: preflight.tools.map((tool) => ({ ...tool, required: profile.requiredToolIds.includes(tool.id) })),
    mcpServers: preflight.mcpServers.map((server) => ({ ...server, ...(server.toolchainState === undefined ? {} : { toolchainState: String(server.toolchainState) }) })),
    missingRequiredTools: [...preflight.missingRequiredTools],
    missingOptionalTools: [...preflight.missingOptionalTools],
    fallbackStrategies: [...preflight.fallbackStrategies],
    firstActionPlan: copyFirstActionPlan(profile.firstActionPlan),
    actionBundles: copyActionBundles(preflight.actionBundles ?? profile.actionBundles),
  };
  return { ...base, hash: sha256(canonicalJson(base)) };
}

/**
 * Assert that a preflight result was durably published before a Provider turn.
 * The local health cache is only an optimization; the Run projection is the
 * publication boundary that survives restart and fences generation changes.
 */
export function assertToolPreparationPublished(
  snapshot: Pick<RunSnapshot, "generation" | "toolPreparation">,
  preparation: RunToolPreparation,
): void {
  const published = snapshot.toolPreparation;
  if (!published) throw new Error("Tool preflight was not durably published before the Provider turn");
  if (published.generation !== snapshot.generation || published.generation !== preparation.generation) throw new Error("Published tool preflight generation is stale");
  if (published.hash !== preparation.hash) throw new Error("Published tool preflight does not match the selected runtime profile");
}

/** Rehydrate the prompt-facing preflight view from a persisted Run state. */
export function preflightFromRunToolPreparation(preparation: RunToolPreparation): ChallengeToolPreflight {
  const profile = challengeToolProfile(preparation.profileId as ChallengeCategory);
  return {
    profileId: preparation.profileId as ChallengeCategory,
    targetKind: preparation.targetKind,
    runtime: preparation.runtime,
    runtimeKey: preparation.runtimeKey,
    cacheKey: preparation.cacheKey,
    toolCatalogHash: preparation.toolCatalogHash,
    mcpCatalogHash: preparation.mcpCatalogHash,
    cacheHit: true,
    checkedAt: preparation.checkedAt,
    tools: preparation.tools.map(({ id, name, path, status }) => ({ id, name, path, status })),
    mcpServers: preparation.mcpServers.map(({ name, status, toolchainState }) => ({ name, status: status as McpServerSummary["status"], ...(toolchainState === undefined ? {} : { toolchainState: toolchainState as McpToolchainState }) })),
    missingRequiredTools: [...preparation.missingRequiredTools],
    missingOptionalTools: [...preparation.missingOptionalTools],
    fallbackStrategies: [...preparation.fallbackStrategies],
    firstActionPlan: copyFirstActionPlan(preparation.firstActionPlan ?? profile.firstActionPlan),
    actionBundles: copyActionBundles(preparation.actionBundles ?? profile.actionBundles),
  };
}

function copyFirstActionPlan(plan: FirstActionPlan): FirstActionPlan {
  return { id: plan.id, allowedToolNames: [...plan.allowedToolNames], maxCalls: plan.maxCalls };
}

function copyActionBundles(bundles: readonly ActionBundle[]): ActionBundle[] {
  return bundles.map((bundle) => ({
    ...bundle,
    toolNames: [...bundle.toolNames],
    capabilityIds: [...bundle.capabilityIds],
    preconditions: [...bundle.preconditions],
    successCriteria: [...bundle.successCriteria],
    failureCriteria: [...bundle.failureCriteria],
  }));
}

const PYTHON_MODULES: Record<string, string> = {
  pwntools: "pwn",
  gmpy2: "gmpy2",
  sympy: "sympy",
  pycryptodome: "Crypto",
  fpylll: "fpylll",
  pefile: "pefile",
  oletools: "oletools",
};

async function probeExecutionTool(env: ExecutionEnv, id: string, candidates: readonly string[]): Promise<boolean> {
  const commandChecks = candidates.map((candidate) => `command -v ${shellQuote(candidate)} >/dev/null 2>&1`).join(" || ");
  const module = PYTHON_MODULES[id];
  const moduleCheck = module === undefined ? "" : `for py in python3 python py; do if command -v \"$py\" >/dev/null 2>&1 && \"$py\" -c ${shellQuote(`import ${module}`)} >/dev/null 2>&1; then exit 0; fi; done;`;
  const command = `${moduleCheck} if ${commandChecks || "false"}; then exit 0; fi; exit 1`;
  try {
    const result = await env.exec(command, { timeout: 5 });
    return result.ok && result.value.exitCode === 0;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
