import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  CompetitionChallengeError,
  CompetitionHttpError,
  HttpCompetitionApi,
} from "../src/competition/api.js";

async function withServer(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>, run: (baseUrl: string, requests: Array<{ method: string; path: string; body: string; authorization?: string; idempotencyKey?: string }>) => Promise<void>): Promise<void> {
  const requests: Array<{ method: string; path: string; body: string; authorization?: string; idempotencyKey?: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method ?? "", path: request.url ?? "", body, authorization: request.headers.authorization, ...(request.headers["idempotency-key"] ? { idempotencyKey: String(request.headers["idempotency-key"]) } : {}) });
    await handler(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/api`, requests);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function send(response: ServerResponse, status: number, payload?: unknown): void {
  response.statusCode = status;
  if (payload === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

test("HttpCompetitionApi executes the five platform operations with configurable auth and envelopes", async () => {
  await withServer(async (request, response, body) => {
    switch (`${request.method} ${request.url}`) {
      case "GET /api/challenges":
        send(response, 200, { data: { items: [{ id: "c-1", name: "SQLite", category: "Crypto", points: 50, solved: false }] } });
        return;
      case "GET /api/challenges/c-1":
        send(response, 200, {
          data: {
            challenge: { challenge_id: "c-1", title: "SQLite", category: "Crypto", description: "read it" },
            attachments: [{ filename: "dump.sqlite", contentBase64: Buffer.from("sqlite").toString("base64") }],
          },
        });
        return;
      case "POST /api/challenges/c-1/environment":
        assert.equal(body, "");
        send(response, 200, { result: { instance_id: "i-1", connection_info: "nc 127.0.0.1 9001", expires_at: 1234 } });
        return;
      case "POST /api/challenges/c-1/submit":
        assert.deepEqual(JSON.parse(body), { flag: "flag{ok}" });
        send(response, 200, { result: { accepted: true, message: "correct", remaining_attempts: 2 } });
        return;
      case "DELETE /api/challenges/c-1/environment/i-1":
        send(response, 204);
        return;
      default:
        send(response, 404, { error: "not found" });
    }
  }, async (baseUrl, requests) => {
    const api = new HttpCompetitionApi({ baseUrl, token: "secret" });
    const challenges = await api.listChallenges();
    assert.deepEqual(challenges[0], {
      challengeId: "c-1",
      title: "SQLite",
      category: "Crypto",
      normalizedCategory: "crypto",
      value: 50,
      solved: false,
    });
    const detail = await api.getChallenge("c-1");
    assert.equal(detail.summary.challengeId, "c-1");
    assert.deepEqual(detail.attachments, [{ name: "dump.sqlite", base64: Buffer.from("sqlite").toString("base64") }]);
    assert.deepEqual(await api.startEnvironment("c-1"), {
      instanceId: "i-1",
      connectionInfo: "nc 127.0.0.1 9001",
      expiresAt: 1234,
      raw: { instance_id: "i-1", connection_info: "nc 127.0.0.1 9001", expires_at: 1234 },
    });
    assert.deepEqual(await api.submitFlag("c-1", "  flag{ok}\n"), {
      correct: true,
      message: "correct",
      remainingAttempts: 2,
      raw: { accepted: true, message: "correct", remaining_attempts: 2 },
    });
    await api.stopEnvironment("c-1", "i-1");
    assert.equal(requests.length, 5);
    assert.ok(requests.every((request) => request.authorization === "Bearer secret"));
  });
});

test("HttpCompetitionApi fails closed on HTTP and malformed platform responses", async () => {
  await withServer(async (request, response) => {
    if (request.url === "/api/challenges") {
      send(response, 503, { error: "maintenance" });
      return;
    }
    send(response, 200, { data: { accepted: "yes" } });
  }, async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.listChallenges(), (error: unknown) => {
      assert.ok(error instanceof CompetitionHttpError);
      assert.equal(error.status, 503);
      assert.match(error.message, /HTTP 503/);
      return true;
    });
  });

  await withServer(async (_request, response) => send(response, 200, { result: { accepted: "yes" } }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.submitFlag("c-1", "flag{bad}"), /invalid payload/);
  });

  await withServer(async (_request, response) => send(response, 200, { result: { success: true, message: "flag rejected" } }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.submitFlag("c-1", "flag{bad}"), /invalid payload/);
  });

  await withServer(async (_request, response) => send(response, 200, { accepted: true, result: "correct" }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    const result = await api.submitFlag("c-1", "flag{ok}");
    assert.equal(result.correct, true);
  });
});

test("HttpCompetitionApi redacts credentials and flags from bounded HTTP errors", async () => {
  await withServer(async (_request, response) => send(response, 401, {
    error: `rejected Bearer top-secret flag{secret} ${"x".repeat(2_000)}`,
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl, token: "top-secret" });
    await assert.rejects(() => api.submitFlag("c-1", "flag{secret}"), (error: unknown) => {
      assert.ok(error instanceof CompetitionHttpError);
      assert.ok(error.responseBody.length <= 512);
      assert.doesNotMatch(error.message, /top-secret|flag\{secret\}/);
      assert.doesNotMatch(error.responseBody, /top-secret|flag\{secret\}/);
      return true;
    });
  });
});

test("HttpCompetitionApi redacts credentials and flags from fetch exceptions", async () => {
  const api = new HttpCompetitionApi({
    baseUrl: "https://competition.example/api",
    token: "top-secret",
    fetch: async () => {
      throw new Error("socket failed after Bearer top-secret flag{secret}");
    },
  });
  await assert.rejects(() => api.submitFlag("c-1", "flag{secret}"), (error: unknown) => {
    assert.ok(error instanceof CompetitionHttpError);
    assert.doesNotMatch(error.message, /top-secret|flag\{secret\}/);
    assert.doesNotMatch(error.responseBody, /top-secret|flag\{secret\}/);
    return true;
  });
});

test("HttpCompetitionApi redacts credentials and flags from response body read failures", async () => {
  const api = new HttpCompetitionApi({
    baseUrl: "https://competition.example/api",
    token: "top-secret",
    fetch: async () => ({
      ok: false,
      status: 401,
      text: async () => { throw new Error("body stream failed after Bearer top-secret flag{secret}"); },
    } as Response),
  });
  await assert.rejects(() => api.submitFlag("c-1", "flag{secret}"), (error: unknown) => {
    assert.ok(error instanceof CompetitionHttpError);
    assert.doesNotMatch(error.message, /top-secret|flag\{secret\}/);
    assert.doesNotMatch(error.responseBody, /top-secret|flag\{secret\}/);
    return true;
  });
});

test("HttpCompetitionApi cancels a streaming response at the configured byte bound", async () => {
  let cancelled = false;
  const api = new HttpCompetitionApi({
    baseUrl: "https://competition.example/api",
    maxResponseBytes: 1_024,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(2_048)); },
        cancel() { cancelled = true; },
      }),
      text: async () => { throw new Error("text() must not be used for a streaming response"); },
    } as unknown as Response),
  });
  await assert.rejects(() => api.listChallenges(), /response exceeds 1024 bytes/);
  assert.equal(cancelled, true);
});

test("HttpCompetitionApi rejects challenge details without an explicit attachments array", async () => {
  await withServer(async (_request, response) => send(response, 200, {
    challenge: { id: "c-1", title: "Missing files", category: "Misc" },
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.getChallenge("c-1"), /explicit attachments array/);
  });
});

test("HttpCompetitionApi preserves attachments declared beside a data envelope", async () => {
  await withServer(async (_request, response) => send(response, 200, {
    data: { challenge: { id: "c-1", title: "Outer files", category: "Misc" } },
    attachments: [],
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    const result = await api.getChallenge("c-1");
    assert.deepEqual(result.attachments, []);
  });
});

test("HttpCompetitionApi fails closed when a live environment has no teardown handle", async () => {
  await withServer(async (_request, response) => send(response, 200, {
    result: { connection_info: "nc 127.0.0.1 9001", expires_at: 1234 },
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.startEnvironment("c-1"), /instanceId for live environment teardown/);
  });
});

test("HttpCompetitionApi permits handle-less live responses with an explicit teardown endpoint", async () => {
  await withServer(async (request, response) => {
    if (request.method === "POST") {
      send(response, 200, { result: { connection_info: "https://target.example", expires_at: 1234 } });
      return;
    }
    send(response, 204);
  }, async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl, endpoints: { stopEnvironment: "/challenges/{challengeId}/environment" } });
    const environment = await api.startEnvironment("c-1");
    assert.equal(environment.connectionInfo, "https://target.example");
    await api.stopEnvironment("c-1");
  });
});

test("HttpCompetitionApi rejects redirects before credentials can cross origins", async () => {
  let redirectMode: RequestRedirect | undefined;
  let tokenHeader: string | null = null;
  const api = new HttpCompetitionApi({
    baseUrl: "https://competition.example/api",
    token: "top-secret",
    tokenHeader: "X-API-Key",
    fetch: async (_input, init) => {
      redirectMode = init?.redirect;
      tokenHeader = new Headers(init?.headers).get("X-API-Key");
      return Response.redirect("https://receiver.example/collect", 302);
    },
  });
  await assert.rejects(() => api.listChallenges(), /HTTP 302/);
  assert.equal(redirectMode, "error");
  assert.equal(tokenHeader, "top-secret");
});

test("HttpCompetitionApi rejects malformed attachment base64", async () => {
  await withServer(async (_request, response) => send(response, 200, {
    challenge: { id: "c-1", title: "Bad attachment", category: "Misc" },
    attachments: [{ name: "payload.bin", base64: "%%%not-base64%%%" }],
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.getChallenge("c-1"), (error: unknown) => {
      assert.ok(error instanceof CompetitionChallengeError);
      assert.match(error.message, /valid base64 content/);
      return true;
    });
  });
});

test("HttpCompetitionApi carries a stable start key and performs exact remote inspection", async () => {
  await withServer(async (request, response, body) => {
    if (request.method === "POST" && request.url === "/api/challenges/c-1/environment") {
      assert.equal(body, "");
      assert.equal(request.headers["idempotency-key"], "env-key-1");
      send(response, 200, { result: { instance_id: "i-1", idempotency_key: "env-key-1", connection_info: "nc target 9001", expires_at: 1234 } });
      return;
    }
    if (request.method === "GET" && request.url === "/api/challenges/c-1/environment") {
      assert.equal(request.headers["idempotency-key"], "env-key-1");
      send(response, 200, { result: { status: "ACTIVE", challenge_id: "c-1", instance_id: "i-1", idempotency_key: "env-key-1", connection_info: "nc target 9001", expires_at: 1234 } });
      return;
    }
    send(response, 404, { error: "not found" });
  }, async (baseUrl, requests) => {
    const api = new HttpCompetitionApi({ baseUrl, endpoints: { inspectEnvironment: "/challenges/{challengeId}/environment" } });
    const environment = await api.startEnvironment("c-1", { idempotencyKey: "env-key-1" });
    assert.equal(environment.idempotencyKey, "env-key-1");
    assert.deepEqual(await api.inspectEnvironment("c-1", undefined, { idempotencyKey: "env-key-1" }), {
      status: "ACTIVE",
      challengeId: "c-1",
      instanceId: "i-1",
      idempotencyKey: "env-key-1",
      connectionInfo: "nc target 9001",
      expiresAt: 1234,
      summary: "platform query confirms an active environment",
      raw: { status: "ACTIVE", challenge_id: "c-1", instance_id: "i-1", idempotency_key: "env-key-1", connection_info: "nc target 9001", expires_at: 1234 },
    });
    assert.deepEqual(requests.map((item) => ({ method: item.method, idempotencyKey: item.idempotencyKey })), [
      { method: "POST", idempotencyKey: "env-key-1" },
      { method: "GET", idempotencyKey: "env-key-1" },
    ]);
  });
});

test("HttpCompetitionApi supports query-by-idempotency endpoints and nested environment state", async () => {
  await withServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/api/environments/by-key/env%2Fkey-1") {
      send(response, 404, { error: "not found" });
      return;
    }
    send(response, 200, {
      environment: {
        status: "ACTIVE",
        challenge_id: "c-1",
        instance_id: "i-1",
        idempotency_key: "env/key-1",
        connection_info: "nc target 9001",
      },
    });
  }, async (baseUrl, requests) => {
    const api = new HttpCompetitionApi({
      baseUrl,
      endpoints: { inspectEnvironment: "/environments/by-key/{idempotencyKey}" },
    });
    assert.deepEqual(await api.inspectEnvironment("c-1", undefined, { idempotencyKey: "env/key-1" }), {
      status: "ACTIVE",
      challengeId: "c-1",
      instanceId: "i-1",
      idempotencyKey: "env/key-1",
      connectionInfo: "nc target 9001",
      summary: "platform query confirms an active environment",
      raw: {
        status: "ACTIVE",
        challenge_id: "c-1",
        instance_id: "i-1",
        idempotency_key: "env/key-1",
        connection_info: "nc target 9001",
      },
    });
    assert.deepEqual(requests.map((item) => ({ method: item.method, path: item.path, idempotencyKey: item.idempotencyKey })), [
      { method: "GET", path: "/api/environments/by-key/env%2Fkey-1", idempotencyKey: "env/key-1" },
    ]);
  });

  await withServer(async (request, response) => {
    if (request.url === "/api/environments/by-key/env-key-2") {
      send(response, 200, { environment: { status: "STOPPED", challenge_id: "c-1", instance_id: "i-2" } });
      return;
    }
    send(response, 404, { error: "not found" });
  }, async (baseUrl) => {
    const api = new HttpCompetitionApi({
      baseUrl,
      endpoints: { inspectEnvironment: "/environments/by-key/{idempotencyKey}" },
    });
    assert.deepEqual(await api.inspectEnvironment("c-1", undefined, { idempotencyKey: "env-key-2" }), {
      status: "ABSENT",
      challengeId: "c-1",
      summary: "platform query reports an absent environment",
      raw: { status: "STOPPED", challenge_id: "c-1", instance_id: "i-2" },
    });
  });
});

test("HttpCompetitionApi skips an instance placeholder when no environment handle exists", async () => {
  let calls = 0;
  await withServer(async (_request, response) => {
    calls += 1;
    send(response, 204);
  }, async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await api.stopEnvironment("static-challenge");
  });
  assert.equal(calls, 0);
});
