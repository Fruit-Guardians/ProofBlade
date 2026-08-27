import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntimeHost } from "../../../scripts/browser-runtime-playwright-host.ts";
import type { BrowserRuntimeCreateRequest, PlaywrightChromiumPort, PlaywrightPagePort } from "../src/index.js";

test("Playwright runtime host uses one process-local context per idempotency key", async () => {
  let launchCount = 0;
  let closeCount = 0;
  const page: PlaywrightPagePort = {
    async goto() { return { status: () => 200 }; },
    async content() { return "<html>runtime</html>"; },
    url() { return "https://target.test/"; },
    async waitForTimeout() {},
  };
  const chromium: PlaywrightChromiumPort = {
    async launch() {
      launchCount += 1;
      return {
        async newContext() {
          return {
            async newPage() { return page; },
            async storageState() { return { cookies: [], origins: [] }; },
            async close() { closeCount += 1; },
          };
        },
        async close() { closeCount += 1; },
      };
    },
  };
  const host = createBrowserRuntimeHost({ loadChromium: () => chromium });
  const request: BrowserRuntimeCreateRequest = {
    runId: "RUN-HOST",
    generation: 0,
    ownerLane: "verifier",
    target: "https://target.test/",
    policyHash: "a".repeat(64),
    verificationKey: "b".repeat(64),
    allowedHosts: ["target.test"],
    allowedPorts: [],
    maxResponseBytes: 65_536,
    scopeHash: "c".repeat(64),
  };
  const first = await host.create(request, "d".repeat(64));
  const second = await host.create(request, "d".repeat(64));
  assert.equal(first.externalId, second.externalId);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(launchCount, 1);
  assert.equal(await host.inspect(first.externalId), "PRESENT");
  assert.deepEqual((await host.inspectByIdempotency?.(request, "d".repeat(64)))?.status, "PRESENT");
  assert.equal(await host.adopt(first.externalId), true);
  assert.equal(await host.resolve(first.externalId), first.context);
  assert.equal((await host.health?.()).capabilities.stableAcrossRestart, false);
  assert.equal(await host.release(first.externalId, "test"), true);
  assert.equal(await host.inspect(first.externalId), "ABSENT");
  assert.equal(closeCount, 2, "context and browser are both closed exactly once");
});

test("Playwright runtime host reopens persistent context after host restart", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "proofblade-browser-persistent-host-"));
  const profiles = new Map<string, { url: string; content: string }>();
  let persistentLaunchCount = 0;
  let persistentCloseCount = 0;
  const chromium: PlaywrightChromiumPort = {
    async launch() {
      throw new Error("persistent host must not use ephemeral launch");
    },
    async launchPersistentContext(userDataDir) {
      persistentLaunchCount += 1;
      const state = profiles.get(userDataDir) ?? { url: "about:blank", content: "<html>empty</html>" };
      profiles.set(userDataDir, state);
      const page: PlaywrightPagePort = {
        async goto(url) {
          state.url = url;
          state.content = `<html>${url}</html>`;
          return { status: () => 200 };
        },
        async content() { return state.content; },
        url() { return state.url; },
        async waitForTimeout() {},
      };
      return {
        pages() { return [page]; },
        async newPage() { return page; },
        async storageState() { return { cookies: [{ name: "persisted" }], origins: [] }; },
        async close() { persistentCloseCount += 1; },
      };
    },
  };
  const request = hostRequest();
  try {
    const firstHost = createBrowserRuntimeHost({ loadChromium: () => chromium, profileRoot: join(workspace, "profiles") });
    const first = await firstHost.create(request, "e".repeat(64));
    await first.context?.goto("https://target.test/after-restart");
    assert.equal(await firstHost.inspect(first.externalId), "PRESENT");
    await first.context?.close();

    const secondHost = createBrowserRuntimeHost({ loadChromium: () => chromium, profileRoot: join(workspace, "profiles") });
    assert.equal((await secondHost.health?.()).capabilities.stableAcrossRestart, true);
    assert.equal(await secondHost.inspect(first.externalId), "PRESENT");
    assert.equal(await secondHost.adopt(first.externalId, undefined, request), true);
    const resolved = await secondHost.resolve(first.externalId);
    assert.ok(resolved);
    assert.equal(await resolved?.currentUrl(), "https://target.test/after-restart");
    const retry = await secondHost.create(request, "e".repeat(64));
    assert.equal(retry.sessionId, first.sessionId);
    assert.equal(retry.externalId, first.externalId);
    assert.equal(persistentLaunchCount, 2, "restart uses persistent launch, not a fresh ephemeral browser");

    assert.equal(await secondHost.release(first.externalId, "test"), true);
    assert.equal(await secondHost.inspect(first.externalId), "ABSENT");
    assert.equal(persistentCloseCount, 2);
    assert.equal((await stat(join(workspace, "profiles"))).isDirectory(), true);
    const ledger = JSON.parse(await readFile(join(workspace, "profiles", "host-ledger.json"), "utf8")) as { records: unknown[] };
    assert.deepEqual(ledger.records, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function hostRequest(): BrowserRuntimeCreateRequest {
  return {
    runId: "RUN-PERSISTENT-HOST",
    generation: 0,
    ownerLane: "verifier",
    target: "https://target.test/",
    policyHash: "a".repeat(64),
    verificationKey: "b".repeat(64),
    allowedHosts: ["target.test"],
    allowedPorts: [],
    maxResponseBytes: 65_536,
    scopeHash: "c".repeat(64),
  };
}
