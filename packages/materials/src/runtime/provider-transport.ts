import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface ProviderTransport {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
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
