import { realpath } from "node:fs/promises";
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
    const roots = await Promise.all(
      dirList.map(async (dir, index) => {
        const requestedDir = isAbsolute(dir) ? dir : resolve(root, dir);
        return { index, allowedRoot: await canonicalOrResolved(requestedDir), requestedDir };
      }),
    );
    const env = portableSkillEnv(new NodeExecutionEnv({ cwd: root }));
    const loaded = await loadSkills(env, roots.map((entry) => entry.requestedDir));
    const diagnostics: ProofBladeSkillDiagnostic[] = loaded.diagnostics.map((item) => ({ ...item }));
    const invalidPaths = new Set(loaded.diagnostics.filter((item) => item.code === "invalid_metadata" || item.code === "parse_failed").map((item) => normalizePath(item.path)));
    const candidates: Array<{ skill: Skill; precedence: number }> = [];

    for (const skill of loaded.skills.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      const canonicalPath = await canonicalOrResolved(skill.filePath);
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
      candidates.push({ skill: { ...skill, filePath: canonicalPath }, precedence: owner.index });
    }

    // First-wins precedence: keep the lowest-precedence entry per name. A true
    // duplicate WITHIN the same root drops both (the original behaviour); a
    // lower-precedence root simply shadows a higher one with a diagnostic.
    const byName = new Map<string, Array<{ skill: Skill; precedence: number }>>();
    for (const entry of candidates) {
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

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return resolve(await realpath(path));
  } catch {
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
