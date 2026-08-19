import assert from "node:assert/strict";
import test from "node:test";
import { DasctfCompetitionApi } from "../src/competition/dasctf-api.js";
import { CompetitionChallengeError } from "../src/competition/api.js";

const HOST = "https://gcsis.dasctf.com";
const KEY = "ak_test_secret";

// A scripted fetch: maps "METHOD path" (path relative to the API prefix, query
// stripped for env/exercise where noted) to a response factory.
function makeFetch(routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: unknown; contentLength?: number }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; accessKey?: string }> = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight += 1; peakInFlight = Math.max(peakInFlight, inFlight);
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, accessKey: headers.get("X-Agent-AccessKey") ?? undefined });
    // Yield a macrotask so overlapping calls (if any) actually co-exist and bump peakInFlight.
    await new Promise((r) => setTimeout(r, 0));
    inFlight -= 1;
    // Match by the part after the API prefix (or the raw url for attachment downloads).
    const afterPrefix = url.includes("/slab-match/api/v1/agent") ? url.slice(url.indexOf("/slab-match/api/v1/agent") + "/slab-match/api/v1/agent".length) : url;
    const key = `${method} ${afterPrefix}`;
    // Try exact, then prefix (for query-bearing paths).
    const route = routes[key] ?? Object.entries(routes).find(([k]) => key.startsWith(k))?.[1];
    if (!route) throw new Error(`unmocked route: ${key}`);
    const { status = 200, body, contentLength, retryAfter } = route(url, init) as { status?: number; body: unknown; contentLength?: number; retryAfter?: string };
    const isBinary = body instanceof Uint8Array;
    const headerMap = new Headers();
    if (contentLength !== undefined) headerMap.set("content-length", String(contentLength));
    else if (isBinary) headerMap.set("content-length", String((body as Uint8Array).byteLength));
    if (retryAfter !== undefined) headerMap.set("retry-after", retryAfter);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: headerMap,
      text: async () => (isBinary ? "" : JSON.stringify(body)),
      arrayBuffer: async () => (isBinary ? (body as Uint8Array).buffer : new TextEncoder().encode(JSON.stringify(body)).buffer),
      // A one-chunk ReadableStream for the streaming download path; JSON routes
      // (not downloaded as attachments) keep body null and use arrayBuffer.
      body: isBinary ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body as Uint8Array); controller.close(); } }) : null,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls, peak: () => peakInFlight };
}

const ok = (data: unknown) => ({ body: { code: "00000", message: "", data } });

function api(routes: Parameters<typeof makeFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetchImpl, calls, peak } = makeFetch(routes);
  const client = new DasctfCompetitionApi({ serverHost: HOST, accessKey: KEY, fetch: fetchImpl, sleep: async () => {}, envPollIntervalMs: 100, minRequestIntervalMs: 0, ...overrides });
  return { client, calls, peak };
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

test("an oversized attachment is rejected by the byte cap (content-length precheck)", async () => {
  const big = new Uint8Array(2048);
  const { client } = api({
    "GET /ctf/exercise": () => ok({ id: 1001, name: "big", isNeedInit: false, isNeedCheck: false, attachment: { files: [{ name: "big.bin", url: "https://cdn.example/big.bin", ext: "bin" }] } }),
    "GET https://cdn.example/big.bin": () => ({ body: big, contentLength: 2048 }),
  }, { maxAttachmentBytes: 1024 });
  await assert.rejects(() => client.getChallenge("1001"), (error: unknown) => {
    assert.ok(error instanceof CompetitionChallengeError);
    assert.match(error.message, /exceeds 1024 bytes/);
    return true;
  });
});

test("a non-http(s) attachment URL is rejected", async () => {
  const { client } = api({
    "GET /ctf/exercise": () => ok({ id: 1001, name: "x", isNeedInit: false, isNeedCheck: false, attachment: { files: [{ name: "f", url: "file:///etc/passwd", ext: "" }] } }),
  });
  await assert.rejects(() => client.getChallenge("1001"), /must be http/);
});

test("submitFlag maps isCorrect true", async () => {
  const { client, calls } = api({ "POST /answer-panel/answer": () => ok({ isCorrect: true }) });
  const result = await client.submitFlag("1001", "flag{x}");
  assert.equal(result.correct, true);
  assert.deepEqual(calls[0]!.body, { exerciseId: 1001, flag: "x" });   // platform wants only the content inside {}
});

test("submitFlag strips only the two contest-standard wrappers", async () => {
  const cases = [
    ["DASCTF{abc123}", "abc123"],
    ["flag{lowercase}", "lowercase"],
    ["raw-answer", "raw-answer"],
    ["CUSTOM{special-format}", "CUSTOM{special-format}"],
    ["DASCTF{nested{value}}", "DASCTF{nested{value}}"],
  ] as const;

  for (const [input, expected] of cases) {
    const { client, calls } = api({ "POST /answer-panel/answer": () => ok({ isCorrect: true }) });
    await client.submitFlag("1001", `  ${input}  `);
    assert.deepEqual(calls[0]!.body, { exerciseId: 1001, flag: expected }, input);
  }
});

test("submitFlag rejects an empty standard wrapper without contacting the platform", async () => {
  const { client, calls } = api({ "POST /answer-panel/answer": () => ok({ isCorrect: false }) });
  await assert.rejects(() => client.submitFlag("1001", "DASCTF{}"), /wrapper must contain a non-empty value/);
  assert.equal(calls.length, 0);
});

test("submitFlag maps a 00000 envelope with isCorrect:false to a wrong verdict (not an error)", async () => {
  const { client } = api({ "POST /answer-panel/answer": () => ok({ isCorrect: false }) });
  const result = await client.submitFlag("1001", "flag{wrong}");
  assert.equal(result.correct, false);
});

test("an ambiguous non-00000 submit code THROWS by default (never silently burns a submission on auth/rate errors)", async () => {
  const { client } = api({ "POST /answer-panel/answer": () => ({ body: { code: "A0401", message: "unauthorized", data: null } }) });
  await assert.rejects(() => client.submitFlag("1001", "flag{x}"), /code A0401/);
});

test("the platform's real wrong-flag code 40001 maps to correct:false BY DEFAULT (no config needed)", async () => {
  // Contest ground truth: a wrong flag returns code 40001, message like
  // "提交flag错误，请重新提交（当前还有49次提交机会）". This must be a clean verdict,
  // never a throw — a throw crashes the verifier and the model misreads it as an
  // outage and re-sprays. Uses the api() default (no wrongFlagCodes override).
  const { client } = api({ "POST /answer-panel/answer": () => ({ body: { code: "40001", message: "提交flag错误，请重新提交（当前还有49次提交机会）", data: null } }) });
  const result = await client.submitFlag("1001", "flag{wrong}");
  assert.equal(result.correct, false);
  assert.match(result.message ?? "", /提交flag错误/);
});

test("an explicit empty wrongFlagCodes array restores strict fail-safe (40001 then throws)", async () => {
  const { client } = api({ "POST /answer-panel/answer": () => ({ body: { code: "40001", message: "提交flag错误", data: null } }) }, { wrongFlagCodes: [] });
  await assert.rejects(() => client.submitFlag("1001", "flag{x}"), /code 40001/);
});

test("a non-00000 code IN the configured wrongFlagCodes allowlist maps to correct:false", async () => {
  const { client } = api({ "POST /answer-panel/answer": () => ({ body: { code: "B0001", message: "flag 错误", data: null } }) }, { wrongFlagCodes: ["B0001"] });
  const result = await client.submitFlag("1001", "flag{wrong}");
  assert.equal(result.correct, false);
  assert.equal(result.message, "flag 错误");
});

test("startEnvironment does NOT re-POST build when the challenge is already building (isNeedInit && isNeedCheck both true)", async () => {
  let detailCalls = 0;
  const { client, calls } = api({
    "GET /ctf/exercise": () => {
      detailCalls += 1;
      // First read: build already in flight (both flags true) — must only poll.
      if (detailCalls === 1) return ok({ id: 1001, isNeedInit: true, isNeedCheck: true });
      return ok({ id: 1001, isNeedInit: true, isNeedCheck: false, endpoints: [{ exposeIps: ["10.0.0.10"], ports: ["80"], isProxy: false }] });
    },
    "POST /ctf/build-exercise-env": () => ok({}),
  });
  await client.startEnvironment("1001");
  assert.equal(calls.filter((c) => c.url.includes("build-exercise-env")).length, 0, "must not POST build while one is in flight");
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

test("parallel environment starts serialize the build decision and avoid a duplicate POST", async () => {
  let buildStarted = false;
  let buildCalls = 0;
  const detailReads = new Map<string, number>();
  const { client } = api({
    "GET /ctf/exercise": (url) => {
      const id = new URL(url).searchParams.get("exerciseId");
      const reads = (detailReads.get(id ?? "") ?? 0) + 1;
      detailReads.set(id ?? "", reads);
      if (buildStarted && id === "1002" && reads === 1) return ok({ id, isNeedInit: true, isNeedCheck: true });
      if (buildStarted && id === "1001") return ok({ id, isNeedInit: true, isNeedCheck: false, endpoints: [{ exposeIps: ["10.0.0.10"], ports: ["80"], isProxy: false }] });
      if (buildStarted && id === "1002") return ok({ id, isNeedInit: true, isNeedCheck: false, endpoints: [{ exposeIps: ["10.0.0.11"], ports: ["81"], isProxy: false }] });
      return ok({ id, isNeedInit: true, isNeedCheck: false });
    },
    "POST /ctf/build-exercise-env": () => {
      buildCalls += 1;
      buildStarted = true;
      return ok({});
    },
  });
  await Promise.all([client.startEnvironment("1001"), client.startEnvironment("1002")]);
  assert.equal(buildCalls, 1, "only one lane may POST while the platform reports a build in flight");
});

test("a rate-limited environment build is rechecked before retrying the non-idempotent POST", async () => {
  let buildCalls = 0;
  let accepted = false;
  let pollCalls = 0;
  const { client } = api({
    "GET /ctf/exercise": () => {
      if (accepted && pollCalls++ > 0) return ok({ id: 1001, isNeedInit: true, isNeedCheck: false, endpoints: [{ exposeIps: ["10.0.0.10"], ports: ["80"], isProxy: false }] });
      if (accepted) return ok({ id: 1001, isNeedInit: true, isNeedCheck: true });
      return ok({ id: 1001, isNeedInit: true, isNeedCheck: false });
    },
    "POST /ctf/build-exercise-env": () => {
      buildCalls += 1;
      // Simulate a request accepted by the platform whose response was
      // rate-limited. The recovery path must not send a second POST.
      accepted = true;
      return { status: 429, body: { code: "", message: "rate limited", data: null }, retryAfter: "1" };
    },
  }, { maxEnvironmentBuildRetries: 2 });
  const env = await client.startEnvironment("1001");
  assert.equal(buildCalls, 1);
  assert.match(env.connectionInfo ?? "", /10\.0\.0\.10:80/);
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

test("platform requests are serialized — never more than one in flight (defeats the burst 429)", async () => {
  const { client, peak } = api({ "GET /ctf/exercise-list": () => ok([]) });
  // Fire many concurrently; the gate must funnel them one at a time.
  await Promise.all([client.listChallenges(), client.listChallenges(), client.listChallenges(), client.listChallenges(), client.listChallenges()]);
  assert.equal(peak(), 1, "at most one platform request may be in flight at once");
});

test("a 429 is retried (honoring Retry-After) and then succeeds — the challenge is not failed", async () => {
  let n = 0;
  const { client, calls } = api({
    "GET /ctf/exercise-list": () => {
      n += 1;
      if (n <= 2) return { status: 429, body: { code: "", message: "rate limited", data: null }, retryAfter: "1" };
      return ok([]);
    },
  });
  const list = await client.listChallenges();
  assert.deepEqual(list, []);
  assert.equal(calls.filter((c) => c.url.includes("exercise-list")).length, 3); // 2×429 + success
});

test("a persistent 429 exhausts the retry budget and throws (not treated as a verdict)", async () => {
  const { client } = api({ "GET /ctf/exercise-list": () => ({ status: 429, body: { code: "", message: "rate limited", data: null }, retryAfter: "1" }) }, { maxRateLimitRetries: 2 });
  await assert.rejects(() => client.listChallenges(), /HTTP 429/);
});

test("a POST returning 503 is never retried because the request may already have been processed", async () => {
  const { client, calls } = api({
    "POST /answer-panel/answer": () => ({ status: 503, body: { code: "", message: "temporarily unavailable", data: null } }),
  });
  await assert.rejects(() => client.submitFlag("1001", "flag{x}"), /HTTP 503/);
  assert.equal(calls.filter((call) => call.url.includes("answer-panel/answer")).length, 1);
});

test("a POST 429 is not retried even when Retry-After is present", async () => {
  const { client, calls } = api({
    "POST /answer-panel/answer": () => ({ status: 429, body: { code: "", message: "rate limited", data: null }, retryAfter: "1" }),
  });
  await assert.rejects(() => client.submitFlag("1001", "flag{x}"), /HTTP 429/);
  assert.equal(calls.filter((call) => call.url.includes("answer-panel/answer")).length, 1);
});

test("a POST 429 without Retry-After is not retried", async () => {
  const { client, calls } = api({
    "POST /answer-panel/answer": () => ({ status: 429, body: { code: "", message: "rate limited", data: null } }),
  });
  await assert.rejects(() => client.submitFlag("1001", "flag{x}"), /HTTP 429/);
  assert.equal(calls.filter((call) => call.url.includes("answer-panel/answer")).length, 1);
});

test("a failed request does not wedge the gate for subsequent requests", async () => {
  let first = true;
  const { client } = api({
    "GET /ctf/exercise-list": () => {
      if (first) { first = false; return { status: 500, body: { code: "", message: "boom", data: null } }; }
      return ok([]);
    },
  });
  await assert.rejects(() => client.listChallenges(), /HTTP 500/);
  // The gate must have chained past the failure — this second call still runs.
  assert.deepEqual(await client.listChallenges(), []);
});
