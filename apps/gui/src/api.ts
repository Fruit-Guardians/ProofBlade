import type { ArtifactContent, BootstrapData, RunDetail, RunListItem } from "./shared.js";

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
