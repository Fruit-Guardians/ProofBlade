import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

test("dependency funnel only points upward in information scope", async () => {
  await assertNoImports(join(root, "packages", "atoms", "src"), [/@proofblade\/molecules/, /@proofblade\/materials/, /@earendil-works\//]);
  await assertNoImports(join(root, "packages", "molecules", "src"), [/@proofblade\/materials/, /@earendil-works\//]);
  await assertNoImports(join(root, "packages", "materials", "src"), [/@proofblade\/cli/]);

  const atoms = await packageJson("packages/atoms/package.json");
  const molecules = await packageJson("packages/molecules/package.json");
  const materials = await packageJson("packages/materials/package.json");
  const cli = await packageJson("apps/cli/package.json");
  assert.deepEqual(Object.keys(atoms.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(molecules.dependencies ?? {}), ["@proofblade/atoms"]);
  assert.ok(Object.hasOwn(materials.dependencies ?? {}, "@proofblade/molecules"));
  assert.deepEqual(Object.keys(cli.dependencies ?? {}), ["@proofblade/materials"]);
});

async function assertNoImports(path: string, forbidden: RegExp[]): Promise<void> {
  for (const file of await sourceFiles(path)) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} violates the dependency funnel`);
  }
}

async function sourceFiles(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(child));
    else if (entry.name.endsWith(".ts")) result.push(child);
  }
  return result;
}

async function packageJson(relativePath: string): Promise<{ dependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(join(root, relativePath), "utf8")) as { dependencies?: Record<string, string> };
}
