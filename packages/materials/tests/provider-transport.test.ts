import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createProviderTransport, wrapJsonResponsesFetch } from "../src/runtime/provider-transport.js";

test("provider transport sends HTTP requests through the configured CONNECT proxy", async () => {
  const target = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await listen(target);
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === "object");

  let connectCount = 0;
  const proxy = createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    connectCount += 1;
    const [hostname, rawPort] = (request.url ?? "").split(":");
    const upstream = connect(Number(rawPort), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  await listen(proxy);
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");

  const transport = createProviderTransport(`http://127.0.0.1:${proxyAddress.port}`);
  assert.ok(transport);
  try {
    const response = await transport.fetch(`http://127.0.0.1:${targetAddress.port}/probe`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(connectCount, 1);
  } finally {
    await transport.close();
    await Promise.all([close(proxy), close(target)]);
  }
});

test("JSON Responses compatibility adapts a completed response to Pi SSE events", async () => {
  let requestBody = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp-test", status: "completed", output: [{ type: "message", id: "msg-test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const fetch = wrapJsonResponsesFetch(`http://127.0.0.1:${address.port}`);
    const request = new Request(`http://127.0.0.1:${address.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: new TextEncoder().encode(JSON.stringify({ model: "test", stream: true })),
    });
    const response = await fetch(request);
    const text = await response.text();
    assert.equal(JSON.parse(requestBody).stream, false);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.match(text, /response\.output_item\.done/);
    assert.match(text, /response\.completed/);
  } finally { await close(server); }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
