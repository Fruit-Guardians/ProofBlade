import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextCompiler } from "../src/context/compiler.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { TaskContract } from "../src/domain/types.js";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import { createCodingTools } from "../src/runtime/coding-resources.js";

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

test("coding skill loading enforces the conversation allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-coding-skills-"));
  try {
    await skill(root, "allowed", "Allowed workflow", "ALLOWED-BODY");
    await skill(root, "blocked", "Blocked workflow", "BLOCKED-BODY");
    const registry = await ProofBladeSkillRegistry.load(root);
    const loadSkill = createCodingTools().find((tool) => tool.name === "load_skill");
    assert.ok(loadSkill);
    const context = { skills: registry, enabledSkills: new Set(["allowed"]) } as never;
    const loaded = await loadSkill.execute("skill-1", { name: "allowed" }, undefined, undefined, context);
    assert.match(JSON.stringify(loaded), /ALLOWED-BODY/);
    await assert.rejects(
      () => loadSkill.execute("skill-2", { name: "blocked" }, undefined, undefined, context),
      /not enabled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function skill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, "skills", name);
  await mkdir(dir, { recursive: true });
  const leaf = name.split(/[\\/]/).at(-1)!;
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${leaf}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
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
