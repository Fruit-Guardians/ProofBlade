import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { snipText } from "@proofblade/molecules";
import type { CodingResourceContext } from "./coding-resources.js";
import type { PwnToolHandler, PwnReproduceTarget } from "../pwn/pwn-tools.js";
import type { ExploitRecipe } from "../verification/pwn-reproducer.js";
import { decodeBase64Strict } from "../pwn/bytes.js";

/**
 * Model-facing pwn interaction tools.  They all route to `context.pwnTools`,
 * which exists only when a Docker-backed pwn container is attached; without it
 * they fail closed with a clear message instead of pretending a tube exists.
 *
 * These are structured session tools (open returns a sessionId; later calls
 * carry it) — the persistent-interaction shape a one-shot `bash` cannot provide.
 * `pwn_reproduce` is the only success path: it opens a fresh session and runs
 * the shell-probe + flag-extract barriers, so proposing an exploit recipe is not
 * the same as claiming a shell.
 */
export function createPwnCodingTools(): AgentHarnessTool<CodingResourceContext>[] {
  return [pwnOpenTool, pwnSendTool, pwnRecvTool, pwnSignalTool, pwnCloseTool, pwnListTool, pwnReproduceTool];
}

function requireHandler(context: CodingResourceContext): PwnToolHandler {
  if (!context.pwnTools) throw new Error("pwn tools are unavailable: this run has no Docker-backed pwn container. Use bash with pwntools as a fallback, or run in a pwn/pwn-kernel profile.");
  return context.pwnTools;
}

function pwnResult(details: unknown, isError = false): ReturnType<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>> extends Promise<infer R> ? R : never {
  const text = snipText(JSON.stringify(details), 4_000).text;
  return { content: [{ type: "text", text }], details, isError } as never;
}

const pwnOpenTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_open",
  label: "pwn_open",
  description: "Open a persistent pwn tube: a local process (kind=local, command=the target binary) or a remote connection (kind=remote, endpoint=host:port). Returns a sessionId to pass to pwn_send/recv. Prefer this over one-shot bash pwntools when the exploit needs multi-step send/recv.",
  parameters: Type.Object({
    // Direct string enum, not a union of literals: strict OpenAI-compatible
    // providers reject the anyOf that Type.Union([Literal,...]) emits.
    kind: Type.String({ enum: ["local", "remote"], description: "local = run a binary; remote = connect to host:port." }),
    command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "argv of the tube process, e.g. [\"./chall\"] or a pwntools tube runner." }),
    endpoint: Type.Optional(Type.String({ description: "host:port, required for kind=remote." })),
    idleSilenceMs: Type.Optional(Type.Number({ minimum: 50, maximum: 30_000 })),
    waitTimeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 120_000 })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { kind: "local" | "remote"; command: string[]; endpoint?: string; idleSilenceMs?: number; waitTimeoutMs?: number };
    if (input.kind === "remote" && !input.endpoint) throw new Error("pwn_open kind=remote requires an endpoint (host:port)");
    return pwnResult(await requireHandler(context).open(input));
  },
};

const pwnSendTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_send",
  label: "pwn_send",
  description: "Write to a pwn session's stdin and drain one readiness window. For exploit payloads with non-UTF-8 bytes (0x00, 0xff, ROP chains, addresses) set encoding=base64 and pass base64-encoded bytes; the default utf8 mode is for text protocols only. Set line=true to append a newline (LF byte in base64 mode). Returns a bounded viewport; exited=true means the process ended.",
  parameters: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    data: Type.String({ description: "Payload. In utf8 mode: the literal text. In base64 mode: base64 of the exact bytes to send (this is how you send 0x00/0xff and packed addresses)." }),
    encoding: Type.Optional(Type.String({ enum: ["utf8", "base64"], description: "How `data` is interpreted. Default utf8. Use base64 for binary exploit payloads." })),
    line: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { sessionId: string; data: string; encoding?: "utf8" | "base64"; line?: boolean };
    // base64 decodes to exact bytes so a payload like AAD/ (0x00 0x00 0xff)
    // reaches stdin verbatim, not as the 8 UTF-8 chars of a "\x00\xff" literal.
    const payload: string | Uint8Array = input.encoding === "base64" ? decodeBase64Strict(input.data) : input.data;
    return pwnResult(await requireHandler(context).send(input.sessionId, payload, input.line ?? false));
  },
};

const pwnRecvTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_recv",
  label: "pwn_recv",
  description: "Read from a pwn session until an anchor string appears (recvuntil). matched=false with exited=true means the process closed before the anchor — treat that as failure, not success.",
  parameters: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    until: Type.String({ minLength: 1, description: "Anchor bytes to wait for, e.g. a prompt like \"> \"." }),
    maxReads: Type.Optional(Type.Number({ minimum: 1, maximum: 64 })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { sessionId: string; until: string; maxReads?: number };
    return pwnResult(await requireHandler(context).recv(input.sessionId, input.until, input.maxReads));
  },
};

const pwnSignalTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_signal",
  label: "pwn_signal",
  description: "Send a POSIX signal to the session's process group (the target and its forked children). An unknown signal name is rejected, not silently downgraded.",
  parameters: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    signal: Type.String({ enum: ["SIGHUP", "SIGINT", "SIGQUIT", "SIGKILL", "SIGTERM", "SIGUSR1", "SIGUSR2", "SIGSTOP", "SIGCONT"], description: "Signal name from the supported set, e.g. SIGINT, SIGTERM, SIGKILL." }),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { sessionId: string; signal: string };
    return pwnResult(await requireHandler(context).signal(input.sessionId, input.signal as NodeJS.Signals));
  },
};

const pwnCloseTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_close",
  label: "pwn_close",
  description: "Close a pwn session and release its process. Idempotent.",
  parameters: Type.Object({ sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { sessionId: string };
    return pwnResult(await requireHandler(context).close(input.sessionId));
  },
};

const pwnListTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_list",
  label: "pwn_list",
  description: "List the pwn sessions currently open in this run.",
  parameters: Type.Object({}, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, _params, _signal, _onUpdate, context) {
    return pwnResult({ sessions: requireHandler(context).list() });
  },
};

const pwnReproduceTool: AgentHarnessTool<CodingResourceContext> = {
  name: "pwn_reproduce",
  label: "pwn_reproduce",
  description: "Independently reproduce an exploit in a FRESH session. Provide the exploit as ordered stages plus the flag path and pattern. Succeeds only when a real shell echoes a unique marker AND the flag is read from that live session. This is the only way to confirm a pwn solve; proposing a recipe is not claiming a shell.",
  parameters: Type.Object({
    stages: Type.Array(Type.Object({
      name: Type.String({ minLength: 1 }),
      send: Type.Optional(Type.String({ description: "utf8 mode: literal text. base64 mode: base64 of exact bytes (for 0x00/0xff/packed addresses/ROP)." })),
      encoding: Type.Optional(Type.String({ enum: ["utf8", "base64"], description: "How `send` is interpreted. Default utf8. Use base64 to replay a binary payload." })),
      line: Type.Optional(Type.Boolean()),
      expect: Type.Optional(Type.String()),
      maxReads: Type.Optional(Type.Number({ minimum: 1, maximum: 64 })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
    flagPath: Type.String({ minLength: 1, description: "Path read in the live shell, e.g. /flag." }),
    flagPattern: Type.String({ minLength: 1, maxLength: 200, description: "Regex the extracted flag must match, e.g. flag\\{[^}]+\\}. Keep it simple and anchored; pathological patterns are rejected." }),
    target: Type.Object({
      kind: Type.String({ enum: ["local", "remote"], description: "Where to run the clean reproduce." }),
      command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      endpoint: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { stages: ExploitRecipe["stages"]; flagPath: string; flagPattern: string; target: { kind: "local" | "remote"; command: string[]; endpoint?: string } };
    if (input.target.kind === "remote" && !input.target.endpoint) throw new Error("pwn_reproduce remote target requires an endpoint");
    const recipe: ExploitRecipe = { stages: input.stages, flagPath: input.flagPath, flagPattern: input.flagPattern };
    const target: PwnReproduceTarget = input.target.kind === "remote"
      ? { kind: "remote", command: input.target.command, endpoint: input.target.endpoint! }
      : { kind: "local", command: input.target.command };
    return pwnResult(await requireHandler(context).reproduce(recipe, target));
  },
};
