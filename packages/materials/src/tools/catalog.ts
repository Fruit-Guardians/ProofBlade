import { readFile, stat } from "node:fs/promises";
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
  /** Optional category for future per-target-kind filtering. Unused in v1. */
  category?: string;
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
        contentHash: entryContentHash({ id, name, kind, description }),
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

  public get size(): number {
    return this.entries.length;
  }

  /** True when the catalog is loaded for a container execution env and suppressed. */
  public get isDisabled(): boolean {
    return this.disabled;
  }

  /** Hash of the sorted identity + description fields. Deliberately EXCLUDES the
   * file location (`path`, `doc`) and the unused category so that moving a tool
   * or upgrading its path does not churn the stable prompt prefix or the run
   * version snapshot. See docs/tool-catalog.md. */
  public catalogHash(): string {
    if (this.disabled) return sha256(canonicalJson([]));
    return sha256(canonicalJson(this.entries.map(({ id, name, kind, description }) => ({
      id,
      name,
      kind,
      description,
    }))));
  }

  /** The stable `<tool-catalog>` block injected into the coding system prompt. */
  public promptBlock(): string {
    if (this.disabled || this.entries.length === 0) return "";
    const sections = new Map<string, ToolCatalogEntry[]>();
    for (const entry of this.entries) {
      const list = sections.get(entry.kind) ?? [];
      list.push(entry);
      sections.set(entry.kind, list);
    }
    const interpreterHint = (sections.get("interpreter")?.length ?? 0) > 0
      ? "\nInterpreters are versioned and may not be on the shell PATH (this host's bash often lacks bare `php`/`python`). For those, call the listed interpreter by its EXACT path rather than the bare name when you must run that language."
      : "";
    const lines = [
      `<tool-catalog catalog-hash="${escapeAttribute(this.catalogHash())}">`,
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
  public async probe(): Promise<ToolCatalogDiagnostic[]> {
    if (this.disabled) return [];
    const missing: ToolCatalogDiagnostic[] = [];
    for (const entry of this.entries) {
      try {
        await stat(entry.path);
      } catch {
        missing.push({ type: "warning", code: "path_missing", message: `Tool "${entry.id}" path "${entry.path}" does not exist on this host.`, path: entry.path, id: entry.id });
      }
    }
    return missing;
  }
}

function entryContentHash(fields: { id: string; name: string; kind: ToolKind; description: string }): string {
  // Identity + description only; excludes path/doc/category (see catalogHash).
  const { id, name, kind, description } = fields;
  return sha256(canonicalJson({ id, name, kind, description }));
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