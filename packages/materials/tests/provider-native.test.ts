import assert from "node:assert/strict";
import test from "node:test";
import { providerNativeCapabilities, providerNativeCapabilitySummary } from "../src/runtime/provider-native.js";

test("declares OpenAI Responses native candidates without treating them as executable capabilities", () => {
  const capabilities = providerNativeCapabilities({ provider: "openai", api: "openai-responses" });

  assert.deepEqual(capabilities.map((item) => [item.id, item.semanticId, item.state]), [
    ["openai.web_search", "web.search", "candidate"],
    ["openai.code_interpreter", "workspace.execute", "suppressed"],
    ["openai.computer_use", "computer.use", "candidate"],
  ]);
  assert.match(capabilities[0]!.reason, /no audited provider-native adapter/i);
  assert.equal(capabilities[1]!.managedBy, "bash");
  assert.deepEqual(providerNativeCapabilitySummary({ provider: "openai", api: "openai-responses" }), {
    api: "openai-responses",
    candidates: 2,
    suppressed: 1,
  });
});

test("deduplicates Anthropic code execution against the controlled workspace runner", () => {
  const capabilities = providerNativeCapabilities({ provider: "anthropic", api: "anthropic-messages" });

  assert.equal(capabilities.find((item) => item.id === "anthropic.web_search")?.state, "candidate");
  const execution = capabilities.find((item) => item.id === "anthropic.code_execution");
  assert.equal(execution?.state, "suppressed");
  assert.equal(execution?.managedBy, "bash");
  assert.match(execution?.reason ?? "", /Effect, Artifact, and Evidence/);
});

test("does not infer native tools for an OpenAI-compatible gateway", () => {
  assert.deepEqual(providerNativeCapabilities({ provider: "deepseek-relay", api: "openai-completions" }), []);
});
