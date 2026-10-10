import assert from "node:assert/strict";
import test from "node:test";
import { SIDEBAR_COLLAPSED_STORAGE_KEY, inspectorStateAfterRunChange, sidebarCollapsedFromStorage } from "../src/ui-state.js";

test("sidebar collapse preference only accepts the persisted true value", () => {
  assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, "proofblade.sidebarCollapsed");
  assert.equal(sidebarCollapsedFromStorage("true"), true);
  assert.equal(sidebarCollapsedFromStorage("false"), false);
  assert.equal(sidebarCollapsedFromStorage(null), false);
  assert.equal(sidebarCollapsedFromStorage(undefined), false);
});

test("switching Runs closes and resets the unified inspector", () => {
  assert.deepEqual(inspectorStateAfterRunChange(), {
    open: false,
    tab: "overview",
    selectedToolId: undefined,
  });
});
