import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityOperationAtom } from "@proofblade/molecules";
import {
  CapabilityBackendResolver,
  type CapabilityBackend,
  type CapabilityBackendKind,
  type CapabilityBackendRequest,
} from "../src/capabilities/backend.js";

const operation: CapabilityOperationAtom = {
  name: "identify",
  description: "Identify an input.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "summary",
  executionMode: "sequential",
};

test("capability backend resolution is deterministic and falls back only before execution", () => {
  const resolver = new CapabilityBackendResolver([
    fakeBackend("preferred-unavailable", 10, false, "tool not installed"),
    fakeBackend("fallback-b", 20, true),
    fakeBackend("fallback-a", 20, true),
  ]);
  const request = { capabilityId: "binary.inspect", operation: "identify", input: {} };

  assert.equal(resolver.resolve(request).backend.id, "fallback-a");
  assert.equal(resolver.resolve({ ...request, backendId: "fallback-b" }).backend.id, "fallback-b");
  assert.throws(() => resolver.resolve({ ...request, backendId: "preferred-unavailable" }), /tool not installed/);
  assert.throws(() => resolver.resolve({ ...request, backendId: "fallback-a", backendVersion: "old" }), /version changed/);
  assert.deepEqual(resolver.statuses().map((status) => status.id), ["preferred-unavailable", "fallback-a", "fallback-b"]);
});

test("capability backend ids are unique and bound backends must handle the logical operation", () => {
  assert.throws(() => new CapabilityBackendResolver([
    fakeBackend("duplicate", 10, true),
    fakeBackend("duplicate", 20, true),
  ]), /Duplicate capability backend id/);

  const resolver = new CapabilityBackendResolver([fakeBackend("other", 10, true, undefined, "other.capability")]);
  assert.throws(() => resolver.resolve({ capabilityId: "binary.inspect", operation: "identify", input: {}, backendId: "other" }), /does not handle/);
});

function fakeBackend(
  id: string,
  priority: number,
  available: boolean,
  reason?: string,
  capabilityId = "binary.inspect",
): CapabilityBackend {
  const kind: CapabilityBackendKind = "local-process";
  return {
    id,
    kind,
    priority,
    status: () => ({ id, kind, priority, version: "1.0.0", available, reason }),
    handles: (candidate, candidateOperation) => candidate === capabilityId && candidateOperation === operation.name,
    versionFor: (_request: CapabilityBackendRequest) => "1.0.0",
    preparePersistence: (request) => ({ operation, input: request.input, argsRedacted: false }),
    prepareExecution: () => ({ operation: "fake", args: {}, cwd: ".", replayPolicy: "pure" }),
  };
}
