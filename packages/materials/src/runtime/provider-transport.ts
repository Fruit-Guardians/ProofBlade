import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface ProviderTransport {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

/**
 * Operation path segments the OpenAI / Anthropic SDKs append to their baseURL.
 * A competition gateway that only proxies a whitelisted FULL endpoint 404s these
 * extra tails, so in "exact" mode we strip whichever one the SDK added and send
 * the request to the exact baseUrl instead.
 */
const SDK_OPERATION_SUFFIXES = ["/chat/completions", "/v1/messages", "/messages", "/responses"] as const;

/**
 * Wrap a fetch so a request whose URL is `{baseUrl}{op}` (op = an SDK-appended
 * operation path) is rewritten to exactly `{baseUrl}` (query preserved). Only
 * URLs starting with `baseUrl` are touched; everything else passes through, so
 * this never affects other hosts or requests. Use when the profile's baseUrl is
 * already the full gateway endpoint (`endpointMode: "exact"`).
 */
export function wrapExactEndpointFetch(baseUrl: string, inner: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const base = baseUrl.replace(/\/+$/, "");
  return async (input, init) => {
    const original = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rewritten = rewriteToExactEndpoint(original, base);
    if (rewritten === original) return inner(input, init);
    // Rebuild the request against the rewritten URL, preserving method/body/headers.
    if (typeof input === "string" || input instanceof URL) return inner(rewritten, init);
    return inner(new Request(rewritten, input), init);
  };
}

/** Pure URL rewrite: strip a trailing SDK operation suffix so the URL equals baseUrl (query kept). */
export function rewriteToExactEndpoint(requestUrl: string, base: string): string {
  if (!requestUrl.startsWith(base)) return requestUrl;
  const rest = requestUrl.slice(base.length); // e.g. "/chat/completions?x=1" or ""
  const queryStart = rest.search(/[?#]/);
  const path = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const query = queryStart === -1 ? "" : rest.slice(queryStart);
  if (path === "" ) return requestUrl; // already exact
  if ((SDK_OPERATION_SUFFIXES as readonly string[]).includes(path)) return base + query;
  return requestUrl; // an unexpected tail — leave it, do not mangle
}

export function createProviderTransport(proxyUrl?: string): ProviderTransport | undefined {
  if (!proxyUrl?.trim()) return undefined;
  const dispatcher = new ProxyAgent(proxyUrl.trim());
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init as Parameters<typeof undiciFetch>[1],
      dispatcher,
    }) as unknown as Response;
  };
  return {
    fetch: providerFetch,
    close: async () => { await dispatcher.close(); },
  };
}

/** Adapt a completed JSON Responses response to the SSE events consumed by Pi. */
export function wrapJsonResponsesFetch(baseUrl: string, inner: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const base = baseUrl.replace(/\/+$/, "");
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(`${base}/responses`)) return inner(input, init);
    const request = input instanceof Request ? input : undefined;
    const requestInit: RequestInit = {
      ...(request ? { method: request.method, headers: request.headers, signal: request.signal } : {}),
      ...(init ?? {}),
    };
    const rawBody = typeof requestInit.body === "string"
      ? requestInit.body
      : requestInit.body instanceof Uint8Array
        ? new TextDecoder().decode(requestInit.body)
        : requestInit.body instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(requestInit.body))
          : request
            ? await request.clone().text()
            : undefined;
    if (!rawBody) return inner(input, init);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rawBody) as Record<string, unknown>; } catch { return inner(input, init); }
    if (payload.stream !== true) return inner(input, init);
    payload.stream = false;
    const headers = new Headers(requestInit.headers);
    // The body changes from `stream:true` to `stream:false`; never forward
    // framing headers calculated for the original SDK request.
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("host");
    headers.delete("accept");
    headers.set("accept", "application/json");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Return stream headers immediately. Pi can then establish the turn and
        // apply its normal request timeout while this gateway completes JSON.
        void (async () => {
          try {
            const response = await inner(url, { ...requestInit, headers, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`JSON Responses request failed: HTTP ${response.status}`);
            const completed = await response.json() as { output?: Array<Record<string, unknown>> } & Record<string, unknown>;
            for (const [output_index, item] of (completed.output ?? []).entries()) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`));
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", code: "json_responses_transport", message })}\n\n`));
            controller.close();
          }
        })();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}
