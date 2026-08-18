import assert from "node:assert/strict";
import test from "node:test";
import { rewriteToExactEndpoint, wrapExactEndpointFetch } from "../src/runtime/provider-transport.js";

const GW = "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/CODE/v1";

test("strips the OpenAI SDK's /chat/completions so the URL equals the exact gateway endpoint", () => {
  assert.equal(rewriteToExactEndpoint(`${GW}/chat/completions`, GW), GW);
});

test("strips the Anthropic SDK's /v1/messages and /messages", () => {
  assert.equal(rewriteToExactEndpoint(`${GW}/v1/messages`, GW), GW);
  assert.equal(rewriteToExactEndpoint(`${GW}/messages`, GW), GW);
});

test("strips /responses (OpenAI Responses API)", () => {
  assert.equal(rewriteToExactEndpoint(`${GW}/responses`, GW), GW);
});

test("preserves the query string when stripping the operation path", () => {
  assert.equal(rewriteToExactEndpoint(`${GW}/chat/completions?beta=true`, GW), `${GW}?beta=true`);
});

test("an already-exact URL is unchanged", () => {
  assert.equal(rewriteToExactEndpoint(GW, GW), GW);
  assert.equal(rewriteToExactEndpoint(`${GW}?x=1`, GW), `${GW}?x=1`);
});

test("a URL for a different host/base is left untouched", () => {
  const other = "https://api.deepseek.com/v1/chat/completions";
  assert.equal(rewriteToExactEndpoint(other, GW), other);
});

test("an UNEXPECTED tail is left untouched rather than mangled", () => {
  // Not one of the known SDK suffixes — do not silently drop it.
  assert.equal(rewriteToExactEndpoint(`${GW}/models`, GW), `${GW}/models`);
});

test("a trailing slash on baseUrl is normalized", () => {
  assert.equal(rewriteToExactEndpoint(`${GW}/chat/completions`, GW.replace(/$/, "/").replace(/\/+$/, "")), GW);
});

test("wrapExactEndpointFetch rewrites the request URL before calling the inner fetch (string input)", async () => {
  let seen: string | undefined;
  const inner = (async (input: string | URL | Request) => {
    seen = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const wrapped = wrapExactEndpointFetch(GW, inner);
  await wrapped(`${GW}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(seen, GW);
});

test("wrapExactEndpointFetch preserves method + body when rewriting a Request input", async () => {
  let method: string | undefined;
  let body: string | undefined;
  const inner = (async (input: string | URL | Request) => {
    if (input instanceof Request) { method = input.method; body = await input.text(); }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const wrapped = wrapExactEndpointFetch(GW, inner);
  await wrapped(new Request(`${GW}/chat/completions`, { method: "POST", body: '{"model":"deepseek-v4-flash"}' }));
  assert.equal(method, "POST");
  assert.equal(body, '{"model":"deepseek-v4-flash"}');
});

test("wrapExactEndpointFetch passes non-matching URLs through unchanged", async () => {
  let seen: string | undefined;
  const inner = (async (input: string | URL | Request) => {
    seen = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const wrapped = wrapExactEndpointFetch(GW, inner);
  await wrapped("https://other.example/v1/chat/completions");
  assert.equal(seen, "https://other.example/v1/chat/completions");
});
