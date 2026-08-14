import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  CompetitionHttpError,
  HttpCompetitionApi,
} from "../src/competition/api.js";

async function withServer(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>, run: (baseUrl: string, requests: Array<{ method: string; path: string; body: string; authorization?: string }>) => Promise<void>): Promise<void> {
  const requests: Array<{ method: string; path: string; body: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method ?? "", path: request.url ?? "", body, authorization: request.headers.authorization });
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

test("HttpCompetitionApi rejects challenge details without an explicit attachments array", async () => {
  await withServer(async (_request, response) => send(response, 200, {
    challenge: { id: "c-1", title: "Missing files", category: "Misc" },
  }), async (baseUrl) => {
    const api = new HttpCompetitionApi({ baseUrl });
    await assert.rejects(() => api.getChallenge("c-1"), /explicit attachments array/);
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
    await assert.rejects(() => api.getChallenge("c-1"), /valid base64 content/);
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
