import type { ArtifactContent, BootstrapData, ChatStreamEvent, RunDetail, RunListItem } from "./shared.js";

export async function getBootstrap(): Promise<BootstrapData> {
  return await request("/api/bootstrap");
}

export async function getRuns(): Promise<RunListItem[]> {
  return await request("/api/runs");
}

export async function getRun(runId: string): Promise<RunDetail> {
  return await request(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function getArtifact(runId: string, artifactId: string): Promise<ArtifactContent> {
  return await request(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
}

export async function startSolve(input: { runId: string; fixtureId: string; mode: "auto" | "assist"; maxTurns: number }): Promise<unknown> {
  return await request("/api/solve", { method: "POST", body: JSON.stringify(input) });
}

export async function createConversation(input: { runId: string; fixtureId: string; objective: string }): Promise<{ runId: string }> {
  return await request("/api/conversations", { method: "POST", body: JSON.stringify(input) });
}

export async function streamChat(runId: string, prompt: string, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(body.error ? String(body.error) : response.statusText);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (data) onEvent(JSON.parse(data) as ChatStreamEvent);
    }
    if (done) break;
  }
}

export async function createCheckpoint(runId: string, reason: string): Promise<unknown> {
  return await request(`/api/runs/${encodeURIComponent(runId)}/checkpoint`, { method: "POST", body: JSON.stringify({ reason }) });
}

export async function reconcileRun(runId: string): Promise<unknown> {
  return await request(`/api/runs/${encodeURIComponent(runId)}/reconcile`, { method: "POST", body: "{}" });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}
