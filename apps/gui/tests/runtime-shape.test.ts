import assert from "node:assert/strict";
import test from "node:test";
import { ControlStore } from "@proofblade/materials";
import {
  REQUIRED_CONTROL_METHODS,
  STALE_RUNTIME_REMEDY,
  assertMaterialsRuntime,
  probeRuntimeShape,
  resolveRuntimeEntry,
  staleRuntimeMessage,
  type RequiredControlMethod,
} from "../src/runtime-shape.js";

test("control store resolves the runtime entry of the materials package", () => {
  const resolved = resolveRuntimeEntry("@proofblade/materials");

  assert.ok(resolved, "expected @proofblade/materials to resolve from the GUI workspace");
  assert.match(resolved, /packages[\\/]materials[\\/]dist[\\/]index\.js$/);
});

test("unresolvable specifiers report undefined instead of throwing", () => {
  assert.equal(resolveRuntimeEntry("@proofblade/definitely-not-installed"), undefined);
});

test("a stale runtime reports every missing member", () => {
  const report = probeRuntimeShape({}, "@proofblade/materials");

  assert.deepEqual(report.present, []);
  assert.deepEqual(report.missing, [...REQUIRED_CONTROL_METHODS]);
  assert.equal(report.specifier, "@proofblade/materials");
});

test("a non-function member counts as missing", () => {
  const report = probeRuntimeShape({ loadProjectionHint: "not-a-function" }, "@proofblade/materials");

  assert.deepEqual(report.missing, ["loadProjectionHint"]);
  assert.deepEqual(report.present, []);
});

test("a complete runtime reports no missing members and is accepted by the assertion", () => {
  const control = { loadProjectionHint: async () => undefined };
  const report = assertMaterialsRuntime(control);

  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.present, [...REQUIRED_CONTROL_METHODS]);
});

test("the assertion throws with the member, the resolved path, and the remedy", () => {
  let thrown: Error | undefined;
  try {
    assertMaterialsRuntime({} as Pick<ControlStore, RequiredControlMethod>);
  } catch (error) {
    thrown = error as Error;
  }

  assert.ok(thrown, "expected the assertion to reject a stale runtime");
  assert.match(thrown.message, /missing loadProjectionHint/);
  assert.match(thrown.message, /packages[\\/]materials[\\/]dist[\\/]index\.js/);
  assert.match(thrown.message, /npm run build:gui-deps/);
});

test("the failure message falls back to unresolved when the entry cannot be resolved", () => {
  const message = staleRuntimeMessage({ specifier: "@proofblade/absent", present: [], missing: ["loadProjectionHint"] });

  assert.match(message, /`@proofblade\/absent` -> unresolved/);
  assert.ok(message.includes(STALE_RUNTIME_REMEDY));
});

test("the installed materials build satisfies the GUI contract", () => {
  // Guards the workspace against a stale build: this fails when the resolved
  // dist predates a member the GUI calls unconditionally, which is exactly the
  // condition that produced `loadProjectionHint is not a function` at runtime.
  const report = assertMaterialsRuntime(ControlStore.prototype as unknown as Pick<ControlStore, RequiredControlMethod>);

  assert.deepEqual(report.missing, [], "rebuild the workspace packages (npm run build)");
});
