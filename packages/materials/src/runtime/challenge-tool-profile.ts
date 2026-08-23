import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpProjectRegistry, McpServerSummary, McpToolchainState } from "../mcp/registry.js";
import type { TargetKind } from "../domain/types.js";
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
  skillNames: string[];
  hostToolIds: string[];
  requiredToolIds: string[];
  optionalToolIds: string[];
  mcpServers: string[];
  capabilities: string[];
  fallbackStrategies: string[];
}

export interface ChallengeClassification {
  profile: ChallengeToolProfile;
  confidence: "high" | "medium";
  reasons: string[];
}

const COMMON_HOST_TOOLS = ["python311", "python", "jq", "xxd"];

const PROFILE_DATA: Record<ChallengeCategory, Omit<ChallengeToolProfile, "id">> = {
  reverse: {
    targetKind: "reverse",
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
    skillNames: ["ctf-pwn"],
    hostToolIds: ["checksec", "gdb", "pwntools", "ropgadget", "one_gadget", "patchelf", "qemu", ...COMMON_HOST_TOOLS],
    requiredToolIds: ["checksec", "python"],
    optionalToolIds: ["gdb", "pwntools", "ropgadget", "one_gadget", "patchelf", "qemu", "jq", "xxd"],
    mcpServers: [],
    capabilities: ["pwn.tube", "pwn.reproduce"],
    fallbackStrategies: ["local:checksec-gdb-reproducer", "remote:pwn-tube-with-bounded-recv", "rop:libc-search-then-ropgadget"],
  },
  web: {
    targetKind: "web",
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
  return { id: category, ...data, skillNames: [...data.skillNames], hostToolIds: [...data.hostToolIds], requiredToolIds: [...data.requiredToolIds], optionalToolIds: [...data.optionalToolIds], mcpServers: [...data.mcpServers], capabilities: [...data.capabilities], fallbackStrategies: [...data.fallbackStrategies] };
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
  if (targetKind === "pwn" || targetKind === "web" || targetKind === "crypto" || targetKind === "misc") return challengeToolProfile(targetKind);
  return undefined;
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
  cacheKey: string;
  cacheHit: boolean;
  checkedAt: number;
  tools: ToolHealthRecord[];
  mcpServers: McpHealthRecord[];
  missingRequiredTools: string[];
  missingOptionalTools: string[];
  fallbackStrategies: string[];
}

interface PersistedPreflight {
  schemaVersion: 1;
  cacheKey: string;
  profileId: ChallengeCategory;
  targetKind: ChallengeToolPreflight["targetKind"];
  tools: ToolHealthRecord[];
  mcpServers: McpHealthRecord[];
  missingRequiredTools: string[];
  /** Added after the initial cache format; old health entries remain readable. */
  missingOptionalTools?: string[];
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
      },
      catalog: catalog.catalogHash(),
      mcp: mcp.catalogHash(),
      tools: selected.map((entry) => entry.id),
    }));
    const cached = await this.readCached(cacheKey);
    if (cached) return { ...cached, cacheHit: true };
    const checkedAt = Date.now();
    const diagnostics = await catalog.probeEntries(selected);
    const missingPaths = new Set(diagnostics.filter((item) => item.code === "path_missing").map((item) => item.id));
    const tools = selected.map((entry) => ({ id: entry.id, name: entry.name, path: entry.path, status: missingPaths.has(entry.id) ? "missing" as const : "ready" as const }));
    const configured = new Set(selected.map((entry) => entry.id));
    const missingRequiredTools = profile.requiredToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const missingOptionalTools = profile.optionalToolIds.filter((id) => !configured.has(id) || tools.find((tool) => tool.id === id)?.status === "missing");
    const mcpServers = mcp.summaries().filter((server) => profile.mcpServers.includes(server.name) && !server.disabled).map((server) => ({ name: server.name, status: server.status, ...(server.toolchain ? { toolchainState: server.toolchain.state } : {}) }));
    const persisted: PersistedPreflight = { schemaVersion: 1, cacheKey, profileId: profile.id, targetKind: profile.targetKind, tools, mcpServers, missingRequiredTools, missingOptionalTools, checkedAt };
    await this.writeCached(persisted);
    return { ...persisted, missingOptionalTools, fallbackStrategies: [...profile.fallbackStrategies], cacheHit: false };
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
      return { ...cached, missingOptionalTools: cached.missingOptionalTools ?? [], fallbackStrategies: [...profile.fallbackStrategies], cacheHit: true };
    } catch {
      return undefined;
    }
  }

  private async writeCached(value: PersistedPreflight): Promise<void> {
    if (!this.cacheRoot) return;
    try {
      const directory = join(this.cacheRoot, ".proofblade");
      await mkdir(directory, { recursive: true });
      let cache: PersistedPreflightCache = { schemaVersion: 1, entries: {} };
      try {
        const existing = JSON.parse(await readFile(join(directory, "tool-health.json"), "utf8")) as PersistedPreflightCache;
        if (existing.schemaVersion === 1 && existing.entries && typeof existing.entries === "object") cache = existing;
      } catch {
        // Start a fresh cache when the optional local file is absent or corrupt.
      }
      cache.entries[value.cacheKey] = value;
      const keys = Object.keys(cache.entries);
      for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete cache.entries[key];
      await writeFile(join(directory, "tool-health.json"), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch {
      // Readiness must never make a lane fail; a later run can simply probe again.
    }
  }
}
