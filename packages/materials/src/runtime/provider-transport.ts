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
