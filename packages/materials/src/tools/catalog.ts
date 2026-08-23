import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { RuntimeResourceSnapshot, ToolKind } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

/**
 * Host-local tool catalog.
 *
 * A STATIC, hand-written manifest (`tool-catalog.json` at the ProofBlade install
 * root) that records tools and toolchains available on THIS machine — never the
 * challenge target. Each entry is a concrete filesystem path the agent can call
 * with bash; the registry keeps its metadata resident so the coding lane can
 * inject a stable `<tool-catalog>` block into the system prompt, the same way
 * skill and MCP metadata stay resident while their payloads load on demand.
 *
 * Design constraints that matter here:
 *  - Paths are stored as Windows absolute paths with forward slashes (`C:/...`)
 *    because they are read by both bash and Node tooling. POSIX absolute paths
 *    (`/opt/...`) are accepted too.
 *  - The catalog hash is computed from the tool identity + description only, so
 *    moving the manifest file or an on-disk path going stale do not churn the
 *    stable prompt prefix. Staleness is surfaced as a probe diagnostic instead.
 *  - A broken manifest or a missing file degrades to an EMPTY catalog with
 *    diagnostics — never a hard failure — so a misconfigured tool list cannot
 *    take down a run.
 */

export const TOOL_CATALOG_MANIFEST = "tool-catalog.json";

const KNOWN_KINDS: readonly ToolKind[] = ["tool", "interpreter", "toolchain"];
const execFile = promisify(execFileCallback);

export type ToolCatalogDiagnosticCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "invalid_entry"
  | "duplicate_id"
  | "relative_path"
  | "path_missing";

export interface ToolCatalogDiagnostic {
  type: "warning";
  code: ToolCatalogDiagnosticCode;
  message: string;
  path?: string;
  id?: string;
}

export interface ToolCatalogEntry {
  id: string;
  name: string;
  kind: ToolKind;
  path: string;
  description: string;
  /** Optional path to a usage doc. Kept as metadata only; read on demand. */
  doc?: string;
  /** Optional legacy profile/category selector used by selectForProfile. */
  category?: string;
  /** Optional profile ids. `category` remains accepted for older manifests. */
  profiles?: string[];
  /** Hash of the normative entry fields (identity + description), stable across manifests. */
  contentHash: string;
}

interface RawToolEntry {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  path?: unknown;
  description?: unknown;
  doc?: unknown;
  category?: unknown;
  profiles?: unknown;
}

export interface ToolCatalogLoadOptions {
  /**
   * True when the catalog is loaded for an execution environment that cannot
   * reach the host filesystem (e.g. the competition Docker container). The
   * catalog is host-local by definition, so in a container it must be suppressed
   * entirely: an empty list, an empty prompt block, and the empty-catalog hash.
   */
  container?: boolean;
}

export class ProofBladeToolCatalogRegistry {
  private constructor(
    private readonly entries: ToolCatalogEntry[],
    public readonly diagnostics: ToolCatalogDiagnostic[],
    /** True suppresses all host-local entries; see ToolCatalogLoadOptions.container. */
    private readonly disabled = false,
  ) {}

  /** Load `tool-catalog.json` from `root`. Missing/invalid manifests degrade to empty. */
  public static async load(root: string, options: ToolCatalogLoadOptions = {}): Promise<ProofBladeToolCatalogRegistry> {
    // A container execution env cannot reach the host filesystem, so the
    // host-local catalog is suppressed: it must never leak host paths into the
    // system prompt of a model whose bash runs inside the container.
    if (options.container) {
      return new ProofBladeToolCatalogRegistry([], [], true);
    }
    const manifestPath = join(root, TOOL_CATALOG_MANIFEST);
    const diagnostics: ToolCatalogDiagnostic[] = [];
    let parsed: { tools?: unknown } | undefined;
    try {
      const text = await readFile(manifestPath, "utf8");
      parsed = JSON.parse(text) as { tools?: unknown };
    } catch (error) {
      const missing = isMissingFile(error);
      diagnostics.push(missing
        ? { type: "warning", code: "manifest_missing", message: `No ${TOOL_CATALOG_MANIFEST} at the ProofBlade root; the tool catalog is empty.`, path: manifestPath }
        : { type: "warning", code: "manifest_invalid", message: `${TOOL_CATALOG_MANIFEST} could not be read or parsed; the tool catalog is empty.`, path: manifestPath });
      return new ProofBladeToolCatalogRegistry([], diagnostics);
    }
    if (!parsed || !Array.isArray(parsed.tools)) {
      diagnostics.push({ type: "warning", code: "manifest_invalid", message: `${TOOL_CATALOG_MANIFEST} must contain a "tools" array; the tool catalog is empty.`, path: manifestPath });
      return new ProofBladeToolCatalogRegistry([], diagnostics);
    }

    const entries: ToolCatalogEntry[] = [];
    const byId = new Set<string>();
    const byName = new Set<string>();
    for (let index = 0; index < parsed.tools.length; index += 1) {
      const raw = parsed.tools[index] as RawToolEntry;
      const label = `tools[${index}]`;
      if (raw === null || typeof raw !== "object") {
        diagnostics.push({ type: "warning", code: "invalid_entry", message: `${label} is not an object and was skipped.`, path: manifestPath });
        continue;
      }
      const id = asNonEmptyString(raw.id, `${label}.id`);
      if (!id) {
        diagnostics.push({ type: "warning", code: "invalid_entry", message: `${label} is missing a non-empty "id" and was skipped.`, path: manifestPath });
        continue;
      }
      if (byId.has(id)) {
        diagnostics.push({ type: "warning", code: "duplicate_id", message: `Tool id "${id}" appears more than once; only the first entry is kept.`, path: manifestPath, id });
        continue;
      }
      const name = asNonEmptyString(raw.name, `${label}.name`) ?? id;
      const kind = asKind(raw.kind, `${label}.kind`);
      if (kind === undefined) {
        diagnostics.push({ type: "warning", code: "invalid_entry", message: `Tool "${id}" has an unknown "kind" and was skipped; expected one of ${KNOWN_KINDS.join(", ")}.`, path: manifestPath, id });
        continue;
      }
      if (byName.has(name)) {
        diagnostics.push({ type: "warning", code: "duplicate_id", message: `Tool name "${name}" is duplicated; only the first entry is kept.`, path: manifestPath, id });
        continue;
      }
      const path = asNonEmptyString(raw.path, `${label}.path`);
      if (!path) {
        diagnostics.push({ type: "warning", code: "invalid_entry", message: `Tool "${id}" is missing a non-empty "path" and was skipped.`, path: manifestPath, id });
        continue;
      }
      const normalized = normalizePath(path);
      if (!isAbsolutePath(normalized)) {
        diagnostics.push({ type: "warning", code: "relative_path", message: `Tool "${id}" path "${path}" is not absolute and was skipped.`, path: manifestPath, id });
        continue;
      }
      const description = asNonEmptyString(raw.description, `${label}.description`) ?? name;
      if (description === name) {
        diagnostics.push({ type: "warning", code: "invalid_entry", message: `Tool "${id}" has no description; using the name instead.`, path: manifestPath, id });
      }
      const doc = asNonEmptyString(raw.doc, `${label}.doc`);
      const category = asNonEmptyString(raw.category, `${label}.category`);
      const profiles = asStringArray(raw.profiles);
      byId.add(id);
      byName.add(name);
      entries.push({
        id,
        name,
        kind,
        path: normalized,
        description,
        ...(doc === undefined ? {} : { doc }),
        ...(category === undefined ? {} : { category }),
        ...(profiles === undefined ? {} : { profiles }),
        contentHash: entryContentHash({ id, name, kind, path: normalized, description, doc }),
      });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    diagnostics.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.code.localeCompare(b.code));
    return new ProofBladeToolCatalogRegistry(entries, diagnostics);
  }

  public list(): ToolCatalogEntry[] {
    if (this.disabled) return [];
    return [...this.entries];
  }

  public get(id: string): ToolCatalogEntry | undefined {
    if (this.disabled) return undefined;
    return this.entries.find((entry) => entry.id === id);
  }

  /** Select only the host entries prepared for one challenge profile. */
  public selectForProfile(profileId: string, toolIds: readonly string[] = []): ToolCatalogEntry[] {
    if (this.disabled) return [];
    const requested = new Set(toolIds);
    const selected = this.entries.filter((entry) => {
      if (requested.size > 0) return requested.has(entry.id);
      const declared = entry.profiles ?? (entry.category ? entry.category.split(/[|,]/).map((item) => item.trim()).filter(Boolean) : []);
      return declared.length === 0 || declared.includes("multi") || declared.includes("common") || declared.includes(profileId);
    });
    return [...selected];
  }

  public get size(): number {
    return this.entries.length;
  }

  /** True when the catalog is loaded for a container execution env and suppressed. */
  public get isDisabled(): boolean {
    return this.disabled;
  }

  /** Hash of the sorted fields that the injected prompt block renders: identity,
   * description, and the path/doc the model sees. Path/doc changes (which are
   * injected into the system prompt) therefore legitimately churn this hash and
   * its prompt prefix — that is intentional, because the model sees the new path.
   * Profile selectors stay excluded because they do not change the full catalog
   * content shown to ordinary Coding conversations. See docs/tool-catalog.md. */
  public catalogHash(): string {
    if (this.disabled) return sha256(canonicalJson([]));
    return sha256(canonicalJson(this.entries.map(({ id, name, kind, path, description, doc }) => ({
      id,
      name,
      kind,
      path,
      description,
      ...(doc === undefined ? {} : { doc }),
    }))));
  }

  /** The stable `<tool-catalog>` block injected into the coding system prompt. */
  public promptBlock(profileId?: string, toolIds: readonly string[] = []): string {
    const entries = profileId === undefined ? this.entries : this.selectForProfile(profileId, toolIds);
    if (this.disabled || entries.length === 0) return "";
    const sections = new Map<string, ToolCatalogEntry[]>();
    for (const entry of entries) {
      const list = sections.get(entry.kind) ?? [];
      list.push(entry);
      sections.set(entry.kind, list);
    }
    const interpreterHint = (sections.get("interpreter")?.length ?? 0) > 0
      ? "\nInterpreters are versioned and may not be on the shell PATH (this host's bash often lacks bare `php`/`python`). For those, call the listed interpreter by its EXACT path rather than the bare name when you must run that language."
      : "";
    const lines = [
      `<tool-catalog catalog-hash="${escapeAttribute(catalogHashForEntries(entries))}">`,
      "Host-local tools are trusted project configuration. Call them with bash by their EXACT path; the path is the canonical spelling. Read the referenced doc for usage details." + interpreterHint,
    ];
    for (const kind of KNOWN_KINDS) {
      const entries = sections.get(kind);
      if (!entries) continue;
      for (const entry of entries) {
        lines.push(`<tool name="${escapeAttribute(entry.name)}" kind="${escapeAttribute(entry.kind)}" path="${escapeAttribute(entry.path)}">${escapeText(entry.description)}${entry.doc ? ` (doc: ${escapeText(entry.doc)})` : ""}</tool>`);
      }
    }
    lines.push("</tool-catalog>");
    return lines.join("\n");
  }

  /** The tool fields merged into a RuntimeResourceSnapshot (ContextManifest resources). */
  public contextSnapshot(): Pick<RuntimeResourceSnapshot, "toolCatalogHash" | "toolCatalog"> {
    if (this.disabled) return { toolCatalogHash: sha256(canonicalJson([])), toolCatalog: [] };
    return {
      toolCatalogHash: this.catalogHash(),
      toolCatalog: this.entries.map(({ id, name, kind, path, description }) => ({ id, name, kind, path, description })),
    };
  }

  /**
   * Best-effort existence probe. Returns extra diagnostics for entries whose path
   * does not exist; NEVER feeds the catalog hash, so a stale path does not churn
   * the stable prompt prefix. Diagnostics-only.
   */
  public async probe(profileId?: string, toolIds: readonly string[] = []): Promise<ToolCatalogDiagnostic[]> {
    if (this.disabled) return [];
    const entries = profileId === undefined ? this.entries : this.selectForProfile(profileId, toolIds);
    return await this.probeEntries(entries);
  }

  /** Probe a preselected bounded set without rediscovering the whole catalog. */
  public async probeEntries(entries: readonly ToolCatalogEntry[]): Promise<ToolCatalogDiagnostic[]> {
    if (this.disabled) return [];
    const missing: ToolCatalogDiagnostic[] = [];
    for (const entry of entries) {
      try {
        await stat(entry.path);
      } catch {
        missing.push({ type: "warning", code: "path_missing", message: `Tool "${entry.id}" path "${entry.path}" does not exist on this host.`, path: entry.path, id: entry.id });
      }
    }
    return missing;
  }
}

function entryContentHash(fields: { id: string; name: string; kind: ToolKind; path: string; description: string; doc?: string }): string {
  // Mirrors catalogHash: identity + description + path/doc, category excluded.
  const { id, name, kind, path, description, doc } = fields;
  return sha256(canonicalJson({ id, name, kind, path, description, ...(doc === undefined ? {} : { doc }) }));
}

function asNonEmptyString(value: unknown, label: string): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function asKind(value: unknown, _label: string): ToolKind | undefined {
  if (typeof value === "string") {
    const kind = value.trim().toLowerCase() as ToolKind;
    if ((KNOWN_KINDS as readonly string[]).includes(kind)) return kind;
  }
  if (value === undefined) return "tool";
  return undefined;
}

/** Windows absolute paths (`C:/...`) or POSIX absolute paths (`/...`, `\\...`). */
function isAbsolutePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(value);
}

/** Backslashes to forward slashes and strip a single trailing slash. */
function normalizePath(value: string): string {
  const forward = value.replace(/\\/g, "/");
  return forward.length > 3 ? forward.replace(/\/+$/, "") : forward;
}

function escapeAttribute(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function escapeText(value: string): string {
  return value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character] ?? character);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export interface ToolCatalogBootstrapSpec {
  id: string;
  name: string;
  kind: ToolKind;
  description: string;
  candidates: string[];
  profiles: string[];
}

export interface ToolCatalogBootstrapResult {
  manifestPath: string;
  entries: Array<Omit<ToolCatalogEntry, "contentHash">>;
  missing: string[];
  overwritten: boolean;
}

/**
 * One-time machine setup for the host catalog. It only resolves a fixed,
 * reviewed list of executable names; it never installs packages or executes a
 * tool. The generated manifest is ignored by Git and reused by later lanes.
 */
export async function bootstrapToolCatalog(root: string, specs: readonly ToolCatalogBootstrapSpec[], options: { force?: boolean } = {}): Promise<ToolCatalogBootstrapResult> {
  const manifestPath = join(root, TOOL_CATALOG_MANIFEST);
  let existed = false;
  try {
    await stat(manifestPath);
    existed = true;
  } catch {
    // The normal first-run path.
  }
  if (existed && options.force !== true) throw new Error(`${TOOL_CATALOG_MANIFEST} already exists; pass --refresh to rebuild it`);
  const entries: Array<Omit<ToolCatalogEntry, "contentHash">> = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const path = await resolveExecutable(spec.candidates);
    if (!path) {
      missing.push(spec.id);
      continue;
    }
    entries.push({ id: spec.id, name: spec.name, kind: spec.kind, path, description: spec.description, profiles: [...spec.profiles] });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, tools: entries }, null, 2)}\n`, "utf8");
  await rename(temporary, manifestPath);
  return { manifestPath, entries, missing, overwritten: existed };
}

function catalogHashForEntries(entries: readonly ToolCatalogEntry[]): string {
  return sha256(canonicalJson(entries.map(({ id, name, kind, path, description, doc }) => ({
    id,
    name,
    kind,
    path,
    description,
    ...(doc === undefined ? {} : { doc }),
  }))));
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

async function resolveExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (isAbsolutePath(candidate)) {
      try {
        await stat(candidate);
        return normalizePath(candidate);
      } catch {
        continue;
      }
    }
    try {
      const resolver = process.platform === "win32" ? "where.exe" : "which";
      const result = await execFile(resolver, [candidate], { windowsHide: true, maxBuffer: 16 * 1024 });
      const path = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && isAbsolutePath(line));
      if (path) return normalizePath(path);
    } catch {
      // Try the next reviewed alias.
    }
  }
  return undefined;
}
