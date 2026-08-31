import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { snipText } from "@proofblade/molecules";
import type { CodingResourceContext } from "./coding-resources.js";
import type { WebToolHandler, WebRequestInput } from "../web/web-tools.js";

/**
 * Model-facing interactive web session tools.  They route to `context.webSession`,
 * which exists only when the task has a resolvable web target; without it they
 * fail closed with a clear message.
 *
 * These are the EXPLORATION counterpart to `web_reproduce` (the verifier-only
 * clean-reproduce barrier). A persistent HTTP session keeps cookies/CSRF across
 * calls, so a stateful chain (login then act, token reuse) survives — the thing
 * a chain of one-shot `curl` calls loses. Confirming a solve still goes through
 * `web_reproduce`; these tools never submit, gate, or judge.
 */
export function createWebSessionTools(): AgentHarnessTool<CodingResourceContext>[] {
  return [webOpenTool, webRequestTool, webReplayTool, webCloseTool, webListTool];
}

function requireHandler(context: CodingResourceContext): WebToolHandler {
  if (!context.webSession) throw new Error("[ProofBlade tool unavailable: web_*]\nReason: this task has no resolvable web target. The requested session action was not executed.\nNext: use bounded bash with curl/python-requests as a fallback, or configure a scoped web target.");
  return context.webSession;
}

/** New network work is investigation; honour the curation backlog gate first. */
async function gateInvestigation(context: CodingResourceContext): Promise<void> {
  await context.evidenceCurationGate?.assertInvestigationAllowed();
}

function webResult(details: unknown, isError = false): ReturnType<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>> extends Promise<infer R> ? R : never {
  const text = snipText(JSON.stringify(details), 4_000).text;
  return { content: [{ type: "text", text }], details, isError } as never;
}

const requestFields = {
  path: Type.String({ minLength: 1, description: "Path or absolute URL; resolved against the session baseUrl and origin-locked to it." }),
  method: Type.Optional(Type.String({ description: "HTTP method (default GET), e.g. GET, POST, PUT." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers." })),
  body: Type.Optional(Type.String({ description: "Request body (utf8 text)." })),
};

const webOpenTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_open",
  label: "web_open",
  description: "Open a persistent HTTP session bound to a target baseUrl. Returns a sessionId to pass to web_request; cookies and CSRF tokens persist across calls in that session, and every request is origin-locked to the baseUrl. Prefer this over one-shot curl when the exploit is stateful (login then act, CSRF reuse).",
  parameters: Type.Object({
    baseUrl: Type.String({ minLength: 1, description: "Target base URL, e.g. http://10.0.0.9:80/. Scope-checked (host/port/scheme)." }),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    await gateInvestigation(context);
    return webResult(await requireHandler(context).open(params as { baseUrl: string }));
  },
};

const webRequestTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_request",
  label: "web_request",
  description: "Issue one HTTP request in a live session (cookies/CSRF persist). Returns status, headers, a bounded body viewport, an artifact id for the full body, and a session state fingerprint.",
  parameters: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    ...requestFields,
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, signal, _onUpdate, context) {
    await gateInvestigation(context);
    return webResult(await requireHandler(context).request(params as WebRequestInput, signal));
  },
};

const webReplayTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_replay",
  label: "web_replay",
  description: "Re-issue a request in a NEW clean session (fresh cookie jar, same origin) to check whether it still works without your accumulated auth state. Useful to confirm an exploit does not secretly depend on a prior authenticated cookie.",
  parameters: Type.Object({
    sessionId: Type.String({ minLength: 1, description: "An existing session; its origin is reused for the clean session." }),
    ...requestFields,
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, signal, _onUpdate, context) {
    await gateInvestigation(context);
    return webResult(await requireHandler(context).replay(params as WebRequestInput, signal));
  },
};

const webCloseTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_close",
  label: "web_close",
  description: "Close a web session and release it. Idempotent.",
  parameters: Type.Object({ sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, params, _signal, _onUpdate, context) {
    const input = params as { sessionId: string };
    await requireHandler(context).close(input.sessionId);
    return webResult({ sessionId: input.sessionId, closed: true });
  },
};

const webListTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_list",
  label: "web_list",
  description: "List the web sessions currently open in this run.",
  parameters: Type.Object({}, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_id, _params, _signal, _onUpdate, context) {
    return webResult({ sessions: requireHandler(context).list() });
  },
};
