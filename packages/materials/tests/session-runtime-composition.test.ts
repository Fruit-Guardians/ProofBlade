import test from "node:test";
import assert from "node:assert/strict";
import { preflightSessionRuntimeBrokers, tryCreateConfiguredSessionRuntimeBrokers } from "../src/recovery/session-runtime-composition.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { SessionRuntimeCreateBroker } from "../src/recovery/session-resource-adapter.js";

const baseConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures" },
  modelProfiles: { executor: {} },
} as unknown as ProofBladeConfig;

test("session runtime composition leaves local mode untouched without broker configuration", () => {
  const result = tryCreateConfiguredSessionRuntimeBrokers(baseConfig, {});
  assert.equal(result.configured, false);
  assert.equal(result.tokenAvailable, true);
  assert.deepEqual(result.brokers, []);
});

test("configured session runtime is fail-closed when its token is absent", () => {
  const config = { ...baseConfig, runtime: { ...baseConfig.runtime, sessionBroker: { baseUrl: "https://runtime.example.test" } } };
  const result = tryCreateConfiguredSessionRuntimeBrokers(config, {});
  assert.equal(result.configured, true);
  assert.equal(result.tokenAvailable, false);
  assert.deepEqual(result.brokers, []);
});

test("configured session runtime composes one broker per durable session kind", () => {
  const config = { ...baseConfig, runtime: { ...baseConfig.runtime, sessionBroker: { baseUrl: "https://runtime.example.test", tokenEnv: "PB_SESSION_TOKEN" } } };
  const result = tryCreateConfiguredSessionRuntimeBrokers(config, { PB_SESSION_TOKEN: "test-token" });
  assert.equal(result.configured, true);
  assert.equal(result.tokenAvailable, true);
  assert.deepEqual(result.brokers.map((broker) => broker.kind), ["pwn-session", "http-session"]);
});

test("session runtime preflight keeps only READY stable brokers with the requested kind", async () => {
  const makeBroker = (kind: SessionRuntimeCreateBroker["kind"], status: "READY" | "DEGRADED", stableAcrossRestart: boolean): SessionRuntimeCreateBroker => ({
    name: `${kind}-test`,
    kind,
    async inspect() { return { status: "UNKNOWN", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
    async create() { return { schemaVersion: 1, operation: "create", state: "UNKNOWN" }; },
    async createBinding() { throw new Error("not reached"); },
    async health() { return { status, capabilities: { kinds: [kind], maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart } }; },
  });
  const ready = makeBroker("pwn-session", "READY", true);
  const degraded = makeBroker("http-session", "DEGRADED", true);
  const unstable = makeBroker("http-session", "READY", false);
  const result = await preflightSessionRuntimeBrokers([ready, degraded, unstable]);
  assert.deepEqual(result.brokers.map((broker) => broker.kind), ["pwn-session"]);
  assert.deepEqual(result.unavailableKinds, ["http-session", "http-session"]);
});

test("session runtime preflight fails closed on probe errors but preserves explicit unprobed adapters", async () => {
  const unprobed: SessionRuntimeCreateBroker = {
    name: "unprobed-test",
    kind: "pwn-session",
    async inspect() { return { status: "UNKNOWN", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
    async create() { return { schemaVersion: 1, operation: "create", state: "UNKNOWN" }; },
    async createBinding() { throw new Error("not reached"); },
  };
  const failing: SessionRuntimeCreateBroker = {
    ...unprobed,
    name: "failing-test",
    kind: "http-session",
    async health() { throw new Error("probe failed"); },
  };
  const result = await preflightSessionRuntimeBrokers([unprobed, failing]);
  assert.deepEqual(result.brokers.map((broker) => broker.name), ["unprobed-test"]);
  assert.deepEqual(result.unavailableKinds, ["http-session"]);
});
