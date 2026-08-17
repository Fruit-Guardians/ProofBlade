import assert from "node:assert/strict";
import test from "node:test";
import { DasctfCompetitionApi } from "../src/competition/dasctf-api.js";

const HOST = "https://gcsis.dasctf.com";
const KEY = "ak_test_secret";

// A scripted fetch: maps "METHOD path" (path relative to the API prefix, query
// stripped for env/exercise where noted) to a response factory.
function makeFetch(routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; accessKey?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, accessKey: headers.get("X-Agent-AccessKey") ?? undefined });
    // Match by the part after the API prefix (or the raw url for attachment downloads).
    const afterPrefix = url.includes("/slab-match/api/v1/agent") ? url.slice(url.indexOf("/slab-match/api/v1/agent") + "/slab-match/api/v1/agent".length) : url;
    const key = `${method} ${afterPrefix}`;
    // Try exact, then prefix (for query-bearing paths).
    const route = routes[key] ?? Object.entries(routes).find(([k]) => key.startsWith(k))?.[1];
    if (!route) throw new Error(`unmocked route: ${key}`);
    const { status = 200, body } = route(url, init);
    const isBinary = body instanceof Uint8Array;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (isBinary ? "" : JSON.stringify(body)),
      arrayBuffer: async () => (isBinary ? (body as Uint8Array).buffer : new TextEncoder().encode(JSON.stringify(body)).buffer),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const ok = (data: unknown) => ({ body: { code: "00000", message: "", data } });

function api(routes: Parameters<typeof makeFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = makeFetch(routes);
  const client = new DasctfCompetitionApi({ serverHost: HOST, accessKey: KEY, fetch: fetchImpl, sleep: async () => {}, envPollIntervalMs: 100, ...overrides });
  return { client, calls };
}

test("listChallenges flattens the two-level category/corpus structure and skips unopened", async () => {
  const { client } = api({
    "GET /ctf/exercise-list": () => ok([
      { id: 10, name: "Web", corpus: [{ id: 1001, name: "easy-web", isOpen: true, hasSolved: false }, { id: 1002, name: "hidden", isOpen: false }] },
      { id: 20, name: "Misc", corpus: [{ id: 2001, name: "misc-1", isOpen: true, hasSolved: true }] },
    ]),
  });
  const list = await client.listChallenges();
  assert.deepEqual(list.map((c) => c.challengeId), ["1001", "2001"]);   // 1002 skipped (isOpen:false)
  assert.equal(list[0]!.category, "Web");
  assert.equal(list[0]!.normalizedCategory, "web");
  assert.equal(list[1]!.solved, true);
});

test("the X-Agent-AccessKey header is sent and success requires code 00000", async () => {
  const { client, calls } = api({ "GET /ctf/exercise-list": () => ok([]) });
  await client.listChallenges();
  assert.equal(calls[0]!.accessKey, KEY);
});

test("a non-00000 envelope on a normal call throws (business/transport failure)", async () => {
  const { client } = api({ "GET /ctf/exercise-list": () => ({ body: { code: "A0401", message: "unauthorized", data: null } }) });
  await assert.rejects(() => client.listChallenges(), /code A0401/);
});

test("getChallenge downloads attachment URLs and encodes them as base64", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const { client } = api({
    "GET /ctf/exercise": () => ok({ id: 1001, name: "easy-web", score: "100", difficulty: "EASY", attachment: { files: [{ name: "a.zip", url: "https://cdn.example/a.zip", ext: "zip" }] }, isNeedInit: false, isNeedCheck: false }),
    "GET https://cdn.example/a.zip": () => ({ body: bytes }),
  });
  const { summary, attachments } = await client.getChallenge("1001");
  assert.equal(summary.value, 100);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.name, "a.zip");
  assert.equal(attachments[0]!.base64, Buffer.from(bytes).toString("base64"));
});

test("submitFlag maps isCorrect true", async () => {
  const { client, calls } = api({ "POST /answer-panel/answer": () => ok({ isCorrect: true }) });
  const result = await client.submitFlag("1001", "flag{x}");
  assert.equal(result.correct, true);
  assert.deepEqual(calls[0]!.body, { exerciseId: 1001, flag: "flag{x}" });   // exerciseId is in the body
});

test("a WRONG flag comes back as a non-00000 code and maps to correct:false WITHOUT throwing (does not burn a retry)", async () => {
  const { client } = api({ "POST /answer-panel/answer": () => ({ body: { code: "B0001", message: "flag 错误", data: null } }) });
  const result = await client.submitFlag("1001", "flag{wrong}");
  assert.equal(result.correct, false);
  assert.equal(result.message, "flag 错误");
});

test("startEnvironment posts build then polls the detail until isNeedCheck is false, and builds connectionInfo", async () => {
  let detailCalls = 0;
  const { client, calls } = api({
    "GET /ctf/exercise": () => {
      detailCalls += 1;
      if (detailCalls === 1) return ok({ id: 1001, isNeedInit: true, isNeedCheck: false });   // pre-build
      if (detailCalls === 2) return ok({ id: 1001, isNeedInit: true, isNeedCheck: true });     // still building
      return ok({ id: 1001, isNeedInit: true, isNeedCheck: false, endpoints: [{ exposeIps: ["10.0.0.10"], ports: ["80", "22"], isProxy: false, users: [{ username: "root", password: "pw" }], expireTime: 1780000000000 }] });
    },
    "POST /ctf/build-exercise-env": () => ok({}),
  });
  const env = await client.startEnvironment("1001");
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("build-exercise-env")));
  assert.match(env.connectionInfo ?? "", /10\.0\.0\.10:80/);
  assert.match(env.connectionInfo ?? "", /login root \/ pw/);
  assert.equal(env.expiresAt, 1780000000000);
});

test("startEnvironment is a no-op for a static (isNeedInit:false) challenge", async () => {
  const { client, calls } = api({ "GET /ctf/exercise": () => ok({ id: 1001, isNeedInit: false, isNeedCheck: false }) });
  const env = await client.startEnvironment("1001");
  assert.equal(env.connectionInfo, undefined);
  assert.equal(calls.filter((c) => c.url.includes("build-exercise-env")).length, 0);
});

test("proxy endpoints use portMappings + proxyIps for the connection string", async () => {
  const { client } = api({
    "GET /ctf/exercise": () => ok({ id: 1001, isNeedInit: false, isNeedCheck: false, endpoints: [{ proxyIps: ["1.2.3.4"], isProxy: true, portMappings: [{ type: "tcp", port: "80", proxy: "30080" }] }] }),
  });
  const env = await client.startEnvironment("1001");
  assert.match(env.connectionInfo ?? "", /1\.2\.3\.4:30080/);
});

test("stopEnvironment posts recover with the exerciseId", async () => {
  const { client, calls } = api({ "POST /ctf/recover-exercise-env": () => ok({}) });
  await client.stopEnvironment("1001");
  assert.deepEqual(calls[0]!.body, { exerciseId: 1001 });
});

test("a non-integer challengeId is rejected before any request", async () => {
  const { client } = api({});
  await assert.rejects(() => client.stopEnvironment("not-a-number"), /positive integer/);
});
