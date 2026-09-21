import { readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  NodeExecutionEnv,
  loadSkills,
  type ExecutionEnv,
  type FileInfo,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core/node";
import { snipText } from "@proofblade/molecules";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { RuntimeResourceSnapshot } from "../domain/types.js";

export interface ProofBladeSkillDiagnostic {
  type: "warning";
  code: SkillDiagnostic["code"] | "duplicate_name" | "path_escape";
  message: string;
  path: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  contentHash: string;
  disableModelInvocation: boolean;
}

export interface LoadedSkillContent extends SkillCatalogEntry {
  content: string;
  truncated: boolean;
  originalChars: number;
}

export class ProofBladeSkillRegistry {
  private constructor(
    private readonly projectRoot: string,
    private readonly loadedSkills: Skill[],
    public readonly diagnostics: ProofBladeSkillDiagnostic[],
  ) {}

  /**
   * Loads that actually parsed the skill tree, and loads served from the memo.
   *
   * Exposed so tests and diagnostics can assert cache behaviour without timing
   * assertions, which are flaky on shared runners.
   */
  public static cacheStats(): { readonly parses: number; readonly hits: number } {
    return { parses: skillRegistryParses, hits: skillRegistryHits };
  }

  /** Reset the memo and its counters (tests and long-lived hosts). */
  public static resetCache(): void {
    skillRegistryCache.clear();
    skillRegistryParses = 0;
    skillRegistryHits = 0;
  }

  /**
   * Load skills from one or more directories, in PRECEDENCE order. The default
   * loads the hand-curated `skills/` dir first (ProofBlade's customized
   * ctf-reverse and evidence-triage), then the vendored `skills-library/ctf-skills`
   * catalog (ctf-web, ctf-pwn, ctf-crypto, …). On a name collision the earlier
   * directory wins, so a customized skill is never shadowed by the upstream
   * catalog. Directories after the first are treated as a bulk catalog and only
   * their `SKILL.md`-sourced skills are kept — this drops loose repo docs
   * (README.md, CONTRIBUTING.md, …) that would otherwise load as junk skills.
   */
  public static async load(
    projectRoot: string,
    skillsDirs: string | string[] = ["skills", "skills-library/ctf-skills"],
  ): Promise<ProofBladeSkillRegistry> {
    const root = await canonicalOrResolved(projectRoot);
    const dirList = Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs];
    const requestedDirs = dirList.map((dir) => (isAbsolute(dir) ? dir : resolve(root, dir)));
    const key = cacheKey(root, dirList);
    // Parsing every skill's front matter costs ~30ms on this tree and the result
    // only changes when a skill file appears, disappears or changes, so the parse
    // is memoized on a cheap structural revision. Both the version snapshot and
    // every lane creation load this registry.
    const revision = await skillTreeRevision(requestedDirs);
    const cached = skillRegistryCache.get(key);
    if (cached && cached.projectRoot === root && cached.revision === revision) {
      // Re-insert so eviction is least-recently-*used*, not first-in: a hit is a
      // use, and a plain FIFO evicts exactly the entries being reused.
      skillRegistryCache.delete(key);
      skillRegistryCache.set(key, cached);
      skillRegistryHits += 1;
      return cached.registry;
    }
    // Single-flight: concurrent loads of the same tree (the version snapshot and
    // every lane creation at startup) must walk and parse once between them, not
    // once each. Only the losers wait; the winner removes its own entry.
    const inFlight = skillRegistryLoads.get(key);
    if (inFlight) return await inFlight;
    const load = ProofBladeSkillRegistry.read(root, requestedDirs).then((registry) => {
      skillRegistryParses += 1;
      skillRegistryCache.delete(key);
      skillRegistryCache.set(key, { revision, projectRoot: root, registry });
      while (skillRegistryCache.size > SKILL_REGISTRY_CACHE_LIMIT) {
        const oldest = skillRegistryCache.keys().next().value;
        if (oldest === undefined) break;
        skillRegistryCache.delete(oldest);
      }
      return registry;
    }).finally(() => {
      skillRegistryLoads.delete(key);
    });
    skillRegistryLoads.set(key, load);
    return await load;
  }

  /** Parse the skill roots without consulting the cache. */
  private static async read(root: string, requestedDirs: readonly string[]): Promise<ProofBladeSkillRegistry> {
    const roots = await Promise.all(
      requestedDirs.map(async (requestedDir, index) => ({ index, allowedRoot: await canonicalOrResolved(requestedDir), requestedDir })),
    );
    const env = portableSkillEnv(new NodeExecutionEnv({ cwd: root }));
    const loaded = await loadSkills(env, roots.map((entry) => entry.requestedDir));
    const diagnostics: ProofBladeSkillDiagnostic[] = loaded.diagnostics.map((item) => ({ ...item }));
    const invalidPaths = new Set(loaded.diagnostics.filter((item) => item.code === "invalid_metadata" || item.code === "parse_failed").map((item) => normalizePath(item.path)));
    // Keyed by canonical filePath, not array: loadSkills recurses each root, so
    // when roots nest (e.g. ["skills", "skills/one"]) the SAME SKILL.md is
    // discovered once per covering root. Without de-duping here, one file yields
    // two identical-precedence candidates and the name-collision pass below drops
    // BOTH as duplicates — silently hiding the skill. Owner selection is
    // deterministic per canonical path, so a repeat insert is idempotent.
    const candidates = new Map<string, { skill: Skill; precedence: number }>();

    for (const skill of loaded.skills.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      const canonicalPath = await canonicalOrResolved(skill.filePath);
      if (candidates.has(canonicalPath)) continue;
      // A skill may sit under more than one configured root only if the roots
      // nest; pick the most specific (highest index) owner so precedence is
      // deterministic and the bulk-catalog filter below applies correctly.
      const owner = roots.filter((entry) => isWithin(entry.allowedRoot, canonicalPath)).sort((a, b) => b.index - a.index)[0];
      if (!owner) {
        diagnostics.push({ type: "warning", code: "path_escape", message: "Skill file resolves outside the configured skills directories", path: skill.filePath });
        continue;
      }
      if (invalidPaths.has(normalizePath(skill.filePath))) continue;
      // Bulk-catalog roots (anything after the first) contribute SKILL.md files
      // only, so a vendored repo's top-level docs never become skills.
      if (owner.index > 0 && basename(canonicalPath) !== "SKILL.md") continue;
      candidates.set(canonicalPath, { skill: { ...skill, filePath: canonicalPath }, precedence: owner.index });
    }

    // First-wins precedence: keep the lowest-precedence entry per name. A true
    // duplicate WITHIN the same root drops both (the original behaviour); a
    // lower-precedence root simply shadows a higher one with a diagnostic.
    const byName = new Map<string, Array<{ skill: Skill; precedence: number }>>();
    for (const entry of candidates.values()) {
      const list = byName.get(entry.skill.name) ?? [];
      list.push(entry);
      byName.set(entry.skill.name, list);
    }
    const skills: Skill[] = [];
    for (const [name, entries] of byName) {
      const best = Math.min(...entries.map((entry) => entry.precedence));
      const winners = entries.filter((entry) => entry.precedence === best);
      for (const shadowed of entries.filter((entry) => entry.precedence !== best)) {
        diagnostics.push({ type: "warning", code: "duplicate_name", message: `Skill "${name}" shadowed by a higher-precedence directory`, path: shadowed.skill.filePath });
      }
      if (winners.length === 1) {
        skills.push(winners[0].skill);
        continue;
      }
      for (const clash of winners) {
        diagnostics.push({ type: "warning", code: "duplicate_name", message: `Duplicate skill name: ${name}`, path: clash.skill.filePath });
      }
    }
    return new ProofBladeSkillRegistry(root, skills.sort((a, b) => a.name.localeCompare(b.name)), diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
  }

  public list(options: { includeDisabled?: boolean } = {}): SkillCatalogEntry[] {
    return this.loadedSkills
      .filter((skill) => options.includeDisabled || !skill.disableModelInvocation)
      .map((skill) => this.entry(skill));
  }

  public catalogHash(): string {
    return sha256(canonicalJson(this.list({ includeDisabled: true }).map(({ path: _path, ...entry }) => entry)));
  }

  public contextSnapshot(): RuntimeResourceSnapshot {
    return {
      version: 1,
      skillCatalogHash: this.catalogHash(),
      skills: this.list().map(({ name, description, contentHash }) => ({ name, description, contentHash })),
      mcpCatalogHash: sha256(canonicalJson([])),
      mcpServers: [],
      toolCatalogHash: sha256(canonicalJson([])),
      toolCatalog: [],
    };
  }

  public piSkills(): Skill[] {
    return this.loadedSkills.map((skill) => ({ ...skill }));
  }

  public loadForModel(name: string, maxChars = 12_000): LoadedSkillContent {
    if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 12_000) throw new Error("Skill maxChars must be between 256 and 12000");
    const skill = this.loadedSkills.find((item) => item.name === name && !item.disableModelInvocation);
    if (!skill) throw new Error(`Unknown model-invocable skill: ${name}`);
    const entry = this.entry(skill);
    const body = `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(entry.path)}">\n${skill.content}\n</skill>`;
    const snipped = snipText(body, maxChars);
    return { ...entry, content: snipped.text, truncated: snipped.truncated, originalChars: body.length };
  }

  private entry(skill: Skill): SkillCatalogEntry {
    return {
      name: skill.name,
      description: skill.description,
      path: relative(this.projectRoot, skill.filePath).split(sep).join("/"),
      contentHash: sha256(skill.content),
      disableModelInvocation: skill.disableModelInvocation === true,
    };
  }
}

/**
 * Process-level memo for parsed skill registries.
 *
 * Keyed by canonical project root plus the requested directory list; invalidated
 * by {@link skillTreeRevision}. Bounded because a long-lived host may be pointed
 * at many project roots over its lifetime.
 */
const SKILL_REGISTRY_CACHE_LIMIT = 8;
const skillRegistryCache = new Map<string, { revision: string; projectRoot: string; registry: ProofBladeSkillRegistry }>();
/** Loads still running, so concurrent callers share one walk and one parse. */
const skillRegistryLoads = new Map<string, Promise<ProofBladeSkillRegistry>>();
let skillRegistryParses = 0;
let skillRegistryHits = 0;

function cacheKey(root: string, dirList: readonly string[]): string {
  return `${root}\u0000${dirList.join("\u0000")}`;
}

/**
 * A cheap structural revision of every skill root.
 *
 * Walks the roots for `SKILL.md` files and records each one's path, identity and
 * metadata. That catches a skill added, removed, renamed or edited without
 * reading any file body.
 *
 * The key is `path \0 ino \0 size \0 mtimeMs \0 ctimeMs`, and `size + mtimeMs`
 * alone is NOT acceptable here. An earlier version of this comment argued it was,
 * on the grounds that the version snapshot hashes file contents anyway -- but
 * that reasoning does not hold. This registry is what produces the per-skill
 * `contentHash` the snapshot records, so while the revision key looks unchanged
 * the memoised registry keeps handing back the pre-edit parse result, and the
 * snapshot ends up reporting the old content hash for a body that has changed.
 * That is measured, not hypothetical: see the same-size rewrite assertion in
 * packages/materials/tests/version-cache.test.ts.
 *
 * `ctimeMs` moves on any content change and cannot be set by ordinary writers;
 * `ino` separates a replaced file from an in-place write of the same length.
 *
 * @param roots - absolute skill root directories.
 * @returns a digest that changes whenever the skill set or any skill file does.
 */
async function skillTreeRevision(roots: readonly string[]): Promise<string> {
  return sha256((await collectSkillFiles(roots)).join("\n"));
}

/**
 * Every file the skill loaders derive their result from.
 *
 * This is the single definition of "the skill input set", shared by the registry
 * memo's revision and by the version snapshot (`runtime/version.ts`), because the
 * two caches cover the same tree and a narrower key in either one silently
 * serves stale content.
 *
 * The discovery rules mirror `loadSkills` from
 * `@earendil-works/pi-agent-core`, which the registry calls:
 *
 * - every root contributes `SKILL.md` files at any depth;
 * - the **first** root also contributes its direct `*.md` files, because
 *   `loadSkills` is documented to treat those as skills too. The registry then
 *   drops any skill whose owner index is > 0, which is why only the first root
 *   gets them — but the *walker* has to collect them for the first root or a new
 *   `skills/<name>.md` would not move the revision.
 *
 *   Measured caveat: on Windows the upstream loader does not actually read those
 *   files. `NodeExecutionEnv` reports absolute backslash paths, so the loader's
 *   own `relativeEnvPath(root, path)` fails to strip the root prefix and the
 *   `ignore` package rejects the resulting absolute path; the read is skipped as
 *   an empty result. Collecting them anyway keeps the revision correct on the
 *   platforms where the loader does read them, and costs only a re-parse where it
 *   does not. The same quirk is why `.gitignore` rules inside a skill root have
 *   no effect on Windows.
 * - hidden entries and `node_modules` are not descended into, matching the
 *   loader's pruning;
 * - directory symlinks are followed (`Dirent.isDirectory()` is false for them,
 *   yet the loader recurses by entry kind), so they are normalized with
 *   `stat()` rather than skipped;
 * - `.gitignore` / `.ignore` / `.fdignore` are included wherever they appear.
 *   This is deliberately conservative: the loader consults them to prune the
 *   walk, and reproducing its matcher here would be a second implementation of
 *   the `ignore` package. Including the rule files themselves means a changed
 *   rule always moves the revision, which is the safe direction — a false
 *   invalidation costs one re-parse, a missed one serves a stale catalog.
 *
 * @param roots - absolute skill root directories, in precedence order.
 * @returns `path \0 ino \0 size \0 mtimeMs \0 ctimeMs` entries, sorted.
 */
export async function collectSkillFiles(roots: readonly string[]): Promise<string[]> {
  const entries: string[] = [];
  for (const [index, root] of roots.entries()) await walkSkillRoot(root, index === 0, entries);
  return entries.sort();
}

async function walkSkillRoot(directory: string, isFirstRoot: boolean, into: string[]): Promise<void> {
  let listing: Dirent[];
  try {
    listing = await readdir(directory, { withFileTypes: true });
  } catch {
    // A missing root contributes nothing: the parser treats it as an empty
    // catalog, so its absence must not invalidate an otherwise identical tree.
    return;
  }
  for (const entry of listing) {
    if (isSkillInput(entry.name, isFirstRoot)) {
      const path = resolve(directory, entry.name);
      try {
        const stats = await stat(path);
        if (stats.isFile()) into.push(`${path}\u0000${stats.ino}\u0000${stats.size}\u0000${stats.mtimeMs}\u0000${stats.ctimeMs}`);
        else if (stats.isDirectory()) await walkSkillRoot(path, isFirstRoot, into);
      } catch {
        // Raced with a deletion, or a broken symlink; the next load recomputes.
      }
      continue;
    }
    // Hidden entries and `node_modules` are pruned before the ignore-file test so
    // a rule file is still collected: it is an input to the walk even though it
    // is never descended into.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    try {
      const stats = await stat(path);
      if (stats.isDirectory()) await walkSkillRoot(path, isFirstRoot, into);
    } catch {
      continue;
    }
  }
}

function isSkillInput(name: string, isFirstRoot: boolean): boolean {
  if (name === "SKILL.md") return true;
  if (SKILL_IGNORE_FILES.has(name)) return true;
  return isFirstRoot && name.endsWith(".md");
}

const SKILL_IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"]);

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return resolve(await realpath(path));  } catch {
    return resolve(path);
  }
}

function isWithin(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizePath(path: string): string {
  return resolve(path).toLowerCase();
}

function escapeAttribute(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function portableSkillEnv(env: NodeExecutionEnv): ExecutionEnv {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "fileInfo") {
        return async (path: string) => {
          const result = await target.fileInfo(path);
          return result.ok ? { ok: true as const, value: portableFileInfo(result.value) } : result;
        };
      }
      if (property === "listDir") {
        return async (path: string, signal?: AbortSignal) => {
          const result = await target.listDir(path, signal);
          return result.ok ? { ok: true as const, value: result.value.map(portableFileInfo) } : result;
        };
      }
      if (property === "canonicalPath") {
        return async (path: string) => {
          const result = await target.canonicalPath(path);
          return result.ok ? { ok: true as const, value: toEnvPath(result.value) } : result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as ExecutionEnv;
}

function portableFileInfo(info: FileInfo): FileInfo {
  const path = toEnvPath(info.path);
  return { ...info, path, name: path.replace(/\/+$/, "").split("/").at(-1) ?? info.name };
}

function toEnvPath(path: string): string {
  return path.replace(/\\/g, "/");
}
