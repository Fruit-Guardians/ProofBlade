interface ScriptRequest {
  id: number;
  code: string;
  input: unknown;
}

interface ScriptResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ScriptRequest>) => void) | null;
  postMessage(value: ScriptResponse): void;
};

worker.onmessage = (event) => {
  const { id, code, input } = event.data;
  void Promise.resolve().then(async () => {
    const execute = new Function("input", `"use strict";\n${code}`) as (value: unknown) => unknown;
    return await execute(input);
  }).then((value) => {
    worker.postMessage({ id, ok: true, value: serializable(value) });
  }).catch((error: unknown) => {
    worker.postMessage({ id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  });
};

function serializable(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export {};
