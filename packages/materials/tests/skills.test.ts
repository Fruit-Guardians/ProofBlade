import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { listBundledCapabilities } from "../src/capabilities/catalog.js";
import { ContextCompiler } from "../src/context/compiler.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { TaskContract } from "../src/domain/types.js";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";

test("skill registry uses Pi validation, excludes invalid and duplicate entries, and hashes deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-skills-"));
  try {
    await skill(root, "valid", "Valid procedure", "SECRET-SKILL-BODY\n" + "x".repeat(2_000));
    await skill(root, "Bad_Name", "Invalid name", "invalid");
    await skill(root, join("group-a", "duplicate"), "First duplicate", "one");
    await skill(root, join("group-b", "duplicate"), "Second duplicate", "two");
    const first = await ProofBladeSkillRegistry.load(root);
    const second = await ProofBladeSkillRegistry.load(root);
    assert.deepEqual(first.list().map((item) => item.name), ["valid"]);
    assert.equal(first.catalogHash(), second.catalogHash());
    assert.equal(first.catalogHash().length, 64);
    assert.ok(first.diagnostics.some((item) => item.code === "invalid_metadata"));
    assert.equal(first.diagnostics.filter((item) => item.code === "duplicate_name").length, 2);
    const loaded = first.loadForModel("valid", 256);
    assert.equal(loaded.truncated, true);
    assert.equal(loaded.contentHash.length, 64);
    assert.match(loaded.content, /^<skill name="valid"/);
    await assert.rejects(async () => first.loadForModel("duplicate"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context keeps only skill metadata resident and records the catalog snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-skill-context-"));
  try {
    await skill(root, "triage", "Choose the smallest evidence-producing action", "BODY-MUST-BE-ON-DEMAND");
    const registry = await ProofBladeSkillRegistry.load(root);
    const task = fixtureTask("SKILL-CONTEXT");
    const snapshot = createInitialSnapshot(task.task_id, task);
    const compiled = new ContextCompiler().build({ runId: task.task_id, lane: "executor", phase: snapshot.phase, task, snapshot, resources: registry.contextSnapshot() });
    const rendered = compiled.messages.map((message) => message.content).join("\n");
    assert.match(rendered, /available-skills/);
    assert.match(rendered, /Choose the smallest evidence-producing action/);
    assert.doesNotMatch(rendered, /BODY-MUST-BE-ON-DEMAND/);
    assert.equal(compiled.manifest.resources.skillCatalogHash, registry.catalogHash());
    assert.deepEqual(compiled.manifest.resources.skills.map((item) => item.name), ["triage"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled CTF reverse Skill is discoverable and remains within the model load budget", async () => {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const registry = await ProofBladeSkillRegistry.load(projectRoot);
  const skill = registry.list().find((item) => item.name === "ctf-reverse");
  assert.ok(skill, "bundled ctf-reverse Skill must be discoverable");
  assert.match(skill.description, /reverse engineering/i);

  const loaded = registry.loadForModel("ctf-reverse");
  assert.equal(loaded.truncated, false);
  assert.match(loaded.content, /invoke_capability/);
  const binary = listBundledCapabilities().find((capability) => capability.id === "proofblade.binary");
  assert.ok(binary, "bundled binary Capability must exist for the reverse Skill");
  for (const operation of ["functions", "disassemble", "xrefs"]) {
    assert.match(loaded.content, new RegExp(`proofblade\\.binary\\.${operation}`));
    assert.ok(binary.operations.some((candidate) => candidate.name === operation), `reverse Skill dependency proofblade.binary.${operation} must exist in the bundled Catalog`);
  }
  const firmware = listBundledCapabilities().find((capability) => capability.id === "proofblade.firmware");
  assert.ok(firmware, "bundled firmware Capability must exist for the reverse Skill");
  for (const operation of ["scan", "partitions", "filesystems", "entropy", "file_tree", "extract"]) {
    assert.match(loaded.content, new RegExp(`proofblade\\.firmware\\.${operation}`));
    assert.ok(firmware.operations.some((candidate) => candidate.name === operation), `reverse Skill dependency proofblade.firmware.${operation} must exist in the bundled Catalog`);
  }
});

test("multi-root load: primary dir shadows the bulk catalog and only SKILL.md files load from the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-skills-multi-"));
  try {
    // Primary curated dir: a customized ctf-reverse plus a unique skill.
    await skillAt(root, join("skills", "ctf-reverse"), "ctf-reverse", "Customized reverse routing", "CUSTOM-MARKER body");
    await skillAt(root, join("skills", "evidence-triage"), "evidence-triage", "Curated triage");
    // Bulk catalog dir: an upstream ctf-reverse (must be shadowed), a unique
    // ctf-web (must load), and a loose repo doc that must NOT become a skill.
    await skillAt(root, join("library", "ctf-reverse"), "ctf-reverse", "Upstream reverse", "UPSTREAM-MARKER body");
    await skillAt(root, join("library", "ctf-web"), "ctf-web", "Web exploitation routing");
    await writeFile(join(root, "library", "README.md"), "# Catalog\n\nNot a skill.\n", "utf8");

    const registry = await ProofBladeSkillRegistry.load(root, ["skills", "library"]);
    const names = registry.list({ includeDisabled: true }).map((item) => item.name).sort();
    assert.deepEqual(names, ["ctf-reverse", "ctf-web", "evidence-triage"]);

    // The primary dir wins for ctf-reverse.
    const reverse = registry.loadForModel("ctf-reverse");
    assert.match(reverse.content, /CUSTOM-MARKER/);
    assert.doesNotMatch(reverse.content, /UPSTREAM-MARKER/);
    assert.ok(registry.diagnostics.some((item) => item.code === "duplicate_name" && /shadowed/.test(item.message)));

    // The catalog's unique skill loads; the loose README did not become one.
    assert.ok(registry.list().some((item) => item.name === "ctf-web"));
    assert.ok(!names.includes("README"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default load wires the vendored ctf-skills catalog: ctf-web and ctf-pwn are model-invocable", async () => {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const registry = await ProofBladeSkillRegistry.load(projectRoot);
  const names = new Set(registry.list().map((item) => item.name));
  for (const expected of ["ctf-web", "ctf-pwn", "ctf-crypto", "ctf-reverse", "evidence-triage"]) {
    assert.ok(names.has(expected), `expected skill "${expected}" to be wired into the default registry`);
  }
  // ctf-web fits the model load budget; ctf-reverse resolves to the curated copy.
  assert.equal(registry.loadForModel("ctf-web").truncated, false);
  assert.match(registry.list().find((item) => item.name === "ctf-reverse")!.path, /^skills\/ctf-reverse/);
});

async function skill(root: string, name: string, description: string, body: string): Promise<void> {
  await skillAt(root, join("skills", name), name.split(/[\\/]/).at(-1)!, description, body);
}

async function skillAt(root: string, relDir: string, name: string, description: string, body = "body"): Promise<void> {
  const dir = join(root, relDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
}

function fixtureTask(runId: string): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: "misc",
    target: "LOCAL_FIXTURE",
    objective: "verify skill context",
    inputs: [],
    success_criteria: ["metadata only"],
    verification: { kind: "reproduction", required_reproductions: 1 },
    scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: `runs/${runId}` },
    pause_policy: [],
    constraints: { deadline_ms: 1_000, max_cost_usd: 0, max_tool_calls: 5, max_submissions: 1 },
  };
}
